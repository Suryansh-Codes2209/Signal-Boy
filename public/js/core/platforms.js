/**
 * What each platform can actually sense.
 *
 * This is the honest core of Signal Boy. Capabilities differ sharply by OS and
 * they do NOT form a hierarchy -- Windows sees every nearby access point while
 * macOS refuses to; a phone has a magnetometer and a rear camera that no
 * laptop has. The UI reads this matrix to decide what to show, what to grey
 * out, and what caveat to print next to a number.
 *
 * Pure data and pure functions: no I/O, no process access. Lives under the web
 * root because the browser and the Android WebView need it as much as the
 * daemon does, and public/ is the only directory both can reach.
 */

/** Levels of support for a single capability. */
export const SUPPORT = {
  FULL: 'full', // works, exact values
  PARTIAL: 'partial', // works, but degraded/approximate/permission-gated
  NONE: 'none', // not possible on this platform
};

/**
 * Devices that measure their own WiFi signal locally (host) vs. devices that
 * can only open the UI and read someone else's measurements over the network
 * (guest). Originally this meant "runs the Node daemon", but androidApp is a
 * host with no Node runtime at all -- WifiManager reads the radio directly, in
 * process, instead of shelling out the way the desktop backends do. Guests
 * still see all host sensor data over the network -- the split only governs
 * which sensors run locally.
 */
export const ROLE = { HOST: 'host', GUEST: 'guest' };

export const PLATFORMS = {
  darwin: {
    id: 'darwin',
    label: 'MACOS',
    role: ROLE.HOST,
    note: 'Apple removed the airport CLI in 14.4 and now treats WiFi metadata as location data. Only the connected network reports signal; other APs are redacted.',
    capabilities: {
      connectedRssi: {
        support: SUPPORT.FULL,
        exact: true,
        via: 'system_profiler SPAirPortDataType',
        detail: 'Real dBm signal and noise, no sudo.',
      },
      scanAllAps: {
        support: SUPPORT.NONE,
        via: null,
        detail: 'SSIDs come back <redacted> with no signal values. Needs a Developer-ID-signed helper with Location permission.',
      },
      ssidVisible: {
        support: SUPPORT.NONE,
        detail: 'Connected SSID is redacted for unsigned processes.',
      },
      noiseFloor: { support: SUPPORT.FULL, detail: 'Reports a real noise floor, so true SNR is available.' },
      lanScan: { support: SUPPORT.FULL, via: 'ping sweep + arp' },
      mdns: { support: SUPPORT.FULL, via: 'native UDP 5353' },
      bleScan: { support: SUPPORT.PARTIAL, detail: 'Needs a native CoreBluetooth binding; macOS will prompt for Bluetooth permission.' },
      cellInfo: { support: SUPPORT.NONE, detail: 'Desktops and laptops have no cellular modem.' },
      linkQuality: { support: SUPPORT.FULL, detail: 'Stability and variance of the connected reading over time -- no packets sent.' },
      activeThroughput: { support: SUPPORT.NONE, detail: 'The opt-in active throughput test is built for the APK only.' },
      ranging: { support: SUPPORT.NONE, detail: 'Desktop WiFi and Bluetooth stacks expose no ranging API.' },
      camera: { support: SUPPORT.FULL, detail: 'Front-facing webcam only -- awkward for sweeping a room.' },
      magnetometer: { support: SUPPORT.NONE, detail: 'No magnetometer in Mac hardware.' },
    },
  },

  win32: {
    id: 'win32',
    label: 'WINDOWS',
    role: ROLE.HOST,
    note: 'The most capable platform for WiFi surveying. netsh lists every visible access point with SSID, BSSID and signal, with no admin rights.',
    capabilities: {
      connectedRssi: {
        support: SUPPORT.FULL,
        exact: false,
        via: 'netsh wlan show interfaces',
        detail: 'Newer Windows 11 builds print RSSI in dBm directly. Older builds give a percentage, converted as dBm = pct/2 - 100 (an approximation, shown with a ~ prefix).',
      },
      scanAllAps: {
        support: SUPPORT.FULL,
        via: 'netsh wlan show networks mode=bssid',
        detail: 'Full neighbour scan: SSID, BSSID, band, channel and signal for every visible AP. No admin required.',
      },
      ssidVisible: { support: SUPPORT.FULL },
      noiseFloor: { support: SUPPORT.NONE, detail: 'netsh reports no noise floor, so SNR cannot be computed -- only signal.' },
      lanScan: { support: SUPPORT.FULL, via: 'ping sweep + arp -a' },
      mdns: { support: SUPPORT.FULL, via: 'native UDP 5353' },
      bleScan: { support: SUPPORT.PARTIAL, detail: 'Needs a native binding, or Web Bluetooth in Chrome.' },
      cellInfo: { support: SUPPORT.NONE, detail: 'Desktops and laptops have no cellular modem.' },
      linkQuality: { support: SUPPORT.FULL, detail: 'Stability and variance of the connected reading over time -- no packets sent.' },
      activeThroughput: { support: SUPPORT.NONE, detail: 'The opt-in active throughput test is built for the APK only.' },
      ranging: { support: SUPPORT.NONE, detail: 'Desktop WiFi and Bluetooth stacks expose no ranging API.' },
      camera: { support: SUPPORT.FULL },
      magnetometer: { support: SUPPORT.NONE },
    },
  },

  linux: {
    id: 'linux',
    label: 'LINUX',
    role: ROLE.HOST,
    note: '/proc/net/wireless exposes true dBm with no root. Neighbour scanning works through NetworkManager where present.',
    capabilities: {
      connectedRssi: {
        support: SUPPORT.FULL,
        exact: true,
        via: '/proc/net/wireless, nmcli',
        detail: 'Real dBm from the kernel, no root needed.',
      },
      scanAllAps: {
        support: SUPPORT.PARTIAL,
        via: 'nmcli dev wifi list',
        detail: 'Available where NetworkManager runs; reports signal as a percentage. `iw scan` gives exact dBm but usually needs root.',
      },
      ssidVisible: { support: SUPPORT.FULL },
      noiseFloor: { support: SUPPORT.PARTIAL, detail: 'Driver-dependent; many report an invalid noise value.' },
      lanScan: { support: SUPPORT.FULL, via: 'ping sweep + ip neigh' },
      mdns: { support: SUPPORT.FULL, via: 'native UDP 5353' },
      bleScan: { support: SUPPORT.PARTIAL, detail: 'Via BlueZ; may need capabilities granted to the node binary.' },
      cellInfo: { support: SUPPORT.NONE, detail: 'Desktops and laptops have no cellular modem.' },
      linkQuality: { support: SUPPORT.FULL, detail: 'Stability and variance of the connected reading over time -- no packets sent.' },
      activeThroughput: { support: SUPPORT.NONE, detail: 'The opt-in active throughput test is built for the APK only.' },
      ranging: { support: SUPPORT.NONE, detail: 'Desktop WiFi and Bluetooth stacks expose no ranging API.' },
      camera: { support: SUPPORT.FULL },
      magnetometer: { support: SUPPORT.NONE },
    },
  },

  android: {
    id: 'android',
    label: 'ANDROID',
    role: ROLE.GUEST,
    note: 'Cannot run the daemon, but carries sensors no laptop has. Best device for physically hunting a camera or a beacon once the survey is done.',
    capabilities: {
      connectedRssi: { support: SUPPORT.NONE, detail: 'No browser API exposes WiFi signal. Shows the host daemon\'s readings instead.' },
      scanAllAps: { support: SUPPORT.NONE },
      ssidVisible: { support: SUPPORT.NONE },
      noiseFloor: { support: SUPPORT.NONE },
      lanScan: { support: SUPPORT.NONE, detail: 'Browsers cannot send ARP or raw pings. Uses the host daemon\'s scan.' },
      mdns: { support: SUPPORT.NONE },
      bleScan: {
        support: SUPPORT.PARTIAL,
        via: 'Web Bluetooth requestLEScan',
        detail: 'Chrome on Android, with chrome://flags/#enable-experimental-web-platform-features enabled.',
      },
      cellInfo: { support: SUPPORT.NONE, detail: 'No browser API exposes cell info; the Android APK reads it instead.' },
      linkQuality: { support: SUPPORT.PARTIAL, detail: "Shows the host daemon's link stability, not this device's own radio." },
      activeThroughput: { support: SUPPORT.NONE, detail: 'The native throughput test is APK-only; a browser cannot run it.' },
      ranging: { support: SUPPORT.NONE, detail: 'No browser API exposes ranging; the Android APK reads it instead.' },
      camera: { support: SUPPORT.FULL, detail: 'Rear camera makes lens-glint sweeping genuinely practical.' },
      magnetometer: {
        support: SUPPORT.PARTIAL,
        via: 'Magnetometer API',
        detail: 'Detects the magnetic field of motors and speakers in concealed devices. Requires HTTPS or a trusted-origin exception.',
      },
    },
  },

  ios: {
    id: 'ios',
    label: 'IPHONE',
    role: ROLE.GUEST,
    note: 'Safari blocks Web Bluetooth and the generic sensor APIs outright. The camera is the only usable sensor.',
    capabilities: {
      connectedRssi: { support: SUPPORT.NONE, detail: 'Shows the host daemon\'s readings instead.' },
      scanAllAps: { support: SUPPORT.NONE },
      ssidVisible: { support: SUPPORT.NONE },
      noiseFloor: { support: SUPPORT.NONE },
      lanScan: { support: SUPPORT.NONE },
      mdns: { support: SUPPORT.NONE },
      bleScan: { support: SUPPORT.NONE, detail: 'Safari does not implement Web Bluetooth and Apple has stated it will not.' },
      cellInfo: { support: SUPPORT.NONE, detail: 'Safari exposes no telephony API.' },
      linkQuality: { support: SUPPORT.PARTIAL, detail: "Shows the host daemon's link stability, not this device's own radio." },
      activeThroughput: { support: SUPPORT.NONE, detail: 'The native throughput test is APK-only; a browser cannot run it.' },
      ranging: { support: SUPPORT.NONE, detail: 'No browser API exposes ranging; the Android APK reads it instead.' },
      camera: { support: SUPPORT.FULL, detail: 'Rear camera works for lens-glint sweeping.' },
      magnetometer: { support: SUPPORT.NONE, detail: 'Safari does not expose the Magnetometer API.' },
    },
  },

  androidApp: {
    id: 'androidApp',
    label: 'ANDROID APP',
    role: ROLE.HOST,
    note: 'The only platform that measures where you are actually standing. WifiManager gives exact dBm with no permission at all, and exact per-AP dBm with one -- but scans are throttled to 4 per 2 minutes and no noise floor is exposed.',
    capabilities: {
      connectedRssi: {
        support: SUPPORT.FULL,
        exact: true,
        via: 'WifiManager.getConnectionInfo()',
        detail: 'Real dBm, no permission required.',
      },
      scanAllAps: {
        support: SUPPORT.FULL,
        exact: true,
        via: 'WifiManager.getScanResults()',
        detail: 'Exact dBm per access point, unlike netsh. Hard-throttled to 4 scans per 2 minutes, so the list is refreshed on demand rather than live. API 33+ scans under NEARBY_WIFI_DEVICES (declared neverForLocation), no location grant needed; API 32 and below need ACCESS_FINE_LOCATION.',
      },
      ssidVisible: {
        support: SUPPORT.PARTIAL,
        detail: 'Android classifies WiFi identity as location data. Without the location grant, SSID reads <unknown ssid> and BSSID reads 02:00:00:00:00:00.',
      },
      noiseFloor: { support: SUPPORT.NONE, detail: 'AOSP exposes no noise floor, so SNR cannot be computed.' },
      lanScan: { support: SUPPORT.NONE, detail: 'No Node runtime in the APK; raw sockets are unavailable to a WebView.' },
      mdns: { support: SUPPORT.NONE, detail: 'No Node runtime in the APK.' },
      bleScan: {
        support: SUPPORT.FULL,
        via: 'BluetoothLeScanner.startScan()',
        detail:
          'Continuous, no OS throttle -- unlike the WiFi scan above. Finds only devices that advertise; hidden cameras are ' +
          'usually WiFi, not BLE. No distance is derived, RSSI only. Most trackers rotate their MAC every ~15 min, so a ' +
          'device is followable within that window, not across a long hunt.',
      },
      camera: {
        support: SUPPORT.NONE,
        detail: 'getUserMedia needs android.permission.CAMERA plus a WebChromeClient.onPermissionRequest handler. Neither is planned; the APK ships WiFi sensing only.',
      },
      magnetometer: {
        support: SUPPORT.PARTIAL,
        detail: 'The Magnetometer API is behind a Chrome flag and is not exposed in a WebView by default, same as the android (browser) entry on the same handset.',
      },
      cellInfo: {
        support: SUPPORT.FULL,
        via: 'TelephonyManager.getAllCellInfo()',
        detail:
          'Read-only serving and neighbour cells with band and RSRP/RSRQ. Needs READ_PHONE_STATE plus the ' +
          'location grant for cell identity. There is no transmit path -- the baseband is locked firmware, so ' +
          'the modem can be read but never made to emit.',
      },
      linkQuality: {
        support: SUPPORT.FULL,
        via: 'WifiManager',
        detail: 'Passive stability of the connected RSSI and link rate over time -- reads the radio, sends no packets.',
      },
      activeThroughput: {
        support: SUPPORT.FULL,
        via: 'HttpURLConnection',
        detail:
          'Opt-in latency/jitter/throughput test against a URL you enter. Adds the INTERNET permission and runs ' +
          'only after an explicit on-screen consent gate; the app is otherwise fully offline.',
      },
      ranging: {
        support: SUPPORT.PARTIAL,
        via: 'RangingManager',
        detail:
          'True measured distance in metres, not an RSSI guess -- the one reading in HUNT that is timed rather ' +
          'than inferred. Needs Android 16, and needs the peer to answer: a device whose radio does not ' +
          'implement Channel Sounding simply produces no fix, which is most of what HUNT finds. UWB is not ' +
          'used yet, so there is still no direction.',
      },
    },
  },
};

/** Every capability key, in the order the UI should list them. */
export const CAPABILITY_KEYS = [
  'connectedRssi',
  'scanAllAps',
  'ssidVisible',
  'noiseFloor',
  'lanScan',
  'mdns',
  'bleScan',
  'cellInfo',
  'linkQuality',
  'activeThroughput',
  'ranging',
  'camera',
  'magnetometer',
];

export const CAPABILITY_LABELS = {
  connectedRssi: 'OWN SIGNAL',
  scanAllAps: 'SCAN ALL APS',
  ssidVisible: 'SEE SSID',
  noiseFloor: 'NOISE / SNR',
  lanScan: 'LAN SCAN',
  mdns: 'MDNS',
  bleScan: 'BLE SCAN',
  cellInfo: 'CELL INFO',
  linkQuality: 'LINK QUALITY',
  activeThroughput: 'THROUGHPUT TEST',
  ranging: 'TRUE DISTANCE',
  camera: 'CAMERA',
  magnetometer: 'MAGNETOMETER',
};

export function getPlatform(id) {
  return PLATFORMS[id] ?? null;
}

export function capability(platformId, key) {
  return PLATFORMS[platformId]?.capabilities?.[key] ?? { support: SUPPORT.NONE };
}

export function supports(platformId, key) {
  return capability(platformId, key).support !== SUPPORT.NONE;
}

/** Host platforms only -- the ones that measure their own WiFi signal locally. */
export function hostPlatforms() {
  return Object.values(PLATFORMS).filter((p) => p.role === ROLE.HOST);
}

/**
 * Compact matrix for the UI's platform comparison panel:
 * [{ key, label, byPlatform: { darwin: 'full', win32: 'full', ... } }]
 */
export function capabilityMatrix() {
  return CAPABILITY_KEYS.map((key) => ({
    key,
    label: CAPABILITY_LABELS[key],
    byPlatform: Object.fromEntries(
      Object.keys(PLATFORMS).map((id) => [id, capability(id, key).support]),
    ),
  }));
}
