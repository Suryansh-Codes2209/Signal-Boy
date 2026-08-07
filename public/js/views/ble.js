import { el, clear } from '../dom.js';
import { shadeColor } from '../render/palette.js';
import { gradeRssi } from '../core/pathloss.js';
import { Kalman1D } from '../core/filter.js';
import { createBleSource, bleBridge } from '../sources/ble.js';
import { createAudioControls } from '../audio/controls.js';
import { PixelRadar } from '../render/radar.js';

/**
 * BLE hunting: every advertising device nearby, loudest first, refreshed
 * continuously while scanning is on.
 *
 * Unlike NEARBY, BLE has no OS throttle -- BluetoothLeScanner reports as fast
 * as devices actually advertise, which is what makes walking a device down in
 * real time possible at all. That same lack of a throttle is exactly why
 * scanning is opt-in here and stops the moment this tab is not the one on
 * screen: an unthrottled radio scan running behind a hidden tab is a battery
 * cost with no one watching the result.
 *
 * This is where audio feedback pays off: tap a device to select it, pocket
 * the phone, and walk on the tone or the click rate instead of the screen.
 * Selection tracks one device's RSSI through its own Kalman1D filter -- BLE
 * RSSI is noisier than WiFi's, and a raw value would make the tone warble
 * unusably within seconds. A device found by a fresh scan (or a rotated MAC)
 * gets a fresh filter; there is no cross-device smoothing to get confused by.
 *
 * Selecting a device also raises a radar (see render/radar.js): the same
 * filtered dBm placed on a ring instead of just spoken as a tone, for anyone
 * who has a screen free to look at it. It shows no more than the tone does --
 * no bearing, no distance -- and is torn down the instant selection drops.
 */

const POLL_MS = 1000;

// Uppercase, factual, no marketing: the three honest limits from the design
// amendment, stated once here rather than implied away by the UI.
const LIMITS_NOTE =
  'BLE ONLY. SHOWS WHAT ADVERTISES, NOT EVERYTHING NEARBY -- HIDDEN CAMERAS ARE USUALLY WIFI, SEE NEARBY INSTEAD. ' +
  'MOST TRACKERS ROTATE THEIR ADDRESS EVERY ~15 MIN, SO A DEVICE IS FOLLOWABLE WITHIN THAT WINDOW, NOT ACROSS A LONG HUNT. ' +
  'NO DISTANCE IS SHOWN. RSSI ONLY.';

export function createBleView(root, context) {
  const support = context.platform?.capabilities?.bleScan ?? {};
  const bridge = bleBridge();
  // The capability matrix can say FULL on a platform this JS build never
  // ships the bridge for (or vice versa on a stripped build); require both
  // rather than trusting either alone.
  const unsupported = support.support !== 'full' || !bridge;

  const button = el('button', { class: 'btn', type: 'button', text: 'START', 'aria-pressed': 'false' });
  const count = el('span');
  const status = el('p', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'ble-list' });
  const limits = el('p', { class: 'note', text: LIMITS_NOTE });
  const audio = createAudioControls('hunt');
  const tracking = el('p', { class: 'note ble-tracking' });
  const selectHint = el('p', { class: 'note', text: 'TAP A DEVICE BELOW TO TRACK IT WITH AUDIO.' });

  // The canvas paints the peak-hold ring but a screen reader gets nothing
  // from it -- aria-hidden here, with radarStatus below as the text
  // equivalent, same redundant-encoding approach the bot's mood/bars pairing
  // uses in companion.js.
  const radarCanvas = el('canvas', { class: 'radar-canvas', 'aria-hidden': 'true' });
  const radarStatus = el('p', { class: 'note radar-status', role: 'status', 'aria-live': 'polite' });
  const radarReset = el('button', { class: 'btn radar-reset', type: 'button', text: 'RESET PEAK' });
  // Hidden until a device is selected -- see showRadar()/hideRadar() below.
  // Not just torn down on deselect because start()/stop() need a live canvas
  // to have ever run against; hiding and stopping together is simpler than
  // reconstructing the canvas on every re-selection.
  const radarWrap = el('div', { class: 'radar-wrap hidden' }, radarCanvas, radarStatus, radarReset);
  const radar = new PixelRadar(radarCanvas);

  function describeRadar(dbm, peakDbm, lost) {
    const cur = dbm == null ? (lost ? 'LOST' : 'NO READING') : `${Math.round(dbm)} DBM`;
    const peak = peakDbm == null ? '--' : `${Math.round(peakDbm)} DBM`;
    radarStatus.textContent = `CURRENT ${cur} · PEAK ${peak} · NO DIRECTION SHOWN`;
  }

  root.append(
    el('div', { class: 'ble' }, el('div', { class: 'ble-bar' }, button, count, status), limits, list),
    audio.el,
    selectHint,
    tracking,
    radarWrap,
  );

  if (unsupported) {
    button.disabled = true;
    status.textContent = support.detail ?? 'THIS PLATFORM CANNOT SCAN FOR BLE DEVICES.';
    return {};
  }

  const source = createBleSource(bridge);
  let scanning = false;
  let pollTimer = null;
  let lastMapped = { devices: [] };

  // One selected address at a time, reversible by tapping it again. A
  // rotated MAC (~15 min on modern trackers) just makes the old address stop
  // appearing in mapped.devices -- see updateTracking() below for how that
  // reads as "lost", not as a silent freeze on a stale number.
  let selectedAddress = null;
  // Keyed by address so a filter never mixes RSSI samples from two different
  // physical devices; a rotated MAC starts a fresh filter rather than reusing
  // a stale one under the assumption it's still the same radio.
  const filters = new Map();

  // Peak-hold: the strongest filtered dBm seen since the *current* selection
  // (see the module comment). Not keyed by address like `filters` -- tapping
  // the same device again is a fresh hunt, so it resets exactly like tapping
  // a different one does. Not the raw address-keyed filter's own state either,
  // since the filter must survive a RESET PEAK tap that this must not.
  let peakDbm = null;
  // The last filtered value actually shown, so RESET PEAK can rebase the peak
  // to "right now" without re-feeding the Kalman filter a sample it already
  // consumed -- see the reset handler below.
  let lastFiltered = null;

  function filterFor(address) {
    let filter = filters.get(address);
    if (!filter) {
      filter = new Kalman1D();
      filters.set(address, filter);
    }
    return filter;
  }

  function showRadar() {
    radarWrap.classList.remove('hidden');
    radar.start();
  }

  function hideRadar() {
    radarWrap.classList.add('hidden');
    radar.stop();
    peakDbm = null;
    lastFiltered = null;
  }

  /** Single call site for both the canvas and its text equivalent, so they can never drift apart. */
  function renderRadar(dbm, lost) {
    showRadar();
    radar.render({ dbm, peakDbm, lost });
    describeRadar(dbm, peakDbm, lost);
  }

  /** Drives the audio engine and the radar from whichever device is selected, or silences both if none is. */
  function updateTracking() {
    if (!selectedAddress) {
      tracking.textContent = '';
      audio.update(null);
      hideRadar();
      return;
    }

    const device = lastMapped.devices.find((d) => d.address === selectedAddress);
    if (!device) {
      // Out of range or its MAC just rotated -- an honest "lost", not a tone
      // frozen on the last number it happened to see. The radar keeps the
      // peak ring up (the strongest reading is still true) but drops the live
      // ring, same "lost" treatment as the tone going silent below.
      tracking.textContent = `TRACKING ${selectedAddress} -- LOST (OUT OF RANGE OR ADDRESS ROTATED)`;
      audio.update(null);
      lastFiltered = null;
      renderRadar(null, true);
      return;
    }

    tracking.textContent = `TRACKING ${device.name ?? 'UNNAMED'} (${device.address})`;
    const filtered = filterFor(selectedAddress).update(device.rssi);
    audio.update(filtered);
    lastFiltered = filtered;
    if (peakDbm == null || filtered > peakDbm) peakDbm = filtered;
    renderRadar(filtered, false);
  }

  function toggleSelect(address) {
    const selecting = selectedAddress !== address;
    selectedAddress = selecting ? address : null;
    // A genuinely new selection -- including re-tapping the same device after
    // dropping it -- starts a fresh hunt, so the peak from whatever was
    // tracked before must not leak into it.
    if (selecting) peakDbm = null;
    render(lastMapped);
    updateTracking();
  }

  function render(mapped) {
    lastMapped = mapped;
    clear(list);

    if (!mapped.devices.length) {
      count.textContent = '';
      return;
    }

    count.textContent = `${mapped.devices.length} DEVICE${mapped.devices.length === 1 ? '' : 'S'}`;

    for (const d of mapped.devices) {
      const grade = gradeRssi(d.rssi);
      const selected = d.address === selectedAddress;
      list.append(
        el(
          'div',
          {
            class: 'ble-row',
            dataset: { selected: String(selected) },
            role: 'button',
            tabindex: '0',
            'aria-pressed': String(selected),
            'aria-label': `Track ${d.name ?? 'unnamed device'} with audio`,
            onClick: () => toggleSelect(d.address),
            onKeydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleSelect(d.address);
              }
            },
          },
          el('span', { class: 'ble-swatch', style: `background:${shadeColor(grade?.shade ?? 0)}` }),
          el('span', { class: 'ble-name', text: d.name ?? 'UNNAMED' }),
          el('span', { class: 'ble-rssi', text: d.rssi == null ? 'N/A' : `${d.rssi} DBM` }),
          el('span', {
            class: 'ble-meta',
            text: [d.txPower != null ? `TX ${d.txPower} DBM` : null, d.connectable ? 'CONNECTABLE' : null]
              .filter(Boolean)
              .join(' · '),
          }),
          el('span', { class: 'ble-addr', text: d.address ?? '' }),
        ),
      );
    }
  }

  function poll() {
    render(source.poll());
    updateTracking();
  }

  function stop() {
    audio.stop();
    // Unconditional, same as audio.stop() above: this is the function
    // visibilitychange calls directly on backgrounding, and a radar rAF loop
    // left running behind a hidden tab is exactly the battery cost the
    // module comment on `document.addEventListener('visibilitychange', ...)`
    // below already explains for the scan itself. hideRadar() is safe to call
    // whether or not the radar was ever shown.
    hideRadar();
    if (!scanning) {
      return;
    }
    scanning = false;
    source.stopScan();
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    button.textContent = 'START';
    button.setAttribute('aria-pressed', 'false');
    status.textContent = 'STOPPED.';
    // The device list Kotlin holds is cleared on the next startScan(), so a
    // kept selection or filter would just be pointing at nothing -- clear
    // both rather than let them silently go stale until the next START.
    selectedAddress = null;
    filters.clear();
    tracking.textContent = '';
  }

  function start() {
    const result = source.startScan();
    if (!result.ok) {
      status.textContent = result.error;
      // Denial never blocks the WiFi meter -- this view is the only thing
      // that stops working, and asking again is one tap away rather than a
      // trip to Settings for a grant that dBm never needed in the first place.
      if (result.needsPermission) source.requestPermissions();
      return;
    }

    scanning = true;
    button.textContent = 'STOP';
    button.setAttribute('aria-pressed', 'true');
    status.textContent = 'SCANNING...';
    clear(list);
    count.textContent = '';

    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  button.addEventListener('click', () => (scanning ? stop() : start()));

  // Rebase the peak to right now rather than clearing it to nothing: RESET
  // PEAK means "stop comparing to that old high", not "forget the device is
  // even selected". Reuses lastFiltered instead of re-running the Kalman
  // filter on the same sample -- see where lastFiltered is set for why.
  radarReset.addEventListener('click', () => {
    peakDbm = lastFiltered;
    if (selectedAddress) renderRadar(lastFiltered, lastFiltered == null);
  });

  // A radio scan left running behind a hidden tab, or a backgrounded app, is a
  // pure battery cost with no payoff. This is the cooperative half of the
  // stop; MainActivity.onPause() enforces the same thing at the platform
  // level regardless of whether this listener runs. It also covers audio and
  // the radar: stop() always silences the tone and halts the radar's blink
  // loop, scanning or not.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
  });

  return {
    // Called by app.js when the user switches to another tab -- see the
    // module comment for why a running scan, its tone and its radar cannot
    // be left behind.
    onHide: stop,
  };
}
