import { mapConnected, mapScanResults } from './android-map.js';
import { Kalman1D, Ewma } from '../core/filter.js';
import { applyFilters } from '../core/derive.js';
import { PLATFORMS, capabilityMatrix } from '../core/platforms.js';

/**
 * Readings from the phone's own radio, via the Kotlin WifiManager bridge.
 *
 * The daemon filters and grades before publishing; here there is no daemon, so
 * this source does it locally with the same modules and the same constants. A
 * view cannot tell the two apart, which is the whole point of the abstraction.
 *
 * Kotlin owns the cadence and pushes into window.__signalboyPush, mirroring the
 * server-push shape of SSE rather than making JS poll across the bridge.
 */

const PUSH_HOOK = '__signalboyPush';

/** The @JavascriptInterface object MainActivity installs, or null in a browser. */
export function nativeBridge(scope = globalThis) {
  return scope?.SignalBoyNative ?? null;
}

/** Kotlin hands JSON strings across the bridge; nothing else survives the boundary. */
function parse(json, fallback = null) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function createNativeSource(bridge, scope = globalThis) {
  // One filter pair, matching server/index.js exactly: Kalman drives the
  // displayed number, EWMA drives the sparkline.
  const kalman = new Kalman1D({ processNoise: 0.01, measurementNoise: 6 });
  const ewma = new Ewma(0.3);

  const listeners = new Map();
  const stateListeners = new Set();
  let state = 'connecting';

  function setState(next) {
    if (state === next) return;
    state = next;
    for (const fn of stateListeners) fn(next);
  }

  function emit(channel, payload) {
    for (const fn of listeners.get(channel) ?? []) fn(payload);
  }

  function onReading(result) {
    const reading = applyFilters(result, { kalman, ewma });
    setState(reading.ok ? 'live' : 'error');
    emit('wifi', reading);
  }

  return {
    isNative: true,

    connect() {
      setState('connecting');
      scope[PUSH_HOOK] = (json) => {
        const raw = parse(json);
        if (raw == null) return;
        onReading(mapConnected(raw));
      };
    },

    on(channel, handler) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(handler);
      return () => listeners.get(channel)?.delete(handler);
    },

    onStateChange(handler) {
      stateListeners.add(handler);
      handler(state);
      return () => stateListeners.delete(handler);
    },

    /** No /api/platform to fetch: the matrix is in the bundle already. */
    async loadPlatform() {
      // androidApp, not android: the latter describes this same phone in Chrome,
      // which cannot read RSSI at all. Both entries exist and mean different
      // things, and picking the wrong one would grey out the working meter.
      const app = PLATFORMS.androidApp;
      return {
        host: 'androidApp',
        label: app.label,
        note: app.note,
        detected: 'androidApp',
        forced: false,
        capabilities: app.capabilities,
        platforms: Object.fromEntries(
          Object.entries(PLATFORMS).map(([id, p]) => [
            id,
            { id, label: p.label, role: p.role, note: p.note, capabilities: p.capabilities },
          ]),
        ),
        matrix: capabilityMatrix(),
      };
    },

    async requestScan() {
      try {
        return mapScanResults(parse(bridge.scan(), { ok: false, error: 'BRIDGE RETURNED NOTHING' }));
      } catch (err) {
        // Broad on purpose: this call crosses into Kotlin over the JS bridge,
        // which can fail in ways a JS catch cannot enumerate in advance (a
        // missing method, a thrown WebView exception, malformed JSON). Every
        // other exit path goes through mapScanResults, so this one carries
        // the same shape by hand rather than inventing a shorter one.
        return {
          ok: false,
          supported: true,
          networks: [],
          error: err.message,
          source: 'WifiManager.getScanResults()',
          exact: true,
        };
      }
    },

    permissions() {
      return parse(bridge.permissions(), { location: false, nearbyDevices: false });
    },

    requestPermissions() {
      bridge.requestPermissions();
    },
  };
}
