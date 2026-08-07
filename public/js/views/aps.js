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
  // Plain readout, not `.note` -- `.note` means an advisory caveat elsewhere in
  // this app (filled background, left accent) and the count is neither.
  const count = el('span', { class: 'aps-count' });
  const note = el('p', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'aps-list' });

  root.append(el('div', { class: 'aps' }, el('div', { class: 'aps-bar' }, button, count, note), list));

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

    for (const n of result.networks) {
      const grade = gradeRssi(n.rssi);
      list.append(
        el(
          'div',
          { class: 'ap' },
          el('span', { class: 'ap-swatch', style: `background:${shadeColor(grade?.shade ?? 0)}` }),
          el('span', { class: 'ap-ssid', text: n.ssid ?? 'HIDDEN' }),
          el('span', { class: 'ap-rssi', text: n.rssi == null ? 'N/A' : `${result.exact ? '' : '~'}${n.rssi} DBM` }),
          // A non-breaking space glues "CH" to its number, and non-breaking
          // hyphens hold security strings like "WPA2-PSK-CCMP" together --
          // both are single tokens that must never split mid-word at phone
          // width (see the layout fix note on `.ap` in pixel.css).
          el('span', {
            class: 'ap-meta',
            text: [n.band, n.channel != null ? `CH ${n.channel}` : null, n.security?.replace(/-/g, '‑')]
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
