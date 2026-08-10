import { el, clear, stat } from '../dom.js';
import { shadeColor } from '../render/palette.js';
import { gradeRssi } from '../core/pathloss.js';
import { analyzeWifi } from '../sources/wifi-analyze.js';
import { detectRogues } from '../sources/rogue-detect.js';
import { spectrumByBand } from '../render/spectrum-map.js';
import { PixelSpectrum } from '../render/spectrum.js';
import { PRIORITY } from '../guide.js';

/**
 * Every access point the radio can see, refreshed on demand, plus what can be
 * read off that one snapshot: how crowded each band and channel is, which
 * 2.4GHz channel is clearest, any evil-twin-shaped AP groups, and a channel
 * power chart. All of it is derived from the same throttled scan (Android
 * allows four per two minutes) -- nothing here is a second, live measurement.
 *
 * On demand rather than live because Android hard-throttles foreground scans;
 * a list that silently stopped updating would be indistinguishable from a quiet
 * neighbourhood. The countdown makes the limit visible instead of hiding it.
 *
 * The shape this consumes is the one win32.js and linux.js already return, so
 * the view (analysis included) works for a daemon on those platforms as well
 * as for the APK.
 */

const TICK_MS = 1000;

export function createApsView(root, context) {
  const support = context.platform?.capabilities?.scanAllAps ?? {};
  const unsupported = support.support === 'none';

  const button = el('button', { class: 'btn', type: 'button', text: 'SCAN' });
  // Plain readout, not `.note` -- `.note` means an advisory caveat elsewhere in
  // this app (filled background, left accent) and the count is neither.
  const count = el('span', { class: 'aps-count' });
  const note = el('p', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'aps-list' });

  // Analysis panels, populated on each successful scan and hidden until then.
  const analysisBody = el('div', { class: 'panel-body' });
  const analysisPanel = el('div', { class: 'panel hidden' }, el('h2', { text: 'ANALYSIS' }), analysisBody);

  const rogueBody = el('div', { class: 'panel-body' });
  const roguePanel = el('div', { class: 'panel hidden' }, el('h2', { text: 'SUSPECT APS' }), rogueBody);

  const spectrumCanvas = el('canvas', { class: 'spectrum-canvas', 'aria-hidden': 'true' });
  const spectrumBands = el('div', { class: 'spectrum-bands' });
  const spectrumStatus = el('p', { class: 'note spectrum-status', role: 'status', 'aria-live': 'polite' });
  const spectrumPanel = el(
    'div',
    { class: 'panel hidden' },
    el('h2', { text: 'SPECTRUM' }),
    el('div', { class: 'panel-body' }, spectrumBands, spectrumCanvas, spectrumStatus),
  );
  const spectrum = new PixelSpectrum(spectrumCanvas);

  root.append(
    el('div', { class: 'aps' }, el('div', { class: 'aps-bar' }, button, count, note), list),
    analysisPanel,
    roguePanel,
    spectrumPanel,
  );

  if (unsupported) {
    button.disabled = true;
    note.textContent = support.detail ?? 'THIS PLATFORM CANNOT SCAN NEARBY NETWORKS.';
    return {};
  }

  let retryUntil = 0;
  let scanning = false;
  // Spectrum state: which band's chart is on screen, and the last set built.
  let spectra = [];
  let selectedBand = null;
  // So a warning about the same suspect set is not re-spoken on every refresh.
  let lastRogueKey = null;

  function renderSpectrum() {
    clear(spectrumBands);
    const current = spectra.find((s) => s.band === selectedBand) ?? spectra[0] ?? null;
    selectedBand = current?.band ?? null;

    for (const s of spectra) {
      spectrumBands.append(
        el('button', {
          class: 'btn spectrum-band',
          type: 'button',
          text: s.band,
          'aria-pressed': String(s.band === selectedBand),
          onClick: () => {
            selectedBand = s.band;
            renderSpectrum();
          },
        }),
      );
    }

    spectrum.render(current);
    spectrumStatus.textContent = current
      ? `${current.band}: ${current.points.length} AP${current.points.length === 1 ? '' : 'S'} BY CHANNEL (PER-AP POWER, NOT A SWEPT SPECTRUM).`
      : 'NO CHANNEL DATA.';
  }

  function renderAnalysis(networks) {
    const summary = analyzeWifi(networks);
    clear(analysisBody);
    analysisBody.append(
      el(
        'div',
        { class: 'stats' },
        stat('TOTAL APS', summary.total),
        stat('2.4 GHZ', summary.bands['2.4GHz']),
        stat('5 GHZ', summary.bands['5GHz']),
        stat('6 GHZ', summary.bands['6GHz']),
        stat(
          'BUSIEST',
          summary.busiest ? `${summary.busiest.band} CH ${summary.busiest.channel}` : null,
          { caveat: summary.busiest ? `${summary.busiest.count} APs share this channel` : '' },
        ),
        stat('BEST 2.4 CH', summary.recommend24 ? summary.recommend24.channel : null, {
          caveat: summary.recommend24 ? 'Least-contested of channels 1 / 6 / 11' : 'No 2.4GHz networks to advise on',
        }),
      ),
    );
    analysisPanel.classList.remove('hidden');
  }

  function renderRogues(networks) {
    const findings = detectRogues(networks);
    clear(rogueBody);

    if (!findings.length) {
      rogueBody.append(el('p', { class: 'note', text: 'NO EVIL-TWIN-SHAPED AP GROUPS IN THIS SCAN.' }));
      roguePanel.classList.remove('hidden');
      lastRogueKey = null;
      return new Set();
    }

    for (const f of findings) {
      rogueBody.append(
        el(
          'div',
          { class: 'rogue', dataset: { severity: f.severity } },
          el('span', { class: 'rogue-ssid', text: f.ssid }),
          el('span', { class: 'rogue-sev', text: f.severity.toUpperCase() }),
          el('span', { class: 'rogue-reason', text: f.reason }),
          f.vendors.length ? el('span', { class: 'rogue-vendors', text: f.vendors.join(' / ') }) : null,
        ),
      );
    }
    roguePanel.classList.remove('hidden');

    // Announce a high-severity finding through TRK, but only when the set of
    // suspects actually changes -- not on every 1s throttle-countdown redraw.
    const highs = findings.filter((f) => f.severity === 'high');
    const key = highs.map((f) => f.ssid).sort().join('|');
    if (key && key !== lastRogueKey) {
      context.companion?.say?.(`HEADS UP: "${highs[0].ssid}" HAS AN OPEN TWIN. DO NOT AUTO-JOIN IT.`, {
        priority: PRIORITY.ALERT,
      });
    }
    lastRogueKey = key || null;

    return new Set(findings.flatMap((f) => f.bssids));
  }

  function render(result) {
    clear(list);

    if (!result.ok) {
      count.textContent = '';
      note.textContent = result.error ?? 'SCAN FAILED.';
      return;
    }
    if (!result.networks.length) {
      count.textContent = '';
      note.textContent = 'NO NETWORKS VISIBLE.';
      return;
    }

    // The count is a plain readout, not a caveat -- see the comment where
    // `note`/`count` are created. Clear `note` so a stale error/empty message
    // doesn't linger next to a now-successful list.
    count.textContent = `${result.networks.length} NETWORKS${result.exact ? '' : ' (APPROXIMATE DBM)'}`;
    note.textContent = '';

    // Analysis over the whole scan, then the per-row suspect flags depend on it.
    renderAnalysis(result.networks);
    const suspectBssids = renderRogues(result.networks);
    spectra = spectrumByBand(result.networks);
    renderSpectrum();

    for (const n of result.networks) {
      const grade = gradeRssi(n.rssi);
      const suspect = n.bssid && suspectBssids.has(n.bssid);
      list.append(
        el(
          'div',
          { class: 'ap', dataset: { suspect: String(Boolean(suspect)) } },
          el('span', { class: 'ap-swatch', style: `background:${shadeColor(grade?.shade ?? 0)}` }),
          el('span', { class: 'ap-ssid', text: n.ssid ?? 'HIDDEN' }),
          suspect ? el('span', { class: 'ap-flag', text: 'SUSPECT' }) : null,
          el('span', { class: 'ap-rssi', text: n.rssi == null ? 'N/A' : `${result.exact ? '' : '~'}${n.rssi} DBM` }),
          // A non-breaking space glues "CH" to its number, and non-breaking
          // hyphens hold security strings like "WPA2-PSK-CCMP" together --
          // both are single tokens that must never split mid-word at phone
          // width (see the layout fix note on `.ap` in pixel.css).
          el('span', {
            class: 'ap-meta',
            text: [n.band, n.channel != null ? `CH ${n.channel}` : null, n.security?.replace(/-/g, '‑')]
              .filter(Boolean)
              .join(' · '),
          }),
          // BSSID gets its own row (see pixel.css) so it earns a line, not a
          // column beside the dBm -- see `.ap` for why.
          el('span', { class: 'ap-bssid', text: n.bssid ?? '' }),
        ),
      );
    }
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    button.disabled = true;
    note.textContent = 'SCANNING...';

    try {
      const result = await context.source.requestScan();
      // A throttled result carries how long is left; hold the button until then
      // rather than letting the user hammer it into more refusals.
      retryUntil = result.retryInMs ? Date.now() + result.retryInMs : 0;
      render(result);
    } catch (err) {
      note.textContent = err.message.toUpperCase();
    } finally {
      scanning = false;
      const throttled = retryUntil > Date.now();
      button.disabled = throttled;
      // Set together with `disabled` so the button never reads "SCAN" for up
      // to a second while already unclickable, waiting on the next tick below.
      button.textContent = throttled ? `THROTTLED · ${Math.ceil((retryUntil - Date.now()) / 1000)}S` : 'SCAN';
    }
  }

  button.addEventListener('click', scan);

  // Readings pushed by another client's scan land here too, so two phones
  // looking at the same daemon stay in step.
  context.source.on('aps', render);

  setInterval(() => {
    if (!retryUntil) return;
    const left = retryUntil - Date.now();
    if (left > 0) {
      button.disabled = true;
      button.textContent = `THROTTLED · ${Math.ceil(left / 1000)}S`;
      return;
    }
    retryUntil = 0;
    button.disabled = false;
    button.textContent = 'SCAN';
  }, TICK_MS);

  return {};
}
