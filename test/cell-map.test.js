import test from 'node:test';
import assert from 'node:assert/strict';

import { earfcnToLteBand, normalizeCell, mapCells, mapCellPermissions } from '../public/js/sources/cell-map.js';

test('earfcnToLteBand maps a downlink EARFCN onto its 3GPP band', () => {
  assert.equal(earfcnToLteBand(300), 'B1');
  assert.equal(earfcnToLteBand(1500), 'B3');
  assert.equal(earfcnToLteBand(6300), 'B20');
  assert.equal(earfcnToLteBand(66886), 'B66');
  assert.equal(earfcnToLteBand(null), null);
  assert.equal(earfcnToLteBand(999999), null, 'an unlisted EARFCN stays null, not a guess');
});

test('normalizeCell picks the type-appropriate primary dBm', () => {
  // LTE and NR report RSRP; GSM reports RSSI; WCDMA reports RSCP.
  assert.equal(normalizeCell({ type: 'LTE', rsrp: -95 }).dbm, -95);
  assert.equal(normalizeCell({ type: 'NR', ssRsrp: -100 }).dbm, -100);
  assert.equal(normalizeCell({ type: 'GSM', rssi: -70 }).dbm, -70);
  assert.equal(normalizeCell({ type: 'WCDMA', rscp: -88 }).dbm, -88);
});

test('normalizeCell derives an LTE band from the EARFCN and carries identity through', () => {
  const cell = normalizeCell({
    type: 'LTE',
    registered: true,
    rsrp: -95,
    rsrq: -11,
    level: 3,
    cid: 12345,
    pci: 210,
    tac: 4,
    earfcn: 1500,
    mcc: '310',
    mnc: '410',
  });
  assert.equal(cell.band, 'B3');
  assert.equal(cell.registered, true);
  assert.equal(cell.rsrp, -95);
  assert.equal(cell.rsrq, -11);
  assert.equal(cell.level, 3);
  assert.equal(cell.identity.pci, 210);
  assert.equal(cell.identity.earfcn, 1500);
});

test('mapCells sorts by signal and picks the registered cell as serving', () => {
  const mapped = mapCells({
    supported: true,
    cells: [
      { type: 'LTE', registered: false, rsrp: -80, pci: 1, earfcn: 1500 },
      { type: 'LTE', registered: true, rsrp: -95, pci: 2, earfcn: 6300 },
      { type: 'LTE', registered: false, rsrp: -110, pci: 3, earfcn: 300 },
    ],
  });
  assert.equal(mapped.supported, true);
  assert.deepEqual(mapped.cells.map((c) => c.identity.pci), [1, 2, 3], 'strongest first');
  assert.equal(mapped.serving.identity.pci, 2, 'the registered cell serves even when not the strongest');
  assert.equal(mapped.serving.band, 'B20');
});

test('mapCells falls back to the strongest cell when none is marked registered', () => {
  const mapped = mapCells({
    supported: true,
    cells: [
      { type: 'LTE', registered: false, rsrp: -100, pci: 1 },
      { type: 'LTE', registered: false, rsrp: -85, pci: 2 },
    ],
  });
  assert.equal(mapped.serving.identity.pci, 2);
});

test('an unsupported or errored read carries its own readable message and empty cells', () => {
  const denied = mapCells({ supported: false, error: 'PERMISSION_DENIED' });
  assert.equal(denied.supported, false);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  assert.match(denied.error, /PERMISSION/i);
  assert.deepEqual(denied.cells, []);
  assert.equal(denied.serving, null);

  const none = mapCells(null);
  assert.equal(none.supported, false);
  assert.deepEqual(none.cells, []);
});

test('cell permissions default to the least-permissive reading', () => {
  assert.deepEqual(mapCellPermissions(null), { phoneState: false, location: false, granted: false });
  const both = mapCellPermissions({ phoneState: true, location: true });
  assert.equal(both.granted, true);
  const partial = mapCellPermissions({ phoneState: true, location: false });
  assert.equal(partial.granted, false, 'both grants are needed to read cell identity');
});
