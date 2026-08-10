/**
 * What a BLE advertisement most likely is, from the identity it broadcasts.
 *
 * A device that advertises a well-known service UUID or a known company id can
 * be named -- an Eddystone beacon, a Tile, an Apple Find My tag, a phone. This
 * is a best-effort label from public assigned numbers, not a certainty: any
 * device can advertise anything, so the view shows the label as a hint beside
 * the address, never as a verdict, and "UNKNOWN" is a first-class outcome.
 *
 * Pure over the mapDevice() shape (serviceUuids / manufacturerId /
 * manufacturerData). No distance, no tracking claim -- just identity. `node
 * --test` covers every branch against synthetic advertisements.
 */

/** Bluetooth SIG company identifiers seen most often in the wild. */
export const COMPANY_NAMES = {
  0x004c: 'APPLE',
  0x0006: 'MICROSOFT',
  0x00e0: 'GOOGLE',
  0x0075: 'SAMSUNG',
  0x0087: 'GARMIN',
};

/** 16-bit service UUIDs with a specific meaning worth surfacing. */
const SERVICE_CLASS = {
  feaa: { label: 'EDDYSTONE BEACON', category: 'beacon' },
  fd6f: { label: 'EXPOSURE NOTIFICATION', category: 'phone' },
  feed: { label: 'TILE TRACKER', category: 'tracker' },
  feec: { label: 'TILE TRACKER', category: 'tracker' },
};

/** Apple manufacturer-data type byte 0x12 is the Find My (offline finding) payload. */
const APPLE_FIND_MY = 0x12;
/** 0x07 is proximity pairing (AirPods and friends). */
const APPLE_PROXIMITY_PAIRING = 0x07;

/** '0000feaa-0000-1000-8000-00805f9b34fb' -> 'feaa'; a bare 'feaa' passes through. */
export function shortUuid(uuid) {
  if (!uuid) return null;
  const s = String(uuid).toLowerCase();
  const base = s.match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/);
  if (base) return base[1];
  if (/^[0-9a-f]{4}$/.test(s)) return s;
  return s; // a custom/128-bit UUID stays as-is
}

function firstByte(hex) {
  if (!hex || String(hex).length < 2) return null;
  const value = parseInt(String(hex).slice(0, 2), 16);
  return Number.isNaN(value) ? null : value;
}

function vendorFromCompany(company) {
  return company != null ? (COMPANY_NAMES[company] ?? null) : null;
}

/** { label, category: 'beacon'|'tracker'|'phone'|'wearable'|'unknown', vendor }. */
export function classifyBeacon(device) {
  const uuids = (device?.serviceUuids ?? []).map(shortUuid).filter(Boolean);
  for (const u of uuids) {
    if (SERVICE_CLASS[u]) {
      return { ...SERVICE_CLASS[u], vendor: vendorFromCompany(device?.manufacturerId) };
    }
  }

  const company = device?.manufacturerId;
  const vendor = vendorFromCompany(company);
  if (vendor) {
    if (company === 0x004c) {
      const type = firstByte(device.manufacturerData);
      if (type === APPLE_FIND_MY) return { label: 'APPLE FIND MY (AIRTAG-CLASS)', category: 'tracker', vendor };
      if (type === APPLE_PROXIMITY_PAIRING) return { label: 'APPLE PROXIMITY PAIRING', category: 'wearable', vendor };
      return { label: 'APPLE DEVICE', category: 'phone', vendor };
    }
    return { label: `${vendor} DEVICE`, category: 'phone', vendor };
  }

  return { label: 'UNKNOWN', category: 'unknown', vendor: null };
}
