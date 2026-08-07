import { el } from '../dom.js';
import { createAudioEngine, MODES } from './engine.js';

/**
 * The SOUND toggle + PITCH/RATE switch, shared by every view that offers
 * audio feedback (LIVE, WALK, HUNT). Each view mounts its own instance --
 * one engine, one AudioContext, one pair of buttons per view -- so leaving a
 * view can always fully silence just that view's tone without touching any
 * other's state.
 *
 * This is deliberately not the same control as the companion's MUTE button
 * (companion.js): that one silences TRK's typewriter voice-over, this one is
 * the RSSI tone. Labelling them SOUND vs MUTE, rather than two buttons that
 * could both plausibly be called "mute", is what keeps a user from thinking
 * one controls the other.
 */
export function createAudioControls(name = 'default') {
  const engine = createAudioEngine(name);

  const soundBtn = el('button', {
    class: 'btn audio-toggle',
    type: 'button',
    text: 'SOUND',
    'aria-pressed': 'false',
    'aria-label': 'Toggle audio feedback',
  });
  const modeBtn = el('button', {
    class: 'btn audio-mode hidden',
    type: 'button',
    text: 'PITCH',
    'aria-pressed': 'false',
    'aria-label': 'Switch between pitch and click-rate audio feedback',
  });

  function render() {
    soundBtn.textContent = engine.enabled ? 'SOUND ON' : 'SOUND';
    soundBtn.setAttribute('aria-pressed', String(engine.enabled));
    modeBtn.classList.toggle('hidden', !engine.enabled);
    modeBtn.textContent = engine.mode === MODES.RATE ? 'RATE' : 'PITCH';
    modeBtn.setAttribute('aria-pressed', String(engine.mode === MODES.RATE));
  }

  soundBtn.addEventListener('click', async () => {
    // The click itself is the user gesture Web Audio requires to leave the
    // AudioContext's initial 'suspended' state -- enable() must run
    // synchronously from here, not from a callback queued off of it.
    if (engine.enabled) engine.disable();
    else await engine.enable();
    render();
  });

  modeBtn.addEventListener('click', () => {
    engine.setMode(engine.mode === MODES.RATE ? MODES.PITCH : MODES.RATE);
    render();
  });

  // Backgrounding the app (or just switching browser tabs) must never leave
  // a tone playing behind the user's back -- this is the one place that
  // covers all three call sites (LIVE, WALK, HUNT) with a single listener
  // instead of each view having to remember to wire it.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && engine.enabled) {
      engine.disable();
      render();
    }
  });

  return {
    el: el('span', { class: 'row audio-controls' }, soundBtn, modeBtn),
    /** Feed the latest filtered dBm. Safe to call whether or not sound is on. */
    update(dbm) {
      engine.update(dbm);
    },
    /** View left, scan stopped, or any other "must go silent now" moment. */
    stop() {
      engine.disable();
      render();
    },
  };
}
