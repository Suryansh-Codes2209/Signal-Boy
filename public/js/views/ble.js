import { el, clear } from '../dom.js';
import { shadeColor } from '../render/palette.js';
import { gradeRssi } from '../core/pathloss.js';
import { Kalman1D } from '../core/filter.js';
import { createBleSource, bleBridge } from '../sources/ble.js';
import { createAudioControls } from '../audio/controls.js';
import { PixelRadar } from '../render/radar.js';
import { decayPeak, trendFromDelta } from '../render/radar-map.js';
import { classifyBeacon } from '../sources/beacon-classify.js';
import { reassociate } from '../sources/reassociate.js';
import { rangeBridge, createRangeSource } from '../sources/range.js';
import { rememberFirstSeen, orderForDisplay, capList, DEFAULT_LIST_CAP } from '../sources/device-order.js';

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
  // Shown only when a lost track has a plausible rotated-MAC continuation.
  // Tapping it adopts the candidate as a fresh selection -- never automatic,
  // because a re-association is a guess (see reassociate.js).
  const reacquireBtn = el('button', { class: 'btn ble-reacquire hidden', type: 'button' });
  const selectHint = el('p', { class: 'note', text: 'TAP A DEVICE BELOW TO TRACK IT WITH AUDIO.' });

  // Session log: every address seen since START, with what it looks like and
  // how long it has been around. Distinct from the live list (which only shows
  // what is advertising right now) -- this is the "map" of the whole hunt.
  const trackedBody = el('div', { class: 'panel-body' });
  const trackedPanel = el('div', { class: 'panel hidden' }, el('h2', { text: 'TRACKED THIS SESSION' }), trackedBody);
  const session = new Map();

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

  // RANGE: the one reading in this view that is measured rather than inferred.
  // Everything else here grades RSSI, which is why the panel is kept visually
  // and structurally separate instead of being folded into the radar's caption
  // -- a metre figure sitting inside the "NO DIRECTION SHOWN" block would blur
  // the exact distinction the block exists to draw.
  const rangeReadout = el('p', { class: 'range-readout', text: '--' });
  const rangeProvenance = el('p', { class: 'note range-provenance' });
  const rangeStatus = el('p', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const rangeBtn = el('button', { class: 'btn', type: 'button', text: 'MEASURE DISTANCE' });
  const rangePanel = el(
    'div',
    { class: 'panel range-panel hidden' },
    el('h2', { text: 'TRUE DISTANCE' }),
    el('div', { class: 'panel-body' }, rangeReadout, rangeProvenance, rangeStatus, rangeBtn),
  );

  function describeRadar(dbm, peakDbm, lost, trend = 'STEADY') {
    const cur = dbm == null ? (lost ? 'LOST' : 'NO READING') : `${Math.round(dbm)} DBM`;
    const peak = peakDbm == null ? '--' : `${Math.round(peakDbm)} DBM`;
    // Trend only means something while there is a live reading -- omit it when
    // lost so the text equivalent never implies motion the canvas isn't showing.
    const trendText = dbm == null ? '' : ` · ${trend}`;
    radarStatus.textContent = `CURRENT ${cur} · PEAK ${peak}${trendText} · NO DIRECTION SHOWN`;
  }

  // Everything about the device you are hunting, gathered above the list.
  //
  // The original order put the list first and the radar, tone and range panel
  // after it. That reads fine with four devices and collapses completely with
  // seventy: selecting a device moved the thing you selected it *for* below the
  // fold, so the tap appeared to do nothing. The list is a picker, not the
  // content -- once something is picked, the pick is the content.
  const focusWrap = el('div', { class: 'ble-focus hidden' }, tracking, reacquireBtn, radarWrap, rangePanel, audio.el);

  // Revealed only when the cap is actually withholding rows, so it never sits
  // there advertising nothing.
  const showAllBtn = el('button', { class: 'btn ble-show-all hidden', type: 'button' });

  root.append(
    el('div', { class: 'ble' }, el('div', { class: 'ble-bar' }, button, count, status)),
    focusWrap,
    selectHint,
    el('div', { class: 'ble' }, list, showAllBtn, limits),
    trackedPanel,
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
  /** Address -> first-sighting index, so the order can be frozen. See device-order.js. */
  const seenOrder = new Map();
  let listExpanded = false;
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

  // For MAC-rotation re-association: what the selected device looked like when
  // last seen, and which other addresses were on screen alongside it (those
  // cannot be its rotated continuation, so they are excluded as candidates).
  let lastTrackedSignature = null;
  let peersAtLastSight = [];

  function filterFor(address) {
    let filter = filters.get(address);
    if (!filter) {
      // BLE RSSI is noisier and the target is being walked around, not held
      // still next to a fixed AP -- so unlike the WiFi meter's plain filter,
      // the hunt filter rejects lone spikes (a reflection or a decode glitch)
      // and opens up when the signal genuinely trends, to track a moving
      // device without warbling on every stray sample.
      filter = new Kalman1D({ adaptive: true, outlierGate: 3 });
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
  function renderRadar(dbm, lost, variance = null, trend = 'STEADY') {
    showRadar();
    radar.render({ dbm, peakDbm, lost, variance, trend });
    describeRadar(dbm, peakDbm, lost, trend);
  }

  /** Drives the audio engine and the radar from whichever device is selected, or silences both if none is. */
  function updateTracking() {
    if (!selectedAddress) {
      tracking.textContent = '';
      reacquireBtn.classList.add('hidden');
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
      offerReacquire();
      return;
    }

    reacquireBtn.classList.add('hidden');
    tracking.textContent = `TRACKING ${device.name ?? 'UNNAMED'} (${device.address})`;
    const filter = filterFor(selectedAddress);
    const filtered = filter.update(device.rssi);
    // Trend is the change since the last shown value; null on the first reading
    // of a selection (lastFiltered reset) so it starts STEADY, not a jump from
    // nothing.
    const trend = trendFromDelta(lastFiltered == null ? null : filtered - lastFiltered);
    audio.update(filtered);
    // Peak eases back down when the signal stays weaker rather than freezing on
    // a brief high -- see decayPeak. A genuine new high is still adopted at once.
    peakDbm = decayPeak(peakDbm, filtered);
    lastFiltered = filtered;
    // Remember what this device looks like now, so if its address vanishes next
    // poll we can look for the rotated continuation. Peers seen alongside it are
    // ruled out -- a device advertising *with* the old address is not it.
    lastTrackedSignature = {
      address: selectedAddress,
      rssi: filtered,
      txPower: device.txPower,
      manufacturerId: device.manufacturerId,
      serviceUuids: device.serviceUuids,
    };
    peersAtLastSight = lastMapped.devices.filter((d) => d.address !== selectedAddress).map((d) => d.address);
    renderRadar(filtered, false, filter.variance, trend);
  }

  /** When a track is lost, look for a plausible rotated-MAC continuation and offer it. */
  function offerReacquire() {
    const match = lastTrackedSignature
      ? reassociate(lastTrackedSignature, lastMapped.devices, { exclude: peersAtLastSight })
      : null;
    if (!match) {
      reacquireBtn.classList.add('hidden');
      return;
    }
    reacquireBtn.textContent = `↺ RE-ACQUIRED? FOLLOW ${match.address} (${Math.round(match.score * 100)}% MATCH)`;
    reacquireBtn.dataset.address = match.address;
    reacquireBtn.classList.remove('hidden');
  }

  /** Roll every currently-visible device into the session log for the TRACKED panel. */
  function logSession(devices) {
    for (const d of devices) {
      if (!d.address) continue;
      const klass = classifyBeacon(d);
      const existing = session.get(d.address);
      if (existing) {
        existing.lastSeen = d.lastSeen ?? Date.now();
        existing.count += 1;
        if (d.name) existing.name = d.name;
        if (klass.category !== 'unknown') existing.klass = klass;
      } else {
        session.set(d.address, {
          address: d.address,
          name: d.name ?? null,
          klass,
          firstSeen: d.lastSeen ?? Date.now(),
          lastSeen: d.lastSeen ?? Date.now(),
          count: 1,
        });
      }
    }
    renderSession();
  }

  function renderSession() {
    clear(trackedBody);
    if (!session.size) {
      trackedPanel.classList.add('hidden');
      return;
    }
    trackedPanel.classList.remove('hidden');
    const rows = [...session.values()].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    for (const r of rows) {
      trackedBody.append(
        el(
          'div',
          { class: 'tracked-row' },
          el('span', { class: 'tracked-name', text: r.name ?? 'UNNAMED' }),
          r.klass.category !== 'unknown'
            ? el('span', { class: 'tracked-class', dataset: { category: r.klass.category }, text: r.klass.label })
            : null,
          el('span', { class: 'tracked-count', text: `×${r.count}` }),
          el('span', { class: 'tracked-addr', text: r.address }),
        ),
      );
    }
  }

  // ------------------------------------------------------------------ range

  const RANGE_POLL_MS = 500;
  const CAPS_RETRY_MS = 400;

  const rangeSupport = context.platform?.capabilities?.ranging ?? {};
  const rangeApi = rangeBridge();
  // Both must agree, for the same reason the bleScan check above requires both:
  // the matrix can describe a build this APK is not, and the bridge is absent
  // in a browser however the matrix reads.
  const rangingPossible = rangeSupport.support !== 'none' && !!rangeApi;
  const rangeSource = rangingPossible ? createRangeSource(rangeApi) : null;

  let rangeTimer = null;
  let ranging = false;

  function stopRanging({ keepStatus = false } = {}) {
    if (rangeTimer) {
      clearInterval(rangeTimer);
      rangeTimer = null;
    }
    if (rangeSource && ranging) rangeSource.stopSession();
    ranging = false;
    rangeBtn.textContent = 'MEASURE DISTANCE';
    rangeReadout.textContent = '--';
    rangeProvenance.textContent = '';
    if (!keepStatus) rangeStatus.textContent = '';
  }

  function pollRange() {
    if (!rangeSource) return;
    const result = rangeSource.poll();

    if (!result.running) {
      // A session ending on its own is the expected outcome for a peer whose
      // radio cannot answer, not a malfunction -- report why and stop, rather
      // than leaving a dead timer spinning against nothing.
      stopRanging({ keepStatus: true });
      rangeStatus.textContent = result.error ?? 'RANGING STOPPED.';
      return;
    }

    const peer = result.peers.find((p) => p.peerId === selectedAddress) ?? result.peers[0] ?? null;
    if (!peer || peer.label == null) {
      // No fix this tick is a real state. Showing the last number instead would
      // make a frozen readout indistinguishable from a live one -- the same
      // failure the WiFi meter's freshness counter exists to prevent.
      rangeReadout.textContent = '--';
      rangeProvenance.textContent = 'NO FIX THIS SECOND.';
      return;
    }

    rangeReadout.textContent = peer.label;
    // The provenance line is not decoration: it is what stops an OS-computed
    // RSSI estimate from reading like a timed measurement.
    rangeProvenance.textContent = peer.derived
      ? `${peer.technologyLabel} -- ESTIMATED FROM SIGNAL STRENGTH, NOT MEASURED.`
      : `${peer.technologyLabel} -- MEASURED${peer.confidence ? ` · ${peer.confidence} CONFIDENCE` : ''}.`;
  }

  function startRanging() {
    if (!rangeSource || !selectedAddress) return;

    const caps = rangeSource.capabilities();
    if (!caps.supported) {
      rangeStatus.textContent = caps.error;
      // Capability delivery is asynchronous, so the first answer after launch
      // is legitimately PENDING. Retrying beats reporting a capable phone as
      // incapable on the strength of one early poll.
      if (caps.code === 'CAPABILITIES_PENDING') setTimeout(startRanging, CAPS_RETRY_MS);
      return;
    }
    if (!caps.best) {
      // Prefer the platform's own reason (switched off, not permitted here)
      // over a generic line -- only some of those are worth acting on.
      const off = caps.technologies.find((t) => t.unavailableDetail);
      rangeStatus.textContent = off?.unavailableDetail ?? 'NO RANGING TECHNOLOGY AVAILABLE ON THIS PHONE.';
      return;
    }

    const started = rangeSource.startSession(selectedAddress, caps.best.code);
    if (!started.ok) {
      rangeStatus.textContent = started.error;
      // Only a denial is one tap from fixed; an OS too old has no button.
      if (started.needsPermission) rangeSource.requestPermissions();
      return;
    }

    ranging = true;
    rangeBtn.textContent = 'STOP MEASURING';
    rangeStatus.textContent = `MEASURING VIA ${caps.best.label}.`;
    if (!rangeTimer) rangeTimer = setInterval(pollRange, RANGE_POLL_MS);
  }

  /** The panel exists only while a device is selected and this phone can range at all. */
  function syncRangePanel() {
    if (!rangingPossible || !selectedAddress) {
      stopRanging();
      rangePanel.classList.add('hidden');
      return;
    }
    rangePanel.classList.remove('hidden');
  }

  /**
   * Show the focus block, and stop telling the user to do what they just did.
   *
   * The hint below the block is an instruction ("TAP A DEVICE BELOW..."), and an
   * instruction still standing after it has been followed reads as though the
   * tap failed -- which, given the panel used to open below the fold, is exactly
   * what it looked like.
   */
  function syncFocus() {
    const active = selectedAddress != null;
    focusWrap.classList.toggle('hidden', !active);
    selectHint.classList.toggle('hidden', active);
    syncRangePanel();
  }

  showAllBtn.addEventListener('click', () => {
    listExpanded = !listExpanded;
    render(lastMapped);
  });

  rangeBtn.addEventListener('click', () => {
    if (ranging) stopRanging();
    else startRanging();
  });

  // Kotlin calls this once a permission dialog resolves, so a granted request
  // starts measuring without the user having to tap MEASURE a second time.
  window.__signalboyRangePermissions = () => {
    if (selectedAddress && !ranging) startRanging();
  };

  function toggleSelect(address) {
    const selecting = selectedAddress !== address;
    selectedAddress = selecting ? address : null;
    // A genuinely new selection -- including re-tapping the same device after
    // dropping it -- starts a fresh hunt, so the peak from whatever was
    // tracked before must not leak into it.
    if (selecting) peakDbm = null;
    // A ranging session is bound to the address it was started with, so
    // changing (or dropping) the selection must end it rather than leave it
    // measuring a device the user is no longer looking at.
    stopRanging();
    syncFocus();
    render(lastMapped);
    updateTracking();
  }

  function render(mapped) {
    lastMapped = mapped;
    clear(list);

    rememberFirstSeen(mapped.devices, seenOrder);

    if (!mapped.devices.length) {
      count.textContent = '';
      showAllBtn.classList.add('hidden');
      return;
    }

    count.textContent = `${mapped.devices.length} DEVICE${mapped.devices.length === 1 ? '' : 'S'}`;

    // Frozen only while something is selected: with nothing picked, loudest-first
    // is the most useful order and nothing is being aimed at, so movement costs
    // nothing. The instant there is a target, positions matter more than ranking.
    const ordered = orderForDisplay(mapped.devices, seenOrder, { frozen: selectedAddress != null });
    const { shown, hidden } = capList(ordered, {
      limit: DEFAULT_LIST_CAP,
      expanded: listExpanded,
      pin: selectedAddress,
    });

    showAllBtn.classList.toggle('hidden', hidden === 0 && !listExpanded);
    showAllBtn.textContent = listExpanded ? 'SHOW FEWER' : `SHOW ALL (${mapped.devices.length})`;

    for (const d of shown) {
      const grade = gradeRssi(d.rssi);
      const selected = d.address === selectedAddress;
      const klass = classifyBeacon(d);
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
          // A best-effort identity label from the advertisement, only when it is
          // actually recognizable -- a hint, never a claim (see beacon-classify).
          klass.category !== 'unknown'
            ? el('span', { class: 'ble-class', dataset: { category: klass.category }, text: klass.label })
            : null,
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

    logSession(mapped.devices);
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
    // Unconditional like hideRadar() above, and for a stronger reason: ranging
    // holds a radio link up rather than merely listening, so it must not
    // survive a backgrounded app even when no scan was running.
    stopRanging();
    rangePanel.classList.add('hidden');
    focusWrap.classList.add('hidden');
    selectHint.classList.remove('hidden');
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
    // The session log and any re-acquire offer belong to the run that just
    // ended -- start fresh next time rather than carrying stale devices over.
    session.clear();
    renderSession();
    reacquireBtn.classList.add('hidden');
    lastTrackedSignature = null;
    peersAtLastSight = [];
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

  // Adopt a re-association as a brand-new selection: fresh filter, fresh peak.
  // Nothing about the old track carries over -- the match is only a lead.
  reacquireBtn.addEventListener('click', () => {
    const address = reacquireBtn.dataset.address;
    if (!address) return;
    selectedAddress = address;
    peakDbm = null;
    lastFiltered = null;
    reacquireBtn.classList.add('hidden');
    render(lastMapped);
    updateTracking();
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
