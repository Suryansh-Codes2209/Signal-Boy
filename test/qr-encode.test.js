import test from 'node:test';
import assert from 'node:assert/strict';

import { pickVersion, toCodewords } from '../server/qr/encode.js';

test('picks the smallest version that fits', () => {
  assert.equal(pickVersion(10).version, 1);
  assert.equal(pickVersion(17).version, 1);
  assert.equal(pickVersion(18).version, 2);
  assert.equal(pickVersion(32).version, 2);
  assert.equal(pickVersion(53).version, 3);
  assert.equal(pickVersion(78).version, 4);
});

test('version metadata matches the level L single-block table', () => {
  assert.deepEqual(pickVersion(32), {
    version: 2,
    dataCodewords: 34,
    ecCodewords: 10,
    size: 25,
  });
});

test('refuses input too long for version 4', () => {
  assert.throws(() => pickVersion(79), /too long/i);
});

test('produces a full codeword block of data plus error correction', () => {
  const words = toCodewords('http://192.168.1.14:3000');
  // Version 2 at level L: 34 data + 10 EC.
  assert.equal(words.length, 44);
  assert.ok(words.every((b) => b >= 0 && b <= 255));
});

test('starts with the byte-mode indicator and length', () => {
  const text = 'HI';
  const words = toCodewords(text);
  // Mode 0100 then an 8-bit length: 0100 0000 0010 ....
  assert.equal(words[0], 0x40 | (text.length >> 4));
  assert.equal(words[1], ((text.length & 0x0f) << 4) | ('H'.charCodeAt(0) >> 4));
});

test('pads with the alternating pad bytes', () => {
  const words = toCodewords('HI');
  // Version 1 at level L is 19 data codewords; the tail must alternate.
  assert.equal(words[17], 0x11);
  assert.equal(words[18], 0xec);
});

test('the pad run starts at 0xEC even when the data ends on an odd codeword', () => {
  // Byte mode spends 2 codewords on the header, so odd-length text leaves the
  // pad run starting at an odd index. It must still start at 0xEC: keying the
  // alternation off the codeword index instead of the pad count inverts the
  // whole run for every odd-length input, which even-length fixtures miss.
  const words = toCodewords('https://192.168.1.14:3000'); // 25 bytes -> version 2
  assert.equal(words.length, 44);
  assert.deepEqual(words.slice(27, 34), [0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec]);
});
