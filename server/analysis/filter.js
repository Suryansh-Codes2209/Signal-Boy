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
 */
export class Kalman1D {
  #q;
  #r;
  #x = null;
  #p;

  constructor({ processNoise = 0.01, measurementNoise = 6, initialVariance = 100 } = {}) {
    this.#q = processNoise;
    this.#r = measurementNoise;
    this.#p = initialVariance;
  }

  update(z) {
    if (this.#x === null) {
      this.#x = z;
      this.#p = this.#r;
      return this.#x;
    }
    this.#p += this.#q;
    const k = this.#p / (this.#p + this.#r);
    this.#x += k * (z - this.#x);
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
  }
}

/** Sample standard deviation, reported alongside survey points as a stability measure. */
export function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
