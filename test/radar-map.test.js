import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RSSI_FLOOR,
  RSSI_CEILING,
  RING_COUNT,
  dbmToRadiusFraction,
  shadeForRadiusFraction,
} from '../public/js/render/radar-map.js';

test('the floor and ceiling are the ones pathloss.js defines, not new bounds', () => {
  assert.equal(RSSI_FLOOR, -90);
  assert.equal(RSSI_CEILING, -30);
});

test('dbmToRadiusFraction places the ceiling (strongest reading) at the centre', () => {
  assert.equal(dbmToRadiusFraction(RSSI_CEILING), 0);
});

test('dbmToRadiusFraction places the floor (weakest reading) at the outer edge', () => {
  assert.equal(dbmToRadiusFraction(RSSI_FLOOR), 1);
});

test('dbmToRadiusFraction clamps beyond both ends rather than drawing outside the ring', () => {
  assert.equal(dbmToRadiusFraction(RSSI_FLOOR - 20), 1);
  assert.equal(dbmToRadiusFraction(RSSI_CEILING + 20), 0);
  assert.equal(dbmToRadiusFraction(-200), 1);
  assert.equal(dbmToRadiusFraction(0), 0);
});

test('dbmToRadiusFraction at the midpoint is exactly 0.5', () => {
  const midpoint = (RSSI_FLOOR + RSSI_CEILING) / 2;
  assert.equal(dbmToRadiusFraction(midpoint), 0.5);
});

test('dbmToRadiusFraction is null for a missing or non-finite reading, never a fabricated position', () => {
  assert.equal(dbmToRadiusFraction(null), null);
  assert.equal(dbmToRadiusFraction(undefined), null);
  assert.equal(dbmToRadiusFraction(NaN), null);
});

test('dbmToRadiusFraction shrinks monotonically as signal strengthens', () => {
  let previous = Infinity;
  for (const dbm of [-90, -80, -70, -60, -50, -40, -30]) {
    const fraction = dbmToRadiusFraction(dbm);
    assert.ok(fraction < previous, `expected ${fraction} < ${previous} at ${dbm}dBm`);
    previous = fraction;
  }
});

test('shadeForRadiusFraction puts the centre at the lightest shade and the edge at the darkest', () => {
  assert.equal(shadeForRadiusFraction(0), RING_COUNT - 1);
  assert.equal(shadeForRadiusFraction(1), 0);
});

test('shadeForRadiusFraction clamps beyond both ends', () => {
  assert.equal(shadeForRadiusFraction(-1), RING_COUNT - 1);
  assert.equal(shadeForRadiusFraction(2), 0);
});

test('shadeForRadiusFraction divides the ring into RING_COUNT equal bands', () => {
  // Every ring boundary should be a whole shade, and it should never skip one
  // as fraction crosses from edge to centre.
  const seen = new Set();
  for (let i = 0; i <= 100; i++) {
    seen.add(shadeForRadiusFraction(i / 100));
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});
