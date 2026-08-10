import { mapCells, mapCellPermissions } from './cell-map.js';

/**
 * Cell-tower telemetry via the Kotlin TelephonyManager bridge.
 *
 * Like BLE (and unlike WiFi), this only exists on-device -- there is no
 * daemon-side equivalent -- so views probe for window.SignalBoyCell directly
 * rather than going through createSource()'s SSE/native switch. JS polls for a
 * snapshot; cell state changes slowly, so a lazy interval is plenty.
 *
 * Read-only: the bridge reports what the modem already sees. There is no
 * transmit path here and none is possible -- the baseband is locked firmware.
 */

/** The @JavascriptInterface object MainActivity installs for cellular, or null. */
export function cellBridge(scope = globalThis) {
  return scope?.SignalBoyCell ?? null;
}

function parse(json, fallback = null) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function createCellSource(bridge) {
  return {
    read() {
      return mapCells(parse(bridge.read(), null));
    },

    permissions() {
      return mapCellPermissions(parse(bridge.permissions(), null));
    },

    requestPermissions() {
      bridge.requestPermissions();
    },
  };
}
