import * as darwin from './wifi/darwin.js';
import * as win32 from './wifi/win32.js';
import * as linux from './wifi/linux.js';
import { PLATFORMS, capabilityMatrix } from '../../public/js/core/platforms.js';
import { detectHostPlatform } from './capabilities.js';

/**
 * Resolves which OS backend to use.
 *
 * Detection is authoritative -- the daemon can only read the hardware it is
 * actually running on. SIGNALBOY_PLATFORM exists to force a backend when
 * detection is wrong (unusual unixes) or when developing one platform's
 * parsing on another.
 */

const BACKENDS = { darwin, win32, linux };

const forced = process.env.SIGNALBOY_PLATFORM;
const detected = detectHostPlatform();

export const hostPlatformId = BACKENDS[forced] ? forced : detected;
export const isForced = Boolean(forced && BACKENDS[forced]);
export const wifi = BACKENDS[hostPlatformId];

/** Everything the client needs to render the platform panel and adapt its UI. */
export function platformInfo() {
  const platform = PLATFORMS[hostPlatformId];
  return {
    host: hostPlatformId,
    label: platform.label,
    note: platform.note,
    detected,
    forced: isForced,
    capabilities: platform.capabilities,
    platforms: Object.fromEntries(
      Object.entries(PLATFORMS).map(([id, p]) => [
        id,
        { id, label: p.label, role: p.role, note: p.note, capabilities: p.capabilities },
      ]),
    ),
    matrix: capabilityMatrix(),
  };
}
