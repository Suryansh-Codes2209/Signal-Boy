/**
 * Passive link quality from the connected reading over time.
 *
 * The honest, offline-by-default half of the LINK tab: it sends nothing. It
 * watches the RSSI and link rate the radio already reports (the same 1Hz 'wifi'
 * stream every other view consumes) and reports how steady they are. A rock-
 * solid signal and a signal that swings 40dB look identical on a single meter;
 * this is what tells them apart. Pure over an array of readings, `node --test`
 * covered.
 *
 * This is not a throughput number -- no packets are sent, so it cannot be one.
 * The active test (link-test-map.js) is the part that measures real throughput,
 * and it is opt-in behind a consent gate precisely because it does send traffic.
 */

import { stdDev } from '../core/filter.js';

/** count / mean / min / max / std of one numeric field across samples, nulls skipped. */
export function summarize(samples, key) {
  const values = (samples ?? []).map((s) => s?.[key]).filter((v) => v != null && Number.isFinite(v));
  if (!values.length) return { count: 0, mean: null, min: null, max: null, std: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    count: values.length,
    mean: Math.round(mean * 10) / 10,
    min: Math.min(...values),
    max: Math.max(...values),
    std: Math.round(stdDev(values) * 100) / 100,
  };
}

/** RSSI jitter (dBm std) -> a plain-language stability band. */
export function stabilityLabel(std) {
  if (std == null || !Number.isFinite(std)) return 'NO DATA';
  if (std < 1.5) return 'ROCK SOLID';
  if (std < 3) return 'STEADY';
  if (std < 6) return 'VARIABLE';
  return 'UNSTABLE';
}

/** Passive summary over a window of readings: rssi + txRate stats, plus an overall label. */
export function linkQuality(readings) {
  const rssi = summarize(readings, 'rssi');
  const txRate = summarize(readings, 'txRate');
  return { rssi, txRate, stability: stabilityLabel(rssi.std) };
}
