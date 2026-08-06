import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORMS,
  SUPPORT,
  ROLE,
  CAPABILITY_KEYS,
  capability,
  supports,
  capabilityMatrix,
  detectHostPlatform,
  hostPlatforms,
} from '../server/platform/capabilities.js';
import {
  percentToDbm,
  dbmToPercent,
  channelToBand,
  parseKeyValueBlock,
  pick,
  toNumber,
} from '../server/platform/wifi/common.js';
import { parseNetworks } from '../server/platform/wifi/win32.js';
import { parseProcNetWireless, splitTerse } from '../server/platform/wifi/linux.js';

/* ---------- capability matrix ---------- */

test('every platform declares every capability', () => {
  for (const [id, platform] of Object.entries(PLATFORMS)) {
    for (const key of CAPABILITY_KEYS) {
      assert.ok(platform.capabilities[key], `${id} is missing capability "${key}"`);
      assert.ok(
        Object.values(SUPPORT).includes(platform.capabilities[key].support),
        `${id}.${key} has an invalid support value`,
      );
    }
  }
});

test('capabilities encode the real platform differences', () => {
  // The headline asymmetry: Windows enumerates neighbouring APs, macOS refuses.
  assert.equal(capability('win32', 'scanAllAps').support, SUPPORT.FULL);
  assert.equal(capability('darwin', 'scanAllAps').support, SUPPORT.NONE);

  // ...but macOS reports a true noise floor and Windows reports none.
  assert.equal(capability('darwin', 'noiseFloor').support, SUPPORT.FULL);
  assert.equal(capability('win32', 'noiseFloor').support, SUPPORT.NONE);

  // Phones cannot read WiFi at all, yet carry sensors no laptop has.
  assert.equal(capability('android', 'connectedRssi').support, SUPPORT.NONE);
  assert.equal(capability('android', 'magnetometer').support, SUPPORT.PARTIAL);
  assert.equal(capability('darwin', 'magnetometer').support, SUPPORT.NONE);

  // Safari implements neither Web Bluetooth nor the sensor APIs.
  assert.equal(capability('ios', 'bleScan').support, SUPPORT.NONE);
  assert.equal(capability('ios', 'camera').support, SUPPORT.FULL);
});

test('unsupported capabilities explain themselves', () => {
  // A greyed-out control with no reason is the exact failure this guards.
  for (const [id, platform] of Object.entries(PLATFORMS)) {
    for (const key of CAPABILITY_KEYS) {
      const cap = platform.capabilities[key];
      if (cap.support === SUPPORT.PARTIAL) {
        assert.ok(cap.detail || cap.via, `${id}.${key} is partial but says nothing about why`);
      }
    }
  }
});

test('only host platforms can run the daemon', () => {
  const ids = hostPlatforms().map((p) => p.id).sort();
  assert.deepEqual(ids, ['darwin', 'linux', 'win32']);
  assert.equal(PLATFORMS.android.role, ROLE.GUEST);
  assert.equal(PLATFORMS.ios.role, ROLE.GUEST);
});

test('supports() is false only for genuinely impossible capabilities', () => {
  assert.equal(supports('win32', 'scanAllAps'), true);
  assert.equal(supports('darwin', 'scanAllAps'), false);
  assert.equal(supports('linux', 'scanAllAps'), true); // partial still counts
  assert.equal(supports('nonexistent', 'lanScan'), false);
});

test('capabilityMatrix covers every capability against every platform', () => {
  const matrix = capabilityMatrix();
  assert.equal(matrix.length, CAPABILITY_KEYS.length);
  for (const row of matrix) {
    assert.ok(row.label, `row ${row.key} has no label`);
    assert.deepEqual(Object.keys(row.byPlatform).sort(), Object.keys(PLATFORMS).sort());
  }
});

test('detectHostPlatform maps process.platform, defaulting unknown unixes to linux', () => {
  assert.equal(detectHostPlatform('darwin'), 'darwin');
  assert.equal(detectHostPlatform('win32'), 'win32');
  assert.equal(detectHostPlatform('linux'), 'linux');
  assert.equal(detectHostPlatform('freebsd'), 'linux');
  assert.equal(detectHostPlatform('sunos'), 'linux');
});

/* ---------- shared conversions ---------- */

test('percentToDbm follows the standard mapping and clamps out-of-range input', () => {
  assert.equal(percentToDbm(100), -50);
  assert.equal(percentToDbm(0), -100);
  assert.equal(percentToDbm(50), -75);
  assert.equal(percentToDbm(85), -57.5);
  assert.equal(percentToDbm(150), -50);
  assert.equal(percentToDbm(-20), -100);
});

test('dbmToPercent inverts percentToDbm across the mapped range', () => {
  for (const pct of [0, 25, 50, 75, 100]) {
    assert.equal(dbmToPercent(percentToDbm(pct)), pct);
  }
});

test('channelToBand infers the band from the channel number', () => {
  assert.equal(channelToBand(1), '2.4GHz');
  assert.equal(channelToBand(11), '2.4GHz');
  assert.equal(channelToBand(14), '2.4GHz');
  assert.equal(channelToBand(36), '5GHz');
  assert.equal(channelToBand(149), '5GHz');
  assert.equal(channelToBand(177), '5GHz');
  assert.equal(channelToBand(200), '6GHz');
  assert.equal(channelToBand(null), null);
});

test('parseKeyValueBlock keeps colons inside values', () => {
  const kv = parseKeyValueBlock('    BSSID  : 00:11:22:33:44:55\n    Signal : 92%\n');
  // Splitting on every colon would mangle every MAC address.
  assert.equal(kv.get('bssid'), '00:11:22:33:44:55');
  assert.equal(kv.get('signal'), '92%');
});

test('pick returns the first present alias and ignores empty values', () => {
  const kv = new Map([['signal', '92%'], ['rssi', '']]);
  assert.equal(pick(kv, 'rssi', 'signal'), '92%');
  assert.equal(pick(kv, 'missing'), null);
});

test('toNumber extracts signed numbers from noisy strings', () => {
  assert.equal(toNumber('92%'), 92);
  assert.equal(toNumber('-57 dBm'), -57);
  assert.equal(toNumber('720'), 720);
  assert.equal(toNumber('149 (5GHz, 80MHz)'), 149);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber('none'), null);
});

/* ---------- windows: netsh ---------- */

const NETSH_NETWORKS = `
Interface name : Wi-Fi
There are 3 networks currently visible.

SSID 1 : HomeNet
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 00:11:22:33:44:55
         Signal             : 92%
         Radio type         : 802.11ax
         Band               : 5 GHz
         Channel            : 149
    BSSID 2                 : 00:11:22:33:44:56
         Signal             : 60%
         Radio type         : 802.11n
         Band               : 2.4 GHz
         Channel            : 6

SSID 2 : NeighbourWifi
    Network type            : Infrastructure
    Authentication          : WPA3-Personal
    Encryption              : CCMP
    BSSID 1                 : AA:BB:CC:DD:EE:FF
         Signal             : 34%
         Radio type         : 802.11ac
         Band               : 5 GHz
         Channel            : 36

SSID 3 :
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None
    BSSID 1                 : 11:22:33:44:55:66
         Signal             : 12%
         Radio type         : 802.11n
         Band               : 2.4 GHz
         Channel            : 1
`;

test('parseNetworks reads every BSSID, including multiple radios per SSID', () => {
  const networks = parseNetworks(NETSH_NETWORKS);
  assert.equal(networks.length, 4);

  const strongest = networks[0];
  assert.equal(strongest.ssid, 'HomeNet');
  assert.equal(strongest.bssid, '00:11:22:33:44:55');
  assert.equal(strongest.signalPercent, 92);
  assert.equal(strongest.rssi, -54);
  assert.equal(strongest.channel, 149);
  assert.equal(strongest.band, '5 GHz');
  assert.equal(strongest.security, 'WPA2-Personal');
});

test('parseNetworks sorts by descending signal', () => {
  const rssis = parseNetworks(NETSH_NETWORKS).map((n) => n.rssi);
  assert.deepEqual(rssis, [...rssis].sort((a, b) => b - a));
});

test('parseNetworks marks a dual-band SSID as two separate radios', () => {
  const home = parseNetworks(NETSH_NETWORKS).filter((n) => n.ssid === 'HomeNet');
  assert.equal(home.length, 2);
  assert.deepEqual(home.map((n) => n.channel).sort((a, b) => a - b), [6, 149]);
});

test('parseNetworks labels a blank SSID as hidden rather than empty', () => {
  const hidden = parseNetworks(NETSH_NETWORKS).find((n) => n.bssid === '11:22:33:44:55:66');
  assert.equal(hidden.ssid, '<hidden>');
});

test('parseNetworks flags netsh values as approximate', () => {
  // netsh gives a percentage; every derived dBm must be marked inexact so the
  // UI renders it with a ~ instead of passing it off as a measurement.
  for (const network of parseNetworks(NETSH_NETWORKS)) {
    assert.equal(network.exact, false);
  }
});

test('parseNetworks tolerates empty and malformed input', () => {
  assert.deepEqual(parseNetworks(''), []);
  assert.deepEqual(parseNetworks('There are 0 networks currently visible.'), []);
});

/* ---------- linux: /proc/net/wireless and nmcli ---------- */

const PROC_NET_WIRELESS = `Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE
 face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22
 wlp3s0: 0000   62.  -48.  -256        0      0      0      0      0        0
`;

test('parseProcNetWireless reads true dBm from the kernel', () => {
  const result = parseProcNetWireless(PROC_NET_WIRELESS);
  assert.equal(result.interface, 'wlp3s0');
  assert.equal(result.link, 62);
  assert.equal(result.level, -48);
  // -256 is the "no valid reading" sentinel and must not become a real value.
  assert.equal(result.noise, null);
});

test('parseProcNetWireless keeps a genuine noise floor', () => {
  const withNoise = PROC_NET_WIRELESS.replace('-256', ' -92');
  assert.equal(parseProcNetWireless(withNoise).noise, -92);
});

test('parseProcNetWireless remaps unsigned-byte level values', () => {
  // Some older drivers report level as an unsigned byte: 208 means -48 dBm.
  const unsigned = PROC_NET_WIRELESS.replace('-48.', ' 208.');
  assert.equal(parseProcNetWireless(unsigned).level, -48);
});

test('parseProcNetWireless returns null when no interface is listed', () => {
  const headerOnly = PROC_NET_WIRELESS.split('\n').slice(0, 2).join('\n');
  assert.equal(parseProcNetWireless(headerOnly), null);
});

test('splitTerse preserves escaped colons inside BSSIDs', () => {
  // nmcli escapes the five colons in every MAC address; splitting naively
  // would turn one field into six.
  const line = 'yes:HomeNet:00\\:11\\:22\\:33\\:44\\:55:78:149:540 Mbit/s:WPA2';
  const fields = splitTerse(line);
  assert.equal(fields[0], 'yes');
  assert.equal(fields[1], 'HomeNet');
  assert.equal(fields[2], '00:11:22:33:44:55');
  assert.equal(fields[3], '78');
  assert.equal(fields[4], '149');
});

test('splitTerse handles empty fields', () => {
  assert.deepEqual(splitTerse('a::c'), ['a', '', 'c']);
  assert.deepEqual(splitTerse(''), ['']);
});
