import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RANGE_SCALES,
  MIN_SCALE,
  MAX_SCALE,
  RING_COUNT,
  SHRINK_HYSTERESIS,
  scaleForMetres,
  metresToRadiusFraction,
  beyondScale,
  ringMetresForScale,
  formatRingLabel,
  bearingToCanvasRadians,
} from '../public/js/render/ruler-map.js';

test('scaleForMetres picks the smallest scale that contains the reading', () => {
  assert.equal(scaleForMetres(0.4), 1);
  assert.equal(scaleForMetres(1.5), 2);
  assert.equal(scaleForMetres(4), 5);
  assert.equal(scaleForMetres(11), 20);
  assert.equal(scaleForMetres(60), 100);
});

test('scaleForMetres clamps past the largest scale rather than inventing one', () => {
  assert.equal(scaleForMetres(5000), MAX_SCALE);
});

test('scaleForMetres treats a boundary reading as fitting its own scale', () => {
  // 10 m must fit the 10 m board, not force the 20 m one -- otherwise the
  // labelled edge of every board is unreachable.
  for (const s of RANGE_SCALES) assert.equal(scaleForMetres(s), s);
});

test('scaleForMetres grows immediately, because an off-board reading cannot be drawn', () => {
  assert.equal(scaleForMetres(12, 10), 20);
  assert.equal(scaleForMetres(0.5, 100), 1, 'a cold jump downward is still allowed');
});

test('scaleForMetres holds its scale near a boundary instead of flapping', () => {
  // 9.8 m on a 10 m board is well past the shrink threshold, so the board stays
  // put; without this the display rescales on ordinary jitter.
  assert.equal(scaleForMetres(9.8, 10), 10);
  assert.equal(scaleForMetres(5.0, 10), 10, 'exactly at the threshold is not yet headroom');
  assert.equal(scaleForMetres(4.4, 10), 5, 'once there is real headroom, it shrinks');
});

test('SHRINK_HYSTERESIS is the documented threshold, not an arbitrary constant', () => {
  const scale = 10;
  assert.equal(scaleForMetres(scale * SHRINK_HYSTERESIS, scale), 5);
  assert.equal(scaleForMetres(scale * SHRINK_HYSTERESIS + 0.01, scale), 10);
});

test('scaleForMetres keeps the current board when the reading is missing', () => {
  assert.equal(scaleForMetres(null, 20), 20);
  assert.equal(scaleForMetres(NaN, 20), 20);
  assert.equal(scaleForMetres(-1, 20), 20, 'a negative distance is not a reading');
});

test('scaleForMetres falls back to the smallest board with no reading and no history', () => {
  assert.equal(scaleForMetres(null), MIN_SCALE);
});

test('metresToRadiusFraction is linear, which is what makes the board a ruler', () => {
  // Equal steps in metres must produce equal steps in radius. This is the
  // property dbmToRadiusFraction deliberately does not have.
  const scale = 20;
  const a = metresToRadiusFraction(5, scale);
  const b = metresToRadiusFraction(10, scale);
  const c = metresToRadiusFraction(15, scale);
  assert.ok(Math.abs((b - a) - (c - b)) < 1e-12, 'ring gaps are equal across the board');
  assert.equal(a, 0.25);
  assert.equal(b, 0.5);
});

test('metresToRadiusFraction puts the phone at the centre and the scale at the rim', () => {
  assert.equal(metresToRadiusFraction(0, 10), 0);
  assert.equal(metresToRadiusFraction(10, 10), 1);
});

test('metresToRadiusFraction clamps beyond the scale rather than drawing off the board', () => {
  assert.equal(metresToRadiusFraction(50, 10), 1);
});

test('metresToRadiusFraction returns null for a missing reading', () => {
  assert.equal(metresToRadiusFraction(null, 10), null);
  assert.equal(metresToRadiusFraction(NaN, 10), null);
  assert.equal(metresToRadiusFraction(-2, 10), null);
});

test('beyondScale distinguishes a clamped blip from one measured at the edge', () => {
  assert.equal(beyondScale(10, 10), false, 'exactly at the rim is a real reading');
  assert.equal(beyondScale(10.1, 10), true);
  assert.equal(beyondScale(null, 10), false);
});

test('ringMetresForScale labels each ring with what it actually stands for', () => {
  assert.deepEqual(ringMetresForScale(20), [5, 10, 15, 20]);
  assert.deepEqual(ringMetresForScale(1), [0.25, 0.5, 0.75, 1]);
});

test('ringMetresForScale always produces one label per drawable ring', () => {
  for (const s of RANGE_SCALES) assert.equal(ringMetresForScale(s).length, RING_COUNT);
});

test('formatRingLabel keeps whole metres clean and fractions readable', () => {
  assert.equal(formatRingLabel(10), '10M');
  assert.equal(formatRingLabel(0.25), '0.3M');
  assert.equal(formatRingLabel(null), '');
});

test('bearingToCanvasRadians puts straight ahead at the top of the board', () => {
  // Canvas angles start at three o'clock, so the top is -90 degrees.
  assert.equal(bearingToCanvasRadians(0), -Math.PI / 2);
  assert.equal(bearingToCanvasRadians(90), 0, 'hard right is the positive x axis');
  assert.ok(Math.abs(bearingToCanvasRadians(180) - Math.PI / 2) < 1e-12);
});

test('bearingToCanvasRadians never invents a heading', () => {
  // Every technology except UWB returns null here, and radar.js relies on that
  // null to place a blip without implying a direction.
  assert.equal(bearingToCanvasRadians(null), null);
  assert.equal(bearingToCanvasRadians(undefined), null);
  assert.equal(bearingToCanvasRadians(NaN), null);
});
