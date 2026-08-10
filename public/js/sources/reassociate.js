/**
 * Following one BLE device across a MAC rotation.
 *
 * Modern trackers (AirTags, Tiles, phones) rotate their Bluetooth address every
 * ~15 minutes precisely so they can't be followed by address alone. When the
 * address a hunt is tracking disappears, the same physical device is usually
 * still advertising under a fresh one. This module scores the currently-visible
 * devices against what we last knew about the lost track and, if one is a
 * confident enough match, names it as a *possible* continuation.
 *
 * It is deliberately a heuristic and is surfaced as one ("RE-ACQUIRED?", never
 * "RE-ACQUIRED"): the caller shows the score and lets the human decide. Pure
 * arithmetic over plain objects, so `node --test` covers every branch without a
 * radio -- the same discipline android-map.js and radar-map.js follow.
 *
 * Evidence used, strongest first:
 *   - manufacturer company id: stable per vendor across a rotation. If both
 *     sides advertise one and they differ, it is a different device, full stop.
 *   - service UUID overlap: a device keeps advertising the same services.
 *   - transmit power: a hardware constant, unchanged by a rotation.
 *   - RSSI proximity: a rotation is instantaneous, so the same device is at
 *     essentially the same distance the moment before and after -- but on its
 *     own this is far too weak to claim a match, so it can never cross the bar
 *     alone.
 */

/** Minimum score to treat a candidate as the same device. */
export const DEFAULT_MIN_SCORE = 0.5;

/** dBm difference over which two readings count as "not the same distance". */
export const RSSI_WINDOW_DB = 12;

/** txPower difference (dBm) over which the hardware looks different. */
const TXPOWER_WINDOW_DB = 10;

// Weights sum to 1.0. A missing feature contributes nothing rather than being
// guessed, so less evidence honestly yields a lower score -- an rssi-only match
// tops out at the rssi weight, which sits below DEFAULT_MIN_SCORE by design.
const W_MANUFACTURER = 0.35;
const W_SERVICES = 0.2;
const W_TXPOWER = 0.2;
const W_RSSI = 0.25;

/** Jaccard overlap of two UUID lists, or null when neither side advertises any. */
function serviceOverlap(a = [], b = []) {
  const la = a ?? [];
  const lb = b ?? [];
  if (!la.length && !lb.length) return null;
  const setB = new Set(lb);
  let intersection = 0;
  for (const uuid of new Set(la)) if (setB.has(uuid)) intersection += 1;
  const union = new Set([...la, ...lb]).size;
  return union ? intersection / union : null;
}

/**
 * How strongly `candidate` (a currently-visible device) looks like `lost` (the
 * track that just vanished). Returns 0..1; exactly 0 when a stable company id
 * rules it out.
 */
export function scoreCandidate(lost, candidate) {
  if (!lost || !candidate) return 0;

  // Hard disqualifier: two known-but-different company ids cannot be one device.
  if (
    lost.manufacturerId != null &&
    candidate.manufacturerId != null &&
    lost.manufacturerId !== candidate.manufacturerId
  ) {
    return 0;
  }

  let score = 0;

  if (lost.manufacturerId != null && candidate.manufacturerId != null) {
    score += W_MANUFACTURER; // same id, already past the mismatch check above
  }

  const overlap = serviceOverlap(lost.serviceUuids, candidate.serviceUuids);
  if (overlap != null) score += W_SERVICES * overlap;

  if (lost.txPower != null && candidate.txPower != null) {
    const closeness = Math.max(0, 1 - Math.abs(lost.txPower - candidate.txPower) / TXPOWER_WINDOW_DB);
    score += W_TXPOWER * closeness;
  }

  if (lost.rssi != null && candidate.rssi != null) {
    const proximity = Math.max(0, 1 - Math.abs(lost.rssi - candidate.rssi) / RSSI_WINDOW_DB);
    score += W_RSSI * proximity;
  }

  return score;
}

/**
 * The best candidate to continue the lost track as, or null if none is
 * convincing. `exclude` is the set of addresses already on screen before the
 * loss -- those were advertising alongside the old address, so they cannot be
 * its rotated continuation.
 */
export function reassociate(lost, candidates, { minScore = DEFAULT_MIN_SCORE, exclude = [] } = {}) {
  if (!lost) return null;
  const seen = new Set(exclude);
  let best = null;

  for (const candidate of candidates ?? []) {
    if (!candidate || candidate.address === lost.address) continue;
    if (seen.has(candidate.address)) continue;
    const score = scoreCandidate(lost, candidate);
    if (score >= minScore && (best == null || score > best.score)) {
      best = { address: candidate.address, score, device: candidate };
    }
  }

  return best;
}
