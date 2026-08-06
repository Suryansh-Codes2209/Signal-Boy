/**
 * QR matrix construction: function patterns, data placement, masking and
 * format information, for versions 1-4 at error correction level L.
 *
 * Two omissions are deliberate and both follow from that range. Versions 1-4 at
 * level L use a single error-correction block, so the codeword stream is laid
 * down as-is with no data/ECC interleaving. And version information blocks only
 * exist from version 7, so none is written -- format information still is.
 */

const EC_LEVEL_L = 0b01;

/** BCH(15,5) generator and the fixed format mask, both from the specification. */
const FORMAT_GENERATOR = 0b10100110111;
const FORMAT_MASK = 0b101010000010010; // 0x5412

/** The eight mask predicates, indexed by mask number. `r` is row, `c` column. */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * Finder patterns, separators, timing patterns, the alignment pattern and the
 * dark module, plus reservations for the format information.
 *
 * `reserved` is what the data walk consults: every module it marks is a
 * function module and must be stepped over rather than written.
 */
function placeFunctionPatterns(size, version) {
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const set = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = dark;
    reserved[r][c] = true;
  };

  // Each finder is a 7x7 pattern; the -1..7 sweep also lays the one-module
  // light separator that surrounds it on the two inward sides.
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const ring = inside && (r === 0 || r === 6 || c === 0 || c === 6);
        const core = inside && r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(top + r, left + c, ring || core);
      }
    }
  }

  // Timing patterns: alternating modules bridging the finders along row 6 and
  // column 6, starting dark at an even coordinate.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Versions 2-4 carry exactly one 5x5 alignment pattern, centred at size - 7.
  if (version >= 2) {
    const centre = size - 7;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        set(centre + r, centre + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
      }
    }
  }

  // The dark module, always set, always here.
  set(4 * version + 9, 8, true);

  // Format information is written after masking, but its cells have to be
  // reserved now so the data walk skips them.
  const reserve = (r, c) => {
    if (!reserved[r][c]) reserved[r][c] = true;
  };
  for (let i = 0; i < 9; i++) {
    reserve(8, i);
    reserve(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    reserve(8, size - 1 - i);
    reserve(size - 1 - i, 8);
  }

  return { modules, reserved };
}

/**
 * Walks the codeword bits into the free modules: two columns at a time from the
 * bottom-right leftwards, alternating upward and downward, skipping column 6
 * because that is the vertical timing pattern.
 *
 * Returns the coordinates written, which is exactly the set of modules a mask
 * is allowed to flip.
 */
function placeData(modules, reserved, codewords, size) {
  const positions = [];
  let byteIndex = 0;
  let bitIndex = 7;
  let row = size - 1;
  let rowStep = -1;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // the vertical timing pattern is not a data column
    for (;;) {
      for (let offset = 0; offset < 2; offset++) {
        const c = col - offset;
        if (reserved[row][c]) continue;
        // Remainder bits past the end of the stream stay light.
        let dark = false;
        if (byteIndex < codewords.length) {
          dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
          if (--bitIndex < 0) {
            bitIndex = 7;
            byteIndex++;
          }
        }
        modules[row][c] = dark;
        positions.push([row, c]);
      }
      row += rowStep;
      if (row < 0 || row >= size) {
        row -= rowStep;
        rowStep = -rowStep;
        break;
      }
    }
  }

  return positions;
}

/** N1: runs of five or more same-coloured modules, in every row and column. */
function penaltyRuns(m, size) {
  let points = 0;
  const scoreRun = (length) => (length >= 5 ? 3 + (length - 5) : 0);

  for (let a = 0; a < size; a++) {
    let rowRun = 1;
    let colRun = 1;
    for (let b = 1; b < size; b++) {
      if (m[a][b] === m[a][b - 1]) {
        rowRun++;
      } else {
        points += scoreRun(rowRun);
        rowRun = 1;
      }
      if (m[b][a] === m[b - 1][a]) {
        colRun++;
      } else {
        points += scoreRun(colRun);
        colRun = 1;
      }
    }
    points += scoreRun(rowRun) + scoreRun(colRun);
  }
  return points;
}

/** N2: every 2x2 block of a single colour, counted at each position. */
function penaltyBlocks(m, size) {
  let points = 0;
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) points += 3;
    }
  }
  return points;
}

/**
 * N3: the finder-like 1:1:3:1:1 sequence with four light modules on one side,
 * which a scanner could mistake for a finder pattern.
 */
function penaltyFinderLike(m, size) {
  const PATTERN_A = 0b10111010000;
  const PATTERN_B = 0b00001011101;
  let points = 0;

  for (let a = 0; a < size; a++) {
    let rowBits = 0;
    let colBits = 0;
    for (let b = 0; b < size; b++) {
      rowBits = ((rowBits << 1) & 0x7ff) | (m[a][b] ? 1 : 0);
      colBits = ((colBits << 1) & 0x7ff) | (m[b][a] ? 1 : 0);
      if (b < 10) continue;
      if (rowBits === PATTERN_A || rowBits === PATTERN_B) points += 40;
      if (colBits === PATTERN_A || colBits === PATTERN_B) points += 40;
    }
  }
  return points;
}

/**
 * N4: ten points for every 5% the dark/light split deviates from even.
 *
 * Implementations differ here. This is the specification's reading -- whole 5%
 * steps away from 50%, in either direction -- which is also what ZXing does.
 * Some encoders round the ratio up instead, which penalises anything above 50%
 * by a step and occasionally selects a different mask. Either choice scans:
 * masking is a quality heuristic and the decoder reads the mask number out of
 * the format information regardless.
 */
function penaltyBalance(m, size) {
  let dark = 0;
  for (const row of m) for (const cell of row) if (cell) dark++;
  const percent = (dark * 100) / (size * size);
  return Math.floor(Math.abs(percent - 50) / 5) * 10;
}

function penalty(m, size) {
  return penaltyRuns(m, size) + penaltyBlocks(m, size) + penaltyFinderLike(m, size) + penaltyBalance(m, size);
}

/** 15 format bits: EC level, mask number, BCH(15,5) check bits, XOR 0x5412. */
function formatBits(mask) {
  const data = (EC_LEVEL_L << 3) | mask;
  let rest = data << 10;
  const degree = (n) => (n === 0 ? 0 : 32 - Math.clz32(n));
  while (degree(rest) >= degree(FORMAT_GENERATOR)) {
    rest ^= FORMAT_GENERATOR << (degree(rest) - degree(FORMAT_GENERATOR));
  }
  return (((data << 10) | rest) ^ FORMAT_MASK) & 0x7fff;
}

/**
 * Writes the format information twice: down the left of the top-left finder and
 * across its top, then mirrored along the top-right and bottom-left finders.
 * Bit 0 is the least significant bit of the 15-bit sequence.
 */
function placeFormatInfo(m, size, mask) {
  const bits = formatBits(mask);
  const bit = (i) => ((bits >> i) & 1) === 1;

  for (let i = 0; i < 15; i++) {
    // Vertical copy: down column 8, hopping over the timing module at row 6.
    if (i < 6) m[i][8] = bit(i);
    else if (i < 8) m[i + 1][8] = bit(i);
    else m[size - 15 + i][8] = bit(i);

    // Horizontal copy: leftwards along row 8 from the right edge, then the
    // tail wraps back to the top-left, again hopping the timing module.
    if (i < 8) m[8][size - 1 - i] = bit(i);
    else if (i < 9) m[8][15 - i] = bit(i);
    else m[8][14 - i] = bit(i);
  }
}

/**
 * Builds the finished matrix for `codewords`: function patterns, data, the
 * lowest-penalty mask of the eight, and format information. `true` is dark.
 */
export function buildMatrix(codewords, version) {
  const size = 4 * version + 17;
  const { modules, reserved } = placeFunctionPatterns(size, version);
  const dataPositions = placeData(modules, reserved, codewords, size);

  let best = null;
  for (let mask = 0; mask < MASKS.length; mask++) {
    const candidate = modules.map((row) => [...row]);
    const flip = MASKS[mask];
    for (const [r, c] of dataPositions) if (flip(r, c)) candidate[r][c] = !candidate[r][c];
    placeFormatInfo(candidate, size, mask);

    const score = penalty(candidate, size);
    if (best === null || score < best.score) best = { score, matrix: candidate };
  }

  return best.matrix;
}
