import { pickVersion, toCodewords } from './encode.js';
import { buildMatrix } from './matrix.js';

/**
 * Encodes text as a QR matrix. `true` is a dark module.
 *
 * Byte mode, error correction level L, versions 1-4 -- enough for any LAN URL
 * and small enough to print in a terminal without wrapping.
 */
export function encodeQr(text) {
  const { version } = pickVersion([...new TextEncoder().encode(text)].length);
  return buildMatrix(toCodewords(text), version);
}
