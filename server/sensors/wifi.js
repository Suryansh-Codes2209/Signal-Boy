import { wifi, hostPlatformId } from '../platform/index.js';

/**
 * Platform-agnostic WiFi sensing.
 *
 * All OS-specific parsing lives in server/platform/wifi/*. This module only
 * handles scheduling: polling on an interval without letting a slow read queue
 * up behind itself (macOS system_profiler takes ~5s on its first call).
 */

export async function readWifi() {
  const result = await wifi.readConnected();
  return { ...result, platform: hostPlatformId };
}

/** Neighbouring access points. Fully supported on Windows, partial on Linux, refused by macOS. */
export async function scanAccessPoints() {
  const result = await wifi.scanAps();
  return { ...result, platform: hostPlatformId };
}

/**
 * Polls readWifi() on an interval, skipping ticks while a read is in flight.
 * Returns a stop function.
 */
export function startWifiPolling(intervalMs, onReading) {
  let inFlight = false;
  let stopped = false;

  const tick = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const result = await readWifi();
      if (!stopped) onReading(result);
    } catch (err) {
      if (!stopped) onReading({ ok: false, error: err.message, platform: hostPlatformId });
    } finally {
      inFlight = false;
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
