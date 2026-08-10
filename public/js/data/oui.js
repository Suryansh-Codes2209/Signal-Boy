/**
 * A small, hand-picked map of 24-bit OUI prefixes to consumer network-gear
 * vendors, used only to put a friendly name next to a BSSID in the rogue-AP
 * panel. It is deliberately NOT a full IEEE registry (that is tens of thousands
 * of entries) -- it is a display aid, so an unknown prefix simply shows no
 * vendor rather than a wrong one. The rogue detector never keys a decision on a
 * name from here; it compares raw OUI prefixes, which works whether or not the
 * vendor is listed.
 *
 * Keys are lowercase "aa:bb:cc". Each vendor owns many prefixes; only a few
 * common ones are listed per vendor.
 */
export const OUI_VENDORS = {
  '00:1a:11': 'Google',
  '00:1d:d8': 'Microsoft',
  '00:50:f2': 'Microsoft',
  '00:03:93': 'Apple',
  '00:1b:63': 'Apple',
  'a4:83:e7': 'Apple',
  '00:09:5b': 'Netgear',
  '00:14:6c': 'Netgear',
  '20:e5:2a': 'Netgear',
  '00:14:bf': 'Linksys',
  '00:25:9c': 'Linksys',
  '00:1d:7e': 'Cisco-Linksys',
  '00:18:0a': 'Cisco Meraki',
  'e0:55:3d': 'Cisco Meraki',
  '00:0c:42': 'MikroTik',
  '00:1c:df': 'Belkin',
  '00:26:5a': 'D-Link',
  '1c:bd:b9': 'D-Link',
  '00:1f:33': 'Netgear',
  '50:c7:bf': 'TP-Link',
  'a4:2b:b0': 'TP-Link',
  '00:0e:8e': 'ASUS',
  '2c:56:dc': 'ASUS',
  '04:18:d6': 'Ubiquiti',
  '24:a4:3c': 'Ubiquiti',
  'fc:ec:da': 'Ubiquiti',
  '18:e8:29': 'Ubiquiti',
  '00:24:6c': 'Aruba',
  '24:de:c6': 'Aruba',
  '00:1d:0f': 'Ruckus',
  '2c:e6:cc': 'Amazon',
  'fc:a1:83': 'Amazon',
  '50:ec:50': 'Google Nest',
  '00:c0:ca': 'Alfa',
};
