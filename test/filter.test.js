import test from 'node:test';
import assert from 'node:assert/strict';

import { Ewma, Kalman1D, stdDev } from '../public/js/core/filter.js';

test('Ewma starts at its first sample rather than at zero', () => {
  const ewma = new Ewma(0.3);
  assert.equal(ewma.value, null);
  assert.equal(ewma.update(-55), -55);
});

test('Ewma converges towards a constant signal', () => {
  const ewma = new Ewma(0.3);
  ewma.update(-80);
  for (let i = 0; i < 100; i++) ewma.update(-50);
  assert.ok(Math.abs(ewma.value - -50) < 0.01, `converged to ${ewma.value}`);
});

test('Ewma responds faster with a larger alpha', () => {
  const slow = new Ewma(0.1);
  const fast = new Ewma(0.9);
  slow.update(-80);
  fast.update(-80);
  slow.update(-40);
  fast.update(-40);
  assert.ok(fast.value > slow.value, 'higher alpha should track the step sooner');
});

test('Ewma rejects an out-of-range alpha', () => {
  assert.throws(() => new Ewma(0), RangeError);
  assert.throws(() => new Ewma(1.5), RangeError);
  assert.throws(() => new Ewma(-0.2), RangeError);
});

test('Kalman1D adopts its first sample exactly', () => {
  const kalman = new Kalman1D();
  assert.equal(kalman.value, null);
  assert.equal(kalman.update(-57), -57);
});

test('Kalman1D converges on a noisy constant signal', () => {
  const kalman = new Kalman1D({ processNoise: 0.01, measurementNoise: 6 });
  const truth = -62;
  // Deterministic alternating noise, so the test cannot flake.
  const noise = [4, -3, 5, -5, 2, -2, 6, -6, 1, -1];
  for (let i = 0; i < 200; i++) kalman.update(truth + noise[i % noise.length]);

  assert.ok(Math.abs(kalman.value - truth) < 1.5, `settled at ${kalman.value}, expected ~${truth}`);
});

test('Kalman1D smooths more than the raw signal varies', () => {
  const kalman = new Kalman1D();
  const samples = [-60, -70, -50, -68, -52, -66, -54, -64, -56, -62];
  const outputs = samples.map((s) => kalman.update(s));

  // Ignore the first sample, which is adopted verbatim by design.
  assert.ok(stdDev(outputs.slice(1)) < stdDev(samples), 'filtered output should be steadier');
});

test('Kalman1D variance shrinks as evidence accumulates', () => {
  const kalman = new Kalman1D();
  kalman.update(-55);
  const initial = kalman.variance;
  for (let i = 0; i < 50; i++) kalman.update(-55);
  assert.ok(kalman.variance < initial, 'confidence should increase with more samples');
});

test('Kalman1D tracks a step change monotonically without overshooting', () => {
  const kalman = new Kalman1D();
  kalman.update(-80);
  let previous = kalman.value;
  for (let i = 0; i < 40; i++) {
    const next = kalman.update(-50);
    assert.ok(next >= previous, 'must not oscillate while tracking a step');
    assert.ok(next <= -50 + 1e-9, 'must not overshoot past the new value');
    previous = next;
  }
});

test('reset clears filter state', () => {
  const kalman = new Kalman1D();
  const ewma = new Ewma(0.3);
  kalman.update(-55);
  ewma.update(-55);
  kalman.reset();
  ewma.reset();
  assert.equal(kalman.value, null);
  assert.equal(ewma.value, null);
});

test('stdDev matches a hand-computed sample standard deviation', () => {
  // Sample (n-1) std dev of [2,4,4,4,5,5,7,9] is 2.13809...
  assert.ok(Math.abs(stdDev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.13809) < 0.0001);
  assert.equal(stdDev([5, 5, 5, 5]), 0);
  assert.equal(stdDev([42]), 0);
  assert.equal(stdDev([]), 0);
});
