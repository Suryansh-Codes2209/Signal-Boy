import test from 'node:test';
import assert from 'node:assert/strict';

import { nativeBridge, createNativeSource } from '../public/js/sources/native.js';
import { PLATFORMS } from '../public/js/core/platforms.js';

/** Stands in for the Kotlin @JavascriptInterface object. */
function fakeBridge(overrides = {}) {
  return {
    intervalMs: () => 1000,
    permissions: () => JSON.stringify({ location: true, nearbyDevices: true }),
    requestPermissions: () => {},
    scan: () => JSON.stringify({ ok: true, results: [] }),
    ...overrides,
  };
}

test('the bridge is absent in a plain browser', () => {
  assert.equal(nativeBridge({}), null);
});

test('the bridge is found when Kotlin has installed it', () => {
  const bridge = fakeBridge();
  assert.equal(nativeBridge({ SignalBoyNative: bridge }), bridge);
});

test('a pushed reading reaches wifi subscribers filtered and graded', () => {
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const seen = [];
  source.on('wifi', (r) => seen.push(r));
  source.connect();

  scope.__signalboyPush(JSON.stringify({ rssi: -58, frequency: 5180, linkSpeed: 780 }));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].rssi, -58, 'the measured value is preserved');
  assert.equal(typeof seen[0].filtered, 'number', 'the Kalman estimate is added client-side');
  assert.equal(typeof seen[0].smoothed, 'number');
  assert.equal(typeof seen[0].quality, 'number');
  assert.ok(seen[0].qualityBand, 'the reading is graded');
});

test('the filter converges towards the true value across repeated pushes', () => {
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const seen = [];
  source.on('wifi', (r) => seen.push(r));
  source.connect();

  for (let i = 0; i < 40; i += 1) {
    scope.__signalboyPush(JSON.stringify({ rssi: -60, frequency: 2412 }));
  }

  const last = seen.at(-1).filtered;
  assert.ok(Math.abs(last - -60) < 1, `expected the estimate to settle near -60, got ${last}`);
});

test('state goes live on the first reading and errors when the radio drops', () => {
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const states = [];
  source.onStateChange((s) => states.push(s));
  source.connect();

  assert.equal(states[0], 'connecting');

  scope.__signalboyPush(JSON.stringify({ rssi: -58, frequency: 5180 }));
  assert.equal(states.at(-1), 'live');

  scope.__signalboyPush(JSON.stringify({ rssi: -127 }));
  assert.equal(states.at(-1), 'error', 'a disconnected radio is not a live reading');
});

test('a failed reading resets the filter so it cannot carry a stale estimate back', () => {
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const seen = [];
  source.on('wifi', (r) => seen.push(r));
  source.connect();

  for (let i = 0; i < 20; i += 1) {
    scope.__signalboyPush(JSON.stringify({ rssi: -40, frequency: 5180 }));
  }
  scope.__signalboyPush(JSON.stringify({ rssi: -127 }));
  scope.__signalboyPush(JSON.stringify({ rssi: -85, frequency: 5180 }));

  const resumed = seen.at(-1).filtered;
  assert.ok(resumed < -70, `estimate should restart near -85, not drift down from -40 (got ${resumed})`);
});

test('platform info is served locally, with the app as the host', async () => {
  const source = createNativeSource(fakeBridge(), {});
  const info = await source.loadPlatform();

  assert.equal(info.host, 'androidApp');
  assert.equal(info.label, 'ANDROID APP');
  assert.equal(info.detected, 'androidApp');
  assert.equal(info.forced, false);
  assert.ok(info.matrix.length > 0);
  assert.ok(info.platforms.androidApp);
});

test('the app reports itself able to read rssi, unlike android in a browser', () => {
  // Getting these two confused would grey out a meter that works perfectly.
  assert.equal(PLATFORMS.androidApp.capabilities.connectedRssi.support, 'full');
  assert.equal(PLATFORMS.android.capabilities.connectedRssi.support, 'none');
});

test('a scan request goes through the bridge and comes back mapped', async () => {
  const bridge = fakeBridge({
    scan: () =>
      JSON.stringify({
        ok: true,
        results: [{ ssid: '"NEAR"', bssid: 'aa:bb:cc:00:00:02', level: -42, frequency: 5180, capabilities: '[ESS]' }],
      }),
  });
  const source = createNativeSource(bridge, {});
  const result = await source.requestScan();

  assert.equal(result.ok, true);
  assert.equal(result.networks.length, 1);
  assert.equal(result.networks[0].ssid, 'NEAR');
});

test('a bridge that throws surfaces as an error rather than crashing the view', async () => {
  const bridge = fakeBridge({
    scan: () => {
      throw new Error('binder died');
    },
  });
  const result = await createNativeSource(bridge, {}).requestScan();

  assert.equal(result.ok, false);
  assert.match(result.error, /binder died/i);
});

test('malformed JSON from the bridge is ignored rather than thrown', () => {
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const seen = [];
  source.on('wifi', (r) => seen.push(r));
  source.connect();

  assert.doesNotThrow(() => scope.__signalboyPush('not json'));
  assert.equal(seen.length, 0);
});

test('the bridge contract is a JSON string: the literal text Kotlin emits reaches a reading', () => {
  // Not JSON.stringify(...) here -- that's what every other test does, and it
  // is exactly the gap that let MainActivity's bare `$json` interpolation ship:
  // evaluateJavascript("window.__signalboyPush($json)", null) hands JavaScript
  // an object *literal*, not this string. This test pushes the literal source
  // text MainActivity.kt evaluates once JSONObject.quote() wraps the payload,
  // i.e. what __signalboyPush actually receives as its argument on-device.
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const seen = [];
  source.on('wifi', (r) => seen.push(r));
  source.connect();

  scope.__signalboyPush('{"connected":true,"rssi":-58,"frequency":5180}');

  assert.equal(seen.length, 1, 'the JSON string must parse into exactly one reading');
  assert.equal(seen[0].rssi, -58);
});

test('the bridge contract rejects an object: pushing one produces no reading', () => {
  // The other half of the same pin. If a future change reintroduces bare
  // interpolation, __signalboyPush starts receiving object literals again --
  // JSON.parse(anObject) calls String(anObject), yields "[object Object]",
  // throws, and parse() swallows it. This must stay silent-and-empty, not
  // silently succeed, or the regression above would stop being a regression.
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const seen = [];
  source.on('wifi', (r) => seen.push(r));
  source.connect();

  scope.__signalboyPush({ connected: true, rssi: -58, frequency: 5180 });

  assert.equal(seen.length, 0, 'an object is not the bridge contract and must not yield a reading');
});
