import { el, clear, stat } from '../dom.js';
import { Sparkline } from '../render/meter.js';
import { linkQuality } from '../sources/link-quality.js';
import { netTestBridge, createNetTestSource } from '../sources/link-test.js';

/**
 * LINK: how good the connection actually is, in two honestly-separated halves.
 *
 * PASSIVE (always on, sends nothing): watches the connected reading over time
 * and reports how steady it is -- variance the single-value meter hides. Works
 * anywhere a WiFi reading flows.
 *
 * ACTIVE (opt-in, sends real traffic): a latency/jitter/throughput test against
 * a URL you enter. It is the only feature that uses the network, so it lives
 * behind a consent gate that names the INTERNET permission and does nothing
 * until you accept -- the app is otherwise fully offline by design.
 */

const WINDOW = 60; // readings kept for the passive stats (~1 per second)
const POLL_MS = 500;

export function createLinkView(root, context) {
  /* ---------- passive half ---------- */
  const passiveStats = el('div', { class: 'panel-body' });
  const sparkCanvas = el('canvas', { class: 'link-spark', 'aria-hidden': 'true' });
  const passivePanel = el(
    'div',
    { class: 'panel' },
    el('h2', { text: 'LINK STABILITY (PASSIVE)' }),
    el('div', { class: 'panel-body' }, sparkCanvas),
    passiveStats,
    el('p', { class: 'note', text: 'READS THE RADIO ONLY -- NO PACKETS SENT.' }),
  );
  const spark = new Sparkline(sparkCanvas);
  const window = [];

  function renderPassive() {
    const q = linkQuality(window);
    clear(passiveStats);
    passiveStats.append(
      el(
        'div',
        { class: 'stats' },
        stat('STABILITY', q.stability),
        stat('RSSI JITTER', q.rssi.std, { unit: 'DB' }),
        stat('RSSI MEAN', q.rssi.mean, { unit: 'DBM' }),
        stat('RSSI RANGE', q.rssi.count ? `${q.rssi.min}..${q.rssi.max}` : null, { unit: 'DBM' }),
        stat('TX RATE', q.txRate.mean, { unit: 'MBPS' }),
        stat('SAMPLES', q.rssi.count),
      ),
    );
  }

  function onReading(reading) {
    if (!reading?.ok || reading.rssi == null) return;
    window.push({ rssi: reading.rssi, txRate: reading.txRate ?? null });
    if (window.length > WINDOW) window.shift();
    spark.push(reading.rssi);
    spark.render();
    renderPassive();
  }

  context.source.on('wifi', onReading);
  renderPassive();

  /* ---------- active half ---------- */
  const support = context.platform?.capabilities?.activeThroughput ?? {};
  const bridge = netTestBridge();
  const activeAvailable = support.support === 'full' && bridge;

  const activePanel = el('div', { class: 'panel' }, el('h2', { text: 'THROUGHPUT TEST (ACTIVE)' }));
  const activeBody = el('div', { class: 'panel-body' });
  activePanel.append(activeBody);
  root.append(el('div', { class: 'link' }, passivePanel, activePanel));

  if (!activeAvailable) {
    activeBody.append(
      el('p', {
        class: 'note',
        text: support.detail ?? 'THE ACTIVE THROUGHPUT TEST IS ONLY AVAILABLE IN THE ANDROID APP.',
      }),
    );
    return { onHide: () => context.source.off?.('wifi', onReading) };
  }

  const source = createNetTestSource(bridge);
  let timer = null;
  let consented = false;

  const urlInput = el('input', {
    class: 'link-url',
    type: 'url',
    value: 'https://speed.cloudflare.com/__down?bytes=25000000',
    'aria-label': 'Target URL for the throughput test',
  });
  const runBtn = el('button', { class: 'btn', type: 'button', text: 'I UNDERSTAND -- RUN TEST' });
  const stopBtn = el('button', { class: 'btn hidden', type: 'button', text: 'STOP' });
  const results = el('div', { class: 'panel-body' });
  const consent = el('p', {
    class: 'note',
    text:
      'THIS TEST SENDS REAL TRAFFIC TO THE URL BELOW AND USES THE INTERNET PERMISSION. ' +
      'EVERYTHING ELSE IN THIS APP IS OFFLINE. NOTHING IS SENT UNTIL YOU RUN IT.',
  });

  activeBody.append(consent, urlInput, el('div', { class: 'link-bar' }, runBtn, stopBtn), results);

  function renderResult(r) {
    clear(results);
    const phase = r.state === 'running' ? ` (${r.phase ?? '...'} ${Math.round(r.progress * 100)}%)` : '';
    results.append(
      el(
        'div',
        { class: 'stats' },
        stat('STATE', `${r.state.toUpperCase()}${phase}`),
        stat('PING', r.pingMs, { unit: 'MS' }),
        stat('JITTER', r.jitterMs, { unit: 'MS' }),
        stat('DOWNLOAD', r.downMbps, { unit: 'MBPS' }),
      ),
      r.error ? el('p', { class: 'note', text: r.error }) : null,
    );
  }

  function poll() {
    const r = source.status();
    renderResult(r);
    if (r.done) stopPolling();
  }

  function startPolling() {
    if (!timer) timer = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    runBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
  }

  runBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) return;
    consented = true;
    runBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    renderResult(source.start(url));
    startPolling();
  });

  stopBtn.addEventListener('click', () => {
    source.stop();
    stopPolling();
    renderResult(source.status());
  });

  function teardown() {
    // A running socket test left behind a hidden tab is exactly the kind of
    // background network cost the whole consent gate exists to avoid.
    if (consented) source.stop();
    stopPolling();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) teardown();
  });

  return { onHide: teardown };
}
