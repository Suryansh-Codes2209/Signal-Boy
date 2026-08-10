import test from 'node:test';
import assert from 'node:assert/strict';

import { mapLinkTest } from '../public/js/sources/link-test-map.js';

test('a missing or idle status maps to a clean idle state', () => {
  const idle = mapLinkTest(null);
  assert.equal(idle.state, 'idle');
  assert.equal(idle.progress, 0);
  assert.equal(idle.done, false);
  assert.equal(idle.pingMs, null);
});

test('a running status clamps progress into 0..1 and stays not-done', () => {
  const r = mapLinkTest({ state: 'running', phase: 'download', progress: 1.7, downMbps: 120.456 });
  assert.equal(r.state, 'running');
  assert.equal(r.phase, 'download');
  assert.equal(r.progress, 1, 'progress never exceeds 1');
  assert.equal(r.done, false);
  assert.equal(r.downMbps, 120.5, 'rounded to one decimal for display');
});

test('a negative progress is floored to 0', () => {
  assert.equal(mapLinkTest({ state: 'running', progress: -0.5 }).progress, 0);
});

test('a completed status carries the final numbers and is done', () => {
  const d = mapLinkTest({ state: 'done', pingMs: 4.27, jitterMs: 0.83, downMbps: 284.9, progress: 1 });
  assert.equal(d.state, 'done');
  assert.equal(d.done, true);
  assert.equal(d.pingMs, 4.3);
  assert.equal(d.jitterMs, 0.8);
  assert.equal(d.downMbps, 284.9);
});

test('an error status surfaces a readable message', () => {
  const e = mapLinkTest({ state: 'error', error: 'UNREACHABLE' });
  assert.equal(e.state, 'error');
  assert.equal(e.done, true, 'an error ends the run');
  assert.match(e.error, /UNREACHABLE|COULD NOT REACH/i);
});
