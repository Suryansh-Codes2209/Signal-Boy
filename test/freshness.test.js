import test from 'node:test';
import assert from 'node:assert/strict';

import { Freshness, STALE_AFTER_MS, freshnessLabel } from '../public/js/freshness.js';

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

// The status line both walk and live render. Shared so the two views cannot
// describe the same state differently -- a phone user is one tab tap apart.

test('labels the state before any reading as having none', () => {
  assert.equal(freshnessLabel({ hasReading: false, fresh: false, ageMs: null }), 'NO READING');
});

test('names the interface on a fresh reading when there is one', () => {
  const label = freshnessLabel({ hasReading: true, fresh: true, ageMs: 0 }, { interfaceName: 'en0' });
  assert.equal(label, 'LIVE · en0');
});

test('omits the separator when no interface is known', () => {
  assert.equal(freshnessLabel({ hasReading: true, fresh: true, ageMs: 0 }), 'LIVE');
  assert.equal(
    freshnessLabel({ hasReading: true, fresh: true, ageMs: 0 }, { interfaceName: null }),
    'LIVE',
  );
});

test('a stale reading reports its own age in whole seconds', () => {
  assert.equal(
    freshnessLabel({ hasReading: true, fresh: false, ageMs: 4200 }),
    'STALE 4S · RECONNECTING',
  );
  // Floored, not rounded: claiming 5s at 4.9s would overstate the age.
  assert.equal(
    freshnessLabel({ hasReading: true, fresh: false, ageMs: 4999 }),
    'STALE 4S · RECONNECTING',
  );
});

test('a stale reading never claims to be live, whatever the interface', () => {
  const label = freshnessLabel(
    { hasReading: true, fresh: false, ageMs: 9000 },
    { interfaceName: 'en0' },
  );
  assert.ok(!label.includes('LIVE'));
  assert.equal(label, 'STALE 9S · RECONNECTING');
});

test('the label is driven straight off a Freshness state', () => {
  const clock = fakeClock();
  const f = new Freshness({ staleAfterMs: 3000, now: clock.now });
  assert.equal(freshnessLabel(f.state()), 'NO READING');
  f.mark();
  assert.equal(freshnessLabel(f.state(), { interfaceName: 'wlan0' }), 'LIVE · wlan0');
  clock.advance(3000);
  assert.equal(freshnessLabel(f.state(), { interfaceName: 'wlan0' }), 'STALE 3S · RECONNECTING');
});
