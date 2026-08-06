/**
 * The only four colours in the application.
 *
 * Index doubles as the "shade" value used everywhere else: signal bands, the
 * heatmap quantiser and the capability matrix all resolve to 0-3.
 */
export const PALETTE = [
  '#0f380f', // 0 darkest  - dead
  '#306230', // 1 dark     - weak
  '#8bac0f', // 2 light    - fair
  '#9bbc0f', // 3 lightest - good / excellent
];

export const DARKEST = 0;
export const DARK = 1;
export const LIGHT = 2;
export const LIGHTEST = 3;

export function shadeColor(shade) {
  return PALETTE[Math.max(0, Math.min(3, shade | 0))];
}

/**
 * Sizes a canvas for the device pixel ratio and returns a context whose
 * coordinates are CSS pixels. Keeps every drawn square crisp on retina
 * displays instead of blurring across half-pixels.
 */
export function setupCanvas(canvas, cssWidth, cssHeight) {
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return ctx;
}
