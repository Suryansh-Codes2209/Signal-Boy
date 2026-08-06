import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BANDS,
  gradeRssi,
  snr,
  qualityPercent,
  distanceToRssi,
  rssiToDistance,
  fitPathLossExponent,
  DEFAULT_PATH_LOSS,
} from '../public/js/core/pathloss.js';

test('gradeRssi puts values in the right band', () => {
  assert.equal(gradeRssi(-35).key, 'excellent');
  assert.equal(gradeRssi(-55).key, 'good');
  assert.equal(gradeRssi(-65).key, 'fair');
  assert.equal(gradeRssi(-72).key, 'weak');
  assert.equal(gradeRssi(-88).key, 'dead');
});

test('band boundaries are inclusive at their stated minimum', () => {
  // -67 is the streaming/VoIP floor: it must still count as fair, not weak.
  assert.equal(gradeRssi(-67).key, 'fair');
  assert.equal(gradeRssi(-67.01).key, 'weak');
  assert.equal(gradeRssi(-50).key, 'excellent');
  assert.equal(gradeRssi(-60).key, 'good');
  assert.equal(gradeRssi(-75).key, 'weak');
});

test('gradeRssi returns null for missing readings rather than a default band', () => {
  assert.equal(gradeRssi(null), null);
  assert.equal(gradeRssi(undefined), null);
  assert.equal(gradeRssi(NaN), null);
});

test('every band maps to a shade in the four-colour palette', () => {
  for (const band of BANDS) {
    assert.ok(band.shade >= 0 && band.shade <= 3, `${band.key} shade out of range`);
  }
});

test('snr subtracts the noise floor, and is null when noise is unavailable', () => {
  assert.equal(snr(-55, -95), 40);
  // Windows reports no noise floor at all; SNR must be null, never 0 or NaN.
  assert.equal(snr(-55, null), null);
  assert.equal(snr(null, -95), null);
});

test('qualityPercent clamps to 0-100 across the usable range', () => {
  assert.equal(qualityPercent(-90), 0);
  assert.equal(qualityPercent(-30), 100);
  assert.equal(qualityPercent(-120), 0);
  assert.equal(qualityPercent(-10), 100);
  assert.equal(qualityPercent(-60), 50);
  assert.equal(qualityPercent(null), 0);
});

test('rssiToDistance inverts distanceToRssi', () => {
  for (const distance of [0.5, 1, 2, 5, 10, 25]) {
    const rssi = distanceToRssi(distance);
    assert.ok(
      Math.abs(rssiToDistance(rssi) - distance) < 1e-9,
      `round trip failed at ${distance}m`,
    );
  }
});

test('RSSI at the reference distance equals the reference RSSI', () => {
  const { refRssi, refDistance } = DEFAULT_PATH_LOSS;
  assert.equal(distanceToRssi(refDistance), refRssi);
});

test('signal weakens monotonically with distance', () => {
  let previous = Infinity;
  for (const d of [1, 2, 4, 8, 16]) {
    const rssi = distanceToRssi(d);
    assert.ok(rssi < previous, `expected ${rssi} < ${previous} at ${d}m`);
    previous = rssi;
  }
});

test('a higher path loss exponent means faster falloff', () => {
  const open = distanceToRssi(10, { n: 2.0 });
  const concrete = distanceToRssi(10, { n: 4.5 });
  assert.ok(concrete < open, 'concrete should attenuate more than open space');
});

test('distanceToRssi rejects non-positive distances', () => {
  assert.throws(() => distanceToRssi(0), RangeError);
  assert.throws(() => distanceToRssi(-3), RangeError);
});

test('rssiToDistance returns null for missing readings', () => {
  assert.equal(rssiToDistance(null), null);
  assert.equal(rssiToDistance(NaN), null);
});

test('fitPathLossExponent recovers the exponent used to generate samples', () => {
  const trueN = 3.2;
  const refRssi = -42;
  const samples = [1, 2, 4, 8].map((distance) => ({
    distance,
    rssi: distanceToRssi(distance, { refRssi, refDistance: 1, n: trueN }),
  }));

  const fitted = fitPathLossExponent(samples, { refRssi, refDistance: 1 });
  assert.ok(Math.abs(fitted - trueN) < 0.01, `fitted ${fitted}, expected ${trueN}`);
});

test('fitPathLossExponent clamps implausible fits instead of returning garbage', () => {
  // Signal rising with distance is physically impossible; must not yield a
  // negative exponent that would invert every later distance estimate.
  const nonsense = [
    { distance: 1, rssi: -80 },
    { distance: 10, rssi: -30 },
  ];
  const fitted = fitPathLossExponent(nonsense, { refRssi: -80, refDistance: 1 });
  assert.ok(fitted >= 1.5 && fitted <= 6, `expected clamped value, got ${fitted}`);
});

test('fitPathLossExponent falls back to the default when samples are unusable', () => {
  assert.equal(fitPathLossExponent([]), DEFAULT_PATH_LOSS.n);
  assert.equal(fitPathLossExponent([{ distance: -1, rssi: -50 }]), DEFAULT_PATH_LOSS.n);
});
