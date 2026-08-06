import { createSseSource } from './sse.js';
import { createNativeSource, nativeBridge } from './native.js';

/**
 * Picks where readings come from.
 *
 * In the Android APK there is no daemon and no network: MainActivity installs a
 * WifiManager bridge on the window, and readings arrive by push from Kotlin. In
 * every browser there is no bridge, and readings arrive over SSE. Views never
 * learn which one they are attached to.
 */
export function createSource() {
  const bridge = nativeBridge();
  return bridge ? createNativeSource(bridge) : createSseSource();
}
