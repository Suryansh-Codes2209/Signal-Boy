import test from 'node:test';
import assert from 'node:assert/strict';

import { bleBridge, createBleSource } from '../public/js/sources/ble.js';

/** Stands in for the Kotlin BleBridge @JavascriptInterface object. */
function fakeBridge(overrides = {}) {
  return {
    startScan: () => JSON.stringify({ ok: true }),
    stopScan: () => {},
    results: () => JSON.stringify({ scanning: true, devices: [] }),
    permissions: () => JSON.stringify({ bluetoothEnabled: true, scanGranted: true, connectGranted: true }),
    requestPermissions: () => {},
    ...overrides,
  };
}

test('the BLE bridge is absent in a plain browser', () => {
  assert.equal(bleBridge({}), null);
});

test('the BLE bridge is found when Kotlin has installed it, distinct from the WiFi one', () => {
  const bridge = fakeBridge();
  assert.equal(bleBridge({ SignalBoyBle: bridge }), bridge);
  // A page with only the WiFi bridge (an older APK build, hypothetically)
  // must not be mistaken for one that can also hunt BLE devices.
  assert.equal(bleBridge({ SignalBoyNative: {} }), null);
});

test('starting a scan surfaces bluetooth-off and permission-denied as distinct results', () => {
  const off = createBleSource(fakeBridge({ startScan: () => JSON.stringify({ ok: false, error: 'BLUETOOTH_DISABLED' }) }));
  assert.equal(off.startScan().bluetoothOff, true);

  const denied = createBleSource(fakeBridge({ startScan: () => JSON.stringify({ ok: false, error: 'PERMISSION_DENIED' }) }));
  assert.equal(denied.startScan().needsPermission, true);
});

test('poll maps a snapshot into a sorted device list with names and tx power preserved', () => {
  const bridge = fakeBridge({
    results: () =>
      JSON.stringify({
        scanning: true,
        devices: [
          { address: 'AA:BB:CC:DD:EE:01', rssi: -80, connectable: true },
          { address: 'AA:BB:CC:DD:EE:02', rssi: -40, name: 'Tile', txPower: -12, connectable: false },
        ],
      }),
  });
  const mapped = createBleSource(bridge).poll();

  assert.equal(mapped.scanning, true);
  assert.equal(mapped.devices.length, 2);
  assert.equal(mapped.devices[0].address, 'AA:BB:CC:DD:EE:02', 'strongest signal first');
  assert.equal(mapped.devices[0].name, 'Tile');
  assert.equal(mapped.devices[0].txPower, -12);
  assert.equal(mapped.devices[1].name, null, 'a nameless device stays null, not a placeholder');
});

test('an empty scan snapshot maps to an empty list', () => {
  const mapped = createBleSource(fakeBridge({ results: () => JSON.stringify({ scanning: true, devices: [] }) })).poll();
  assert.deepEqual(mapped.devices, []);
});

test('malformed JSON from the bridge degrades to an empty, non-scanning snapshot rather than throwing', () => {
  const source = createBleSource(fakeBridge({ results: () => 'not json' }));
  assert.doesNotThrow(() => source.poll());
  const mapped = source.poll();
  assert.deepEqual(mapped.devices, []);
  assert.equal(mapped.scanning, false);
});

test('permissions and requestPermissions reach the underlying bridge', () => {
  let requested = false;
  const source = createBleSource(fakeBridge({ requestPermissions: () => (requested = true) }));

  const perms = source.permissions();
  assert.equal(perms.bluetoothEnabled, true);
  assert.equal(perms.scanGranted, true);

  source.requestPermissions();
  assert.equal(requested, true);
});
