import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rememberFirstSeen,
  orderForDisplay,
  capList,
  DEFAULT_LIST_CAP,
} from '../public/js/sources/device-order.js';

const dev = (address, rssi) => ({ address, rssi });

test('rememberFirstSeen keeps an address at the position it was first seen', () => {
  const seen = rememberFirstSeen([dev('a'), dev('b')]);
  rememberFirstSeen([dev('b'), dev('a'), dev('c')], seen);
  assert.deepEqual([...seen.entries()], [['a', 0], ['b', 1], ['c', 2]]);
});

test('rememberFirstSeen restores a device that missed a poll to its old position', () => {
  // A device dropping out for one poll and returning must not jump to the end;
  // that is the jitter the frozen order exists to prevent.
  const seen = rememberFirstSeen([dev('a'), dev('b'), dev('c')]);
  rememberFirstSeen([dev('a'), dev('c')], seen);
  rememberFirstSeen([dev('a'), dev('b'), dev('c')], seen);
  assert.equal(seen.get('b'), 1);
});

test('rememberFirstSeen ignores an address-less entry rather than indexing null', () => {
  const seen = rememberFirstSeen([dev(null), dev('a')]);
  assert.deepEqual([...seen.keys()], ['a']);
});

test('orderForDisplay leaves the loudest-first order alone when not frozen', () => {
  const devices = [dev('c', -40), dev('a', -60), dev('b', -80)];
  assert.deepEqual(orderForDisplay(devices, new Map()).map((d) => d.address), ['c', 'a', 'b']);
});

test('orderForDisplay holds first-seen order while frozen, whatever the signal does', () => {
  const seen = rememberFirstSeen([dev('a'), dev('b'), dev('c')]);
  // Same devices, now arriving loudest-first in a completely different order.
  const devices = [dev('c', -30), dev('b', -50), dev('a', -90)];
  assert.deepEqual(
    orderForDisplay(devices, seen, { frozen: true }).map((d) => d.address),
    ['a', 'b', 'c'],
    'positions stay put so a tap lands on the row the user aimed at',
  );
});

test('orderForDisplay sinks an unknown address instead of throwing', () => {
  const seen = rememberFirstSeen([dev('a')]);
  const order = orderForDisplay([dev('zz'), dev('a')], seen, { frozen: true });
  assert.deepEqual(order.map((d) => d.address), ['a', 'zz']);
});

test('orderForDisplay never hands back the caller its own array', () => {
  const devices = [dev('a')];
  assert.notEqual(orderForDisplay(devices, new Map()), devices);
  assert.notEqual(orderForDisplay(devices, new Map(), { frozen: true }), devices);
});

test('orderForDisplay tolerates a missing list', () => {
  assert.deepEqual(orderForDisplay(null, new Map()), []);
});

test('capList shows everything when the list is within the cap', () => {
  const devices = [dev('a'), dev('b')];
  const { shown, hidden } = capList(devices, { limit: 8 });
  assert.equal(shown.length, 2);
  assert.equal(hidden, 0);
});

test('capList withholds the tail and reports how much', () => {
  const devices = Array.from({ length: 20 }, (_, i) => dev(`d${i}`));
  const { shown, hidden } = capList(devices, { limit: 8 });
  assert.equal(shown.length, 8);
  assert.equal(hidden, 12);
});

test('capList shows everything once expanded', () => {
  const devices = Array.from({ length: 20 }, (_, i) => dev(`d${i}`));
  const { shown, hidden } = capList(devices, { limit: 8, expanded: true });
  assert.equal(shown.length, 20);
  assert.equal(hidden, 0);
});

test('capList always keeps the selected device visible', () => {
  // A hunt whose own target has scrolled out of its list is worse than no cap.
  const devices = Array.from({ length: 20 }, (_, i) => dev(`d${i}`));
  const { shown } = capList(devices, { limit: 8, pin: 'd15' });
  assert.ok(shown.some((d) => d.address === 'd15'));
});

test('pinning a far-off device does not grow the list past its promised cap', () => {
  const devices = Array.from({ length: 20 }, (_, i) => dev(`d${i}`));
  const { shown, hidden } = capList(devices, { limit: 8, pin: 'd15' });
  assert.equal(shown.length, 8);
  assert.equal(hidden, 12);
});

test('a pin already inside the cap changes nothing', () => {
  const devices = Array.from({ length: 20 }, (_, i) => dev(`d${i}`));
  const { shown } = capList(devices, { limit: 8, pin: 'd2' });
  assert.deepEqual(shown.map((d) => d.address), ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
});

test('an unknown pin is simply ignored', () => {
  const devices = Array.from({ length: 20 }, (_, i) => dev(`d${i}`));
  const { shown } = capList(devices, { limit: 8, pin: 'nope' });
  assert.equal(shown.length, 8);
  assert.equal(shown[7].address, 'd7');
});

test('the default cap leaves room to choose without burying the panels below', () => {
  assert.equal(DEFAULT_LIST_CAP, 8);
});
