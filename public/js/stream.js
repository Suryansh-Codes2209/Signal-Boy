/**
 * Server-Sent Events client with channel-based dispatch.
 *
 * SSE rather than WebSockets: sensor data is entirely server->browser, it is
 * built into every browser, and it reconnects on its own. Commands travel the
 * other way as ordinary JSON POSTs.
 */

export class Stream {
  #source = null;
  #listeners = new Map();
  #stateListeners = new Set();
  #state = 'connecting';

  constructor(url = '/api/stream') {
    this.url = url;
  }

  connect() {
    this.#source?.close();
    this.#setState('connecting');

    const source = new EventSource(this.url);
    this.#source = source;

    source.onopen = () => this.#setState('live');

    source.onmessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#setState('live');
      for (const fn of this.#listeners.get(parsed.channel) ?? []) fn(parsed.payload, parsed);
    };

    // EventSource retries automatically; surface the gap so the LED reflects it.
    source.onerror = () => this.#setState('error');

    return this;
  }

  on(channel, handler) {
    if (!this.#listeners.has(channel)) this.#listeners.set(channel, new Set());
    this.#listeners.get(channel).add(handler);
    return () => this.#listeners.get(channel)?.delete(handler);
  }

  onStateChange(handler) {
    this.#stateListeners.add(handler);
    handler(this.#state);
    return () => this.#stateListeners.delete(handler);
  }

  get state() {
    return this.#state;
  }

  #setState(next) {
    if (this.#state === next) return;
    this.#state = next;
    for (const fn of this.#stateListeners) fn(next);
  }
}

/** JSON GET with a useful error message when the daemon is not reachable. */
export async function apiGet(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json();
}

export async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `${path} responded ${res.status}`);
  }
  return res.json();
}
