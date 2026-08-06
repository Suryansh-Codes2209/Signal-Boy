import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { reading, failure, percentToDbm, channelToBand, toNumber } from './common.js';

const run = promisify(execFile);

/**
 * Linux WiFi backend.
 *
 * /proc/net/wireless is the best source available on any platform: the kernel
 * hands over true dBm with no root and no permission prompt. Neighbour
 * scanning goes through NetworkManager (nmcli), which reports a percentage;
 * `iw scan` would give exact dBm but almost always needs root, so it is not
 * used here.
 */

/** -256 is the conventional "no valid reading" sentinel for the noise column. */
const INVALID_NOISE = -256;

/**
 * Some older drivers report level as an unsigned byte rather than a signed
 * dBm value. A positive level above the plausible dBm range is remapped by
 * subtracting 256; anything else is taken at face value.
 */
function normaliseLevel(level) {
  if (level == null) return null;
  if (level > 0) {
    const shifted = level - 256;
    return shifted >= -120 && shifted <= 0 ? shifted : null;
  }
  return level;
}

export function parseProcNetWireless(text) {
  // Two header lines, then one line per interface.
  for (const line of text.split('\n').slice(2)) {
    const m = /^\s*([\w.-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const cols = m[2].trim().split(/\s+/).map((c) => Number(c.replace(/\.$/, '')));
    const [, link, level, noise] = cols;
    return {
      interface: m[1],
      link: Number.isFinite(link) ? link : null,
      level: normaliseLevel(Number.isFinite(level) ? level : null),
      noise: Number.isFinite(noise) && noise !== INVALID_NOISE ? noise : null,
    };
  }
  return null;
}

/**
 * Splits an `nmcli -t` terse line. nmcli escapes literal colons as "\:", which
 * matters because every BSSID contains five of them.
 */
export function splitTerse(line) {
  const fields = [];
  let buf = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      buf += line[++i];
    } else if (ch === ':') {
      fields.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  fields.push(buf);
  return fields;
}

async function nmcli(args) {
  const { stdout } = await run('nmcli', args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/** Connected-network metadata that /proc cannot provide (SSID, channel, security). */
async function activeNetworkDetails() {
  try {
    const stdout = await nmcli([
      '-t',
      '-f',
      'ACTIVE,SSID,BSSID,SIGNAL,CHAN,RATE,SECURITY',
      'dev',
      'wifi',
    ]);
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [active, ssid, bssid, signal, chan, rate, security] = splitTerse(line);
      if (active !== 'yes') continue;
      return {
        ssid: ssid || null,
        bssid: bssid || null,
        signalPercent: toNumber(signal),
        channel: toNumber(chan),
        txRate: toNumber(rate),
        security: security || null,
      };
    }
  } catch {
    // NetworkManager is not always present; /proc alone is still enough.
  }
  return null;
}

export async function readConnected() {
  let proc = null;
  try {
    proc = parseProcNetWireless(await readFile('/proc/net/wireless', 'utf8'));
  } catch {
    // Fall through to nmcli-only mode.
  }

  const details = await activeNetworkDetails();
  if (!proc?.level && !details?.signalPercent) {
    return failure('no signal reading available (no /proc/net/wireless entry and no active nmcli connection)');
  }

  // Prefer the kernel's exact dBm; fall back to converting nmcli's percentage.
  const exact = proc?.level != null;
  const rssi = exact ? proc.level : percentToDbm(details.signalPercent);
  const noise = proc?.noise ?? null;
  const channel = details?.channel ?? null;

  return reading({
    rssi,
    noise,
    snr: noise == null ? null : rssi - noise,
    exact,
    signalPercent: details?.signalPercent ?? null,
    ssid: details?.ssid ?? null,
    bssid: details?.bssid ?? null,
    channel,
    band: channelToBand(channel),
    txRate: details?.txRate ?? null,
    security: details?.security ?? null,
    interface: proc?.interface ?? null,
    source: exact ? '/proc/net/wireless' : 'nmcli',
  });
}

export async function scanAps() {
  let stdout;
  try {
    stdout = await nmcli(['-t', '-f', 'SSID,BSSID,SIGNAL,CHAN,SECURITY', 'dev', 'wifi', 'list']);
  } catch (err) {
    return {
      ok: false,
      supported: true,
      error: `nmcli unavailable (${err.message}). Neighbour scanning needs NetworkManager.`,
      networks: [],
    };
  }

  const networks = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [ssid, bssid, signal, chan, security] = splitTerse(line);
    if (!bssid) continue;
    const pct = toNumber(signal);
    const channel = toNumber(chan);
    networks.push({
      ssid: ssid || '<hidden>',
      bssid,
      signalPercent: pct,
      rssi: pct == null ? null : percentToDbm(pct),
      exact: false,
      channel,
      band: channelToBand(channel),
      security: security || null,
    });
  }

  networks.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  return { ok: true, supported: true, networks, source: 'nmcli', exact: false };
}
