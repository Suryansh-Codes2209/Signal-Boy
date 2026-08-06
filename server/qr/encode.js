import { remainder } from './galois.js';

/**
 * Byte-mode QR data encoding at error correction level L.
 *
 * Restricted to versions 1-4 deliberately: a LAN URL never exceeds 78 bytes,
 * and at level L those four versions each use a single error-correction block.
 * That removes data/ECC interleaving entirely -- the codeword stream is simply
 * the data block followed by its remainder.
 */

const VERSIONS = [
  { version: 1, dataCodewords: 19, ecCodewords: 7, size: 21 },
  { version: 2, dataCodewords: 34, ecCodewords: 10, size: 25 },
  { version: 3, dataCodewords: 55, ecCodewords: 15, size: 29 },
  { version: 4, dataCodewords: 80, ecCodewords: 20, size: 33 },
];

const PAD_BYTES = [0xec, 0x11];

/** Smallest version holding `byteLength` bytes, allowing 2 codewords of overhead. */
export function pickVersion(byteLength) {
  // Mode indicator (4 bits) + length (8 bits) = 12 bits, plus a 4-bit
  // terminator, rounds to 2 codewords of overhead.
  const found = VERSIONS.find((v) => byteLength + 2 <= v.dataCodewords);
  if (!found) throw new RangeError(`Text too long for a version 4 QR code: ${byteLength} bytes`);
  return { ...found };
}

export function toCodewords(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const spec = pickVersion(bytes.length);

  const bits = [];
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // count indicator is 8 bits for versions 1-9
  for (const b of bytes) push(b, 8);

  // Terminator, up to four zero bits, then pad to a byte boundary.
  const capacityBits = spec.dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  // Alternating pad bytes fill the remaining capacity.
  while (data.length < spec.dataCodewords) data.push(PAD_BYTES[data.length % 2 === 0 ? 0 : 1]);

  return [...data, ...remainder(data, spec.ecCodewords)];
}
