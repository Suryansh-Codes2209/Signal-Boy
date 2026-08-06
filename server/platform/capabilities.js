/**
 * Host platform detection.
 *
 * The matrix itself lives in public/js/core/platforms.js so the browser and the
 * Android WebView can read it too; this module adds the one piece that is
 * genuinely server-only, since process.platform does not exist in a browser.
 */

/** Maps process.platform onto a platform id, defaulting to linux for unknown unixes. */
export function detectHostPlatform(processPlatform = process.platform) {
  if (processPlatform === 'darwin') return 'darwin';
  if (processPlatform === 'win32') return 'win32';
  return 'linux';
}
