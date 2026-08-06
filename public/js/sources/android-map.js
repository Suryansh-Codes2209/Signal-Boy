/**
 * Raw Android values in, canonical Signal Boy readings out.
 *
 * The Kotlin bridge deliberately performs no interpretation -- it hands over
 * WifiInfo and ScanResult fields exactly as the platform reports them. All the
 * conversion lives here instead, because a pure JS module is covered by
 * `node --test` against captured payloads, while the same logic in Kotlin would
 * need Robolectric or a device.
 *
 * Output matches reading() in server/platform/wifi/common.js exactly, so the
 * views cannot tell an Android reading from a macOS one.
 */

/** WifiManager.UNKNOWN_SSID, returned when the location grant is missing. */
export const REDACTED_SSID = '<unknown ssid>';
/** WifiInfo returns this fixed address rather than the real BSSID when redacted. */
export const REDACTED_BSSID = '02:00:00:00:00:00';

/** ScanResult.WIFI_STANDARD_* -> label. Unlisted codes stay null rather than guessing. */
const PHY_MODES = {
  1: '802.11A/B/G',
  4: '802.11N',
  5: '802.11AC',
  6: '802.11AX',
  7: '802.11AD',
  8: '802.11BE',
};

export function frequencyToBand(mhz) {
  if (mhz == null || mhz <= 0) return null;
  if (mhz >= 2401 && mhz <= 2495) return '2.4GHz';
  if (mhz >= 5150 && mhz <= 5895) return '5GHz';
  if (mhz >= 5925 && mhz <= 7125) return '6GHz';
  return null;
}

export function frequencyToChannel(mhz) {
  if (mhz == null || mhz <= 0) return null;
  // Channel 14 sits 12MHz above channel 13 instead of the usual 5, and 6GHz
  // channel 2 sits below its band's base. Both break the arithmetic, so they
  // must be checked before the ranges below.
  if (mhz === 2484) return 14;
  if (mhz === 5935) return 2;
  if (mhz >= 2401 && mhz <= 2483) return Math.round((mhz - 2407) / 5);
  if (mhz >= 5150 && mhz <= 5895) return Math.round((mhz - 5000) / 5);
  if (mhz >= 5925 && mhz <= 7125) return Math.round((mhz - 5950) / 5);
  return null;
}

export function wifiStandardToPhyMode(code) {
  if (code == null) return null;
  return PHY_MODES[code] ?? null;
}

export function cleanSsid(raw) {
  if (raw == null) return null;
  const unquoted = String(raw).replace(/^"(.*)"$/s, '$1').trim();
  if (!unquoted || unquoted === REDACTED_SSID) return null;
  return unquoted;
}

export function cleanBssid(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value || value === REDACTED_BSSID) return null;
  return value;
}

/**
 * ScanResult.capabilities is a bracketed flag string like
 * "[WPA2-PSK-CCMP][WPS][ESS]". The first flag that is not an infrastructure
 * marker is the security mode; nothing left means an open network.
 */
function parseSecurity(capabilities) {
  if (!capabilities) return 'OPEN';
  const flags = [...String(capabilities).matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  const security = flags.find((f) => !/^(ESS|IBSS|WPS|RSN)$/i.test(f));
  return security ? security.toUpperCase() : 'OPEN';
}

export function mapConnected(raw) {
  // WifiManager reports rssi -127 with networkId -1 when the radio is on but
  // not associated. Reporting that as a reading would draw a real-looking bar.
  if (!raw || raw.networkId === -1 || raw.rssi == null || raw.rssi <= -127) {
    return { ok: false, error: 'NOT CONNECTED TO A NETWORK', platform: 'androidApp' };
  }

  const frequency = raw.frequency ?? null;

  return {
    ok: true,
    rssi: raw.rssi,
    // AOSP exposes no noise floor, so SNR cannot be derived. Both stay null and
    // the UI prints the reason from the capability matrix.
    noise: null,
    snr: null,
    exact: true,
    ssid: cleanSsid(raw.ssid),
    bssid: cleanBssid(raw.bssid),
    channel: frequencyToChannel(frequency),
    band: frequencyToBand(frequency),
    width: null,
    phyMode: wifiStandardToPhyMode(raw.wifiStandard ?? null),
    txRate: raw.linkSpeed ?? null,
    security: null,
    interface: 'wlan0',
    source: 'WifiManager.getConnectionInfo()',
    platform: 'androidApp',
  };
}

export function mapScanResults(raw) {
  const base = { supported: true, networks: [], source: 'WifiManager.getScanResults()', exact: true };

  if (!raw || raw.ok !== true) {
    if (raw?.permissionDenied) {
      return { ...base, ok: false, error: 'NEEDS LOCATION PERMISSION TO LIST NEARBY NETWORKS' };
    }
    if (raw?.throttled) {
      return { ...base, ok: false, error: 'THROTTLED BY ANDROID', retryInMs: raw.retryInMs ?? null };
    }
    return { ...base, ok: false, error: raw?.error ?? 'SCAN FAILED' };
  }

  const networks = (raw.results ?? [])
    .map((r) => ({
      ssid: cleanSsid(r.ssid),
      bssid: cleanBssid(r.bssid),
      rssi: r.level ?? null,
      channel: frequencyToChannel(r.frequency),
      band: frequencyToBand(r.frequency),
      security: parseSecurity(r.capabilities),
      exact: true,
    }))
    .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));

  return { ...base, ok: true, networks };
}
