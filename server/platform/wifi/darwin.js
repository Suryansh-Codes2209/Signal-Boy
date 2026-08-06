import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reading, failure, channelToBand } from './common.js';

const run = promisify(execFile);

/**
 * macOS WiFi backend.
 *
 * `airport -s` was removed in macOS 14.4 and Apple reclassified WiFi metadata
 * as location data. system_profiler still reports the connected network's RSSI
 * and noise without sudo -- enough for a survey, since you walk around
 * measuring your own network -- but neighbouring SSIDs come back <redacted>
 * with no signal values at all.
 *
 * First call is slow (~5s, cold ioreg cache); subsequent calls ~0.3s.
 */

const SIGNAL_NOISE = /(-?\d+)\s*dBm\s*\/\s*(-?\d+)\s*dBm/;
const CHANNEL = /^(\d+)\s*(?:\((.+)\))?/;

function parseChannel(raw) {
  if (!raw) return { channel: null, band: null, width: null };
  const m = CHANNEL.exec(String(raw).trim());
  if (!m) return { channel: null, band: null, width: null };
  const [band, width] = (m[2] ?? '').split(',').map((s) => s.trim());
  const channel = Number(m[1]);
  return { channel, band: band || channelToBand(channel), width: width || null };
}

/** "spairport_security_mode_wpa2_personal" -> "WPA2 PERSONAL" */
function prettifySecurity(raw) {
  if (!raw) return null;
  return String(raw).replace(/^spairport_security_mode_/, '').replace(/_/g, ' ').toUpperCase();
}

/**
 * Picks the real WiFi interface.
 *
 * Macs report more than one: alongside en0 there is awdl0, the Apple Wireless
 * Direct Link used by AirDrop and AirPlay, which reports itself as connected
 * but carries no signal data. Selecting by index would work only by accident,
 * so choose the first interface that actually yields a signal reading.
 */
async function airportInterface() {
  const { stdout } = await run('system_profiler', ['-json', 'SPAirPortDataType'], {
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
  });

  const interfaces = JSON.parse(stdout).SPAirPortDataType?.[0]?.spairport_airport_interfaces ?? [];
  if (!interfaces.length) return null;

  const withSignal = interfaces.find((iface) =>
    SIGNAL_NOISE.test(iface.spairport_current_network_information?.spairport_signal_noise ?? ''),
  );
  // Fall back to any connected interface so "not connected" stays distinct
  // from "connected but reporting nothing".
  return (
    withSignal ??
    interfaces.find((iface) => iface.spairport_current_network_information) ??
    interfaces[0]
  );
}

export async function readConnected() {
  let iface;
  try {
    iface = await airportInterface();
  } catch (err) {
    return failure(`system_profiler failed: ${err.message}`);
  }
  if (!iface) return failure('no WiFi interface found');

  const current = iface.spairport_current_network_information;
  if (!current) return failure('not connected to a WiFi network', { interface: iface._name ?? null });

  const sn = SIGNAL_NOISE.exec(current.spairport_signal_noise ?? '');
  if (!sn) return failure('no signal reading available');

  const rssi = Number(sn[1]);
  const noise = Number(sn[2]);

  return reading({
    rssi,
    noise,
    snr: rssi - noise,
    exact: true,
    // Redacted unless the calling binary is signed and holds Location
    // permission. The UI renders this as "HIDDEN BY MACOS" rather than blank.
    ssid: current._name ?? null,
    ...parseChannel(current.spairport_network_channel),
    phyMode: current.spairport_network_phymode ?? null,
    txRate: current.spairport_network_rate ?? null,
    security: prettifySecurity(current.spairport_security_mode),
    interface: iface._name ?? null,
    source: 'system_profiler',
  });
}

/**
 * Neighbour scanning is not possible on modern macOS without a signed helper.
 * Returns an explicit unsupported result so the UI can explain why the panel
 * is empty instead of showing a silently blank list.
 */
export async function scanAps() {
  return {
    ok: false,
    supported: false,
    error: 'macOS redacts neighbouring networks. Signal values are not exposed to unsigned processes.',
    networks: [],
  };
}
