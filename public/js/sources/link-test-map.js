/**
 * Raw NetTestBridge status in, a display-ready active-test result out.
 *
 * The active throughput/latency test is the one part of this app that sends
 * real traffic, so it is opt-in behind a consent gate in the LINK view and adds
 * the INTERNET permission. The Kotlin bridge runs the sockets on a background
 * thread and this maps its polled status: clamps progress, rounds numbers for
 * the pixel display, and turns an error code into readable copy. Pure, `node
 * --test` covered -- no network here, only formatting.
 */

function round1(v) {
  return v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
}

const ERROR_COPY = {
  UNREACHABLE: 'COULD NOT REACH THE TARGET.',
  BAD_URL: 'THAT DOES NOT LOOK LIKE A VALID URL.',
  TIMEOUT: 'THE TARGET TIMED OUT.',
};

export function mapLinkTest(raw) {
  const state = raw?.state ?? 'idle';
  const progress = Math.max(0, Math.min(1, raw?.progress ?? 0));
  const done = state === 'done' || state === 'error';
  return {
    state,
    phase: raw?.phase ?? null,
    pingMs: round1(raw?.pingMs),
    jitterMs: round1(raw?.jitterMs),
    downMbps: round1(raw?.downMbps),
    progress,
    done,
    error: state === 'error' ? (ERROR_COPY[raw?.error] ?? raw?.error ?? 'THE TEST FAILED.') : null,
  };
}
