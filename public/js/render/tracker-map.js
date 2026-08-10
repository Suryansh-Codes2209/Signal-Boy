/**
 * Geometry for the motion-tracker face. Pure arithmetic, no canvas -- same
 * split as radar-map.js and ruler-map.js, so the part that has to be right is
 * the part `node --test` can hold to account.
 *
 * The look is the M314 from Aliens: a dark phosphor field, graduated range
 * arcs, a bracket frame with tick marks, an outward ping and a scanline. What
 * is deliberately *not* borrowed is the part everyone remembers -- the forward
 * cone and the blip sitting at a bearing inside it. A single BLE antenna
 * resolves no direction, so a mark at an angle would be inventing the most
 * important number on the display. Nothing in this module produces an angle;
 * there is no theta anywhere in the file, and that absence is the design.
 *
 * Every shape here is radial or axial, which is what makes it honest: an arc
 * at radius r asserts "the reading matches this radius", true at every angle
 * simultaneously, and a scanline asserts nothing at all.
 */

/** Range arcs drawn across the field, matching radar-map.js's four bands. */
export const GRADUATIONS = 4;

/**
 * Radii for the graduation arcs, outermost last.
 *
 * Evenly spaced in radius rather than in signal, so the arcs read as a ruler.
 * That is decoration while the display is driven by dBm, and stops being
 * decoration the moment a ranging fix drives it instead -- ruler-map.js
 * already computes the metre value each of these arcs stands for.
 */
export function graduationRadii(maxRadius, count = GRADUATIONS) {
  const max = Number.isFinite(maxRadius) && maxRadius > 0 ? maxRadius : 0;
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : GRADUATIONS;
  return Array.from({ length: n }, (_, i) => (max * (i + 1)) / n);
}

/** Frames for one ping to travel from centre to rim. ~1.5s at 60fps. */
export const PING_PERIOD_FRAMES = 90;

/**
 * How far through its travel the current ping is, 0 at the centre to just
 * under 1 at the rim.
 *
 * A sawtooth rather than a sine: the ping should restart at the centre, not
 * ease back inward, because an inward-travelling wave would read as something
 * approaching -- a claim about the device, which this pulse never makes. It is
 * a liveness indicator and nothing more.
 */
export function pingFraction(frame, period = PING_PERIOD_FRAMES) {
  const p = Number.isFinite(period) && period > 0 ? period : PING_PERIOD_FRAMES;
  const f = Number.isFinite(frame) ? frame : 0;
  // Modulo of a negative frame would run the ping backwards; clamp instead.
  return Math.max(0, f) % p / p;
}

export function pingRadius(frame, maxRadius, period = PING_PERIOD_FRAMES) {
  const max = Number.isFinite(maxRadius) && maxRadius > 0 ? maxRadius : 0;
  return pingFraction(frame, period) * max;
}

/**
 * The ping's shade as it travels: brightest leaving the centre, dimmest at the
 * rim, so it dissipates instead of stopping dead at the edge.
 *
 * Returns a palette index, because this app has four colours and no alpha --
 * fading is done by picking a darker shade, the same way meter.js and bot.js
 * handle it rather than reaching for globalAlpha.
 */
export function pingShade(fraction) {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  if (f < 0.34) return 3;
  if (f < 0.67) return 2;
  return 1;
}

/**
 * Which grid row the scanline occupies this frame, or -1 when it is between
 * rows.
 *
 * Two frames per row so the sweep is legible rather than a strobe. Purely a
 * CRT affectation -- it carries no data, and deliberately runs top-to-bottom
 * rather than rotating, because a rotating sweep would imply the sensor is
 * scanning a bearing.
 */
export function scanlineRow(frame, rows, framesPerRow = 2) {
  const n = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;
  if (n === 0) return -1;
  const per = Number.isFinite(framesPerRow) && framesPerRow > 0 ? Math.floor(framesPerRow) : 1;
  const f = Number.isFinite(frame) ? Math.max(0, frame) : 0;
  return Math.floor(f / per) % n;
}

/**
 * Tick positions along one edge of the bracket frame, as pixel offsets.
 *
 * Inset by half a step at each end so the run of ticks reads as centred on the
 * edge rather than crashing into the corners.
 */
export function tickPositions(span, count) {
  const s = Number.isFinite(span) && span > 0 ? span : 0;
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n === 0) return [];
  const step = s / n;
  return Array.from({ length: n }, (_, i) => step * i + step / 2);
}
