import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  GRADUATIONS,
  PING_PERIOD_FRAMES,
  graduationRadii,
  pingFraction,
  pingRadius,
  pingShade,
  scanlineRow,
  tickPositions,
} from '../public/js/render/tracker-map.js';

test('the tracker face contains no angle anywhere', () => {
  // The whole reason this module exists rather than a literal M314 copy: the
  // reference has a cone and a blip at a bearing, and a single BLE antenna
  // resolves no direction. If trigonometry ever appears here, someone has
  // started placing marks at angles the radio cannot measure.
  const source = readFileSync(new URL('../public/js/render/tracker-map.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['Math.atan', 'Math.sin', 'Math.cos', 'angle', 'bearing', 'theta']) {
    assert.ok(!code.includes(forbidden), `${forbidden} must not appear in tracker geometry`);
  }
});

test('graduationRadii spaces arcs evenly out to the rim', () => {
  assert.deepEqual(graduationRadii(128, 4), [32, 64, 96, 128]);
});

test('graduationRadii always reaches the rim exactly', () => {
  for (const n of [1, 2, 3, 4, 8]) {
    const radii = graduationRadii(100, n);
    assert.equal(radii.length, n);
    assert.equal(radii[radii.length - 1], 100);
  }
});

test('graduationRadii defaults to the four bands the palette can draw', () => {
  assert.equal(graduationRadii(100).length, GRADUATIONS);
});

test('graduationRadii degrades to empty geometry rather than NaN', () => {
  assert.deepEqual(graduationRadii(0, 4), [0, 0, 0, 0]);
  assert.deepEqual(graduationRadii(NaN, 4), [0, 0, 0, 0]);
});

test('pingFraction sweeps 0 to just under 1 and restarts at the centre', () => {
  assert.equal(pingFraction(0, 10), 0);
  assert.equal(pingFraction(5, 10), 0.5);
  assert.equal(pingFraction(9, 10), 0.9);
  // Restarts rather than easing back inward: an inward wave would read as
  // something approaching, which is a claim this pulse never makes.
  assert.equal(pingFraction(10, 10), 0);
});

test('pingFraction never runs backwards on a negative frame', () => {
  assert.equal(pingFraction(-5, 10), 0);
});

test('pingFraction survives a nonsense period', () => {
  assert.equal(pingFraction(3, 0), 3 % PING_PERIOD_FRAMES / PING_PERIOD_FRAMES);
});

test('pingRadius stays inside the field at every frame of its cycle', () => {
  for (let f = 0; f < PING_PERIOD_FRAMES * 3; f++) {
    const r = pingRadius(f, 128);
    assert.ok(r >= 0 && r < 128, `frame ${f} produced ${r}`);
  }
});

test('pingShade dims as the ping travels outward', () => {
  assert.equal(pingShade(0), 3);
  assert.equal(pingShade(0.5), 2);
  assert.equal(pingShade(0.99), 1);
});

test('pingShade clamps rather than indexing outside the palette', () => {
  // There are exactly four colours; an out-of-range index would be undefined
  // and paint nothing at all.
  for (const f of [-1, 0, 0.5, 1, 2, NaN]) {
    const shade = pingShade(f);
    assert.ok(Number.isInteger(shade) && shade >= 0 && shade <= 3, `${f} gave ${shade}`);
  }
});

test('scanlineRow walks every row in order and wraps', () => {
  const seen = [];
  for (let f = 0; f < 16 * 2; f += 2) seen.push(scanlineRow(f, 16));
  assert.deepEqual(seen, Array.from({ length: 16 }, (_, i) => i));
  assert.equal(scanlineRow(32, 16), 0, 'wraps back to the top');
});

test('scanlineRow holds each row for the configured number of frames', () => {
  assert.equal(scanlineRow(0, 16, 2), 0);
  assert.equal(scanlineRow(1, 16, 2), 0);
  assert.equal(scanlineRow(2, 16, 2), 1);
});

test('scanlineRow reports no row for an empty grid instead of dividing by zero', () => {
  assert.equal(scanlineRow(5, 0), -1);
});

test('tickPositions centres the run of ticks on the edge', () => {
  // Inset by half a step at both ends, so the ticks read as belonging to the
  // edge rather than colliding with the corners.
  assert.deepEqual(tickPositions(100, 5), [10, 30, 50, 70, 90]);
});

test('tickPositions keeps every tick inside the span', () => {
  for (const n of [1, 3, 7, 12]) {
    for (const p of tickPositions(256, n)) {
      assert.ok(p > 0 && p < 256, `tick ${p} escaped the edge`);
    }
  }
});

test('tickPositions returns nothing rather than dividing by zero', () => {
  assert.deepEqual(tickPositions(100, 0), []);
  assert.deepEqual(tickPositions(0, 5), [0, 0, 0, 0, 0]);
});
