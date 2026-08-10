import { mapLinkTest } from './link-test-map.js';

/**
 * The active throughput/latency test, via the Kotlin NetTestBridge.
 *
 * On-device only (window.SignalBoyNetTest) and gated behind a consent step in
 * views/link.js -- this is the one path in the app that sends traffic. JS starts
 * it and polls status(), the same poll shape BLE and cell use, so the WebView
 * thread never waits on a socket.
 */

export function netTestBridge(scope = globalThis) {
  return scope?.SignalBoyNetTest ?? null;
}

function parse(json, fallback = null) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function createNetTestSource(bridge) {
  return {
    start(url) {
      return mapLinkTest(parse(bridge.start(url), { state: 'error', error: 'BRIDGE_ERROR' }));
    },

    status() {
      return mapLinkTest(parse(bridge.status(), null));
    },

    stop() {
      bridge.stop();
    },
  };
}
