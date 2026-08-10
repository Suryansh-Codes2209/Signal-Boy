/**
 * Raw TelephonyManager cell info in, a normalized serving/neighbor picture out.
 *
 * Read-only telephony state, never modem control: the phone's baseband is
 * locked firmware with no app-accessible transmit path, so this reports what
 * the radio already knows -- which cells it sees and how strong they are -- and
 * nothing it could be made to do. Same discipline as android-map.js: the Kotlin
 * TelephonyBridge forwards raw fields, and every judgment (which cell serves,
 * what band an EARFCN is, how to word a permission error) lives here under
 * `node --test`.
 */

/**
 * Downlink E-UTRA EARFCN -> LTE band, a representative subset of the 3GPP
 * table. An unlisted EARFCN returns null rather than a guess -- the same
 * "never fabricate" rule android-map.js uses for channels.
 */
export const LTE_BANDS = [
  { band: 1, lo: 0, hi: 599 },
  { band: 2, lo: 600, hi: 1199 },
  { band: 3, lo: 1200, hi: 1949 },
  { band: 4, lo: 1950, hi: 2399 },
  { band: 5, lo: 2400, hi: 2649 },
  { band: 7, lo: 2750, hi: 3449 },
  { band: 8, lo: 3450, hi: 3799 },
  { band: 12, lo: 5010, hi: 5179 },
  { band: 13, lo: 5180, hi: 5279 },
  { band: 20, lo: 6150, hi: 6449 },
  { band: 25, lo: 8040, hi: 8689 },
  { band: 26, lo: 8690, hi: 9039 },
  { band: 28, lo: 9210, hi: 9659 },
  { band: 66, lo: 66436, hi: 67335 },
  { band: 71, lo: 68586, hi: 68935 },
];

export function earfcnToLteBand(earfcn) {
  if (earfcn == null || !Number.isFinite(earfcn)) return null;
  const match = LTE_BANDS.find((b) => earfcn >= b.lo && earfcn <= b.hi);
  return match ? `B${match.band}` : null;
}

/** The dBm a given radio type actually reports its signal in. */
function primaryDbm(raw) {
  if (raw.rsrp != null) return raw.rsrp; // LTE
  if (raw.ssRsrp != null) return raw.ssRsrp; // NR (5G)
  if (raw.rscp != null) return raw.rscp; // WCDMA
  if (raw.rssi != null) return raw.rssi; // GSM
  if (raw.dbm != null) return raw.dbm; // generic fallback
  return null;
}

/** One CellInfo, normalized to a common shape with its identity preserved. */
export function normalizeCell(raw) {
  const type = raw.type ?? 'UNKNOWN';
  return {
    type,
    registered: raw.registered === true,
    dbm: primaryDbm(raw),
    rsrp: raw.rsrp ?? raw.ssRsrp ?? null,
    rsrq: raw.rsrq ?? raw.ssRsrq ?? null,
    level: raw.level ?? null,
    band: type === 'LTE' ? earfcnToLteBand(raw.earfcn) : null,
    identity: {
      cid: raw.cid ?? raw.nci ?? null,
      pci: raw.pci ?? null,
      tac: raw.tac ?? raw.lac ?? null,
      earfcn: raw.earfcn ?? raw.nrarfcn ?? raw.arfcn ?? null,
      mcc: raw.mcc ?? null,
      mnc: raw.mnc ?? null,
    },
  };
}

const ERROR_COPY = {
  PERMISSION_DENIED: 'PHONE-STATE / LOCATION PERMISSION DENIED.',
  NO_TELEPHONY: 'NO CELLULAR MODEM ON THIS DEVICE.',
  AIRPLANE: 'AIRPLANE MODE OR NO SERVICE.',
};

/**
 * The full picture: every visible cell strongest-first, plus the serving one
 * (the registered cell, or the strongest if the platform flags none). On an
 * error, an empty list with a readable message and its code.
 */
export function mapCells(raw) {
  if (!raw || raw.supported !== true) {
    const code = raw?.error ?? 'UNKNOWN';
    return { supported: false, code, error: ERROR_COPY[code] ?? 'NO CELL INFO AVAILABLE.', cells: [], serving: null };
  }

  const cells = (raw.cells ?? [])
    .map(normalizeCell)
    .sort((a, b) => (b.dbm ?? -999) - (a.dbm ?? -999));
  const serving = cells.find((c) => c.registered) ?? cells[0] ?? null;
  return { supported: true, cells, serving };
}

/** Cell identity needs BOTH phone-state and location; granted is the AND of them. */
export function mapCellPermissions(raw) {
  const phoneState = raw?.phoneState === true;
  const location = raw?.location === true;
  return { phoneState, location, granted: phoneState && location };
}
