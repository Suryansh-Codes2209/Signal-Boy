import { el, clear, stat } from '../dom.js';
import { PixelMeter, Sparkline } from '../render/meter.js';
import { Freshness, freshnessLabel } from '../freshness.js';
import { createAudioControls } from '../audio/controls.js';

/**
 * Live signal view: the large readout, the rolling history strip and the
 * per-reading detail stats.
 *
 * Every field that a platform cannot provide renders as N/A with the reason
 * attached, rather than as a blank or a fabricated zero.
 *
 * That extends to age. This view is one tab away from walk mode on a phone, so
 * it ages its reading on the same clock and with the same treatment: an update
 * only fires when a reading arrives, and a number nobody has refreshed for
 * three seconds is not a live number.
 */

const TICK_MS = 500;

const BAND_LEGEND = [
  { shade: 3, label: 'GOOD  >= -60' },
  { shade: 2, label: 'FAIR  -60..-67' },
  { shade: 1, label: 'WEAK  -67..-75' },
  { shade: 0, label: 'DEAD  < -75' },
];

export function createLiveView(root, { platform }) {
  const meterCanvas = el('canvas');
  const sparkCanvas = el('canvas');
  const statsEl = el('div', { class: 'stats' });
  const noteEl = el('div');
  const statusEl = el('p', { class: 'status-line', role: 'status', 'aria-live': 'polite' });

  const meter = new PixelMeter(meterCanvas);
  const spark = new Sparkline(sparkCanvas);
  const freshness = new Freshness();
  const audio = createAudioControls('live');
  let lastReading = null;

  root.append(
    el(
      'section',
      { class: 'panel' },
      el('h2', { text: 'Live signal' }),
      el('div', { class: 'panel-body' }, el('div', { class: 'meter-wrap' }, meterCanvas)),
      el(
        'div',
        { class: 'legend' },
        BAND_LEGEND.map(({ shade, label }) =>
          el(
            'span',
            { class: 'legend-item' },
            el('span', { class: 'swatch', dataset: { shade: String(shade) } }),
            label,
          ),
        ),
      ),
      // Pitch or click-rate feedback for the connected network's own signal --
      // off by default like everywhere else audio appears in this app.
      el('div', { class: 'panel-body' }, audio.el),
      statusEl,
    ),
    el(
      'section',
      { class: 'panel' },
      el('h2', { text: 'History' }),
      el('div', { class: 'panel-body' }, el('div', { class: 'meter-wrap' }, sparkCanvas)),
    ),
    el('section', { class: 'panel' }, el('h2', { text: 'Detail' }), statsEl, noteEl),
  );

  const caps = platform.capabilities;
  meter.render({ connected: false, message: 'WAITING FOR DAEMON' });
  spark.render();

  /**
   * Only the age presentation, deliberately: the canvases still hold the last
   * reading, and redrawing them twice a second would rebuild the stats table
   * for nothing. Dimming and the status line are what has to keep moving.
   */
  function showFreshness() {
    const state = freshness.state();
    root.dataset.stale = String(state.hasReading && !state.fresh);
    statusEl.textContent = freshnessLabel(state, { interfaceName: lastReading?.interface });
  }

  showFreshness();
  setInterval(showFreshness, TICK_MS);

  function renderStats(reading) {
    clear(statsEl).append(
      stat('SNR', reading.snr?.toFixed(0), {
        unit: 'dB',
        caveat: caps.noiseFloor?.detail,
      }),
      stat('NOISE FLOOR', reading.noise, { unit: 'dBm', caveat: caps.noiseFloor?.detail }),
      stat('RAW', reading.rssi, { unit: 'dBm' }),
      stat('FILTERED', reading.filtered?.toFixed(1), { unit: 'dBm' }),
      stat('CHANNEL', reading.channel),
      stat('BAND', reading.band),
      stat('WIDTH', reading.width),
      stat('PHY MODE', reading.phyMode),
      stat('TX RATE', reading.txRate, { unit: 'Mbps' }),
      stat('SECURITY', reading.security),
      stat(
        'SSID',
        reading.ssid === '<redacted>' ? 'HIDDEN BY OS' : reading.ssid,
        { caveat: caps.ssidVisible?.detail },
      ),
      stat('INTERFACE', reading.interface),
      stat('SOURCE', reading.source),
    );
  }

  function renderNote(reading) {
    clear(noteEl);
    const notes = [];

    if (reading.exact === false) {
      notes.push(
        'This platform reports signal as a 0-100 quality percentage, not dBm. Values shown are converted with dBm = pct/2 - 100 and marked with ~. They are approximations, not measurements.',
      );
    }
    if (reading.snr == null && caps.noiseFloor?.detail) {
      notes.push(`No noise floor: ${caps.noiseFloor.detail}`);
    }
    if (reading.ssid === '<redacted>' && caps.ssidVisible?.detail) {
      notes.push(`SSID hidden: ${caps.ssidVisible.detail}`);
    }

    for (const text of notes) {
      noteEl.append(el('p', { class: 'note' }, el('strong', { text: 'Note: ' }), text));
    }
  }

  return {
    update(reading) {
      lastReading = reading;

      if (!reading?.ok) {
        freshness.reset();
        showFreshness();
        meter.render({ connected: false, message: reading?.error ?? 'NO READING' });
        clear(statsEl);
        clear(noteEl).append(
          el(
            'p',
            { class: 'note' },
            el('strong', { text: 'No signal: ' }),
            reading?.error ?? 'The daemon returned no reading.',
          ),
        );
        // Nothing to sound while there is no reading -- the filtered value
        // below is exactly what a live tone would otherwise be tracking.
        audio.update(null);
        return;
      }

      meter.render({
        rssi: reading.filtered ?? reading.rssi,
        bandLabel: reading.bandLabel,
        quality: reading.quality,
        exact: reading.exact !== false,
        connected: true,
      });

      spark.push(reading.smoothed ?? reading.rssi);
      spark.render();
      renderStats(reading);
      renderNote(reading);
      // Driven from the Kalman-filtered value, same field the meter itself
      // reads -- raw RSSI warbles too fast to be a listenable tone.
      audio.update(reading.filtered ?? reading.rssi);

      freshness.mark();
      showFreshness();
    },
    // Switching to another tab must not leave this view's tone playing behind
    // the one now on screen -- app.js calls this on every tab change.
    onHide: () => audio.stop(),
  };
}
