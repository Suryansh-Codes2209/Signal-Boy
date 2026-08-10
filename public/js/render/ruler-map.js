/**
 * Metres -> radar ring geometry. Pure arithmetic, no canvas -- same split as
 * radar-map.js, so the part that has to be *correct* is the part `node --test`
 * can hold to account.
 *
 * This deliberately does not reuse dbmToRadiusFraction from radar-map.js, and
 * the reason is the whole point of the module. That function encodes "stronger
 * means smaller radius, nothing more" for a quantity with no units: its rings
 * are evenly spaced in radius precisely because they cannot be labelled with a
 * distance. Ranging produces metres, which are linear and real, so the rings
 * here are a ruler -- evenly spaced *and* labelled, where the gap between two
 * rings means the same thing at the edge as it does at the centre.
 *
 * Putting metres through the dBm mapping would draw a ruler with unequal
 * divisions, which is a subtler version of the fabrication this project spends
 * so much effort avoiding.
 */

import { RING_COUNT } from './radar-map.js';

export { RING_COUNT };

/**
 * The board's outer edge, in metres.
 *
 * dBm had a natural floor and ceiling (see pathloss.js) so its board never
 * needed rescaling. Distance has no such bound -- a UWB fix can read 0.2 m or
 * 40 m in the same session -- so the board picks a scale instead. The steps are
 * 1/2/5 per decade, the same progression an oscilloscope or a map scale bar
 * uses, so the ring labels always land on numbers worth reading.
 */
export const RANGE_SCALES = [1, 2, 5, 10, 20, 50, 100];

export const MIN_SCALE = RANGE_SCALES[0];
export const MAX_SCALE = RANGE_SCALES[RANGE_SCALES.length - 1];

/**
 * Shrink only once the reading is well inside the next scale down.
 *
 * Without this, a peer sitting near a boundary -- 10.0 m on a 10 m board --
 * rescales the entire display on every jitter, and a ruler whose divisions keep
 * changing is harder to read than one that is slightly too large. Growing is
 * immediate (a reading off the edge of the board cannot be drawn at all), but
 * shrinking waits until there is real headroom.
 */
export const SHRINK_HYSTERESIS = 0.45;

/**
 * The smallest scale that contains this reading, given the scale in use.
 *
 * `current` makes the choice sticky rather than memoryless; pass null (or omit
 * it) for a cold start, where there is no previous board to flap against.
 */
export function scaleForMetres(metres, current = null) {
  if (metres == null || !Number.isFinite(metres) || metres < 0) return current ?? MIN_SCALE;

  const needed = RANGE_SCALES.find((s) => metres <= s) ?? MAX_SCALE;
  if (current == null) return needed;
  // Growing is never delayed: an off-board reading has nowhere to be drawn.
  if (needed > current) return needed;
  // Shrinking waits for headroom, so a reading hovering at a boundary does not
  // rescale the board on every update.
  if (metres <= current * SHRINK_HYSTERESIS) return needed;
  return current;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Metres normalised to a radius fraction: 0 at the centre (the phone, 0 m) out
 * to 1 at the outer edge (the current scale).
 *
 * Linear, unlike dbmToRadiusFraction, because that is what makes it a ruler.
 * Beyond the scale it clamps to the edge rather than extrapolating off the
 * board -- but see beyondScale() for telling the caller that clamping happened,
 * since a blip pinned to the rim would otherwise be indistinguishable from one
 * measured exactly at the edge. Returns null for a missing reading, the same
 * convention dbmToRadiusFraction and tone-map.js's normalizedLevel use.
 */
export function metresToRadiusFraction(metres, scale) {
  if (metres == null || !Number.isFinite(metres) || metres < 0) return null;
  const max = Number.isFinite(scale) && scale > 0 ? scale : MIN_SCALE;
  return clamp01(metres / max);
}

/** Whether a reading had to be clamped to the rim to be drawn at all. */
export function beyondScale(metres, scale) {
  if (metres == null || !Number.isFinite(metres)) return false;
  const max = Number.isFinite(scale) && scale > 0 ? scale : MIN_SCALE;
  return metres > max;
}

/**
 * The distance each ring stands for, centre outward, for the axis labels.
 *
 * There are only RING_COUNT rings to draw with, so a 20 m board reads 5/10/15/20.
 * These are the numbers that make the board a ruler rather than a decoration;
 * without them the rings are just concentric circles and the display is back to
 * claiming nothing.
 */
export function ringMetresForScale(scale) {
  const max = Number.isFinite(scale) && scale > 0 ? scale : MIN_SCALE;
  const step = max / RING_COUNT;
  return Array.from({ length: RING_COUNT }, (_, i) => step * (i + 1));
}

/** A ring distance formatted for the axis: no trailing noise on whole metres. */
export function formatRingLabel(metres) {
  if (metres == null || !Number.isFinite(metres)) return '';
  return Number.isInteger(metres) ? `${metres}M` : `${metres.toFixed(1)}M`;
}

/**
 * A UWB bearing in degrees -> the canvas angle for the blip, in radians.
 *
 * Azimuth arrives as degrees off the phone's boresight, positive clockwise,
 * with 0 meaning straight ahead. Canvas angles run from the positive x axis
 * (three o'clock), so straight ahead -- the top of the board -- is -90 degrees.
 *
 * Null in, null out, and that null is load-bearing: every technology except UWB
 * returns it, and render/radar.js is built to place the blip without an angle
 * rather than pick one. This function must never invent a heading to fill a
 * gap, which is why it does no defaulting.
 */
export function bearingToCanvasRadians(bearing) {
  if (bearing == null || !Number.isFinite(bearing)) return null;
  return ((bearing - 90) * Math.PI) / 180;
}
