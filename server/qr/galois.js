/**
 * GF(256) arithmetic for QR Reed-Solomon error correction.
 *
 * Every byte except zero is a power of 2 in this field, so multiplication
 * becomes addition of logarithms and the whole thing reduces to two 256-entry
 * tables built once at module load. The primitive polynomial 0x11d is fixed by
 * the QR specification.
 */

const PRIMITIVE = 0x11d;

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIMITIVE;
  }
  EXP[255] = EXP[0];
}

export function exp(n) {
  return EXP[n % 255];
}

export function log(n) {
  if (n === 0) throw new RangeError('log(0) is undefined in GF(256)');
  return LOG[n];
}

export function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

/** The generator polynomial whose roots are a^0 .. a^(degree-1). */
export function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], exp(i));
    }
    poly = next;
  }
  return poly;
}

/** Polynomial long division; the remainder is the EC codeword block. */
export function remainder(data, degree) {
  const gen = generatorPoly(degree);
  const buf = [...data, ...new Array(degree).fill(0)];

  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], coef);
  }

  return buf.slice(data.length);
}
