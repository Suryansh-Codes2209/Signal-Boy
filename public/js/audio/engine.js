import { dbmToFrequency, dbmToClickIntervalMs, BASE_FREQUENCY_HZ } from './tone-map.js';

/**
 * The Web Audio side of audio feedback. Thin and untested by necessity --
 * this project's test suite is `node --test` with no DOM/AudioContext
 * harness, so the part that must be correct (the dBm -> sound mapping) lives
 * in tone-map.js instead, where it is fully covered. This file just wires
 * that mapping to an OscillatorNode and a GainNode.
 *
 * Off by default, always: a fresh engine makes no sound until enable() runs,
 * and enable() must be called from a user gesture (a click handler) or the
 * AudioContext it creates stays 'suspended' and never produces audio -- that
 * restriction is what makes the toggle double as Web Audio's required unlock.
 */

export const MODES = { PITCH: 'pitch', RATE: 'rate' };

/** Square wave is the Game Boy DMG voice -- the same argument as the four-colour palette. */
const OSCILLATOR_TYPE = 'square';

/** Loud enough to hear in a pocket, quiet enough not to be the point of the app. */
const TONE_GAIN = 0.06;
/** Click bursts read clearly at a higher peak than the sustained tone would tolerate. */
const CLICK_GAIN = 0.18;
/** How fast frequency/gain changes glide, so the filtered value's own smoothing survives instead of stepping. */
const RAMP_SECONDS = 0.08;
/** Click burst length: long enough to read as a "tock", short enough to leave silence between fast clicks. */
const CLICK_DURATION_SECONDS = 0.03;

/**
 * A registry of live engines keyed by name, purely for on-device inspection
 * over the WebView DevTools protocol (Runtime.evaluate reading
 * window.__signalboyAudio) -- there is no other way to see an AudioContext's
 * state or an oscillator's frequency from outside the page. Harmless at
 * runtime: it is a debugging aid, not a control path.
 */
const registry = (globalThis.__signalboyAudio ??= {});

export function createAudioEngine(name = 'default') {
  let ctx = null;
  let osc = null;
  let gain = null;
  let mode = MODES.PITCH;
  let enabled = false;
  let clickTimer = null;
  let lastDbm = null;

  function ensureGraph() {
    if (ctx) return;
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    ctx = new Ctor();
    osc = ctx.createOscillator();
    osc.type = OSCILLATOR_TYPE;
    osc.frequency.value = BASE_FREQUENCY_HZ;
    gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    registry[name] = api;
  }

  function silence() {
    if (!gain) return;
    gain.gain.setTargetAtTime(0, ctx.currentTime, RAMP_SECONDS);
  }

  function stopClicks() {
    clearTimeout(clickTimer);
    clickTimer = null;
  }

  /** One click burst, then reschedules itself at the interval implied by the latest reading. */
  function scheduleClick() {
    stopClicks();
    const intervalMs = dbmToClickIntervalMs(lastDbm);
    if (intervalMs == null) return; // nothing to click toward; stay silent until a reading arrives

    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(CLICK_GAIN, now);
    gain.gain.linearRampToValueAtTime(0, now + CLICK_DURATION_SECONDS);
    clickTimer = setTimeout(scheduleClick, intervalMs);
  }

  function applyPitch() {
    if (!gain) return;
    const freq = dbmToFrequency(lastDbm);
    if (freq == null) {
      silence();
      return;
    }
    osc.frequency.setTargetAtTime(freq, ctx.currentTime, RAMP_SECONDS);
    gain.gain.setTargetAtTime(TONE_GAIN, ctx.currentTime, RAMP_SECONDS);
  }

  const api = {
    get enabled() {
      return enabled;
    },
    get mode() {
      return mode;
    },
    /**
     * Read-only snapshot for the on-device verification step: the actual
     * AudioContext state and the oscillator/gain values currently in effect,
     * exactly what Runtime.evaluate needs to confirm a frequency change or a
     * drop to silence really happened, rather than trusting this module's
     * own bookkeeping.
     */
    get debug() {
      return {
        contextState: ctx?.state ?? 'none',
        frequency: osc?.frequency.value ?? null,
        gain: gain?.gain.value ?? null,
        mode,
        enabled,
      };
    },

    /**
     * Requires a user gesture in its call stack the first time -- the
     * AudioContext this creates starts 'suspended' otherwise and resume()
     * never settles. Callers are expected to invoke this from a click
     * handler, never automatically.
     */
    async enable() {
      ensureGraph();
      if (ctx.state === 'suspended') await ctx.resume();
      enabled = true;
      if (mode === MODES.RATE) scheduleClick();
      else applyPitch();
    },

    /**
     * Covers every "must stop" case in one method: the toggle switched off,
     * the view left, the BLE scan stopped, or the app backgrounded. Suspends
     * the whole context rather than only silencing gain, so a stray update()
     * or a timer firing cannot make sound resume by any path -- only a fresh
     * enable() (a fresh user gesture) can start it again. Deliberately does
     * not auto-resume on its own: coming back to a foregrounded tab and
     * immediately hearing a tone would be exactly the surprise noise this
     * feature must never produce.
     */
    disable() {
      enabled = false;
      stopClicks();
      silence();
      ctx?.suspend();
    },

    setMode(next) {
      if (next !== MODES.PITCH && next !== MODES.RATE) throw new RangeError(`unknown mode: ${next}`);
      mode = next;
      stopClicks();
      silence();
      // Click timbre stays fixed regardless of whatever pitch mode last set
      // the oscillator to -- rate is the only variable that should carry
      // meaning in this mode, not a frequency left over from the other one.
      if (mode === MODES.RATE && osc) osc.frequency.setValueAtTime(BASE_FREQUENCY_HZ, ctx.currentTime);
      if (enabled) {
        if (mode === MODES.RATE) scheduleClick();
        else applyPitch();
      }
    },

    /** Feed the latest filtered dBm. A no-op while disabled -- readings never queue up silently for later. */
    update(dbm) {
      lastDbm = dbm;
      if (!enabled) return;
      if (mode === MODES.PITCH) applyPitch();
      // RATE mode picks up the new lastDbm the next time scheduleClick() fires
      // on its own timer; no need to reschedule immediately on every reading.
    },
  };

  return api;
}
