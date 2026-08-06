import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { encodeQr } from '../server/qr/index.js';

/**
 * Ground truth from an independent QR implementation, generated once per
 * version.
 *
 * Each must be produced with a single forced byte-mode segment. Left to choose,
 * most encoders split a URL into Byte + Alphanumeric segments, which is a
 * perfectly valid code but not one a byte-mode-only encoder can reproduce.
 *
 * Three versions are pinned because the version-dependent paths -- the
 * alignment pattern, the dark module at 4 * version + 9, the format-info tail
 * and the length of the data walk -- are otherwise all fixed at a single point.
 * Version 1 is the only one with no alignment pattern at all, and version 4 is
 * the largest this encoder supports.
 */
const CASES = [
  { file: 'qr-golden-v1.json', version: 1, size: 21 },
  { file: 'qr-golden-v2.json', version: 2, size: 25 },
  { file: 'qr-golden-v4.json', version: 4, size: 33 },
].map((entry) => ({
  ...entry,
  golden: JSON.parse(readFileSync(new URL(`./fixtures/${entry.file}`, import.meta.url), 'utf8')),
}));

for (const { golden, version, size } of CASES) {
  test(`reproduces the version ${version} golden matrix exactly`, () => {
    // Guard against a fixture being regenerated into a different version.
    assert.equal(golden.version, version);
    assert.equal(golden.mode, 'byte');

    const matrix = encodeQr(golden.text);
    const asInts = matrix.map((row) => row.map((cell) => (cell ? 1 : 0)));
    assert.deepEqual(asInts, golden.modules);
  });
}

test('matrix is square and sized for its version', () => {
  for (const { golden, size } of CASES) {
    const matrix = encodeQr(golden.text);
    assert.equal(matrix.length, size);
    for (const row of matrix) assert.equal(row.length, size);
  }
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

test('finder patterns sit in three corners and not the fourth', () => {
  for (const { golden, version } of CASES) {
    const m = encodeQr(golden.text);
    const n = m.length;
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      assert.ok(isFinder(m, r, c), `version ${version}: missing finder at ${r},${c}`);
    }
    // The bottom-right corner carries data, not a finder. Checked structurally
    // rather than by sampling one module: that module's colour depends on the
    // payload, and it is dark for some of these fixtures.
    assert.equal(isFinder(m, n - 7, n - 7), false);
  }
});
