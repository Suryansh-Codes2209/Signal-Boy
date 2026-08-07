import { mapBleDevices, mapScanStatus, mapPermissions } from './ble-map.js';

/**
 * BLE device hunting, via the Kotlin BluetoothLeScanner bridge.
 *
 * Unlike the WiFi source, this is not part of createSource()'s SSE/native
 * switch: BLE hunting only exists on-device (there is no daemon-side BLE
 * scan to fall back to over SSE), so views that want it probe for
 * window.SignalBoyBle directly, exactly as native.js probes for
 * window.SignalBoyNative.
 *
 * JS drives start/stop and polls for the current snapshot, rather than Kotlin
 * pushing on its own cadence the way WifiBridge's readings do. BLE results
 * already arrive on the scan callback's own clock -- effectively continuous,
 * unlike WiFi's 4-scans-per-2-minutes -- so a fixed poll interval here is
 * enough to surface that without adding a second push channel to keep in
 * step with the WiFi one.
 */

/** The @JavascriptInterface object MainActivity installs for BLE, or null. */
export function bleBridge(scope = globalThis) {
  return scope?.SignalBoyBle ?? null;
}

/** Kotlin hands JSON strings across the bridge; nothing else survives the boundary. */
function parse(json, fallback = null) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function createBleSource(bridge) {
  return {
    startScan() {
      return mapScanStatus(parse(bridge.startScan(), { ok: false, error: 'BRIDGE_ERROR' }));
    },

    stopScan() {
      bridge.stopScan();
    },

    poll() {
      return mapBleDevices(parse(bridge.results(), null));
    },

    permissions() {
      return mapPermissions(parse(bridge.permissions(), null));
    },

    requestPermissions() {
      bridge.requestPermissions();
    },
  };
}
