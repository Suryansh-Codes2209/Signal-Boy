import { EventEmitter } from 'node:events';

/**
 * Single pub/sub hub between sensors and connected browsers.
 *
 * Sensors call publish(); the HTTP layer subscribes and forwards each event
 * to every open SSE connection. Nothing here knows about HTTP, and sensors
 * never hold a reference to a client.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

/** Latest value seen per channel, so a new client can be caught up instantly. */
const lastByChannel = new Map();

export function publish(channel, payload) {
  const event = { channel, payload, t: Date.now() };
  lastByChannel.set(channel, event);
  emitter.emit('event', event);
}

export function subscribe(listener) {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}

/** Snapshot of the most recent event on each channel (for client catch-up). */
export function replay() {
  return [...lastByChannel.values()];
}
