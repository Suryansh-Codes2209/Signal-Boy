import { el, clear, $ } from './dom.js';
import { createSource } from './sources/index.js';
import { clientProfile } from './capabilities.js';
import { createCompanion } from './companion.js';
import { createLiveView } from './views/live.js';
import { createPlatformView } from './views/platform.js';
import { createWalkView } from './views/walk.js';
import { createApsView } from './views/aps.js';
import { createBleView } from './views/ble.js';
import { createCellView } from './views/cell.js';
import { createLinkView } from './views/link.js';

/**
 * Application shell: fetches platform info, registers views and routes the
 * sensor stream to whichever view is mounted.
 *
 * Views register themselves here as later phases land, so the tab bar always
 * reflects what actually exists rather than showing placeholders.
 */

const VIEWS = [
  { id: 'walk', label: 'WALK', create: createWalkView },
  { id: 'live', label: 'LIVE', create: createLiveView },
  { id: 'aps', label: 'NEARBY', create: createApsView },
  { id: 'ble', label: 'HUNT', create: createBleView },
  { id: 'cell', label: 'CELL', create: createCellView },
  { id: 'link', label: 'LINK', create: createLinkView },
  { id: 'platform', label: 'PLATFORM', create: createPlatformView },
];

const state = {
  platform: null,
  client: clientProfile(),
  views: new Map(),
  active: null,
  companion: null,
};

const source = createSource();

function setConnectionState(next) {
  const led = $('#led');
  const label = $('#conn');
  if (led) led.dataset.state = next;
  if (label) {
    label.textContent = { connecting: 'CONNECTING', live: 'LIVE', error: 'RECONNECTING' }[next] ?? next;
  }
}

function mount(id) {
  if (state.active === id) return;
  const previous = state.active;
  state.active = id;

  for (const [viewId, entry] of state.views) {
    entry.root.classList.toggle('is-active', viewId === id);
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === id));
  }
  location.hash = id;

  // Optional lifecycle: only HUNT uses it today, to stop its BLE scan the
  // moment it is not the tab on screen. Every other view's api has neither
  // method, so both calls are no-ops there.
  if (previous) state.views.get(previous)?.api.onHide?.();
  state.views.get(id)?.api.onShow?.();
}

function buildTabs() {
  const tabs = clear($('#tabs'));
  for (const view of VIEWS) {
    tabs.append(
      el('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        text: view.label,
        dataset: { view: view.id },
        'aria-selected': 'false',
        onClick: () => mount(view.id),
      }),
    );
  }
}

function buildViews() {
  const container = clear($('#views'));
  const context = {
    platform: state.platform,
    client: state.client,
    source,
    companion: state.companion,
  };

  for (const view of VIEWS) {
    const root = el('section', { class: 'view', dataset: { view: view.id } });
    container.append(root);
    state.views.set(view.id, { root, api: view.create(root, context) });
  }
}

async function start() {
  setConnectionState('connecting');

  try {
    state.platform = await source.loadPlatform();
  } catch (err) {
    $('#views').append(
      el(
        'p',
        { class: 'note' },
        el('strong', { text: 'Daemon unreachable: ' }),
        // Published users run npx, not npm start -- and on a phone the daemon
        // is on a different machine entirely, so "start it" has to say where.
        `${err.message}. Run "npx signalboy" on the machine doing the measuring, then reload this page.`,
      ),
    );
    setConnectionState('error');
    return;
  }

  $('#host-platform').textContent = state.platform.label;

  state.companion = createCompanion(clear($('#companion')));
  buildTabs();
  buildViews();

  const initial = location.hash.slice(1);
  const fallback = state.client.isHostMachine ? 'live' : 'walk';
  mount(VIEWS.some((v) => v.id === initial) ? initial : fallback);

  source.onStateChange(setConnectionState);
  source.on('wifi', (reading) => {
    // Every view that consumes readings gets them; PLATFORM has no update and
    // is skipped by the optional call.
    for (const { api } of state.views.values()) api.update?.(reading);
    state.companion.update(reading);
  });
  source.connect();
  state.companion.greet(state.platform.label);
}

start();
