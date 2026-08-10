import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bandCounts,
  channelUsage,
  recommend24Channel,
  analyzeWifi,
  NON_OVERLAPPING_24,
} from '../public/js/sources/wifi-analyze.js';

// The shape mapScanResults() in android-map.js produces: one entry per AP with
// ssid/bssid/rssi/channel/band/security already derived.
const net = (channel, band, rssi, ssid = 'AP') => ({ ssid, bssid: `x-${ssid}-${channel}`, rssi, channel, band, security: 'WPA2' });

test('bandCounts sorts access points into their radio bands', () => {
  const counts = bandCounts([
    net(1, '2.4GHz', -50),
    net(6, '2.4GHz', -60),
    net(36, '5GHz', -55),
    net(37, '6GHz', -70),
    { ssid: 'GHOST', bssid: 'g', rssi: -80, channel: null, band: null, security: 'OPEN' },
  ]);
  assert.equal(counts['2.4GHz'], 2);
  assert.equal(counts['5GHz'], 1);
  assert.equal(counts['6GHz'], 1);
  assert.equal(counts.unknown, 1, 'an AP with no band is counted honestly, not dropped');
});

test('channelUsage counts APs per channel within each band', () => {
  const usage = channelUsage([
    net(1, '2.4GHz', -50),
    net(1, '2.4GHz', -55),
    net(6, '2.4GHz', -60),
    net(36, '5GHz', -55),
  ]);
  assert.equal(usage['2.4GHz'][1], 2);
  assert.equal(usage['2.4GHz'][6], 1);
  assert.equal(usage['5GHz'][36], 1);
});

test('recommend24Channel returns one of the three non-overlapping channels', () => {
  const rec = recommend24Channel([net(1, '2.4GHz', -40), net(6, '2.4GHz', -45)]);
  assert.ok(NON_OVERLAPPING_24.includes(rec.channel));
});

test('recommend24Channel steers away from the crowded channels', () => {
  // Everything is piled onto 1 and 6; 11 is clear, so 11 should win.
  const rec = recommend24Channel([
    net(1, '2.4GHz', -40),
    net(1, '2.4GHz', -42),
    net(3, '2.4GHz', -45), // overlaps 1 and 6
    net(6, '2.4GHz', -41),
    net(6, '2.4GHz', -44),
  ]);
  assert.equal(rec.channel, 11);
});

test('recommend24Channel weighs a strong nearby AP as more interference than a faint one', () => {
  // A loud AP on 1 and a faint one on 11. Channel 6 is clear of both and wins,
  // but the point under test is the weighting: sitting *on* 1 (under the loud
  // AP) must score worse than sitting on 11 (under the faint one).
  const rec = recommend24Channel([net(1, '2.4GHz', -35), net(11, '2.4GHz', -85)]);
  const all = [{ channel: rec.channel, score: rec.score }, ...rec.alternatives];
  const scoreOf = (ch) => all.find((a) => a.channel === ch).score;
  assert.ok(scoreOf(1) > scoreOf(11), 'the loud neighbour should make channel 1 the worse seat');
});

test('recommend24Channel is null when there is no 2.4GHz to advise on', () => {
  assert.equal(recommend24Channel([net(36, '5GHz', -50)]), null);
});

test('analyzeWifi reports the busiest channel and total, tolerating channel-less APs', () => {
  const summary = analyzeWifi([
    net(1, '2.4GHz', -50),
    net(1, '2.4GHz', -52),
    net(1, '2.4GHz', -54),
    net(36, '5GHz', -55),
    { ssid: 'GHOST', bssid: 'g', rssi: -80, channel: null, band: null, security: 'OPEN' },
  ]);
  assert.equal(summary.total, 5);
  assert.equal(summary.busiest.band, '2.4GHz');
  assert.equal(summary.busiest.channel, 1);
  assert.equal(summary.busiest.count, 3);
  assert.ok(NON_OVERLAPPING_24.includes(summary.recommend24.channel));
});

test('analyzeWifi on an empty scan is empty, not a crash', () => {
  const summary = analyzeWifi([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.busiest, null);
  assert.equal(summary.recommend24, null);
});
