import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TECHNOLOGIES,
  AVAILABILITY,
  CONFIDENCE,
  mapCapabilities,
  formatMetres,
  normalizeResult,
  mapRangeResults,
  mapRangePermissions,
  mapSessionStatus,
} from '../public/js/sources/range-map.js';

// The platform's own constants, spelled out so a drift in android.ranging is a
// test failure here rather than a silently mislabelled reading on screen.
const UWB = 0;
const BLE_CS = 1;
const WIFI_NAN_RTT = 2;
const BLE_RSSI = 3;

const NOT_SUPPORTED = 0;
const DISABLED_USER = 1;
const DISABLED_REGULATORY = 2;
const ENABLED = 3;

test('technology codes match android.ranging.RangingManager', () => {
  const byId = Object.fromEntries(TECHNOLOGIES.map((t) => [t.id, t.code]));
  assert.deepEqual(byId, { UWB, BLE_CS, WIFI_NAN_RTT, BLE_RSSI });
});

test('BLE RSSI ranging is the only technology flagged as derived', () => {
  // The whole point of the derived flag: three of these time or phase-compare a
  // signal, one estimates from strength. If this flips, the app starts giving an
  // RSSI guess the same authority as a UWB measurement.
  assert.deepEqual(TECHNOLOGIES.filter((t) => t.derived).map((t) => t.id), ['BLE_RSSI']);
});

test('only UWB claims a bearing', () => {
  assert.deepEqual(TECHNOLOGIES.filter((t) => t.bearing).map((t) => t.id), ['UWB']);
});

test('only ENABLED counts as available', () => {
  // A availability code that reads as available by accident would put a dead
  // technology in front of a live one when picking `best`.
  const available = Object.entries(AVAILABILITY)
    .filter(([, v]) => v.available)
    .map(([k]) => Number(k));
  assert.deepEqual(available, [ENABLED]);
});

test('mapCapabilities reports an unsupported platform with readable copy', () => {
  const result = mapCapabilities({ supported: false, error: 'REQUIRES_ANDROID_16' });
  assert.equal(result.supported, false);
  assert.equal(result.error, 'RANGING NEEDS ANDROID 16 OR NEWER.');
  assert.deepEqual(result.technologies, []);
  assert.equal(result.best, null);
});

test('mapCapabilities distinguishes "still reading" from "cannot do it"', () => {
  // The first call after boot arrives before the async capabilities callback.
  // An empty technology list would otherwise read as a phone that can do nothing.
  assert.equal(mapCapabilities({ supported: false, error: 'CAPABILITIES_PENDING' }).error, 'READING RANGING CAPABILITIES...');
});

test('mapCapabilities defaults a missing payload to unavailable, never to available', () => {
  for (const input of [null, undefined, {}, { supported: 'yes' }]) {
    assert.equal(mapCapabilities(input).supported, false);
  }
});

test('mapCapabilities orders technologies most-precise-first regardless of payload order', () => {
  const result = mapCapabilities({
    supported: true,
    technologies: [
      { id: BLE_RSSI, availability: ENABLED },
      { id: UWB, availability: ENABLED },
      { id: WIFI_NAN_RTT, availability: NOT_SUPPORTED },
    ],
  });
  assert.deepEqual(result.technologies.map((t) => t.id), ['UWB', 'WIFI_NAN_RTT', 'BLE_RSSI']);
});

test('mapCapabilities keeps why a technology is unavailable, not just that it is', () => {
  const result = mapCapabilities({
    supported: true,
    technologies: [
      { id: UWB, availability: NOT_SUPPORTED },
      { id: BLE_CS, availability: DISABLED_USER },
      { id: WIFI_NAN_RTT, availability: DISABLED_REGULATORY },
    ],
  });
  const [uwb, cs, rtt] = result.technologies;
  // Only one of these is worth walking to Settings for, and the view can only
  // say which if the reason survives the mapping.
  assert.equal(uwb.reason, 'NOT_SUPPORTED');
  assert.equal(cs.reason, 'DISABLED_USER');
  assert.equal(cs.unavailableDetail, 'Switched off in Settings.');
  assert.equal(rtt.reason, 'DISABLED_REGULATORY');
});

test('mapCapabilities treats an unrecognised availability code as unavailable', () => {
  const result = mapCapabilities({ supported: true, technologies: [{ id: UWB, availability: 99 }] });
  assert.equal(result.technologies[0].available, false);
  assert.equal(result.technologies[0].reason, 'UNKNOWN');
  assert.equal(result.best, null);
});

test('mapCapabilities prefers a measured technology over an available derived one', () => {
  const result = mapCapabilities({
    supported: true,
    technologies: [
      { id: BLE_RSSI, availability: ENABLED },
      { id: BLE_CS, availability: ENABLED },
    ],
  });
  assert.equal(result.best.id, 'BLE_CS', 'a timed technology outranks an RSSI estimate');
});

test('mapCapabilities falls back to a derived technology only when nothing better is available', () => {
  const result = mapCapabilities({
    supported: true,
    technologies: [
      { id: UWB, availability: NOT_SUPPORTED },
      { id: BLE_RSSI, availability: ENABLED },
    ],
  });
  assert.equal(result.best.id, 'BLE_RSSI');
  assert.equal(result.best.derived, true, 'and it still arrives flagged');
});

test('mapCapabilities picks no best when every technology is present but off', () => {
  const result = mapCapabilities({
    supported: true,
    technologies: [
      { id: UWB, availability: NOT_SUPPORTED },
      { id: BLE_CS, availability: DISABLED_USER },
    ],
  });
  assert.equal(result.best, null);
  assert.equal(result.technologies.length, 2, 'they are still listed, so the view can say why');
});

test('mapCapabilities drops a technology code the table does not vouch for', () => {
  const result = mapCapabilities({
    supported: true,
    technologies: [{ id: UWB, availability: ENABLED }, { id: 77, availability: ENABLED }],
  });
  assert.deepEqual(result.technologies.map((t) => t.id), ['UWB']);
});

test('formatMetres quotes only the precision the technology earned', () => {
  assert.equal(formatMetres(3.4217, UWB), '3.42 M');
  assert.equal(formatMetres(3.4217, WIFI_NAN_RTT), '3.4 M');
  // An RSSI estimate gets whole metres: decimals would dress a guess as a fix.
  assert.equal(formatMetres(3.4217, BLE_RSSI), '3 M');
});

test('formatMetres returns null for a missing or non-finite reading', () => {
  for (const v of [null, undefined, NaN, Infinity]) assert.equal(formatMetres(v, UWB), null);
});

test('normalizeResult keeps a UWB bearing, its elevation and its confidence', () => {
  const result = normalizeResult({
    peerId: 'AA:BB:CC:DD:EE:FF',
    metres: 4.5,
    confidence: 2,
    technology: UWB,
    azimuth: -12.5,
    elevation: 3,
    timestamp: 1000,
  });
  assert.equal(result.bearing, -12.5);
  assert.equal(result.elevation, 3);
  assert.equal(result.confidence, CONFIDENCE[2]);
  assert.equal(result.derived, false);
  assert.equal(result.label, '4.50 M');
});

test('normalizeResult discards an azimuth from a technology that cannot measure one', () => {
  // Channel Sounding reports distance but no angle. A stray azimuth on that
  // payload must not reach the radar, which would draw it as a real direction.
  const result = normalizeResult({ peerId: 'p', metres: 2, technology: BLE_CS, azimuth: 90, elevation: 5 });
  assert.equal(result.bearing, null);
  assert.equal(result.elevation, null);
});

test('normalizeResult carries provenance per sample, not per session', () => {
  const fallback = normalizeResult({ peerId: 'p', metres: 6, technology: BLE_RSSI });
  assert.equal(fallback.derived, true, 'a mid-session fallback to RSSI must be visible');
  assert.equal(fallback.technologyLabel, 'BLE RSSI');
});

test('normalizeResult treats an unknown technology as derived', () => {
  const result = normalizeResult({ peerId: 'p', metres: 1, technology: 77 });
  assert.equal(result.derived, true, 'the cautious default, so nothing unvetted reads as measured');
  assert.equal(result.technology, null);
});

test('normalizeResult does not carry a dropped sample forward', () => {
  const result = normalizeResult({ peerId: 'p', metres: null, technology: UWB });
  assert.equal(result.metres, null);
  assert.equal(result.label, null);
  assert.equal(result.peerId, 'p', 'the peer is still known, only its fix is missing');
});

test('mapRangeResults sorts peers nearest-first and sinks peers with no fix', () => {
  const result = mapRangeResults({
    running: true,
    peers: [
      { peerId: 'far', metres: 12.0, technology: BLE_CS },
      { peerId: 'lost', metres: null, technology: BLE_CS },
      { peerId: 'near', metres: 1.5, technology: BLE_CS },
    ],
  });
  assert.deepEqual(result.peers.map((p) => p.peerId), ['near', 'far', 'lost']);
  assert.equal(result.peers.length, 3, 'a quiet peer is kept, because its silence is information');
});

test('a peer that cannot range reads as a fact about the peer, not a failure', () => {
  // This is the expected outcome for most of HUNT's list: an AirTag-class
  // tracker has no Channel Sounding radio to answer with.
  const result = mapRangeResults({ running: false, error: 'PEER_CANNOT_RANGE' });
  assert.equal(result.error, 'THIS DEVICE CANNOT BE RANGED -- ITS RADIO DOES NOT ANSWER.');
});

test('mapRangeResults on a missing payload is empty, not a crash', () => {
  for (const input of [null, undefined, {}]) {
    const result = mapRangeResults(input);
    assert.equal(result.running, false);
    assert.deepEqual(result.peers, []);
  }
});

test('mapSessionStatus separates a fixable denial from an unfixable OS version', () => {
  // Only one of these is worth showing a GRANT button for; offering one for the
  // other would be a button that can never succeed.
  const denied = mapSessionStatus({ ok: false, error: 'PERMISSION_DENIED' });
  assert.equal(denied.needsPermission, true);
  assert.equal(denied.needsNewerAndroid, false);

  const tooOld = mapSessionStatus({ ok: false, error: 'REQUIRES_ANDROID_16' });
  assert.equal(tooOld.needsPermission, false);
  assert.equal(tooOld.needsNewerAndroid, true);
});

test('mapSessionStatus reports a clean start with nothing to act on', () => {
  const ok = mapSessionStatus({ ok: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.error, null);
  assert.equal(ok.needsPermission, false);
});

test('mapSessionStatus defaults an unparseable or missing answer to failure', () => {
  for (const input of [null, undefined, {}, { ok: 'yes' }]) {
    assert.equal(mapSessionStatus(input).ok, false);
  }
  assert.equal(mapSessionStatus({ ok: false, error: 'NO_PEER' }).error, 'NO DEVICE SELECTED TO RANGE.');
});

test('mapRangePermissions grants only when the API, the grant and the connect grant all hold', () => {
  assert.equal(mapRangePermissions({ apiSupported: true, ranging: true, bluetoothConnect: true }).granted, true);
  assert.equal(mapRangePermissions({ apiSupported: false, ranging: true, bluetoothConnect: true }).granted, false);
  assert.equal(mapRangePermissions({ apiSupported: true, ranging: false, bluetoothConnect: true }).granted, false);
  assert.equal(mapRangePermissions(null).granted, false);
});
