import test from 'node:test';
import assert from 'node:assert/strict';

import { renderQr } from '../server/qr/terminal.js';

// Plain boolean matrices, not encoder output: the renderer's job is independent
// of what the modules mean. Chosen so one line carries all three block glyphs.
const M = [
  [true, true, false],
  [true, false, true],
  [false, false, true],
];

const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
const lines = (text, options) => strip(renderQr(text, options)).split('\n');

/** Parses the half-block glyphs back into the full grid, quiet zone included. */
function parse(matrix, options = {}) {
  const quietZone = options.quietZone ?? 4;
  const size = matrix.length + quietZone * 2;
  const grid = Array.from({ length: size }, () => new Array(size).fill(false));
  lines(matrix, options).forEach((line, index) => {
    [...line].forEach((glyph, c) => {
      const top = glyph === '█' || glyph === '▀';
      const bottom = glyph === '█' || glyph === '▄';
      if (index * 2 < size) grid[index * 2][c] = top;
      if (index * 2 + 1 < size) grid[index * 2 + 1][c] = bottom;
    });
  });
  return grid;
}

test('packs two matrix rows per line and pads to the quiet zone', () => {
  const rendered = lines(M);
  // 3 modules plus a 4-module quiet zone on each side is 11 rows and columns,
  // and two rows share a line.
  assert.equal(rendered.length, 6);
  for (const line of rendered) assert.equal([...line].length, 11);
});

test('surrounds the code with exactly four light modules on every side', () => {
  const grid = parse(M);
  const size = grid.length;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const inside = i >= 4 && i < 4 + M.length && j >= 4 && j < 4 + M.length;
      if (!inside) assert.equal(grid[i][j], false, `module ${i},${j} should be light`);
    }
  }
  // ...and the code itself survives the round trip unchanged.
  const inner = M.map((_, r) => M.map((_, c) => grid[r + 4][c + 4]));
  assert.deepEqual(inner, M);
});

test('honours a non-default quiet zone', () => {
  const rendered = lines(M, { quietZone: 2 });
  assert.equal(rendered.length, 4); // 3 + 2*2 = 7 rows -> 4 lines
  for (const line of rendered) assert.equal([...line].length, 7);

  const grid = parse(M, { quietZone: 2 });
  const inner = M.map((_, r) => M.map((_, c) => grid[r + 2][c + 2]));
  assert.deepEqual(inner, M);
});

test('maps each dark/light pair to the right half block', () => {
  // Line 2 covers matrix rows 0 and 1, offset by the 4-module quiet zone.
  const row = [...lines(M)[2]];
  assert.equal(row[4], '█'); // dark over dark
  assert.equal(row[5], '▀'); // dark over light
  assert.equal(row[6], '▄'); // light over dark
  assert.equal(row[3], ' '); // light over light, in the quiet zone
});

test('writes explicit dark-on-light colours around every line', () => {
  // Scanners need dark modules on a light background and most terminals are
  // dark, so the escapes are load-bearing rather than decorative. Asserted as
  // raw bytes because an ESC lost in transcription still looks right in a diff.
  for (const line of renderQr(M).split('\n')) {
    assert.ok(line.startsWith('\x1b[47m\x1b[30m'), 'line must open light-bg dark-fg');
    assert.ok(line.endsWith('\x1b[0m'), 'line must reset');
  }
});
