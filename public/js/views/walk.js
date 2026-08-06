import { el } from '../dom.js';
import { PixelMeter, Sparkline, meterScaleForWidth, meterHeightForScale } from '../render/meter.js';
import { Freshness, freshnessLabel } from '../freshness.js';
import { createWakeLock } from '../wakelock.js';

/**
 * The phone view: one number, big enough to read at arm's length while walking.
 *
 * A phone cannot measure WiFi -- no browser exposes RSSI -- so every figure here
 * belongs to the daemon host. That makes staleness the thing worth designing
 * around: when the phone drops off the LAN, the last reading must stop claiming
 * to be current. It dims and starts counting its own age instead.
 */

const TICK_MS = 500;

export function createWalkView(root) {
  const meterCanvas = el('canvas');
  const sparkCanvas = el('canvas');
  const statusEl = el('p', { class: 'status-line', role: 'status', 'aria-live': 'polite' });

  const wrap = el(
    'div',
    { class: 'walk' },
    el('div', { class: 'walk-meter' }, meterCanvas),
    el('div', { class: 'walk-spark' }, sparkCanvas),
    statusEl,
  );
  root.append(wrap);

  const wakeBtn = el('button', { class: 'btn walk-wake', type: 'button', text: 'KEEP AWAKE', 'aria-pressed': 'false' });
  const wakeNote = el('p', { class: 'note walk-wake-note' });
  wrap.append(wakeBtn, wakeNote);

  const WAKE_LABEL = {
    wakelock: 'SCREEN HELD AWAKE.',
    video: 'SCREEN HELD AWAKE VIA VIDEO FALLBACK (PLAIN HTTP).',
    none: 'CANNOT HOLD THE SCREEN AWAKE HERE. RESTART WITH --HTTPS, OR RAISE YOUR PHONE SCREEN TIMEOUT.',
  };

  // Every button state change goes through here, including a downgrade the
  // user did not ask for -- if the lock is lost on returning to the tab, both
  // the button and the note must stop saying it is held.
  function showWakeState(mechanism) {
    const held = mechanism != null;
    wakeBtn.textContent = held ? 'AWAKE ON' : 'KEEP AWAKE';
    wakeBtn.setAttribute('aria-pressed', String(held));
    wakeNote.textContent = held ? WAKE_LABEL[mechanism] : '';
  }

  const wakeLock = createWakeLock({ onChange: showWakeState });

  wakeBtn.addEventListener('click', async () => {
    if (wakeLock.mechanism) {
      wakeLock.disable();
      return;
    }
    const got = await wakeLock.enable();
    // 'none' never becomes a mechanism, so onChange does not fire for it.
    if (got === 'none') wakeNote.textContent = WAKE_LABEL.none;
  });

  let meter = null;
  let spark = null;
  let lastReading = null;
  let builtWidth = 0;
  const freshness = new Freshness();

  /**
   * Sized to the viewport so the digits are as large as the screen allows.
   *
   * Driven by a ResizeObserver rather than measured at construction: the app
   * shell builds every view before mounting it, and a hidden view has zero
   * width, so measuring here at startup would pick the fallback on every load
   * on every device. The observer fires when the element actually gains layout,
   * which covers becoming visible and the window resizing in one mechanism.
   */
  function build(width) {
    const w = Math.max(280, Math.floor(width));
    if (w === builtWidth) return;
    builtWidth = w;

    // Scale the digits to the width, then take the height from the scale.
    // Both come from PixelMeter's own layout arithmetic rather than being
    // guessed here: deriving the height from an aspect ratio instead let the
    // strength bar, which is drawn after the digits, paint over the number on
    // every screen narrower than about 410px.
    const scale = meterScaleForWidth(w);
    const height = meterHeightForScale(scale);

    const kept = spark;
    meter = new PixelMeter(meterCanvas, { width: w, height, scale });
    spark = new Sparkline(sparkCanvas, { width: w, height: 96, capacity: Math.floor(w / 4) });
    // Carry history across a rebuild rather than losing the walk so far.
    if (kept) for (const v of kept.values) spark.push(v);
    draw();
  }

  function draw() {
    // Nothing to draw until the element has had a width, and so a renderer.
    if (!meter || !spark) return;

    const state = freshness.state();
    const { hasReading, fresh } = state;

    if (!hasReading || !lastReading?.ok) {
      meter.render({ connected: false, message: lastReading?.error ?? 'WAITING FOR DAEMON' });
      spark.render();
      statusEl.textContent = freshnessLabel(state);
      wrap.dataset.stale = 'false';
      return;
    }

    meter.render({
      rssi: lastReading.filtered ?? lastReading.rssi,
      bandLabel: lastReading.bandLabel,
      quality: lastReading.quality,
      exact: lastReading.exact !== false,
      connected: true,
    });
    spark.render();

    wrap.dataset.stale = String(!fresh);
    statusEl.textContent = freshnessLabel(state, { interfaceName: lastReading.interface });
  }

  const observer = new ResizeObserver(([entry]) => {
    const { width } = entry.contentRect;
    if (width > 0) build(width);
  });
  observer.observe(wrap);

  const tick = setInterval(draw, TICK_MS);

  return {
    update(reading) {
      lastReading = reading;
      if (reading?.ok) {
        freshness.mark();
        // The sparkline does not exist until the element has had a width, and
        // readings can arrive before layout. Dropping the first sample or two
        // is correct here -- the alternative is buffering history nobody sees.
        spark?.push(reading.smoothed ?? reading.rssi);
      } else {
        freshness.reset();
      }
      draw();
    },
  };
}
