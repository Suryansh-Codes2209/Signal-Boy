/**
 * dBm -> sound. Pure arithmetic, no Web Audio, no DOM -- see engine.js for the
 * side that actually makes noise. Kept separate so the part that must be
 * *correct* (the mapping) is the part `node --test` can actually hold to
 * account, with no browser and no emulator.
 *
 * Both a walk and a hunt run for minutes, so the range this maps onto was
 * chosen to be listenable that long, not just correct:
 *
 * - Two octaves, A3 (220Hz) to A5 (880Hz). Below ~200Hz a square wave turns to
 *   mud on a phone speaker; above ~1kHz a square wave (all odd harmonics, no
 *   low-pass shaping) turns shrill fast. A3-A5 sits in the middle of a phone
 *   speaker's honest range and spans a musically legible interval -- the
 *   midpoint of the RSSI range lands exactly on A4 (440Hz), one octave up from
 *   the floor and one below the ceiling, so the ear has a clean reference for
 *   "halfway there".
 */

import { RSSI_FLOOR, RSSI_CEILING } from '../core/pathloss.js';

export { RSSI_FLOOR, RSSI_CEILING };

/** A3. Low enough to stay warm on a phone speaker, not so low it disappears. */
export const BASE_FREQUENCY_HZ = 220;

/** Two octaves: dBm ceiling reaches A5 (880Hz), never higher. */
export const SEMITONE_SPAN = 24;

/** Slowest and fastest click-mode cadence, in clicks per second. */
export const CLICK_RATE_MIN_HZ = 1;
export const CLICK_RATE_MAX_HZ = 16;

/**
 * dBm normalised to 0 (floor, weakest usable signal) .. 1 (ceiling, strongest),
 * clamped outside that range rather than extrapolating into absurd values.
 * Returns null for a missing/non-finite reading -- there is nothing to map,
 * and null propagates to "silent" in both dbmToFrequency and
 * dbmToClickRateHz rather than one of them inventing a fallback number.
 */
export function normalizedLevel(dbm) {
  if (dbm == null || !Number.isFinite(dbm)) return null;
  const level = (dbm - RSSI_FLOOR) / (RSSI_CEILING - RSSI_FLOOR);
  return Math.max(0, Math.min(1, level));
}

/**
 * dBm mapped to semitones above the base frequency, 0..SEMITONE_SPAN. Linear
 * in semitones, not in Hz: pitch perception is logarithmic and dBm already is
 * too, so this linear mapping is what produces an even musical response.
 * Mapping straight to Hz would cram the whole useful range into a squeak at
 * one end instead.
 */
export function dbmToSemitones(dbm) {
  const level = normalizedLevel(dbm);
  return level == null ? null : level * SEMITONE_SPAN;
}

/** Equal-tempered frequency `semitones` above `base`. */
export function semitoneToFrequency(semitones, base = BASE_FREQUENCY_HZ) {
  return base * 2 ** (semitones / 12);
}

/** dBm -> Hz for the oscillator, or null when there is nothing to sound. */
export function dbmToFrequency(dbm) {
  const semitones = dbmToSemitones(dbm);
  return semitones == null ? null : semitoneToFrequency(semitones);
}

/**
 * dBm -> clicks per second for rate mode. Linear in the normalised level,
 * same as the pitch mapping's semitone axis -- there is no perceptual reason
 * to curve a *counting* rate the way pitch needs curving, so this stays the
 * simplest thing that is still monotonic and clamped.
 */
export function dbmToClickRateHz(dbm) {
  const level = normalizedLevel(dbm);
  if (level == null) return null;
  return CLICK_RATE_MIN_HZ + level * (CLICK_RATE_MAX_HZ - CLICK_RATE_MIN_HZ);
}

/** dBm -> milliseconds between clicks, the form setTimeout actually wants. */
export function dbmToClickIntervalMs(dbm) {
  const hz = dbmToClickRateHz(dbm);
  return hz == null ? null : 1000 / hz;
}
