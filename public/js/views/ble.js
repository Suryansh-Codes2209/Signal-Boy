import { el, clear } from '../dom.js';
import { shadeColor } from '../render/palette.js';
import { gradeRssi } from '../core/pathloss.js';
import { Kalman1D } from '../core/filter.js';
import { createBleSource, bleBridge } from '../sources/ble.js';
import { createAudioControls } from '../audio/controls.js';

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

  root.append(
    el('div', { class: 'ble' }, el('div', { class: 'ble-bar' }, button, count, status), limits, list),
    audio.el,
    selectHint,
    tracking,
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

  function filterFor(address) {
    let filter = filters.get(address);
    if (!filter) {
      filter = new Kalman1D();
      filters.set(address, filter);
    }
    return filter;
  }

  /** Drives the audio engine from whichever device is selected, or silences it if none is. */
  function updateTracking() {
    if (!selectedAddress) {
      tracking.textContent = '';
      audio.update(null);
      return;
    }

    const device = lastMapped.devices.find((d) => d.address === selectedAddress);
    if (!device) {
      // Out of range or its MAC just rotated -- an honest "lost", not a tone
      // frozen on the last number it happened to see.
      tracking.textContent = `TRACKING ${selectedAddress} -- LOST (OUT OF RANGE OR ADDRESS ROTATED)`;
      audio.update(null);
      return;
    }

    tracking.textContent = `TRACKING ${device.name ?? 'UNNAMED'} (${device.address})`;
    audio.update(filterFor(selectedAddress).update(device.rssi));
  }

  function toggleSelect(address) {
    selectedAddress = selectedAddress === address ? null : address;
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

  // A radio scan left running behind a hidden tab, or a backgrounded app, is a
  // pure battery cost with no payoff. This is the cooperative half of the
  // stop; MainActivity.onPause() enforces the same thing at the platform
  // level regardless of whether this listener runs. It also covers audio:
  // stop() always silences it, scanning or not.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
  });

  return {
    // Called by app.js when the user switches to another tab -- see the
    // module comment for why a running scan (and its tone) cannot be left
    // behind.
    onHide: stop,
  };
}
