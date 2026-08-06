import { el, clear, stat } from '../dom.js';
import { PixelMeter, Sparkline } from '../render/meter.js';

/**
 * Live signal view: the large readout, the rolling history strip and the
 * per-reading detail stats.
 *
 * Every field that a platform cannot provide renders as N/A with the reason
 * attached, rather than as a blank or a fabricated zero.
 */

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

  const meter = new PixelMeter(meterCanvas);
  const spark = new Sparkline(sparkCanvas);

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
      if (!reading?.ok) {
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
    },
  };
}
