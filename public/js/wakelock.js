/**
 * Keeping a phone screen on during a walk.
 *
 * The Wake Lock API is secure-context-only, so it is absent at
 * http://192.168.1.14:3000 -- exactly the URL this tool tells you to open. The
 * fallback is a muted looping video, which browsers do treat as active playback
 * over plain HTTP, but which needs a user gesture to start. Hence a toggle: one
 * tap, and the UI reports which mechanism it actually got rather than pretending.
 */

export function createWakeLock() {
  let sentinel = null;
  let video = null;
  let mechanism = null;

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
  function startVideo() {
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

      const played = video.play();
      if (played?.catch) played.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  // The sentinel is released whenever the tab hides; take it again on return.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && mechanism === 'wakelock' && sentinel?.released) {
      await requestNative();
    }
  });

  return {
    async enable() {
      if (await requestNative()) mechanism = 'wakelock';
      else if (startVideo()) mechanism = 'video';
      else mechanism = 'none';
      return mechanism;
    },

    disable() {
      sentinel?.release?.();
      sentinel = null;
      video?.remove();
      video = null;
      mechanism = null;
    },

    get mechanism() {
      return mechanism;
    },
  };
}
