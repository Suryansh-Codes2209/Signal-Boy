import { el, $ } from './dom.js';
import { PixelBot, MOODS, moodForBand } from './render/bot.js';
import { Guide } from './guide.js';

/**
 * The companion strip: TRK plus a speech box, persistent across every view.
 *
 * Owns the bot renderer and the Guide, and translates guidance into a
 * typewriter readout. Views push findings in through `say()`; the live stream
 * feeds `update()`.
 */

const TYPE_INTERVAL_MS = 22;

export function createCompanion(mount) {
  const botCanvas = el('canvas', { 'aria-hidden': 'true' });
  const speech = el('p', { class: 'speech-text', role: 'status', 'aria-live': 'polite' });
  const muteBtn = el('button', {
    class: 'btn speech-mute',
    type: 'button',
    text: 'MUTE',
    'aria-pressed': 'false',
  });

  mount.append(
    el(
      'div',
      { class: 'companion' },
      el('div', { class: 'companion-bot' }, botCanvas),
      el(
        'div',
        { class: 'speech' },
        el('div', { class: 'speech-head' }, el('span', { text: 'TRK' }), muteBtn),
        speech,
      ),
    ),
  );

  const bot = new PixelBot(botCanvas, { scale: 4 });
  bot.start();

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let typeTimer = null;

  function type(text) {
    clearInterval(typeTimer);
    if (reduceMotion) {
      speech.textContent = text;
      return;
    }
    speech.textContent = '';
    let i = 0;
    typeTimer = setInterval(() => {
      speech.textContent = text.slice(0, ++i);
      if (i >= text.length) clearInterval(typeTimer);
    }, TYPE_INTERVAL_MS);
  }

  const guide = new Guide((text, mood) => {
    bot.setMood(mood);
    type(text);
  });

  muteBtn.addEventListener('click', () => {
    guide.setMuted(!guide.muted);
    muteBtn.setAttribute('aria-pressed', String(guide.muted));
    muteBtn.textContent = guide.muted ? 'UNMUTE' : 'MUTE';
  });

  return {
    /** Live reading: drives the antenna bars and the bot's mood. */
    update(reading) {
      if (reading?.ok) {
        bot.setBars((reading.quality ?? 0) / 25);
        bot.setMood(moodForBand(reading.qualityBand));
      } else {
        bot.setBars(0);
        bot.setMood(MOODS.asleep);
      }
      guide.observeReading(reading);
    },
    greet: (label) => guide.greet(label),
    /** Views push findings here, e.g. "3 DEAD ZONES FOUND". */
    say: (text, opts) => guide.say(text, opts),
    setScanning(active) {
      if (active) bot.setMood(MOODS.scanning);
    },
    guide,
  };
}
