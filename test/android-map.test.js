import test from 'node:test';
import assert from 'node:assert/strict';

import {
  frequencyToBand,
  frequencyToChannel,
  wifiStandardToPhyMode,
  cleanSsid,
  cleanBssid,
  mapConnected,
  mapScanResults,
} from '../public/js/sources/android-map.js';
import { reading } from '../server/platform/wifi/common.js';

/* ---------- frequency ---------- */

test('frequency maps onto the three bands', () => {
  assert.equal(frequencyToBand(2412), '2.4GHz');
  assert.equal(frequencyToBand(2484), '2.4GHz');
  assert.equal(frequencyToBand(5180), '5GHz');
  assert.equal(frequencyToBand(5895), '5GHz');
  assert.equal(frequencyToBand(6115), '6GHz');
  assert.equal(frequencyToBand(null), null);
  assert.equal(frequencyToBand(1000), null);
});

test('frequency maps onto channel numbers, including the two irregular ones', () => {
  assert.equal(frequencyToChannel(2412), 1);
  assert.equal(frequencyToChannel(2437), 6);
  // Channel 14 breaks the 5MHz spacing and needs its own case.
  assert.equal(frequencyToChannel(2484), 14);
  assert.equal(frequencyToChannel(5180), 36);
  assert.equal(frequencyToChannel(5955), 1);
  // 6GHz channel 2 sits below the band's base frequency, also a special case.
  assert.equal(frequencyToChannel(5935), 2);
  assert.equal(frequencyToChannel(null), null);
});

test('frequencies in the 5925-5954 6GHz gap yield no channel, not a negative or zero one', () => {
  // 6GHz channel 1 is centred at 5955 (5950 + 5*1); nothing below that is a
  // real channel even though frequencyToBand still calls it 6GHz.
  for (const mhz of [5925, 5940, 5949, 5950, 5954]) {
    assert.equal(frequencyToChannel(mhz), null, `${mhz}MHz must not produce a channel`);
  }
  assert.equal(frequencyToBand(5950), '6GHz');
});

/* ---------- PHY mode ---------- */

test('wifi standard codes map onto readable PHY modes', () => {
  assert.equal(wifiStandardToPhyMode(4), '802.11N');
  assert.equal(wifiStandardToPhyMode(5), '802.11AC');
  assert.equal(wifiStandardToPhyMode(6), '802.11AX');
  assert.equal(wifiStandardToPhyMode(8), '802.11BE');
});

test('an unknown or absent wifi standard is null, never a guess', () => {
  // 0 is WIFI_STANDARD_UNKNOWN; null is what pre-API-30 devices report.
  assert.equal(wifiStandardToPhyMode(0), null);
  assert.equal(wifiStandardToPhyMode(null), null);
  assert.equal(wifiStandardToPhyMode(99), null);
});

/* ---------- permission redaction ---------- */

test('ssid quotes are stripped and the redaction sentinel becomes null', () => {
  assert.equal(cleanSsid('"HOME-5G"'), 'HOME-5G');
  assert.equal(cleanSsid('<unknown ssid>'), null);
  assert.equal(cleanSsid('"<unknown ssid>"'), null);
  assert.equal(cleanSsid(null), null);
});

test('the redacted bssid becomes null rather than a fake address', () => {
  assert.equal(cleanBssid('a4:2b:8c:00:11:22'), 'a4:2b:8c:00:11:22');
  assert.equal(cleanBssid('02:00:00:00:00:00'), null);
  assert.equal(cleanBssid(null), null);
});

/* ---------- connected reading ---------- */

const RAW_CONNECTED = {
  connected: true,
  rssi: -58,
  frequency: 5180,
  linkSpeed: 780,
  ssid: '"HOME-5G"',
  bssid: 'a4:2b:8c:00:11:22',
  wifiStandard: 6,
};

test('a connected reading produces every key of the canonical shape', () => {
  const mapped = mapConnected(RAW_CONNECTED);
  for (const key of Object.keys(reading({}))) {
    assert.ok(key in mapped, `mapped reading is missing "${key}"`);
  }
});

test('a connected reading carries the measured values through', () => {
  const mapped = mapConnected(RAW_CONNECTED);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.rssi, -58);
  assert.equal(mapped.exact, true);
  assert.equal(mapped.ssid, 'HOME-5G');
  assert.equal(mapped.channel, 36);
  assert.equal(mapped.band, '5GHz');
  assert.equal(mapped.phyMode, '802.11AX');
  assert.equal(mapped.txRate, 780);
  assert.equal(mapped.platform, 'androidApp');
});

test('android never reports a noise floor or an SNR', () => {
  const mapped = mapConnected(RAW_CONNECTED);
  assert.equal(mapped.noise, null);
  assert.equal(mapped.snr, null);
});

test('a denied location permission redacts identity but keeps the signal', () => {
  const mapped = mapConnected({
    ...RAW_CONNECTED,
    ssid: '<unknown ssid>',
    bssid: '02:00:00:00:00:00',
  });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.rssi, -58, 'dBm needs no permission and must survive');
  assert.equal(mapped.ssid, null);
  assert.equal(mapped.bssid, null);
});

test('a disconnected radio is a failure, not a zero reading', () => {
  // WifiManager reports rssi -127 when not associated; the bridge separately
  // reports connected: false via ConnectivityManager. Either guard alone
  // must be enough to fail the reading.
  const mapped = mapConnected({ connected: false, rssi: -127, frequency: -1 });
  assert.equal(mapped.ok, false);
  assert.match(mapped.error, /NOT CONNECTED/i);
});

// Regression guard: WifiInfo.getNetworkId() always returns INVALID_NETWORK_ID
// (-1) for apps targeting API 33+, regardless of actual association. An
// earlier version of mapConnected() keyed "not connected" off that field,
// which meant every reading on a modern targetSdk reported disconnected
// forever even with a real, valid RSSI. The bridge no longer sends
// networkId at all -- this asserts a good reading maps to ok: true on its
// own, with nothing named networkId anywhere in the input.
test('a connected reading maps to ok: true even with no networkId field present', () => {
  const mapped = mapConnected({ ...RAW_CONNECTED, connected: true });
  assert.ok(!('networkId' in RAW_CONNECTED), 'fixture must not carry networkId');
  assert.equal(mapped.ok, true);
  assert.equal(mapped.rssi, -58);
});

/* ---------- scan results ---------- */

test('scan results map to the shape the daemon backends already return', () => {
  const mapped = mapScanResults({
    ok: true,
    results: [
      { ssid: 'FAR', bssid: 'aa:bb:cc:00:00:01', level: -81, frequency: 2412, capabilities: '[WPA2-PSK-CCMP][ESS]' },
      // Real ScanResult.capabilities for WPA3-SAE, per AOSP -- there is no
      // "[WPA3-SAE]" flag anywhere in the platform.
      { ssid: 'NEAR', bssid: 'aa:bb:cc:00:00:02', level: -42, frequency: 5180, capabilities: '[RSN-SAE-CCMP][ESS][MFPR][MFPC]' },
    ],
  });

  assert.equal(mapped.ok, true);
  assert.equal(mapped.supported, true);
  assert.equal(mapped.exact, true, 'android reports true dBm per AP, unlike netsh');
  assert.equal(mapped.source, 'WifiManager.getScanResults()');
  assert.deepEqual(mapped.networks.map((n) => n.ssid), ['NEAR', 'FAR'], 'sorted by signal descending');
  assert.equal(mapped.networks[0].rssi, -42);
  assert.equal(mapped.networks[0].channel, 36);
  assert.equal(mapped.networks[0].band, '5GHz');
  // parseSecurity takes the first flag that isn't an infra marker
  // (ESS/IBSS/WPS/RSN exactly) -- "RSN-SAE-CCMP" does not match that
  // allowlist as a whole flag, so it is what the mapper actually returns.
  assert.equal(mapped.networks[0].security, 'RSN-SAE-CCMP');
});

test('a scan result with a missing frequency yields no channel or band, not a fabricated one', () => {
  const mapped = mapScanResults({
    ok: true,
    results: [
      { ssid: 'NOFREQ', bssid: 'aa:bb:cc:00:00:04', level: -70, frequency: null, capabilities: '[ESS]' },
    ],
  });
  assert.equal(mapped.networks[0].channel, null);
  assert.equal(mapped.networks[0].band, null);
});

test('a hidden network keeps its bssid and reports a null ssid', () => {
  const mapped = mapScanResults({
    ok: true,
    results: [{ ssid: '', bssid: 'aa:bb:cc:00:00:03', level: -60, frequency: 2412, capabilities: '[ESS]' }],
  });
  assert.equal(mapped.networks[0].ssid, null);
  assert.equal(mapped.networks[0].bssid, 'aa:bb:cc:00:00:03');
  assert.equal(mapped.networks[0].security, 'OPEN');
});

test('a throttled scan reports how long is left and returns no networks', () => {
  const mapped = mapScanResults({ ok: false, throttled: true, retryInMs: 47000 });
  assert.equal(mapped.ok, false);
  assert.equal(mapped.supported, true);
  assert.equal(mapped.retryInMs, 47000);
  assert.match(mapped.error, /THROTTLED/i);
  assert.deepEqual(mapped.networks, []);
});

test('a missing permission is reported as a permission problem, not a scan failure', () => {
  const mapped = mapScanResults({ ok: false, permissionDenied: true });
  assert.equal(mapped.ok, false);
  assert.equal(mapped.supported, true);
  assert.match(mapped.error, /PERMISSION/i);
});
