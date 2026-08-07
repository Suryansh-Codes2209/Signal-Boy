import { el, clear } from '../dom.js';
import { shadeColor } from '../render/palette.js';
import { gradeRssi } from '../core/pathloss.js';

/**
 * Every access point the radio can see, refreshed on demand.
 *
 * On demand rather than live because Android hard-throttles foreground scans to
 * four per two minutes, and a list that silently stopped updating would be
 * indistinguishable from a quiet neighbourhood. The countdown makes the limit
 * visible instead of hiding it.
 *
 * The shape this consumes is the one win32.js and linux.js already return, so
 * the view works for a daemon on those platforms as well as for the APK.
 */

const TICK_MS = 1000;

export function createApsView(root, context) {
  const support = context.platform?.capabilities?.scanAllAps ?? {};
  const unsupported = support.support === 'none';

  const button = el('button', { class: 'btn', type: 'button', text: 'SCAN' });
  const note = el('p', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'aps-list' });

  root.append(el('div', { class: 'aps' }, el('div', { class: 'aps-bar' }, button, note), list));

  if (unsupported) {
    button.disabled = true;
    note.textContent = support.detail ?? 'THIS PLATFORM CANNOT SCAN NEARBY NETWORKS.';
    return {};
  }

  let retryUntil = 0;
  let scanning = false;

  function render(result) {
    clear(list);

    if (!result.ok) {
      note.textContent = result.error ?? 'SCAN FAILED.';
      return;
    }
    if (!result.networks.length) {
      note.textContent = 'NO NETWORKS VISIBLE.';
      return;
    }

    note.textContent = `${result.networks.length} NETWORKS${result.exact ? '' : ' (APPROXIMATE DBM)'}`;

    for (const n of result.networks) {
      const grade = gradeRssi(n.rssi);
      list.append(
        el(
          'div',
          { class: 'ap' },
          el('span', { class: 'ap-swatch', style: `background:${shadeColor(grade?.shade ?? 0)}` }),
          el('span', { class: 'ap-ssid', text: n.ssid ?? 'HIDDEN' }),
          el('span', { class: 'ap-rssi', text: n.rssi == null ? 'N/A' : `${result.exact ? '' : '~'}${n.rssi} DBM` }),
          el('span', { class: 'ap-meta', text: [n.band, n.channel != null ? `CH ${n.channel}` : null, n.security].filter(Boolean).join(' · ') }),
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
      button.disabled = retryUntil > Date.now();
    }
  }

  button.addEventListener('click', scan);

  // Readings pushed by another client's scan land here too, so two phones
  // looking at the same daemon stay in step.
  context.source.on('aps', render);

  const timer = setInterval(() => {
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
  timer.unref?.();

  return {};
}
