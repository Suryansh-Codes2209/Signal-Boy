import test from 'node:test';
import assert from 'node:assert/strict';

import { Freshness, STALE_AFTER_MS } from '../public/js/freshness.js';

/** A clock the test drives by hand, so no timers are involved. */
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('reports no reading before the first mark', () => {
  const f = new Freshness({ now: fakeClock().now });
  assert.deepEqual(f.state(), { hasReading: false, fresh: false, ageMs: null });
});

test('a just-marked reading is fresh with zero age', () => {
  const clock = fakeClock();
  const f = new Freshness({ now: clock.now });
  f.mark();
  assert.deepEqual(f.state(), { hasReading: true, fresh: true, ageMs: 0 });
});

test('stays fresh right up to the threshold', () => {
  const clock = fakeClock();
  const f = new Freshness({ staleAfterMs: 3000, now: clock.now });
  f.mark();
  clock.advance(2999);
  assert.equal(f.state().fresh, true);
});

test('goes stale at the threshold', () => {
  const clock = fakeClock();
  const f = new Freshness({ staleAfterMs: 3000, now: clock.now });
  f.mark();
  clock.advance(3000);
  const state = f.state();
  assert.equal(state.fresh, false);
  assert.equal(state.ageMs, 3000);
});

test('a new reading restores freshness', () => {
  const clock = fakeClock();
  const f = new Freshness({ staleAfterMs: 3000, now: clock.now });
  f.mark();
  clock.advance(10000);
  assert.equal(f.state().fresh, false);
  f.mark();
  assert.deepEqual(f.state(), { hasReading: true, fresh: true, ageMs: 0 });
});

test('reset clears the reading entirely', () => {
  const clock = fakeClock();
  const f = new Freshness({ now: clock.now });
  f.mark();
  f.reset();
  assert.deepEqual(f.state(), { hasReading: false, fresh: false, ageMs: null });
});

test('defaults to a three second threshold', () => {
  assert.equal(STALE_AFTER_MS, 3000);
  const clock = fakeClock();
  const f = new Freshness({ now: clock.now });
  f.mark();
  clock.advance(3000);
  assert.equal(f.state().fresh, false);
});
