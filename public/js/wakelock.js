/**
 * Keeping a phone screen on during a walk.
 *
 * The Wake Lock API is secure-context-only, so it is absent at
 * http://192.168.1.14:3000 -- exactly the URL this tool tells you to open. The
 * fallback is a muted looping video, which browsers do treat as active playback
 * over plain HTTP, but which needs a user gesture to start. Hence a toggle: one
 * tap, and the UI reports which mechanism it actually got rather than pretending.
 */

export function createWakeLock({ onChange = () => {} } = {}) {
  let sentinel = null;
  let video = null;
  let mechanism = null;
  let pending = null;

  // `mechanism` is null whenever nothing is actually held. 'none' is an
  // outcome that enable() reports, never a state the object sits in -- so
  // callers can test `mechanism` for truth without a failed attempt reading
  // as success.
  function setMechanism(next) {
    if (mechanism === next) return;
    mechanism = next;
    onChange(next);
  }

  async function requestNative() {
    if (!navigator.wakeLock?.request) return false;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      return true;
    } catch {
      return false;
    }
  }

  // A 2x2 canvas captured as a stream is enough to count as playing video, and
  // avoids shipping a binary asset for the sake of a fallback.
  async function startVideo() {
    if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      canvas.getContext('2d').fillRect(0, 0, 2, 2);

      video = document.createElement('video');
      video.muted = true;
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.loop = true;
      video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
      video.srcObject = canvas.captureStream(1);
      document.body.append(video);

      await video.play();
      return true;
    } catch {
      video?.remove();
      video = null;
      return false;
    }
  }

  // The sentinel is released whenever the tab hides; take it again on return.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (mechanism !== 'wakelock' || !sentinel?.released) return;

    if (!(await requestNative())) {
      sentinel = null;
      setMechanism(null);
    }
  });

  return {
    /** Resolves to the mechanism obtained: 'wakelock', 'video', or 'none'. */
    async enable() {
      // A second tap while the first attempt is in flight must not start a
      // rival mechanism and orphan the first one.
      if (pending) return pending;

      pending = (async () => {
        if (await requestNative()) setMechanism('wakelock');
        else if (await startVideo()) setMechanism('video');
        else setMechanism(null);
        return mechanism ?? 'none';
      })();

      try {
        return await pending;
      } finally {
        pending = null;
      }
    },

    disable() {
      sentinel?.release?.();
      sentinel = null;
      video?.remove();
      video = null;
      setMechanism(null);
    },

    get mechanism() {
      return mechanism;
    },
  };
}
