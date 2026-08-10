/**
 * dBm + channel -> spectrum geometry. Pure arithmetic, no canvas -- spectrum.js
 * draws it, the same split radar-map.js / radar.js use so the part that must be
 * correct is the part `node --test` can hold to account.
 *
 * This is a channel-POWER chart, not an SDR spectrum: the phone's WiFi radio
 * reports one RSSI per access point, not a swept power-vs-frequency trace. So
 * each AP becomes one mark at its channel (x) and signal (height), and the
 * "spectrum" is the envelope of those marks across a band. The view labels it
 * as such -- no real noise floor or spectral shape is implied.
 */

import { RSSI_FLOOR, RSSI_CEILING, gradeRssi } from '../core/pathloss.js';

/** Channel number ranges used to place a channel along each band's x-axis. */
export const CHANNEL_RANGE = {
  '2.4GHz': [1, 14],
  '5GHz': [36, 165],
  '6GHz': [1, 233],
};

const BANDS = ['2.4GHz', '5GHz', '6GHz'];

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/** Signal strength as a 0..1 bar height over the usable dBm range; 0 for no reading. */
export function rssiToHeightFraction(rssi) {
  if (rssi == null || !Number.isFinite(rssi)) return 0;
  return clamp01((rssi - RSSI_FLOOR) / (RSSI_CEILING - RSSI_FLOOR));
}

/** A channel's horizontal position within its band, 0..1; null for an unknown band. */
export function channelToXFraction(channel, band) {
  const range = CHANNEL_RANGE[band];
  if (!range || channel == null) return null;
  const [lo, hi] = range;
  return clamp01((channel - lo) / (hi - lo));
}

/** One band's marks: { band, points: [{ ssid, channel, rssi, xFraction, heightFraction, shade }] }. */
export function buildSpectrum(networks, band) {
  const points = (networks ?? [])
    .filter((n) => n.band === band && n.channel != null)
    .map((n) => ({
      ssid: n.ssid,
      channel: n.channel,
      rssi: n.rssi,
      xFraction: channelToXFraction(n.channel, band),
      heightFraction: rssiToHeightFraction(n.rssi),
      shade: gradeRssi(n.rssi)?.shade ?? 0,
    }))
    .sort((a, b) => a.channel - b.channel);
  return { band, points };
}

/** A spectrum per band that has any APs, busiest band first. */
export function spectrumByBand(networks) {
  return BANDS.map((band) => buildSpectrum(networks, band))
    .filter((s) => s.points.length > 0)
    .sort((a, b) => b.points.length - a.points.length);
}
