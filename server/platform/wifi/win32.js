import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  reading,
  failure,
  percentToDbm,
  channelToBand,
  parseKeyValueBlock,
  pick,
  toNumber,
} from './common.js';

const run = promisify(execFile);

/**
 * Windows WiFi backend -- the most capable of the three.
 *
 * `netsh wlan show networks mode=bssid` lists every visible access point with
 * SSID, BSSID, band, channel and signal, with no admin rights. macOS refuses
 * this outright, so the survey gets a whole extra dimension here: you can map
 * interference from neighbouring networks, not just your own coverage.
 *
 * Signal is reported as a 0-100 quality percentage. Recent Windows 11 builds
 * also print a true `RSSI` line in dBm; we prefer that when present and fall
 * back to the pct/2-100 approximation otherwise, flagging which was used.
 */

async function netsh(args) {
  const { stdout } = await run('netsh', args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export async function readConnected() {
  let stdout;
  try {
    stdout = await netsh(['wlan', 'show', 'interfaces']);
  } catch (err) {
    return failure(`netsh failed: ${err.message}`);
  }

  const kv = parseKeyValueBlock(stdout);
  const state = pick(kv, 'state');
  if (state && !/connect/i.test(state)) {
    return failure('not connected to a WiFi network', { interface: pick(kv, 'name') });
  }

  // Newer Windows 11 exposes RSSI directly; older builds only give a percentage.
  const rssiDbm = toNumber(pick(kv, 'rssi'));
  const signalPct = toNumber(pick(kv, 'signal'));
  if (rssiDbm == null && signalPct == null) return failure('no signal reading available');

  const exact = rssiDbm != null;
  const rssi = exact ? rssiDbm : percentToDbm(signalPct);
  const channel = toNumber(pick(kv, 'channel'));

  return reading({
    rssi,
    // netsh reports no noise floor at all, so SNR is genuinely unavailable.
    noise: null,
    snr: null,
    exact,
    signalPercent: signalPct,
    ssid: pick(kv, 'ssid'),
    bssid: pick(kv, 'bssid'),
    channel,
    band: channelToBand(channel),
    phyMode: pick(kv, 'radio type'),
    txRate: toNumber(pick(kv, 'transmit rate (mbps)', 'receive rate (mbps)')),
    security: pick(kv, 'authentication'),
    interface: pick(kv, 'name'),
    source: 'netsh',
  });
}

/**
 * Parses the nested `netsh wlan show networks mode=bssid` layout, where each
 * SSID block owns one or more indented BSSID blocks:
 *
 *   SSID 1 : HomeNet
 *       Authentication : WPA2-Personal
 *       BSSID 1        : 00:11:22:33:44:55
 *            Signal    : 92%
 *            Channel   : 149
 */
export function parseNetworks(text) {
  const networks = [];
  let ssid = null;
  let security = null;
  let current = null;

  const flush = () => {
    if (current) networks.push(current);
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const ssidMatch = /^SSID\s+\d+\s*:\s*(.*)$/i.exec(line);
    if (ssidMatch) {
      flush();
      ssid = ssidMatch[1].trim() || '<hidden>';
      security = null;
      continue;
    }

    const bssidMatch = /^BSSID\s+\d+\s*:\s*(.+)$/i.exec(line);
    if (bssidMatch) {
      flush();
      current = { ssid, bssid: bssidMatch[1].trim(), security };
      continue;
    }

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'authentication') {
      security = value;
      if (current) current.security = value;
    }
    if (!current) continue;

    if (key === 'signal') {
      const pct = toNumber(value);
      current.signalPercent = pct;
      current.rssi = pct == null ? null : percentToDbm(pct);
      current.exact = false;
    } else if (key === 'channel') {
      current.channel = toNumber(value);
      current.band ??= channelToBand(current.channel);
    } else if (key === 'band') {
      current.band = value;
    } else if (key === 'radio type') {
      current.phyMode = value;
    }
  }
  flush();

  return networks.filter((n) => n.bssid);
}

export async function scanAps() {
  let stdout;
  try {
    stdout = await netsh(['wlan', 'show', 'networks', 'mode=bssid']);
  } catch (err) {
    return { ok: false, supported: true, error: `netsh failed: ${err.message}`, networks: [] };
  }
  const networks = parseNetworks(stdout).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  return { ok: true, supported: true, networks, source: 'netsh', exact: false };
}
