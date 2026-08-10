/**
 * Smoothing for RSSI streams. Raw RSSI jitters +/-5 dBm even when the receiver
 * is completely still, so every displayed or recorded value is filtered.
 *
 * Pure state machines: no I/O, no timers. Feed them samples, read `.value`.
 */

/** Exponentially weighted moving average: s = a*x + (1-a)*s. Used for the sparkline. */
export class Ewma {
  #alpha;
  #value = null;

  constructor(alpha = 0.3) {
    if (!(alpha > 0 && alpha <= 1)) throw new RangeError('alpha must be in (0, 1]');
    this.#alpha = alpha;
  }

  update(x) {
    this.#value = this.#value === null ? x : this.#alpha * x + (1 - this.#alpha) * this.#value;
    return this.#value;
  }

  get value() {
    return this.#value;
  }

  reset() {
    this.#value = null;
  }
}

/**
 * Scalar Kalman filter over a near-constant signal. Used for the displayed dBm
 * number and for the value recorded at each survey point.
 *
 *   predict:  P = P + Q
 *   gain:     K = P / (P + R)
 *   update:   x = x + K(z - x);  P = (1 - K)P
 *
 * Q is small because true RSSI barely moves while you stand still; R is the
 * measurement variance, ~4-9 dBm^2 for consumer WiFi hardware.
 *
 * Two opt-in refinements exist for BLE hunting, where the phone is being walked
 * around a moving-or-hidden target rather than held still next to a fixed AP.
 * Both default OFF, so the WiFi/desktop call sites (new Kalman1D()) are
 * unchanged to the last decimal:
 *
 *   - `outlierGate: g` rejects a reading whose innovation exceeds g standard
 *     deviations (a reflection or a decode glitch) so one bad sample cannot
 *     yank the blip -- but after `maxRejects` consecutive rejects it accepts
 *     again, because that many big readings in a row means the target truly
 *     moved, not that one sample was noise.
 *   - `adaptive: true` opens Q up when a run of same-signed innovations shows
 *     the target is genuinely moving (track faster), and tightens R from the
 *     observed jitter when it is not (steadier number). Alternating noise flips
 *     sign every sample and never triggers the trend boost.
 */
export class Kalman1D {
  #baseQ;
  #q;
  #r;
  #x = null;
  #p;
  #adaptive;
  #gate;
  #maxRejects;
  #rejectRun = 0;
  #signRun = 0;
  #lastSign = 0;
  #rEst;

  constructor({
    processNoise = 0.01,
    measurementNoise = 6,
    initialVariance = 100,
    adaptive = false,
    outlierGate = null,
    maxRejects = 3,
  } = {}) {
    this.#baseQ = processNoise;
    this.#q = processNoise;
    this.#r = measurementNoise;
    this.#rEst = measurementNoise;
    this.#p = initialVariance;
    this.#adaptive = adaptive;
    this.#gate = outlierGate;
    this.#maxRejects = maxRejects;
  }

  update(z) {
    if (this.#x === null) {
      this.#x = z;
      this.#p = this.#r;
      return this.#x;
    }

    const innovation = z - this.#x;

    // Outlier gate. Skip the update for a lone spike, but only up to
    // #maxRejects in a row -- past that the world has moved and we must follow.
    let forcedAccept = false;
    if (this.#gate != null && Math.abs(innovation) > this.#gate * Math.sqrt(this.#p + this.#r)) {
      this.#rejectRun += 1;
      if (this.#rejectRun < this.#maxRejects) {
        this.#p += this.#q; // grew more uncertain while ignoring a reading
        return this.#x;
      }
      // We have now been surprised the same way #maxRejects times: the estimate
      // is stale, not the reading. Open the covariance up so the gain is high
      // and the filter snaps to the new level instead of crawling to it.
      forcedAccept = true;
    } else {
      this.#rejectRun = 0;
    }

    let q = this.#baseQ;
    let r = this.#r;
    if (forcedAccept) this.#p += this.#r;

    if (this.#adaptive) {
      const sign = Math.sign(innovation);
      if (sign !== 0 && sign === this.#lastSign) this.#signRun += 1;
      else this.#signRun = 0;
      this.#lastSign = sign;

      if (this.#signRun >= 2) {
        // A sustained trend: raise Q to catch up, and trust the readings (base
        // R) while the target is actually moving.
        q = this.#baseQ * (1 + this.#signRun * this.#signRun);
      } else {
        // Holding still: learn R from recent jitter, clamped so a burst cannot
        // make the filter deaf to every reading.
        this.#rEst = 0.9 * this.#rEst + 0.1 * innovation * innovation;
        r = Math.max(1, Math.min(this.#rEst, this.#r * 4));
      }
    }

    this.#q = q;
    this.#p += q;
    const k = this.#p / (this.#p + r);
    this.#x += k * innovation;
    this.#p = (1 - k) * this.#p;
    return this.#x;
  }

  get value() {
    return this.#x;
  }

  get variance() {
    return this.#p;
  }

  reset() {
    this.#x = null;
    this.#p = 100;
    this.#q = this.#baseQ;
    this.#rEst = this.#r;
    this.#rejectRun = 0;
    this.#signRun = 0;
    this.#lastSign = 0;
  }
}

/** Sample standard deviation, reported alongside survey points as a stability measure. */
export function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
