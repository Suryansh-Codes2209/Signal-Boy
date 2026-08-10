/**
 * Turns a flat scan list into an environment picture: how crowded each band
 * and channel is, and which 2.4GHz channel is least contested.
 *
 * Input is exactly what mapScanResults() in android-map.js returns (and what
 * the win32/linux daemon backends return too), so this analysis works for a
 * browser talking to a desktop daemon as well as for the APK. Pure functions
 * over that array -- no I/O, no platform knowledge -- so `node --test` covers
 * the arithmetic against synthetic scans.
 *
 * Everything here is derived from a single throttled snapshot (Android allows
 * four scans per two minutes), never a live feed; the view labels it as such.
 */

import { RSSI_FLOOR, RSSI_CEILING } from '../core/pathloss.js';

/** The three 2.4GHz channels whose 22MHz masks do not overlap each other. */
export const NON_OVERLAPPING_24 = [1, 6, 11];

const BANDS = ['2.4GHz', '5GHz', '6GHz'];

/**
 * 2.4GHz channels are 5MHz apart but ~22MHz wide, so a channel bleeds into its
 * neighbours up to about four channels away. This is the fraction of one AP's
 * energy that lands on a channel `delta` away, linear to zero at 5.
 */
function overlap24(delta) {
  return Math.max(0, 1 - Math.abs(delta) / 5);
}

/**
 * How much an AP contributes to interference, by signal strength: a loud
 * neighbour crowds a channel far more than a faint one. Maps the usable dBm
 * range onto 0.1..1 so even a weak AP counts for something, and a missing RSSI
 * counts as a mid-strength presence rather than zero.
 */
function signalWeight(rssi) {
  if (rssi == null || !Number.isFinite(rssi)) return 0.5;
  const level = (rssi - RSSI_FLOOR) / (RSSI_CEILING - RSSI_FLOOR);
  return Math.max(0.1, Math.min(1, level));
}

/** Count of APs per band, plus an honest `unknown` bucket for band-less APs. */
export function bandCounts(networks) {
  const counts = { '2.4GHz': 0, '5GHz': 0, '6GHz': 0, unknown: 0 };
  for (const n of networks ?? []) {
    if (BANDS.includes(n.band)) counts[n.band] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

/** { band: { channel: count } } for every AP that reports a band and channel. */
export function channelUsage(networks) {
  const usage = { '2.4GHz': {}, '5GHz': {}, '6GHz': {} };
  for (const n of networks ?? []) {
    if (!BANDS.includes(n.band) || n.channel == null) continue;
    const band = usage[n.band];
    band[n.channel] = (band[n.channel] ?? 0) + 1;
  }
  return usage;
}

/**
 * The least-contested of channels 1/6/11, weighting each other AP by how much
 * its channel overlaps the candidate and by how loud it is. Returns the winner
 * plus every candidate's score for display, or null when nothing is on 2.4GHz.
 */
export function recommend24Channel(networks) {
  const on24 = (networks ?? []).filter((n) => n.band === '2.4GHz' && n.channel != null);
  if (!on24.length) return null;

  const scored = NON_OVERLAPPING_24.map((channel) => {
    const score = on24.reduce(
      (sum, n) => sum + overlap24(n.channel - channel) * signalWeight(n.rssi),
      0,
    );
    return { channel, score };
  }).sort((a, b) => a.score - b.score);

  const [best, ...alternatives] = scored;
  return { channel: best.channel, score: best.score, alternatives };
}

/** The single most crowded (band, channel), or null on an empty scan. */
function busiestChannel(usage) {
  let busiest = null;
  for (const band of BANDS) {
    for (const [channel, count] of Object.entries(usage[band])) {
      if (busiest == null || count > busiest.count) {
        busiest = { band, channel: Number(channel), count };
      }
    }
  }
  return busiest;
}

/** One call the view uses: totals, per-band and per-channel usage, the busiest channel, and the 2.4GHz advice. */
export function analyzeWifi(networks) {
  const list = networks ?? [];
  const usage = channelUsage(list);
  return {
    total: list.length,
    bands: bandCounts(list),
    channels: usage,
    busiest: busiestChannel(usage),
    recommend24: recommend24Channel(list),
  };
}
