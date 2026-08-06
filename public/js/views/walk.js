import { el } from '../dom.js';
import { PixelMeter, Sparkline } from '../render/meter.js';
import { Freshness } from '../freshness.js';
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
  const statusEl = el('p', { class: 'walk-status', role: 'status', 'aria-live': 'polite' });

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

    // Scale the digits to the width; 13 is the desktop default at 464px.
    const scale = Math.max(8, Math.floor((w / 464) * 13));
    // Snapped to the 8px grid the rest of the layout sits on.
    const height = Math.round((w * 0.45) / 8) * 8;

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

    const { hasReading, fresh, ageMs } = freshness.state();

    if (!hasReading || !lastReading?.ok) {
      meter.render({ connected: false, message: lastReading?.error ?? 'WAITING FOR DAEMON' });
      spark.render();
      statusEl.textContent = 'NO READING';
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
    statusEl.textContent = fresh
      ? `LIVE${lastReading.interface ? ` · ${lastReading.interface}` : ''}`
      : `STALE ${Math.floor(ageMs / 1000)}S · RECONNECTING`;
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
