/**
 * Renders a QR matrix as text.
 *
 * Half-block characters put two matrix rows in one terminal row, which keeps a
 * version 2 code at 13 lines instead of 25 -- small enough to sit in the startup
 * banner without scrolling it away.
 *
 * Colours are written explicitly rather than inherited: scanners need dark
 * modules on a light background, and most terminals are dark. The quiet zone is
 * four modules, as the specification requires -- without it, many scanners will
 * not lock on.
 */

const UPPER = '▀'; // upper half block
const LOWER = '▄'; // lower half block
const FULL = '█';
const RESET = '\x1b[0m';
const LIGHT_BG = '\x1b[47m'; // white background
const DARK_FG = '\x1b[30m'; // black foreground

export function renderQr(matrix, { quietZone = 4 } = {}) {
  const n = matrix.length;
  const size = n + quietZone * 2;
  const at = (r, c) => {
    const y = r - quietZone;
    const x = c - quietZone;
    return y >= 0 && y < n && x >= 0 && x < n ? matrix[y][x] : false;
  };

  const lines = [];
  for (let r = 0; r < size; r += 2) {
    let line = LIGHT_BG + DARK_FG;
    for (let c = 0; c < size; c++) {
      const top = at(r, c);
      const bottom = r + 1 < size ? at(r + 1, c) : false;
      // The cell background is light, so an unset half stays light.
      if (top && bottom) line += FULL;
      else if (top) line += UPPER;
      else if (bottom) line += LOWER;
      else line += ' ';
    }
    lines.push(line + RESET);
  }
  return lines.join('\n');
}
