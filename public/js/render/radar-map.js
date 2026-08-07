/**
 * dBm -> radar ring geometry. Pure arithmetic, no canvas -- see radar.js for
 * the side that actually draws. Kept separate so the part that must be
 * *correct* (the mapping) is the part `node --test` can hold to account, the
 * same split tone-map.js uses for the audio side.
 *
 * A single BLE antenna has no bearing and no reliable distance -- see the
 * HUNT view's own on-screen caveat. What it does have is a Kalman-filtered
 * dBm, and dBm moves monotonically with proximity to one fixed device even
 * though it can never be converted to metres (transmit power is unknown and
 * varies wildly by device). That monotonic relationship -- stronger reading
 * means smaller radius, nothing more -- is the only thing this module
 * encodes. There is deliberately no angle anywhere in this file; see radar.js
 * for how the blip's angular position is handled honestly.
 */

import { RSSI_FLOOR, RSSI_CEILING } from '../core/pathloss.js';

export { RSSI_FLOOR, RSSI_CEILING };

/** One ring band per palette shade -- there are only four colours to draw with. */
export const RING_COUNT = 4;

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * dBm normalised to a radius fraction: 0 at the centre (RSSI_CEILING, the
 * strongest reading this app will ever show) out to 1 at the outer edge
 * (RSSI_FLOOR). Clamped beyond both ends rather than extrapolating past the
 * ring the display actually has room to draw. Returns null for a missing or
 * non-finite reading -- same convention as normalizedLevel in tone-map.js --
 * so there is nothing to place on the display, not a fabricated centre or edge.
 */
export function dbmToRadiusFraction(dbm) {
  if (dbm == null || !Number.isFinite(dbm)) return null;
  const level = (dbm - RSSI_FLOOR) / (RSSI_CEILING - RSSI_FLOOR);
  return 1 - clamp01(level);
}

/**
 * Radius fraction -> palette shade for the static band fill, strongest
 * (centre, fraction 0) at shade 3 down to weakest (edge, fraction 1) at shade
 * 0. Pure bucketing with no dBm involved: the bands are spaced evenly in
 * radius, not in dBm, so the rings read as a ruler rather than a second copy
 * of the strength meter's bands.
 */
export function shadeForRadiusFraction(fraction) {
  const f = clamp01(fraction);
  const band = Math.min(RING_COUNT - 1, Math.floor(f * RING_COUNT));
  return RING_COUNT - 1 - band;
}
