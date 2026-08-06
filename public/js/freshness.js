/**
 * How long a reading stays believable.
 *
 * The phone loses the LAN exactly where the survey gets interesting -- you walk
 * into the dead zone you were hunting and Android falls back to cellular. The
 * EventSource reconnects on its own, but until it does the last number on screen
 * is a lie. This tracks how old that number is so the UI can say so.
 *
 * Pure time arithmetic: the clock is injected, nothing here touches the DOM or
 * owns a timer. Callers decide when to ask.
 */

export const STALE_AFTER_MS = 3000;

export class Freshness {
  #staleAfterMs;
  #now;
  #markedAt = null;

  constructor({ staleAfterMs = STALE_AFTER_MS, now = () => Date.now() } = {}) {
    this.#staleAfterMs = staleAfterMs;
    this.#now = now;
  }

  /** Record that a reading just arrived. */
  mark() {
    this.#markedAt = this.#now();
  }

  reset() {
    this.#markedAt = null;
  }

  state() {
    if (this.#markedAt == null) return { hasReading: false, fresh: false, ageMs: null };

    const ageMs = this.#now() - this.#markedAt;
    return { hasReading: true, fresh: ageMs < this.#staleAfterMs, ageMs };
  }
}
