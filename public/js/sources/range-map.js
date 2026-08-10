/**
 * Raw RangingManager values in, an honest distance picture out.
 *
 * Same discipline as ble-map.js and cell-map.js: RangeBridge.kt forwards the
 * platform's own integers and makes no judgments, and everything that *is* a
 * judgment -- which technology to trust, what counts as a real bearing, how
 * many decimals a number has earned, what an availability code means in
 * English -- lives here under `node --test`. The int-to-name mapping below is
 * the same class of work android-map.js does for frequency-to-channel, and it
 * belongs on this side of the bridge for the same reason: it is testable here
 * and would need a device to test there.
 *
 * The distinction this module exists to protect: ble-map.js refuses to derive
 * distance because a BLE *advertisement* carries only an RSSI, and that refusal
 * is still correct. Ranging is a different mechanism -- a two-way exchange with
 * a peer whose controller answers, timing the round trip or comparing phase --
 * so the metres it produces are measured rather than modelled. Those two facts
 * coexist in one app, which is why `derived` below is a per-technology flag and
 * never a global assumption.
 */

/**
 * The four technologies RangingManager can range over, keyed by the platform's
 * own constant (android.ranging.RangingManager.UWB and friends).
 *
 * `derived` is the load-bearing field. BLE_RSSI is in the list because the
 * platform offers it, not because it is good: it is the same RSSI-to-distance
 * conversion this project refuses everywhere else, performed by the OS instead
 * of by us. Laundering it through a system API does not make it a measurement,
 * so it is flagged and its copy says so outright. The other three time a signal
 * or compare its phase; those are measurements.
 *
 * `decimals` is display precision, chosen not to out-claim the technology:
 * quoting a UWB-grade 3.42 m from an RSSI estimate would be a lie told in the
 * formatting layer.
 */
export const TECHNOLOGIES = [
  {
    code: 0, // RangingManager.UWB
    id: 'UWB',
    label: 'UWB',
    derived: false,
    decimals: 2,
    bearing: true,
    detail: 'Ultra-wideband. ~10 cm, and the only technology here that reports a real bearing.',
  },
  {
    code: 1, // RangingManager.BLE_CS
    id: 'BLE_CS',
    label: 'CHANNEL SOUNDING',
    derived: false,
    decimals: 2,
    bearing: false,
    detail: 'Bluetooth 6.0 phase-based ranging. Sub-metre, but carries no direction.',
  },
  {
    code: 2, // RangingManager.WIFI_NAN_RTT
    id: 'WIFI_NAN_RTT',
    label: 'WIFI RTT',
    derived: false,
    decimals: 1,
    bearing: false,
    detail: 'Round-trip time over Wi-Fi Aware. Metre-scale, no direction.',
  },
  {
    code: 3, // RangingManager.BLE_RSSI
    id: 'BLE_RSSI',
    label: 'BLE RSSI',
    derived: true,
    decimals: 0,
    bearing: false,
    detail:
      'Estimated from signal strength, not timed -- the same conversion this app refuses ' +
      'to make for advertisements. Treat it as a hint, never as a measurement.',
  },
];

/** Most precise first, so "best available" is a find() rather than a sort. */
const PRECEDENCE = TECHNOLOGIES.map((t) => t.code);

function technologyByCode(code) {
  return TECHNOLOGIES.find((t) => t.code === code) ?? null;
}

/**
 * RangingCapabilities' availability codes.
 *
 * Flattening these to a boolean would throw away the only part the user can act
 * on: "your phone cannot do this" and "you switched this radio off" and "this
 * is not permitted in this country" are three different messages, and only one
 * of them is worth walking to Settings for. Same reasoning that keeps
 * BLUETOOTH_DISABLED distinct from PERMISSION_DENIED in ble-map.js.
 */
export const AVAILABILITY = {
  0: { available: false, reason: 'NOT_SUPPORTED', detail: 'This phone has no radio for it.' },
  1: { available: false, reason: 'DISABLED_USER', detail: 'Switched off in Settings.' },
  2: { available: false, reason: 'DISABLED_REGULATORY', detail: 'Not permitted in this region.' },
  3: { available: true, reason: 'ENABLED', detail: null },
  4: { available: false, reason: 'DISABLED_USER_RESTRICTIONS', detail: 'Blocked by a device restriction.' },
};

const UNKNOWN_AVAILABILITY = {
  available: false,
  reason: 'UNKNOWN',
  detail: 'The platform reported a state this app does not recognise.',
};

/** RangingMeasurement confidence, which the platform reports per sample. */
export const CONFIDENCE = { 0: 'LOW', 1: 'MEDIUM', 2: 'HIGH' };

const ERROR_COPY = {
  REQUIRES_ANDROID_16: 'RANGING NEEDS ANDROID 16 OR NEWER.',
  NO_RANGING_HARDWARE: 'THIS PHONE HAS NO RANGING RADIO.',
  CAPABILITIES_PENDING: 'READING RANGING CAPABILITIES...',
  PERMISSION_DENIED: 'RANGING PERMISSION DENIED.',
  NO_PEER: 'NO DEVICE SELECTED TO RANGE.',
  // The expected outcome for most of HUNT's list, and the reason this is
  // phrased as a fact about the peer rather than as a failure.
  PEER_CANNOT_RANGE: 'THIS DEVICE CANNOT BE RANGED -- ITS RADIO DOES NOT ANSWER.',
  PEER_LOST: 'PEER STOPPED RANGING.',
  UNSUPPORTED: 'RANGING NOT SUPPORTED FOR THIS PEER.',
  SYSTEM_POLICY: 'THE SYSTEM STOPPED RANGING.',
  STOPPED: 'RANGING STOPPED.',
  SESSION_FAILED: 'RANGING SESSION FAILED.',
};

/**
 * Which technologies this handset reports, normalized against the table above.
 *
 * A code the table does not know is dropped rather than passed through: a
 * future Android could add one, and a row rendered with no precision and no
 * `derived` verdict would be a number on screen that nothing here has vouched
 * for. Silence beats an unvouched-for reading.
 */
export function mapCapabilities(raw) {
  if (!raw || raw.supported !== true) {
    const code = raw?.error ?? 'UNKNOWN';
    return {
      supported: false,
      code,
      error: ERROR_COPY[code] ?? 'RANGING UNAVAILABLE.',
      technologies: [],
      best: null,
    };
  }

  const reported = new Map();
  for (const entry of raw.technologies ?? []) {
    const known = technologyByCode(entry?.id);
    if (!known) continue;
    const availability = AVAILABILITY[entry?.availability] ?? UNKNOWN_AVAILABILITY;
    reported.set(known.code, {
      ...known,
      available: availability.available,
      reason: availability.reason,
      // The technology's own caveat and the reason it is off are different
      // sentences; a view showing "sub-metre, no direction" next to a radio the
      // user switched off would be answering a question nobody asked.
      unavailableDetail: availability.detail,
    });
  }

  const technologies = PRECEDENCE.filter((c) => reported.has(c)).map((c) => reported.get(c));
  // "Best" means most precise *and* measured: an available BLE_RSSI must never
  // be chosen while a timed technology is on offer, and it is selected at all
  // only when nothing better exists.
  const best =
    technologies.find((t) => t.available && !t.derived) ?? technologies.find((t) => t.available) ?? null;

  return { supported: true, code: null, error: null, technologies, best };
}

/**
 * Metres formatted at the precision its technology has earned, or null.
 *
 * Null in, null out -- a dropped sample is a real state (the peer moved behind
 * something, the session stuttered) and the caller renders its own placeholder
 * rather than this module carrying the last known value forward. Holding a
 * stale number would make a frozen readout indistinguishable from a live one,
 * the exact failure the WiFi meter's freshness counter exists to prevent.
 */
export function formatMetres(metres, technologyCode) {
  if (metres == null || !Number.isFinite(metres)) return null;
  const tech = technologyByCode(technologyCode);
  return `${metres.toFixed(tech?.decimals ?? 1)} M`;
}

/** One RangingData sample, normalized, with its provenance attached. */
export function normalizeResult(raw) {
  const tech = technologyByCode(raw?.technology);
  const metres = Number.isFinite(raw?.metres) ? raw.metres : null;

  // A bearing is kept only when the technology genuinely produces one. UWB is
  // the sole entry with bearing:true, so an azimuth arriving alongside any
  // other technology is discarded rather than drawn -- render/radar.js is built
  // to refuse an implied direction, and this is where that refusal is decided.
  const azimuth = Number.isFinite(raw?.azimuth) ? raw.azimuth : null;
  const bearing = tech?.bearing === true ? azimuth : null;

  return {
    peerId: raw?.peerId ?? null,
    metres,
    label: formatMetres(metres, raw?.technology),
    technology: tech?.id ?? null,
    technologyLabel: tech?.label ?? null,
    // Surfaced per sample, not just per capability: a session can fall back
    // from Channel Sounding to RSSI mid-run, and the reading must carry its own
    // provenance so the view never keeps a "measured" badge over an estimate.
    // An unrecognised technology counts as derived -- the cautious default.
    derived: tech ? tech.derived : true,
    confidence: CONFIDENCE[raw?.confidence] ?? null,
    bearing,
    elevation: tech?.bearing === true && Number.isFinite(raw?.elevation) ? raw.elevation : null,
    rssi: Number.isFinite(raw?.rssi) ? raw.rssi : null,
    timestamp: raw?.timestamp ?? null,
  };
}

/**
 * The answer to "did the session start", which is a different question from
 * "what is the distance" and so gets its own mapper -- exactly the split
 * ble-map.js draws between mapScanStatus and mapBleDevices.
 *
 * needsPermission and needsNewerAndroid are separate booleans because the fixes
 * are different and only one of them is actionable: a permission prompt is one
 * tap away, an OS version is not. Blending them into a single failure would
 * offer a GRANT button that could never work.
 */
export function mapSessionStatus(raw) {
  if (raw?.ok === true) return { ok: true, code: null, error: null, needsPermission: false, needsNewerAndroid: false };

  const code = raw?.error ?? 'SESSION_FAILED';
  return {
    ok: false,
    code,
    error: ERROR_COPY[code] ?? 'RANGING SESSION FAILED.',
    needsPermission: code === 'PERMISSION_DENIED',
    needsNewerAndroid: code === 'REQUIRES_ANDROID_16',
  };
}

/**
 * The live session: every ranged peer, nearest first.
 *
 * Sorted the way ble-map.js sorts loudest-first and for the same reason -- the
 * thing you are walking toward stays at the top without the view sorting. Peers
 * with no current fix sink to the bottom rather than being dropped, because a
 * peer that has gone quiet is information the hunt needs.
 */
export function mapRangeResults(raw) {
  if (!raw || raw.running !== true) {
    const code = raw?.error ?? null;
    return {
      running: false,
      code,
      error: code ? (ERROR_COPY[code] ?? 'RANGING STOPPED.') : null,
      peers: [],
    };
  }

  const peers = (raw.peers ?? [])
    .map(normalizeResult)
    .sort((a, b) => (a.metres ?? Infinity) - (b.metres ?? Infinity));

  return { running: true, code: null, error: null, peers };
}

/** Raw permission/support facts, defaulting to the least-permissive reading. */
export function mapRangePermissions(raw) {
  const apiSupported = raw?.apiSupported === true;
  const ranging = raw?.ranging === true;
  const bluetoothConnect = raw?.bluetoothConnect === true;
  return { apiSupported, ranging, bluetoothConnect, granted: apiSupported && ranging && bluetoothConnect };
}
