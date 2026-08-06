import { el, clear, $ } from './dom.js';
import { Stream, apiGet } from './stream.js';
import { clientProfile } from './capabilities.js';
import { createCompanion } from './companion.js';
import { createLiveView } from './views/live.js';
import { createPlatformView } from './views/platform.js';
import { createWalkView } from './views/walk.js';

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
  { id: 'platform', label: 'PLATFORM', create: createPlatformView },
];

const state = {
  platform: null,
  client: clientProfile(),
  views: new Map(),
  active: null,
  companion: null,
};

const stream = new Stream();

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
  state.active = id;

  for (const [viewId, entry] of state.views) {
    entry.root.classList.toggle('is-active', viewId === id);
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === id));
  }
  location.hash = id;
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
    stream,
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
    state.platform = await apiGet('/api/platform');
  } catch (err) {
    $('#views').append(
      el(
        'p',
        { class: 'note' },
        el('strong', { text: 'Daemon unreachable: ' }),
        `${err.message}. Start it with "npm start" and reload.`,
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

  stream.onStateChange(setConnectionState);
  stream.on('wifi', (reading) => {
    // Every view that consumes readings gets them; PLATFORM has no update and
    // is skipped by the optional call.
    for (const { api } of state.views.values()) api.update?.(reading);
    state.companion.update(reading);
  });
  stream.connect();
  state.companion.greet(state.platform.label);
}

start();
