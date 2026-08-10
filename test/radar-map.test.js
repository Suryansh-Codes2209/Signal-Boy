import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RSSI_FLOOR,
  RSSI_CEILING,
  RING_COUNT,
  RING_MIN_HALF_WIDTH,
  RING_MAX_HALF_WIDTH,
  dbmToRadiusFraction,
  shadeForRadiusFraction,
  ringHalfWidthForVariance,
  decayPeak,
  trendFromDelta,
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

/* ---------- confidence / peak decay / trend (HUNT radar refinement) ---------- */

test('the live ring widens with Kalman variance and clamps at both ends', () => {
  // A settled track (tiny variance) draws a tight ring; a fresh selection or a
  // sudden move (large variance) draws a fuzzy band that honestly says "unsure".
  assert.equal(ringHalfWidthForVariance(0), RING_MIN_HALF_WIDTH);
  assert.equal(ringHalfWidthForVariance(null), RING_MIN_HALF_WIDTH);
  const settled = ringHalfWidthForVariance(0.5);
  const uncertain = ringHalfWidthForVariance(40);
  assert.ok(uncertain > settled, 'an uncertain estimate should draw a wider band');
  assert.ok(uncertain <= RING_MAX_HALF_WIDTH, 'never wider than the cap');
  assert.equal(ringHalfWidthForVariance(1e9), RING_MAX_HALF_WIDTH);
});

test('decayPeak adopts a stronger reading immediately', () => {
  assert.equal(decayPeak(null, -60), -60);
  assert.equal(decayPeak(-70, -50), -50, 'a new high is the whole point of peak-hold');
  assert.equal(decayPeak(-50, -50), -50);
});

test('decayPeak relaxes slowly toward a weaker reading instead of sticking forever', () => {
  const eased = decayPeak(-40, -80, 0.02);
  assert.ok(eased < -40 && eased > -80, `should ease down, not jump or freeze (${eased})`);
  let peak = -40;
  for (let i = 0; i < 2000; i++) peak = decayPeak(peak, -80, 0.02);
  assert.ok(Math.abs(peak - -80) < 1, `a held-down signal should converge, got ${peak}`);
});

test('decayPeak ignores a missing reading rather than dropping the peak', () => {
  assert.equal(decayPeak(-55, null), -55);
  assert.equal(decayPeak(-55, NaN), -55);
});

test('trendFromDelta reports approach/recede with a dead-band for jitter', () => {
  // WARMER = the signal strengthened (dBm rose, e.g. -70 -> -60). It never says
  // which way to walk -- only that the reading is improving or worsening.
  assert.equal(trendFromDelta(3), 'WARMER');
  assert.equal(trendFromDelta(-3), 'COLDER');
  assert.equal(trendFromDelta(0), 'STEADY');
  assert.equal(trendFromDelta(0.2), 'STEADY', 'ordinary jitter must not flicker the label');
  assert.equal(trendFromDelta(null), 'STEADY');
});
