import test from 'node:test';
import assert from 'node:assert/strict';

import { exp, log, mul, generatorPoly, remainder } from '../server/qr/galois.js';

test('exp and log are inverses across the field', () => {
  for (let i = 1; i < 255; i++) assert.equal(log(exp(i)), i);
});

test('multiplication by zero is zero', () => {
  assert.equal(mul(0, 123), 0);
  assert.equal(mul(123, 0), 0);
});

test('multiplication by one is identity', () => {
  assert.equal(mul(1, 123), 123);
});

test('multiplication matches known GF(256) products', () => {
  // Standard results for the QR primitive polynomial 0x11d.
  assert.equal(mul(2, 2), 4);
  assert.equal(mul(0x80, 2), 0x1d);
});

test('generator polynomial has the expected degree and leading coefficient', () => {
  const g = generatorPoly(10);
  assert.equal(g.length, 11);
  assert.equal(g[0], 1);
});

test('remainder produces the requested number of EC codewords', () => {
  const ec = remainder([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236], 10);
  assert.equal(ec.length, 10);
  assert.ok(ec.every((b) => b >= 0 && b <= 255));
});
