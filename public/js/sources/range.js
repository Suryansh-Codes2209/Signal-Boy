import { mapCapabilities, mapRangeResults, mapRangePermissions, mapSessionStatus } from './range-map.js';

/**
 * True distance to a peer, via the Kotlin RangingManager bridge.
 *
 * Same shape as ble.js: on-device only, so views probe for window.SignalBoyRange
 * directly rather than going through createSource()'s SSE/native switch -- there
 * is no daemon-side ranging to fall back to, and there never will be, because
 * ranging is a property of the radio in your hand.
 *
 * JS drives start/stop and polls, exactly as it does for BLE. Ranging results
 * arrive on the session callback's own clock, so a poll interval is enough to
 * surface them without adding a second push channel alongside WifiBridge's.
 *
 * Nothing here interprets. startSession returns whatever the bridge said and
 * every reading goes through range-map.js, which is where the rule that an
 * RSSI-derived estimate can never be presented as a measurement is written down
 * and tested.
 */

/** The @JavascriptInterface object MainActivity installs for ranging, or null. */
export function rangeBridge(scope = globalThis) {
  return scope?.SignalBoyRange ?? null;
}

/** Kotlin hands JSON strings across the bridge; nothing else survives the boundary. */
function parse(json, fallback = null) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function createRangeSource(bridge) {
  return {
    /**
     * What this handset can range with.
     *
     * Worth calling more than once: delivery is asynchronous on the platform
     * side, so the first call after launch legitimately answers
     * CAPABILITIES_PENDING rather than an empty list. A caller that treats one
     * pending answer as final would report a capable phone as incapable.
     */
    capabilities() {
      return mapCapabilities(parse(bridge.capabilities(), null));
    },

    /**
     * Begin ranging one peer, by the MAC address HUNT already has for it.
     *
     * `technology` is a RangingManager constant, normally the `code` of
     * capabilities().best -- picking it here rather than in Kotlin keeps the
     * "never choose an RSSI estimate over a timed measurement" rule on the
     * tested side of the bridge.
     */
    startSession(address, technology) {
      return mapSessionStatus(parse(bridge.startSession(address, technology), { ok: false, error: 'BRIDGE_ERROR' }));
    },

    stopSession() {
      bridge.stopSession();
    },

    poll() {
      return mapRangeResults(parse(bridge.results(), null));
    },

    permissions() {
      return mapRangePermissions(parse(bridge.permissions(), null));
    },

    requestPermissions() {
      bridge.requestPermissions();
    },
  };
}
