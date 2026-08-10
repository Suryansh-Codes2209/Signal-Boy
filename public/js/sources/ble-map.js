/**
 * Raw BleBridge values in, a stable device list out.
 *
 * Mirrors public/js/sources/android-map.js: BleBridge.kt forwards raw
 * ScanResult fields with no interpretation, and every judgment call --
 * sorting, what "no name" means, how a permission-denied or radio-off state
 * reads -- lives here, where node --test covers it against captured payloads
 * with no device and no emulator.
 *
 * Distance is never derived, anywhere in this module. pathloss.js's model is
 * calibrated against WiFi transmit power; BLE transmit power varies wildly by
 * device by design, so a metre figure computed from BLE RSSI would be
 * invented, not measured. Callers grade hot/cold by RSSI alone, the same as
 * every other reading this project shows.
 */

/** One advertisement, raw fields mapped straight across with no fabrication. */
export function mapDevice(raw) {
  return {
    address: raw.address ?? null,
    // No name is a real, common state (plenty of trackers advertise none) --
    // this stays null so the view can render its own "UNNAMED" label rather
    // than the mapper inventing text.
    name: raw.name ?? null,
    rssi: raw.rssi ?? null,
    txPower: raw.txPower ?? null,
    connectable: raw.connectable === true,
    lastSeen: raw.timestamp ?? null,
    // Advertised identity, used by beacon-classify.js and the MAC-rotation
    // re-association heuristic -- never to derive distance. Absent fields stay
    // empty/null; the mapper invents nothing.
    serviceUuids: Array.isArray(raw.serviceUuids) ? raw.serviceUuids : [],
    manufacturerId: raw.manufacturerId ?? null,
    manufacturerData: raw.manufacturerData ?? null,
  };
}

/**
 * The current snapshot from BleBridge.results(), sorted loudest-first so the
 * device you are walking toward stays at the top of the list without the view
 * doing any of its own sorting.
 */
export function mapBleDevices(raw) {
  const devices = (raw?.devices ?? [])
    .map(mapDevice)
    .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  return { scanning: raw?.scanning === true, devices };
}

/**
 * "Bluetooth is off" and "permission denied" are different problems with
 * different fixes (a Settings toggle vs. a permission prompt), so BleBridge
 * reports them as distinct error codes and this keeps them distinct here too,
 * as separate boolean facts plus their own copy -- never one blended message.
 */
const ERROR_COPY = {
  BLUETOOTH_DISABLED: 'BLUETOOTH IS OFF.',
  PERMISSION_DENIED: 'BLUETOOTH PERMISSION DENIED.',
  UNSUPPORTED: 'NO BLUETOOTH RADIO ON THIS DEVICE.',
  SCANNER_UNAVAILABLE: 'BLE SCANNER UNAVAILABLE.',
};

export function mapScanStatus(raw) {
  if (raw?.ok === true) return { ok: true };

  const code = raw?.error ?? 'SCAN_FAILED';
  return {
    ok: false,
    code,
    needsPermission: code === 'PERMISSION_DENIED',
    bluetoothOff: code === 'BLUETOOTH_DISABLED',
    error: ERROR_COPY[code] ?? 'SCAN FAILED.',
  };
}

/** Raw permission/adapter facts, defaulting to the least-permissive reading. */
export function mapPermissions(raw) {
  return {
    bluetoothEnabled: raw?.bluetoothEnabled === true,
    scanGranted: raw?.scanGranted === true,
    connectGranted: raw?.connectGranted === true,
  };
}
