import { Stream, apiGet, apiPost } from '../stream.js';

/**
 * Readings from a Signal Boy daemon over the network.
 *
 * The daemon has already applied the Kalman filter and grading before it
 * publishes, so this source passes readings straight through. Its counterpart,
 * sources/native.js, has no server to do that and filters locally instead.
 */
export function createSseSource() {
  const stream = new Stream();

  return {
    isNative: false,
    connect: () => stream.connect(),
    on: (channel, handler) => stream.on(channel, handler),
    onStateChange: (handler) => stream.onStateChange(handler),
    loadPlatform: () => apiGet('/api/platform'),
    requestScan: () => apiPost('/api/scan'),
  };
}
