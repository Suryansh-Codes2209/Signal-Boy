import test from 'node:test';
import assert from 'node:assert/strict';

import { ouiOf, detectRogues } from '../public/js/sources/rogue-detect.js';

const ap = (ssid, bssid, security, extra = {}) => ({
  ssid,
  bssid,
  security,
  rssi: -50,
  channel: 6,
  band: '2.4GHz',
  ...extra,
});

test('ouiOf extracts the 24-bit vendor prefix, or null for junk', () => {
  assert.equal(ouiOf('a4:2b:8c:00:11:22'), 'a4:2b:8c');
  assert.equal(ouiOf('A4:2B:8C:00:11:22'), 'a4:2b:8c', 'case-insensitive');
  assert.equal(ouiOf(null), null);
  assert.equal(ouiOf('not-a-mac'), null);
});

test('an open network sharing a secured SSID is flagged high (evil-twin lure)', () => {
  const findings = detectRogues([
    ap('HOME', 'aa:bb:cc:00:00:01', 'WPA2-PSK-CCMP'),
    ap('HOME', '11:22:33:00:00:02', 'OPEN'),
  ]);
  const f = findings.find((x) => x.ssid === 'HOME');
  assert.ok(f, 'the twin should be reported');
  assert.equal(f.severity, 'high');
  assert.match(f.reason, /OPEN/i);
});

test('a single access point is never a finding', () => {
  assert.deepEqual(detectRogues([ap('HOME', 'aa:bb:cc:00:00:01', 'WPA2')]), []);
});

test('the same secured SSID roaming across same-vendor APs is not flagged', () => {
  const findings = detectRogues([
    ap('OFFICE', 'aa:bb:cc:00:00:01', 'WPA2', { channel: 1 }),
    ap('OFFICE', 'aa:bb:cc:00:00:09', 'WPA2', { channel: 11 }),
  ]);
  assert.deepEqual(findings, []);
});

test('a WPA2/WPA3 transition network (two secured types, no open) is not flagged', () => {
  const findings = detectRogues([
    ap('SECURE', 'aa:bb:cc:00:00:01', 'WPA2-PSK-CCMP'),
    ap('SECURE', 'aa:bb:cc:00:00:01', 'RSN-SAE-CCMP'),
  ]);
  assert.deepEqual(findings, []);
});

test('the same SSID across different vendor prefixes is flagged as suspicious', () => {
  const findings = detectRogues([
    ap('CAFE', 'aa:bb:cc:00:00:01', 'WPA2'),
    ap('CAFE', 'de:ad:be:00:00:02', 'WPA2'),
  ]);
  const f = findings.find((x) => x.ssid === 'CAFE');
  assert.ok(f);
  assert.equal(f.severity, 'medium');
  assert.match(f.reason, /VENDOR/i);
});

test('hidden networks are never grouped into a finding', () => {
  const findings = detectRogues([
    ap(null, 'aa:bb:cc:00:00:01', 'OPEN'),
    ap(null, 'de:ad:be:00:00:02', 'WPA2'),
  ]);
  assert.deepEqual(findings, []);
});

test('findings are ordered worst-first', () => {
  const findings = detectRogues([
    ap('A', 'aa:bb:cc:00:00:01', 'WPA2'),
    ap('A', 'de:ad:be:00:00:02', 'WPA2'), // vendor mismatch -> medium
    ap('B', 'aa:bb:cc:00:00:03', 'WPA2'),
    ap('B', 'aa:bb:cc:00:00:04', 'OPEN'), // open twin -> high
  ]);
  assert.equal(findings[0].ssid, 'B', 'the high-severity twin should sort first');
  assert.equal(findings[1].ssid, 'A');
});
