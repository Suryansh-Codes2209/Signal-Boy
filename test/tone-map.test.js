import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RSSI_FLOOR,
  RSSI_CEILING,
  BASE_FREQUENCY_HZ,
  SEMITONE_SPAN,
  CLICK_RATE_MIN_HZ,
  CLICK_RATE_MAX_HZ,
  normalizedLevel,
  dbmToSemitones,
  semitoneToFrequency,
  dbmToFrequency,
  dbmToClickRateHz,
  dbmToClickIntervalMs,
} from '../public/js/audio/tone-map.js';

test('the floor and ceiling are the ones pathloss.js defines, not new bounds', () => {
  assert.equal(RSSI_FLOOR, -90);
  assert.equal(RSSI_CEILING, -30);
});

test('normalizedLevel maps floor to 0 and ceiling to 1', () => {
  assert.equal(normalizedLevel(RSSI_FLOOR), 0);
  assert.equal(normalizedLevel(RSSI_CEILING), 1);
});

test('normalizedLevel clamps beyond both ends instead of extrapolating', () => {
  assert.equal(normalizedLevel(RSSI_FLOOR - 20), 0);
  assert.equal(normalizedLevel(RSSI_CEILING + 20), 1);
  assert.equal(normalizedLevel(-200), 0);
  assert.equal(normalizedLevel(0), 1);
});

test('normalizedLevel is null for a missing or non-finite reading', () => {
  assert.equal(normalizedLevel(null), null);
  assert.equal(normalizedLevel(undefined), null);
  assert.equal(normalizedLevel(NaN), null);
});

test('normalizedLevel at the midpoint is exactly 0.5', () => {
  const midpoint = (RSSI_FLOOR + RSSI_CEILING) / 2;
  assert.equal(normalizedLevel(midpoint), 0.5);
});

test('dbmToSemitones spans 0 at the floor to SEMITONE_SPAN at the ceiling', () => {
  assert.equal(dbmToSemitones(RSSI_FLOOR), 0);
  assert.equal(dbmToSemitones(RSSI_CEILING), SEMITONE_SPAN);
});

test('dbmToSemitones clamps beyond the range rather than going negative or past the span', () => {
  assert.equal(dbmToSemitones(RSSI_FLOOR - 20), 0);
  assert.equal(dbmToSemitones(RSSI_CEILING + 20), SEMITONE_SPAN);
});

test('semitoneToFrequency doubles every 12 semitones (one octave)', () => {
  assert.equal(semitoneToFrequency(0, 220), 220);
  assert.equal(semitoneToFrequency(12, 220), 440);
  assert.equal(semitoneToFrequency(24, 220), 880);
});

test('dbmToFrequency at the floor is exactly the base frequency', () => {
  assert.equal(dbmToFrequency(RSSI_FLOOR), BASE_FREQUENCY_HZ);
});

test('dbmToFrequency at the ceiling is the base frequency two octaves up', () => {
  assert.equal(dbmToFrequency(RSSI_CEILING), BASE_FREQUENCY_HZ * 4);
});

test('dbmToFrequency clamps beyond both ends rather than producing absurd pitches', () => {
  assert.equal(dbmToFrequency(RSSI_FLOOR - 30), dbmToFrequency(RSSI_FLOOR));
  assert.equal(dbmToFrequency(RSSI_CEILING + 30), dbmToFrequency(RSSI_CEILING));
});

test('dbmToFrequency at the midpoint lands on A4, one octave above the floor', () => {
  const midpoint = (RSSI_FLOOR + RSSI_CEILING) / 2;
  assert.equal(dbmToFrequency(midpoint), 440);
});

test('dbmToFrequency is null for a missing reading, never a fabricated pitch', () => {
  assert.equal(dbmToFrequency(null), null);
  assert.equal(dbmToFrequency(NaN), null);
});

test('dbmToFrequency rises monotonically with signal strength', () => {
  let previous = 0;
  for (const dbm of [-90, -80, -70, -60, -50, -40, -30]) {
    const freq = dbmToFrequency(dbm);
    assert.ok(freq > previous, `expected ${freq} > ${previous} at ${dbm}dBm`);
    previous = freq;
  }
});

test('dbmToClickRateHz spans the min at the floor to the max at the ceiling', () => {
  assert.equal(dbmToClickRateHz(RSSI_FLOOR), CLICK_RATE_MIN_HZ);
  assert.equal(dbmToClickRateHz(RSSI_CEILING), CLICK_RATE_MAX_HZ);
});

test('dbmToClickRateHz clamps beyond both ends', () => {
  assert.equal(dbmToClickRateHz(RSSI_FLOOR - 30), CLICK_RATE_MIN_HZ);
  assert.equal(dbmToClickRateHz(RSSI_CEILING + 30), CLICK_RATE_MAX_HZ);
});

test('dbmToClickRateHz at the midpoint is exactly between min and max', () => {
  const midpoint = (RSSI_FLOOR + RSSI_CEILING) / 2;
  assert.equal(dbmToClickRateHz(midpoint), (CLICK_RATE_MIN_HZ + CLICK_RATE_MAX_HZ) / 2);
});

test('dbmToClickRateHz is null for a missing reading', () => {
  assert.equal(dbmToClickRateHz(null), null);
  assert.equal(dbmToClickRateHz(undefined), null);
});

test('dbmToClickRateHz increases as signal strengthens, so clicks speed up approaching a device', () => {
  let previous = 0;
  for (const dbm of [-90, -80, -70, -60, -50, -40, -30]) {
    const rate = dbmToClickRateHz(dbm);
    assert.ok(rate > previous, `expected ${rate} > ${previous} at ${dbm}dBm`);
    previous = rate;
  }
});

test('dbmToClickIntervalMs is the reciprocal of the rate, in milliseconds', () => {
  assert.equal(dbmToClickIntervalMs(RSSI_CEILING), 1000 / CLICK_RATE_MAX_HZ);
  assert.equal(dbmToClickIntervalMs(RSSI_FLOOR), 1000 / CLICK_RATE_MIN_HZ);
});

test('dbmToClickIntervalMs is null for a missing reading', () => {
  assert.equal(dbmToClickIntervalMs(null), null);
});

test('dbmToClickIntervalMs shrinks as signal strengthens, matching the rate increase', () => {
  let previous = Infinity;
  for (const dbm of [-90, -80, -70, -60, -50, -40, -30]) {
    const interval = dbmToClickIntervalMs(dbm);
    assert.ok(interval < previous, `expected ${interval} < ${previous} at ${dbm}dBm`);
    previous = interval;
  }
});
