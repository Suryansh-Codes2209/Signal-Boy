import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreCandidate, reassociate, DEFAULT_MIN_SCORE } from '../public/js/sources/reassociate.js';

/**
 * The lost device: what we last knew about the track before its address
 * vanished (a MAC rotation, ~every 15 min on modern trackers). `rssi` is the
 * last filtered value shown, not a raw sample.
 */
const LOST = {
  address: 'aa:aa:aa:aa:aa:aa',
  rssi: -55,
  txPower: -8,
  manufacturerId: 0x004c, // Apple
  serviceUuids: ['fd6f'],
};

test('a candidate with the same vendor and a near-identical signal scores high', () => {
  const score = scoreCandidate(LOST, {
    address: 'bb:bb:bb:bb:bb:bb',
    rssi: -57,
    txPower: -8,
    manufacturerId: 0x004c,
    serviceUuids: ['fd6f'],
  });
  assert.ok(score >= DEFAULT_MIN_SCORE, `expected a confident match, got ${score}`);
});

test('a different vendor is disqualified outright, however close the signal', () => {
  const score = scoreCandidate(LOST, {
    address: 'cc:cc:cc:cc:cc:cc',
    rssi: -55,
    txPower: -8,
    manufacturerId: 0x0006, // Microsoft, not Apple
    serviceUuids: ['fd6f'],
  });
  assert.equal(score, 0, 'a stable company id that differs means a different device');
});

test('signal proximity alone is not enough to claim a re-association', () => {
  // No vendor, no services, no txPower -- only that the RSSI is similar. That is
  // far too little to assert two addresses are one device.
  const score = scoreCandidate(
    { address: 'aa:aa:aa:aa:aa:aa', rssi: -55 },
    { address: 'dd:dd:dd:dd:dd:dd', rssi: -55 },
  );
  assert.ok(score < DEFAULT_MIN_SCORE, `rssi-only should stay below the threshold, got ${score}`);
});

test('less evidence yields a lower score than more', () => {
  const strong = scoreCandidate(LOST, {
    address: 'bb:bb:bb:bb:bb:bb',
    rssi: -55,
    txPower: -8,
    manufacturerId: 0x004c,
    serviceUuids: ['fd6f'],
  });
  const partial = scoreCandidate(LOST, {
    address: 'bb:bb:bb:bb:bb:bb',
    rssi: -55,
    manufacturerId: 0x004c,
  });
  assert.ok(strong > partial, `${strong} should beat ${partial} on more matching features`);
});

test('a far-off signal weakens the score even with the same vendor', () => {
  const near = scoreCandidate(LOST, { address: 'b1', rssi: -55, manufacturerId: 0x004c });
  const far = scoreCandidate(LOST, { address: 'b2', rssi: -85, manufacturerId: 0x004c });
  assert.ok(near > far, 'a rotated MAC should be at roughly the same distance in the same instant');
});

test('reassociate returns the best genuinely-new candidate above the threshold', () => {
  const best = reassociate(
    LOST,
    [
      { address: 'weak', rssi: -80, manufacturerId: 0x004c },
      { address: 'strong', rssi: -56, txPower: -8, manufacturerId: 0x004c, serviceUuids: ['fd6f'] },
      { address: 'other', rssi: -55, manufacturerId: 0x0006 }, // different vendor
    ],
    {},
  );
  assert.ok(best, 'a plausible match exists');
  assert.equal(best.address, 'strong');
  assert.ok(best.score >= DEFAULT_MIN_SCORE);
});

test('reassociate ignores addresses that were already on screen before the loss', () => {
  const candidate = { address: 'strong', rssi: -56, txPower: -8, manufacturerId: 0x004c, serviceUuids: ['fd6f'] };
  // Excluded because it was already being advertised before the track vanished,
  // so it cannot be the rotated continuation of it.
  const best = reassociate(LOST, [candidate], { exclude: ['strong'] });
  assert.equal(best, null);
});

test('reassociate returns null when nothing clears the bar', () => {
  const best = reassociate(LOST, [
    { address: 'x', rssi: -80, manufacturerId: 0x0006 },
    { address: 'y', rssi: -84 },
  ]);
  assert.equal(best, null);
});

test('reassociate never re-selects the lost address itself', () => {
  const best = reassociate(LOST, [
    { address: LOST.address, rssi: -55, txPower: -8, manufacturerId: 0x004c, serviceUuids: ['fd6f'] },
  ]);
  assert.equal(best, null, 'the same address reappearing is not a rotation');
});
