/**
 * Shared helpers for the per-OS WiFi backends. Every backend returns the same
 * normalised reading shape so nothing downstream needs to know which OS it is
 * running on.
 */

/**
 * Canonical reading shape produced by every backend.
 *
 * `exact` records whether rssi came from hardware in dBm (macOS, Linux, newer
 * Windows) or was derived from a signal percentage (older Windows, nmcli).
 * The UI prefixes approximated values with "~" rather than pretending they are
 * measurements.
 */
export function reading(fields) {
  return {
    ok: true,
    rssi: null,
    noise: null,
    snr: null,
    exact: true,
    ssid: null,
    bssid: null,
    channel: null,
    band: null,
    width: null,
    phyMode: null,
    txRate: null,
    security: null,
    interface: null,
    source: null,
    ...fields,
  };
}

export function failure(error, extra = {}) {
  return { ok: false, error, ...extra };
}

/**
 * Windows and nmcli both report signal as a 0-100 quality percentage. The
 * accepted linear mapping is dBm = pct/2 - 100, spanning -100 dBm at 0% to
 * -50 dBm at 100%. It is an approximation, not a measurement.
 */
export function percentToDbm(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  return clamped / 2 - 100;
}

/** Inverse of percentToDbm, for platforms that want a bar percentage back. */
export function dbmToPercent(dbm) {
  return Math.max(0, Math.min(100, (dbm + 100) * 2));
}

/** Channel numbers are unambiguous across bands, so band can be inferred. */
export function channelToBand(channel) {
  if (channel == null) return null;
  if (channel >= 1 && channel <= 14) return '2.4GHz';
  if (channel >= 32 && channel <= 177) return '5GHz';
  if (channel > 177) return '6GHz';
  return null;
}

/**
 * Parses "Key : Value" console output (netsh, and similar) into a Map keyed by
 * the lowercased key. Values containing colons -- MAC addresses especially --
 * are preserved by splitting only on the first separator.
 */
export function parseKeyValueBlock(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) out.set(key, value);
  }
  return out;
}

/** First key present in the map, so localised console output can list aliases. */
export function pick(map, ...keys) {
  for (const key of keys) {
    const value = map.get(key.toLowerCase());
    if (value !== undefined && value !== '') return value;
  }
  return null;
}

export function toNumber(value) {
  if (value == null) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(String(value));
  return m ? Number(m[0]) : null;
}
