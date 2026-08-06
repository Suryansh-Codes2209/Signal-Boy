/**
 * Signal grading and RSSI <-> distance conversion.
 *
 * Pure functions over numbers. No I/O, no platform knowledge.
 */

/**
 * Signal quality bands, strongest first.
 *
 * -67 dBm is the meaningful boundary: it is the accepted floor for voice and
 * video streaming, so anything below it is a real-world problem rather than a
 * cosmetic one. `shade` indexes the 4-colour LCD palette (3 = lightest).
 */
export const BANDS = [
  { key: 'excellent', label: 'EXCELLENT', min: -50, shade: 3 },
  { key: 'good', label: 'GOOD', min: -60, shade: 3 },
  { key: 'fair', label: 'FAIR', min: -67, shade: 2 },
  { key: 'weak', label: 'WEAK', min: -75, shade: 1 },
  { key: 'dead', label: 'DEAD', min: -Infinity, shade: 0 },
];

/** Below this, a survey cell counts as a dead zone. */
export const DEAD_ZONE_THRESHOLD = -70;

/** Range used to map dBm onto meters, bars and heatmap shades. */
export const RSSI_FLOOR = -90;
export const RSSI_CEILING = -30;

export function gradeRssi(rssi) {
  if (rssi == null || !Number.isFinite(rssi)) return null;
  return BANDS.find((band) => rssi >= band.min) ?? BANDS[BANDS.length - 1];
}

/** Signal-to-noise ratio in dB. Null where the platform reports no noise floor. */
export function snr(signal, noise) {
  if (signal == null || noise == null) return null;
  return signal - noise;
}

/** Maps RSSI onto 0-100 for bars and meters, clamped to the usable range. */
export function qualityPercent(rssi) {
  if (rssi == null || !Number.isFinite(rssi)) return 0;
  const pct = ((rssi - RSSI_FLOOR) / (RSSI_CEILING - RSSI_FLOOR)) * 100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Path loss exponent presets. Free space is 2.0; every wall, floor and piece
 * of furniture pushes it higher.
 */
export const ENVIRONMENTS = {
  freeSpace: { label: 'OPEN / LINE OF SIGHT', n: 2.0 },
  apartment: { label: 'APARTMENT / DRYWALL', n: 3.0 },
  house: { label: 'HOUSE / MIXED WALLS', n: 3.5 },
  dense: { label: 'BRICK / CONCRETE', n: 4.5 },
};

export const DEFAULT_PATH_LOSS = {
  /** RSSI measured at the reference distance, set by the calibration step. */
  refRssi: -40,
  /** Reference distance in metres. */
  refDistance: 1,
  /** Path loss exponent n. */
  n: 3.0,
};

/**
 * Log-distance path loss model:
 *
 *   RSSI(d) = RSSI(d0) - 10 * n * log10(d / d0)
 *
 * Indoors this is accurate to roughly +/-50% because multipath, walls and body
 * blocking all violate its assumptions. Every distance derived from it should
 * be presented as an estimate.
 */
export function distanceToRssi(distance, opts = {}) {
  const { refRssi, refDistance, n } = { ...DEFAULT_PATH_LOSS, ...opts };
  if (!(distance > 0)) throw new RangeError('distance must be > 0');
  return refRssi - 10 * n * Math.log10(distance / refDistance);
}

/** Inverse of distanceToRssi: d = d0 * 10^((RSSI(d0) - RSSI) / (10n)) */
export function rssiToDistance(rssi, opts = {}) {
  const { refRssi, refDistance, n } = { ...DEFAULT_PATH_LOSS, ...opts };
  if (rssi == null || !Number.isFinite(rssi)) return null;
  return refDistance * 10 ** ((refRssi - rssi) / (10 * n));
}

/**
 * Fits the path loss exponent from calibration samples taken at known
 * distances, by least squares on the linearised model:
 *
 *   RSSI = refRssi - 10n * log10(d/d0)   ->   y = -10n * x
 *
 * where x = log10(d/d0) and y = RSSI - refRssi. Needs at least one sample past
 * the reference distance; falls back to the default n otherwise.
 */
export function fitPathLossExponent(samples, { refRssi, refDistance = 1 } = {}) {
  const usable = samples.filter((s) => s.distance > 0 && Number.isFinite(s.rssi));
  if (usable.length === 0) return DEFAULT_PATH_LOSS.n;

  const ref = refRssi ?? usable.find((s) => s.distance === refDistance)?.rssi;
  if (ref == null) return DEFAULT_PATH_LOSS.n;

  let num = 0;
  let den = 0;
  for (const { distance, rssi } of usable) {
    const x = Math.log10(distance / refDistance);
    if (x === 0) continue;
    num += x * (rssi - ref);
    den += x * x;
  }
  if (den === 0) return DEFAULT_PATH_LOSS.n;

  const n = -num / den / 10;
  // Values outside this range mean the samples were bad, not the environment.
  return Math.max(1.5, Math.min(6, n));
}
