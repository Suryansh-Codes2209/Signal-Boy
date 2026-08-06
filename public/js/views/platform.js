import { el, clear } from '../dom.js';
import { unavailableReason } from '../capabilities.js';

/**
 * Platform comparison and capability disclosure.
 *
 * Signal Boy's abilities differ sharply by OS and the differences do not form a
 * hierarchy: Windows lists every neighbouring access point while macOS refuses
 * to, macOS reports a true noise floor while Windows reports none, and a phone
 * carries a magnetometer and rear camera that no laptop has. This view makes
 * that explicit instead of silently greying controls out.
 *
 * The host platform is detected by the daemon and is authoritative -- the
 * toggle selects which platform to *read about*, not which hardware is in use.
 */

const MARKS = { full: '###', partial: '#--', none: '---' };
const SUPPORT_LABEL = { full: 'FULL', partial: 'PARTIAL', none: 'NONE' };

export function createPlatformView(root, { platform, client }) {
  const platforms = platform.platforms;
  const ids = Object.keys(platforms);
  let selected = client.isHostMachine ? platform.host : client.platform;
  if (!platforms[selected]) selected = platform.host;

  const toggleRow = el('div', { class: 'row' });
  const matrixWrap = el('div', { class: 'panel-body' });
  const detailWrap = el('div', { class: 'panel-body' });

  root.append(
    el(
      'section',
      { class: 'panel' },
      el('h2', { text: 'This setup' }),
      el('div', { class: 'panel-body' }, renderIdentity(platform, client)),
    ),
    el(
      'section',
      { class: 'panel' },
      el('h2', { text: 'Platform' }),
      el('div', { class: 'panel-body' }, toggleRow),
    ),
    el('section', { class: 'panel' }, el('h2', { text: 'Capability matrix' }), matrixWrap),
    el('section', { class: 'panel' }, el('h2', { text: 'Detail' }), detailWrap),
  );

  function renderToggle() {
    clear(toggleRow).append(
      ids.map((id) =>
        el('button', {
          class: 'btn',
          type: 'button',
          text: platforms[id].label,
          'aria-pressed': String(id === selected),
          onClick: () => {
            selected = id;
            render();
          },
        }),
      ),
    );
  }

  function renderMatrix() {
    clear(matrixWrap).append(
      el(
        'div',
        { style: 'overflow-x:auto' },
        el(
          'table',
          { class: 'matrix' },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', { scope: 'col', text: 'CAPABILITY' }),
              ids.map((id) =>
                el('th', {
                  scope: 'col',
                  text: platforms[id].label,
                  class: id === selected ? 'is-active' : '',
                }),
              ),
            ),
          ),
          el(
            'tbody',
            {},
            platform.matrix.map((row) =>
              el(
                'tr',
                {},
                el('th', { scope: 'row', text: row.label }),
                ids.map((id) => {
                  const support = row.byPlatform[id] ?? 'none';
                  return el(
                    'td',
                    {
                      dataset: { support },
                      class: id === selected ? 'is-active' : '',
                      title: `${platforms[id].label}: ${SUPPORT_LABEL[support]}`,
                    },
                    el('span', { class: 'mark', text: MARKS[support] }),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
      el(
        'div',
        { class: 'legend' },
        [
          ['full', 'FULL SUPPORT'],
          ['partial', 'PARTIAL / APPROXIMATE'],
          ['none', 'NOT POSSIBLE'],
        ].map(([key, label]) =>
          el('span', { class: 'legend-item' }, el('span', { class: 'mark', text: MARKS[key] }), label),
        ),
      ),
    );
  }

  function renderDetail() {
    const p = platforms[selected];
    clear(detailWrap).append(
      el('p', { class: 'note' }, el('strong', { text: `${p.label}: ` }), p.note),
      el(
        'div',
        { class: 'stats' },
        platform.matrix.map((row) => {
          const cap = p.capabilities[row.key] ?? { support: 'none' };
          return el(
            'div',
            { class: 'stat', dataset: { muted: String(cap.support === 'none') } },
            el('dt', { text: row.label }),
            el(
              'dd',
              {},
              SUPPORT_LABEL[cap.support],
              cap.via ? el('span', { class: 'unit', text: ` ${cap.via}` }) : null,
            ),
            cap.detail
              ? el('div', { style: 'font-size:10px;text-transform:none;line-height:1.5;margin-top:4px' }, cap.detail)
              : null,
          );
        }),
      ),
    );
  }

  function render() {
    renderToggle();
    renderMatrix();
    renderDetail();
  }

  render();
  return { render };
}

/** Summarises the actual running setup: which machine senses, which one displays. */
function renderIdentity(platform, client) {
  const { features } = client;
  const rows = [
    ['DAEMON HOST', `${platform.label}${platform.forced ? ' (FORCED)' : ''}`],
    ['THIS DEVICE', client.isHostMachine ? 'SAME MACHINE' : (platform.platforms[client.platform]?.label ?? client.platform.toUpperCase())],
    ['SECURE CONTEXT', features.secureContext ? 'YES' : 'NO'],
    ['WEB BLUETOOTH', features.bluetoothLeScan ? 'SCAN OK' : features.webBluetooth ? 'LIMITED' : 'NO'],
    ['CAMERA', features.camera ? 'YES' : 'NO'],
    ['MAGNETOMETER', features.magnetometer ? 'YES' : 'NO'],
  ];

  const notes = [];
  if (!client.isHostMachine) {
    notes.push(
      'You are viewing from a different device than the one sensing. WiFi and network readings come from the daemon host; Bluetooth, camera and magnetometer come from this device.',
    );
  }
  if (!features.secureContext) {
    notes.push(unavailableReason('camera', features));
  }

  return el(
    'div',
    {},
    el(
      'div',
      { class: 'stats' },
      rows.map(([label, value]) =>
        el('div', { class: 'stat' }, el('dt', { text: label }), el('dd', { text: value })),
      ),
    ),
    notes.filter(Boolean).map((text) => el('p', { class: 'note' }, text)),
  );
}
