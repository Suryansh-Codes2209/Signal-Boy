import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rssiToHeightFraction,
  channelToXFraction,
  buildSpectrum,
  spectrumByBand,
  CHANNEL_RANGE,
} from '../public/js/render/spectrum-map.js';

const ap = (ssid, channel, band, rssi) => ({ ssid, bssid: `x-${ssid}`, channel, band, rssi, security: 'WPA2' });

test('rssiToHeightFraction maps the usable range onto 0..1 and clamps', () => {
  assert.equal(rssiToHeightFraction(-90), 0);
  assert.equal(rssiToHeightFraction(-30), 1);
  assert.ok(Math.abs(rssiToHeightFraction(-60) - 0.5) < 1e-9);
  assert.equal(rssiToHeightFraction(-200), 0, 'clamped, never negative');
  assert.equal(rssiToHeightFraction(0), 1, 'clamped, never over 1');
  assert.equal(rssiToHeightFraction(null), 0);
});

test('channelToXFraction places the band edges at 0 and 1', () => {
  const [lo, hi] = CHANNEL_RANGE['2.4GHz'];
  assert.equal(channelToXFraction(lo, '2.4GHz'), 0);
  assert.equal(channelToXFraction(hi, '2.4GHz'), 1);
  assert.ok(channelToXFraction(6, '2.4GHz') > 0 && channelToXFraction(6, '2.4GHz') < 1);
});

test('channelToXFraction clamps out-of-range channels rather than drawing off-axis', () => {
  assert.equal(channelToXFraction(0, '2.4GHz'), 0);
  assert.equal(channelToXFraction(999, '2.4GHz'), 1);
  assert.equal(channelToXFraction(6, 'nonsense-band'), null);
});

test('buildSpectrum keeps only the requested band and maps every AP to a point', () => {
  const spectrum = buildSpectrum(
    [ap('A', 1, '2.4GHz', -50), ap('B', 36, '5GHz', -55), ap('C', 11, '2.4GHz', -70)],
    '2.4GHz',
  );
  assert.equal(spectrum.band, '2.4GHz');
  assert.deepEqual(
    spectrum.points.map((p) => p.ssid),
    ['A', 'C'],
    'the 5GHz AP is excluded',
  );
  const a = spectrum.points.find((p) => p.ssid === 'A');
  assert.equal(a.channel, 1);
  assert.ok(a.heightFraction > 0 && a.xFraction === 0);
  assert.ok(Number.isInteger(a.shade));
});

test('buildSpectrum on a band with no APs returns an empty point list, not a crash', () => {
  const spectrum = buildSpectrum([ap('A', 36, '5GHz', -50)], '6GHz');
  assert.deepEqual(spectrum.points, []);
});

test('spectrumByBand returns one entry per band that actually has APs, busiest first', () => {
  const byBand = spectrumByBand([
    ap('A', 1, '2.4GHz', -50),
    ap('B', 6, '2.4GHz', -55),
    ap('C', 36, '5GHz', -60),
  ]);
  assert.deepEqual(
    byBand.map((s) => s.band),
    ['2.4GHz', '5GHz'],
    '2.4GHz has more APs so it leads',
  );
  assert.equal(byBand[0].points.length, 2);
});
