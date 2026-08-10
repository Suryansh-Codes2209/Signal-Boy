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

/**
 * Live-ring half-width in px as a function of the Kalman filter's variance.
 *
 * The blip's *radius* is already continuous (dbmToRadiusFraction), but a
 * fixed-width ring hides how sure of that radius we are. A freshly selected
 * device, or one whose signal just jumped, has a large variance and should read
 * as a fuzzy band; a settled track has a tiny variance and should read as a
 * crisp line. This is the honest visual of confidence -- it never invents a
 * position, it only widens the uncertainty around the one it has.
 *
 * RING_MIN_HALF_WIDTH is the old fixed value (CELL/2), so a confident track
 * looks exactly as it did before. Uncertainty is measured in dBm (sqrt of the
 * variance) and scaled onto pixels, clamped so the band is always visible and
 * never swallows the whole board.
 */
export const RING_MIN_HALF_WIDTH = 8; // = CELL / 2 in radar.js
export const RING_MAX_HALF_WIDTH = 28;

export function ringHalfWidthForVariance(
  variance,
  { min = RING_MIN_HALF_WIDTH, max = RING_MAX_HALF_WIDTH } = {},
) {
  if (variance == null || !Number.isFinite(variance) || variance <= 0) return min;
  const sd = Math.sqrt(variance); // dBm of uncertainty
  return Math.max(min, Math.min(max, min + sd * 4));
}

/**
 * Peak-hold with slow decay toward the current reading.
 *
 * A hard maximum never lies about the strongest reading it saw, but it also
 * never forgets a peak from a moment you were briefly closer, so the mark
 * drifts further and further from anything true as a hunt goes on. Decay lets
 * the peak relax back down when the signal stays weaker: a stronger reading is
 * always adopted at once (that is what peak-hold is for), but a weaker one only
 * pulls the peak down by `rate` of the gap, so a genuine new high still stands
 * out while a stale one fades. Pure: the caller owns the peak, this just
 * returns its next value.
 */
export function decayPeak(peak, current, rate = 0.02) {
  if (current == null || !Number.isFinite(current)) return peak;
  if (peak == null || current >= peak) return current;
  return peak + (current - peak) * rate; // current < peak, so this eases the peak down
}

/**
 * Approach/recede label from the change in filtered dBm between two updates.
 *
 * The single most useful honest cue when hunting: is the signal getting
 * stronger (WARMER) or weaker (COLDER) as you move? It adds no direction -- it
 * cannot say which way to walk, only whether the last step helped. A dead-band
 * keeps ordinary jitter from flickering the label every frame.
 */
export const TREND_DEADBAND_DB = 0.5;

export function trendFromDelta(delta, deadband = TREND_DEADBAND_DB) {
  if (delta == null || !Number.isFinite(delta)) return 'STEADY';
  if (delta > deadband) return 'WARMER';
  if (delta < -deadband) return 'COLDER';
  return 'STEADY';
}
