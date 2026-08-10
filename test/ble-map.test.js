import test from 'node:test';
import assert from 'node:assert/strict';

import { mapDevice, mapBleDevices, mapScanStatus, mapPermissions } from '../public/js/sources/ble-map.js';

/* ---------- single device ---------- */

test('a device with no name maps to null, not a placeholder', () => {
  const mapped = mapDevice({ address: 'AA:BB:CC:DD:EE:01', rssi: -60, connectable: true });
  assert.equal(mapped.name, null, 'the view decides how to label a nameless device, not the mapper');
});

test('a device with no tx power maps to null, not a fabricated one', () => {
  const mapped = mapDevice({ address: 'AA:BB:CC:DD:EE:02', rssi: -60, name: 'Tile', connectable: true });
  assert.equal(mapped.txPower, null);
});

test('a device carries its measured fields straight through', () => {
  const mapped = mapDevice({
    address: 'AA:BB:CC:DD:EE:03',
    rssi: -42,
    name: 'AirTag',
    txPower: -12,
    connectable: false,
    timestamp: 1712345678000,
  });
  assert.equal(mapped.address, 'AA:BB:CC:DD:EE:03');
  assert.equal(mapped.rssi, -42);
  assert.equal(mapped.name, 'AirTag');
  assert.equal(mapped.txPower, -12);
  assert.equal(mapped.connectable, false);
  assert.equal(mapped.lastSeen, 1712345678000);
});

test('advertised identity (service UUIDs, manufacturer data) is carried through for classification', () => {
  const mapped = mapDevice({
    address: 'AA:BB:CC:DD:EE:05',
    rssi: -50,
    serviceUuids: ['0000feaa-0000-1000-8000-00805f9b34fb'],
    manufacturerId: 0x004c,
    manufacturerData: '1219abcd',
  });
  assert.deepEqual(mapped.serviceUuids, ['0000feaa-0000-1000-8000-00805f9b34fb']);
  assert.equal(mapped.manufacturerId, 0x004c);
  assert.equal(mapped.manufacturerData, '1219abcd');
});

test('a device advertising no identity gets empty/null identity fields, never guesses', () => {
  const mapped = mapDevice({ address: 'AA:BB:CC:DD:EE:06', rssi: -50 });
  assert.deepEqual(mapped.serviceUuids, []);
  assert.equal(mapped.manufacturerId, null);
  assert.equal(mapped.manufacturerData, null);
});

test('no distance field exists anywhere on a mapped device', () => {
  // BLE tx power varies wildly by device, so a metre figure would be
  // invented, not measured -- this is the central rule the whole module
  // exists to enforce. Assert the shape itself carries nothing named it.
  const mapped = mapDevice({ address: 'AA:BB:CC:DD:EE:04', rssi: -50, txPower: -12 });
  assert.ok(!('distance' in mapped));
  assert.ok(!('meters' in mapped));
});

/* ---------- scan snapshot ---------- */

test('an empty scan yields an empty list, not an error', () => {
  const mapped = mapBleDevices({ scanning: true, devices: [] });
  assert.equal(mapped.scanning, true);
  assert.deepEqual(mapped.devices, []);
});

test('a missing or malformed snapshot degrades to an empty, non-scanning result', () => {
  assert.deepEqual(mapBleDevices(null), { scanning: false, devices: [] });
  assert.deepEqual(mapBleDevices(undefined), { scanning: false, devices: [] });
  assert.deepEqual(mapBleDevices({}), { scanning: false, devices: [] });
});

test('devices are sorted loudest first', () => {
  const mapped = mapBleDevices({
    scanning: true,
    devices: [
      { address: 'FAR', rssi: -88 },
      { address: 'NEAR', rssi: -40 },
      { address: 'MID', rssi: -65 },
    ],
  });
  assert.deepEqual(mapped.devices.map((d) => d.address), ['NEAR', 'MID', 'FAR']);
});

test('a device with a null rssi sorts last rather than crashing the comparator', () => {
  const mapped = mapBleDevices({
    scanning: true,
    devices: [
      { address: 'UNKNOWN', rssi: null },
      { address: 'STRONG', rssi: -50 },
    ],
  });
  assert.deepEqual(mapped.devices.map((d) => d.address), ['STRONG', 'UNKNOWN']);
});

/* ---------- scan status: bluetooth-off vs. permission-denied ---------- */

test('a successful start reports ok with nothing else attached', () => {
  assert.deepEqual(mapScanStatus({ ok: true }), { ok: true });
});

test('bluetooth being off is reported as its own fact, not folded into a permission error', () => {
  const mapped = mapScanStatus({ ok: false, error: 'BLUETOOTH_DISABLED' });
  assert.equal(mapped.ok, false);
  assert.equal(mapped.bluetoothOff, true);
  assert.equal(mapped.needsPermission, false);
  assert.match(mapped.error, /BLUETOOTH IS OFF/i);
});

test('a denied permission is reported as its own fact, not folded into a radio-off error', () => {
  const mapped = mapScanStatus({ ok: false, error: 'PERMISSION_DENIED' });
  assert.equal(mapped.ok, false);
  assert.equal(mapped.needsPermission, true);
  assert.equal(mapped.bluetoothOff, false);
  assert.match(mapped.error, /PERMISSION/i);
});

test('an unrecognised error code still produces a readable message, not undefined', () => {
  const mapped = mapScanStatus({ ok: false, error: 'SOMETHING_NEW' });
  assert.equal(mapped.ok, false);
  assert.equal(mapped.code, 'SOMETHING_NEW');
  assert.match(mapped.error, /SCAN FAILED/i);
});

test('a missing status object is treated as a generic scan failure, not a crash', () => {
  const mapped = mapScanStatus(null);
  assert.equal(mapped.ok, false);
  assert.equal(mapped.code, 'SCAN_FAILED');
});

/* ---------- raw permission/adapter facts ---------- */

test('permissions default to the least-permissive reading when the bridge sends nothing', () => {
  assert.deepEqual(mapPermissions(null), {
    bluetoothEnabled: false,
    scanGranted: false,
    connectGranted: false,
  });
});

test('permissions pass real grants through unchanged', () => {
  const mapped = mapPermissions({ bluetoothEnabled: true, scanGranted: true, connectGranted: false });
  assert.equal(mapped.bluetoothEnabled, true);
  assert.equal(mapped.scanGranted, true);
  assert.equal(mapped.connectGranted, false);
});
