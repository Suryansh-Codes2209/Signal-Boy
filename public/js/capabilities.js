/**
 * What the *browser* running this page can sense, as opposed to what the host
 * daemon can sense.
 *
 * These are different machines whenever you open Signal Boy on your phone. The
 * phone cannot read WiFi signal at all, but it carries a magnetometer and a
 * rear camera that no laptop has -- so the UI needs both capability sets and
 * has to be explicit about which device a given number came from.
 *
 * Feature detection first, user-agent only as a label. Sniffing decides what
 * to *call* the device; probing decides what it can actually do.
 */

export function detectClientPlatform() {
  const ua = navigator.userAgent;
  const touchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || touchMac) return 'ios';
  if (/windows/i.test(ua)) return 'win32';
  if (/mac os x/i.test(ua)) return 'darwin';
  if (/linux|x11/i.test(ua)) return 'linux';
  return 'linux';
}

/** True when this page is the one running on the same machine as the daemon. */
export function isLocalHost() {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
}

/**
 * Probes the actual browser APIs. `secureContext` gates several of these:
 * getUserMedia, Web Bluetooth and the sensor APIs all refuse to run over plain
 * HTTP from a non-localhost origin, which is exactly the case when a phone
 * opens Signal Boy across the LAN.
 */
export function detectClientFeatures() {
  const secure = window.isSecureContext === true;

  return {
    secureContext: secure,
    // Web Bluetooth exists in Chrome/Edge. requestLEScan (continuous
    // advertisement scanning with RSSI) additionally needs the experimental
    // web platform features flag, which cannot be feature-detected -- calling
    // it is the only way to find out.
    webBluetooth: typeof navigator.bluetooth?.requestDevice === 'function' && secure,
    bluetoothLeScan: typeof navigator.bluetooth?.requestLEScan === 'function',
    camera: typeof navigator.mediaDevices?.getUserMedia === 'function' && secure,
    magnetometer: typeof window.Magnetometer === 'function' && secure,
    orientation: typeof window.DeviceOrientationEvent === 'function',
    // iOS requires an explicit user gesture to grant motion/orientation.
    orientationNeedsPermission:
      typeof window.DeviceOrientationEvent?.requestPermission === 'function',
    geolocation: 'geolocation' in navigator && secure,
    wakeLock: 'wakeLock' in navigator && secure,
  };
}

/**
 * Why a capability is unavailable, phrased for display. Returns null when it
 * is available, so callers can use it directly as a caveat string.
 */
export function unavailableReason(feature, features) {
  if (features[feature]) return null;

  if (!features.secureContext && ['camera', 'magnetometer', 'geolocation', 'webBluetooth', 'wakeLock'].includes(feature)) {
    return 'Browsers block this over plain HTTP. Restart the daemon with --https, or open Signal Boy at localhost on the host machine.';
  }

  return {
    webBluetooth: 'This browser has no Web Bluetooth. Chrome or Edge is required; Safari does not implement it.',
    bluetoothLeScan:
      'Continuous BLE scanning needs chrome://flags/#enable-experimental-web-platform-features enabled.',
    camera: 'No camera access available in this browser.',
    magnetometer: 'This browser does not expose the Magnetometer API. Safari blocks it entirely.',
    geolocation: 'Geolocation is unavailable.',
  }[feature] ?? 'Not available in this browser.';
}

/** Bundles everything about the viewing device for the platform panel. */
export function clientProfile() {
  const platform = detectClientPlatform();
  return {
    platform,
    features: detectClientFeatures(),
    isHostMachine: isLocalHost(),
  };
}
