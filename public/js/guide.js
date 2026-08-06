import { MOODS, moodForBand } from './render/bot.js';

/**
 * What TRK says, and when.
 *
 * The companion is only useful if it stays quiet. Guidance is driven by
 * *changes* -- crossing a signal band, a scan finishing, an error -- never by
 * the 1 Hz reading stream, and low-priority chatter is rate limited so the
 * speech box never becomes noise you learn to ignore.
 */

export const PRIORITY = {
  TIP: 0, // ambient suggestions; heavily rate limited
  STATUS: 1, // normal narration of something that changed
  ALERT: 2, // errors and findings; always interrupts
};

/** Ambient tips, shown only during long quiet stretches. */
const IDLE_TIPS = [
  'WALK AROUND. I WILL TRACK THE SIGNAL AS YOU GO.',
  'BELOW -67 DBM IS WHERE VIDEO CALLS START TO BREAK UP.',
  'STAND STILL FOR A FEW SECONDS BEFORE TRUSTING A READING.',
  'THE HISTORY STRIP SHOWS THE LAST TWO MINUTES OF SIGNAL.',
  'YOUR BODY BLOCKS WIFI. TRY TURNING AROUND SLOWLY.',
];

const BAND_LINES = {
  excellent: ['STRONG SIGNAL HERE. THIS SPOT IS GREAT.', 'EXCELLENT. YOU ARE CLOSE TO THE ROUTER.'],
  good: ['GOOD SIGNAL. NOTHING TO WORRY ABOUT HERE.', 'SOLID COVERAGE IN THIS SPOT.'],
  fair: ['SIGNAL IS FAIR. STREAMING IS FINE, CALLS MIGHT WOBBLE.'],
  weak: ['SIGNAL IS GETTING WEAK. MARK THIS SPOT.', 'WEAK HERE. A WALL IS PROBABLY IN THE WAY.'],
  dead: ['DEAD ZONE! BARELY ANYTHING REACHES HERE.', 'ALMOST NO SIGNAL. THIS IS A PROBLEM SPOT.'],
};

const IDLE_AFTER_MS = 45000;
const TIP_COOLDOWN_MS = 60000;
const STATUS_COOLDOWN_MS = 4000;

/** Deterministic-ish variety without repeating the same line twice in a row. */
function pickLine(lines, lastLine) {
  const options = lines.filter((l) => l !== lastLine);
  const pool = options.length ? options : lines;
  return pool[Math.floor(Math.random() * pool.length)];
}

export class Guide {
  #onSay;
  #lastSpokeAt = 0;
  #lastTipAt = 0;
  #lastLine = null;
  #lastBand = null;
  #tipIndex = 0;
  #idleTimer = null;
  #muted = false;

  /** @param onSay {(text: string, mood: string) => void} */
  constructor(onSay) {
    this.#onSay = onSay;
    this.#scheduleIdle();
  }

  setMuted(muted) {
    this.#muted = muted;
    if (muted) clearTimeout(this.#idleTimer);
    else this.#scheduleIdle();
  }

  get muted() {
    return this.#muted;
  }

  say(text, { mood = MOODS.neutral, priority = PRIORITY.STATUS } = {}) {
    if (this.#muted && priority < PRIORITY.ALERT) return false;

    const now = Date.now();
    if (priority === PRIORITY.STATUS && now - this.#lastSpokeAt < STATUS_COOLDOWN_MS) return false;
    if (priority === PRIORITY.TIP && now - this.#lastTipAt < TIP_COOLDOWN_MS) return false;

    this.#lastSpokeAt = now;
    if (priority === PRIORITY.TIP) this.#lastTipAt = now;
    this.#lastLine = text;
    this.#onSay(text, mood);
    this.#scheduleIdle();
    return true;
  }

  /**
   * Feeds a live reading. Speaks only when the signal band changes, so
   * standing still produces silence rather than a running commentary.
   */
  observeReading(reading) {
    if (!reading?.ok) {
      if (this.#lastBand !== 'offline') {
        this.#lastBand = 'offline';
        this.say(errorLine(reading?.error), { mood: MOODS.asleep, priority: PRIORITY.ALERT });
      }
      return;
    }

    const band = reading.qualityBand;
    if (!band || band === this.#lastBand) return;

    const first = this.#lastBand === null;
    this.#lastBand = band;
    if (first) return; // the greeting already covered the opening state

    this.say(pickLine(BAND_LINES[band] ?? [], this.#lastLine), {
      mood: moodForBand(band),
      priority: band === 'dead' ? PRIORITY.ALERT : PRIORITY.STATUS,
    });
  }

  greet(platformLabel) {
    this.say(`SIGNAL BOY ONLINE. READING WIFI VIA ${platformLabel}.`, {
      mood: MOODS.happy,
      priority: PRIORITY.ALERT,
    });
  }

  #scheduleIdle() {
    clearTimeout(this.#idleTimer);
    if (this.#muted) return;
    this.#idleTimer = setTimeout(() => {
      const tip = IDLE_TIPS[this.#tipIndex % IDLE_TIPS.length];
      this.#tipIndex++;
      this.say(tip, { mood: MOODS.neutral, priority: PRIORITY.TIP });
      this.#scheduleIdle();
    }, IDLE_AFTER_MS);
  }
}

function errorLine(error) {
  if (!error) return 'I LOST THE SIGNAL READING.';
  if (/not connected/i.test(error)) return 'YOU ARE NOT ON WIFI RIGHT NOW. CONNECT AND I WILL RESUME.';
  if (/no signal/i.test(error)) return 'THE ADAPTER IS NOT REPORTING A SIGNAL LEVEL.';
  return `SENSOR PROBLEM: ${error.toUpperCase()}`;
}
