import test from 'node:test';
import assert from 'node:assert/strict';

import { shortUuid, classifyBeacon } from '../public/js/sources/beacon-classify.js';

const EDDYSTONE = '0000feaa-0000-1000-8000-00805f9b34fb';
const EXPOSURE = '0000fd6f-0000-1000-8000-00805f9b34fb';
const TILE = '0000feed-0000-1000-8000-00805f9b34fb';

test('shortUuid pulls the 16-bit id out of a full base UUID and passes a short one through', () => {
  assert.equal(shortUuid(EDDYSTONE), 'feaa');
  assert.equal(shortUuid('FEAA'), 'feaa');
  assert.equal(shortUuid(null), null);
});

test('an Eddystone service UUID classifies as a beacon', () => {
  const c = classifyBeacon({ serviceUuids: [EDDYSTONE] });
  assert.equal(c.category, 'beacon');
  assert.match(c.label, /EDDYSTONE/);
});

test('an exposure-notification UUID classifies as a phone, not a tracker', () => {
  const c = classifyBeacon({ serviceUuids: [EXPOSURE] });
  assert.equal(c.category, 'phone');
  assert.match(c.label, /EXPOSURE/);
});

test('a Tile service UUID classifies as a tracker', () => {
  const c = classifyBeacon({ serviceUuids: [TILE] });
  assert.equal(c.category, 'tracker');
  assert.match(c.label, /TILE/);
});

test('Apple Find My manufacturer data classifies as an AirTag-class tracker', () => {
  // Company 0x004C, first data byte 0x12 = the Find My (offline finding) type.
  const c = classifyBeacon({ manufacturerId: 0x004c, manufacturerData: '1219a0ffee' });
  assert.equal(c.category, 'tracker');
  assert.match(c.label, /FIND MY/);
  assert.equal(c.vendor, 'APPLE');
});

test('a plain Apple advertisement is an Apple device, not a tracker', () => {
  const c = classifyBeacon({ manufacturerId: 0x004c, manufacturerData: '100512abcd' });
  assert.equal(c.category, 'phone');
  assert.equal(c.vendor, 'APPLE');
});

test('a Microsoft company id is named from the company table', () => {
  const c = classifyBeacon({ manufacturerId: 0x0006 });
  assert.equal(c.vendor, 'MICROSOFT');
  assert.match(c.label, /MICROSOFT/);
});

test('a service-UUID match wins over the manufacturer id', () => {
  // A Tile that also carries a manufacturer block still reads as a Tile tracker.
  const c = classifyBeacon({ serviceUuids: [TILE], manufacturerId: 0x0006 });
  assert.match(c.label, /TILE/);
  assert.equal(c.category, 'tracker');
});

test('a device advertising nothing recognizable is honestly unknown', () => {
  const c = classifyBeacon({ serviceUuids: [], manufacturerId: null });
  assert.equal(c.category, 'unknown');
  assert.equal(c.label, 'UNKNOWN');
  assert.equal(c.vendor, null);
});
