import { gradeRssi, qualityPercent } from './pathloss.js';

/**
 * Turns a raw WiFi reading into the fields every view actually renders:
 * filtered dBm, smoothed dBm, quality band and percent.
 *
 * Both the daemon (server/index.js, polling a desktop backend) and the APK
 * (public/js/sources/native.js, receiving pushes from the Kotlin bridge) run
 * this over their own reading with their own Kalman/EWMA instances. It lives
 * here, under public/js/core/, rather than in either caller, so there is
 * exactly one place that decides what a filtered reading looks like -- tuning
 * `measurementNoise` once tunes it for every platform. Pure data in, pure data
 * out: no I/O, no platform knowledge, so both a browser and a Node process can
 * import it unchanged.
 *
 * A failed reading resets both filters rather than being fed through them --
 * otherwise the estimate would resume from wherever it sat when the radio
 * dropped, and the first reading after reconnecting would be a lie about how
 * quickly the signal recovered.
 */
export function applyFilters(reading, { kalman, ewma }) {
  if (!reading.ok) {
    kalman.reset();
    ewma.reset();
    return reading;
  }

  const filtered = kalman.update(reading.rssi);
  const smoothed = ewma.update(reading.rssi);
  const grade = gradeRssi(filtered);

  return {
    ...reading,
    filtered,
    smoothed,
    // Named qualityBand, not band: `band` already means the radio frequency
    // band (2.4/5/6GHz) on the reading and must not be clobbered.
    qualityBand: grade?.key ?? null,
    bandLabel: grade?.label ?? null,
    shade: grade?.shade ?? 0,
    quality: qualityPercent(filtered),
    variance: kalman.variance,
  };
}
