import { el } from '../dom.js';
import { PixelMeter, Sparkline } from '../render/meter.js';
import { Freshness } from '../freshness.js';

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

  // Sized to the viewport so the digits are as large as the screen allows.
  // Falls back to the desktop default width when the element has no layout yet.
  function canvasWidth() {
    return Math.max(280, Math.floor(wrap.clientWidth || 464));
  }

  let meter = null;
  let spark = null;
  let lastReading = null;
  const freshness = new Freshness();

  function build() {
    const w = canvasWidth();
    // Scale the digits to the width; 13 is the desktop default at 464px.
    const scale = Math.max(8, Math.floor((w / 464) * 13));
    const kept = spark;
    meter = new PixelMeter(meterCanvas, { width: w, height: Math.round(w * 0.45), scale });
    spark = new Sparkline(sparkCanvas, { width: w, height: 96, capacity: Math.floor(w / 4) });
    // Carry history across a resize rather than losing the walk so far.
    if (kept) for (const v of kept.values) spark.push(v);
    draw();
  }

  function draw() {
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

  build();
  const tick = setInterval(draw, TICK_MS);
  window.addEventListener('resize', build);

  return {
    update(reading) {
      lastReading = reading;
      if (reading?.ok) {
        freshness.mark();
        spark.push(reading.smoothed ?? reading.rssi);
      } else {
        freshness.reset();
      }
      draw();
    },
  };
}
