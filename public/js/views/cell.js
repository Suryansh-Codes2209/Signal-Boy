import { el, clear, stat } from '../dom.js';
import { shadeColor } from '../render/palette.js';
import { cellBridge, createCellSource } from '../sources/cell.js';

/**
 * CELL: the cellular side of the same "what's in the air here" question the
 * WiFi and BLE tabs answer. Read-only telephony state -- serving and neighbor
 * cells, their band and signal -- polled slowly because cell state barely
 * moves. It never touches the modem's transmit side; that firmware is locked
 * and no app can reach it, which is stated plainly in the caption.
 *
 * On-device only (window.SignalBoyCell). A browser or desktop daemon has no
 * cellular radio, so the capability matrix reports `none` there and this view
 * shows why instead of an empty panel.
 */

const POLL_MS = 2000;

// Android's own 0-4 signal level maps straight onto the 4-colour LCD palette;
// this is the platform's bucket, not a WiFi-calibrated grade applied to a
// cellular dBm it doesn't fit.
function shadeForLevel(level) {
  if (level == null) return 0;
  return Math.max(0, Math.min(3, level >= 4 ? 3 : level));
}

export function createCellView(root, context) {
  const support = context.platform?.capabilities?.cellInfo ?? {};
  const bridge = cellBridge();
  const unsupported = support.support !== 'full' || !bridge;

  const status = el('p', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const grantBtn = el('button', { class: 'btn hidden', type: 'button', text: 'GRANT PERMISSION' });
  const servingBody = el('div', { class: 'panel-body' });
  const servingPanel = el('div', { class: 'panel hidden' }, el('h2', { text: 'SERVING CELL' }), servingBody);
  const neighborBody = el('div', { class: 'panel-body' });
  const neighborPanel = el('div', { class: 'panel hidden' }, el('h2', { text: 'NEIGHBOURS' }), neighborBody);
  const caption = el('p', {
    class: 'note',
    text: 'READ-ONLY. SIGNAL AND CELL IDENTITY ONLY -- THE MODEM CANNOT BE TRANSMITTED FROM BY ANY APP.',
  });

  root.append(el('div', { class: 'cell' }, status, grantBtn, servingPanel, neighborPanel, caption));

  if (unsupported) {
    status.textContent = support.detail ?? 'THIS PLATFORM HAS NO CELLULAR RADIO TO READ.';
    return {};
  }

  const source = createCellSource(bridge);
  let timer = null;

  function renderServing(cell) {
    clear(servingBody);
    servingBody.append(
      el(
        'div',
        { class: 'stats' },
        stat('TYPE', cell.type),
        stat('BAND', cell.band),
        stat('RSRP', cell.rsrp, { unit: 'DBM' }),
        stat('RSRQ', cell.rsrq, { unit: 'DB' }),
        stat('LEVEL', cell.level == null ? null : `${cell.level}/4`),
        stat('CID', cell.identity.cid),
        stat('PCI', cell.identity.pci),
        stat('TAC', cell.identity.tac),
        stat('EARFCN', cell.identity.earfcn),
        stat('MCC/MNC', cell.identity.mcc && cell.identity.mnc ? `${cell.identity.mcc}/${cell.identity.mnc}` : null),
      ),
    );
    servingPanel.classList.remove('hidden');
  }

  function renderNeighbors(cells, servingCell) {
    const others = cells.filter((c) => c !== servingCell);
    clear(neighborBody);
    if (!others.length) {
      neighborPanel.classList.add('hidden');
      return;
    }
    for (const c of others) {
      neighborBody.append(
        el(
          'div',
          { class: 'cell-row' },
          el('span', { class: 'cell-swatch', style: `background:${shadeColor(shadeForLevel(c.level))}` }),
          el('span', { class: 'cell-type', text: [c.type, c.band].filter(Boolean).join(' ') }),
          el('span', { class: 'cell-dbm', text: c.dbm == null ? 'N/A' : `${c.dbm} DBM` }),
          el('span', { class: 'cell-id', text: c.identity.pci != null ? `PCI ${c.identity.pci}` : '' }),
        ),
      );
    }
    neighborPanel.classList.remove('hidden');
  }

  function poll() {
    const result = source.read();
    if (!result.supported) {
      servingPanel.classList.add('hidden');
      neighborPanel.classList.add('hidden');
      status.textContent = result.error ?? 'NO CELL INFO.';
      // A denied read is one tap from fixed, same as the WiFi/BLE flow.
      grantBtn.classList.toggle('hidden', result.code !== 'PERMISSION_DENIED');
      return;
    }
    grantBtn.classList.add('hidden');
    if (!result.serving) {
      servingPanel.classList.add('hidden');
      neighborPanel.classList.add('hidden');
      status.textContent = 'NO CELLS VISIBLE (NO SERVICE?).';
      return;
    }
    status.textContent = `${result.cells.length} CELL${result.cells.length === 1 ? '' : 'S'} VISIBLE.`;
    renderServing(result.serving);
    renderNeighbors(result.cells, result.serving);
  }

  grantBtn.addEventListener('click', () => source.requestPermissions());

  // Kotlin calls this after a permission dialog resolves, so the panel refreshes
  // without waiting for the next poll tick or a manual tap.
  window.__signalboyCellPermissions = () => poll();

  function startPolling() {
    poll();
    if (!timer) timer = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
  });

  return {
    onShow: startPolling,
    onHide: stopPolling,
  };
}
