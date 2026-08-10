import test from 'node:test';
import assert from 'node:assert/strict';

import { summarize, stabilityLabel, linkQuality } from '../public/js/sources/link-quality.js';

test('summarize computes count/mean/min/max/std over a numeric field, ignoring nulls', () => {
  const s = summarize([{ rssi: -50 }, { rssi: -54 }, { rssi: null }, { rssi: -52 }], 'rssi');
  assert.equal(s.count, 3, 'the null sample is not counted');
  assert.equal(s.mean, -52);
  assert.equal(s.min, -54);
  assert.equal(s.max, -50);
  assert.ok(s.std > 0);
});

test('summarize on no usable samples is empty, not NaN', () => {
  const s = summarize([{ rssi: null }], 'rssi');
  assert.equal(s.count, 0);
  assert.equal(s.mean, null);
  assert.equal(s.std, null);
});

test('stabilityLabel bins the jitter from rock-solid to unstable', () => {
  assert.equal(stabilityLabel(0.5), 'ROCK SOLID');
  assert.equal(stabilityLabel(2), 'STEADY');
  assert.equal(stabilityLabel(4.5), 'VARIABLE');
  assert.equal(stabilityLabel(9), 'UNSTABLE');
  assert.equal(stabilityLabel(null), 'NO DATA');
});

test('linkQuality summarizes rssi and txRate and labels overall stability from rssi jitter', () => {
  const readings = [
    { rssi: -50, txRate: 866 },
    { rssi: -51, txRate: 866 },
    { rssi: -50, txRate: 780 },
    { rssi: -49, txRate: 866 },
  ];
  const q = linkQuality(readings);
  assert.equal(q.rssi.count, 4);
  assert.equal(q.txRate.count, 4);
  assert.ok(['ROCK SOLID', 'STEADY'].includes(q.stability), `steady signal, got ${q.stability}`);
});

test('linkQuality on an empty window reports NO DATA rather than crashing', () => {
  const q = linkQuality([]);
  assert.equal(q.stability, 'NO DATA');
  assert.equal(q.rssi.count, 0);
});

test('a wildly swinging signal reads as unstable', () => {
  const readings = [{ rssi: -40 }, { rssi: -80 }, { rssi: -45 }, { rssi: -85 }, { rssi: -50 }];
  const q = linkQuality(readings);
  assert.equal(q.stability, 'UNSTABLE');
});
