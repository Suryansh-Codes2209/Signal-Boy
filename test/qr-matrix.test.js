import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { encodeQr } from '../server/qr/index.js';

/**
 * Ground truth from an independent QR implementation, generated once.
 *
 * It must be produced with a single forced byte-mode segment. Left to choose,
 * most encoders split a URL into Byte + Alphanumeric segments, which is a
 * perfectly valid code but not one a byte-mode-only encoder can reproduce.
 */
const golden = JSON.parse(
  readFileSync(new URL('./fixtures/qr-golden.json', import.meta.url), 'utf8'),
);

test('reproduces the golden matrix exactly', () => {
  const matrix = encodeQr(golden.text);
  const asInts = matrix.map((row) => row.map((cell) => (cell ? 1 : 0)));
  assert.deepEqual(asInts, golden.modules);
});

test('matrix is square and sized for its version', () => {
  const matrix = encodeQr(golden.text);
  assert.equal(matrix.length, 25); // version 2
  for (const row of matrix) assert.equal(row.length, 25);
});

/** A finder is a 7x7 dark ring, a light ring inside it, and a 3x3 dark centre. */
function isFinder(m, top, left) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (m[top + r][left + c] !== (ring || core)) return false;
    }
  }
  return true;
}

test('finder patterns sit in three corners', () => {
  const m = encodeQr(golden.text);
  const n = m.length;
  // Each finder is a 7x7 block with a dark border and a 3x3 dark centre.
  for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.equal(m[r][c], true);
    assert.equal(m[r + 3][c + 3], true);
    assert.equal(m[r + 1][c + 1], false);
    assert.ok(isFinder(m, r, c));
  }
  // The fourth corner must NOT have one. Checked structurally rather than by
  // sampling a single module: the bottom-right corner is an ordinary data
  // module, so its colour depends on the payload and is dark for this one.
  assert.equal(isFinder(m, n - 7, n - 7), false);
});
