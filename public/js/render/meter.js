import { drawText, drawTextRight, measureText } from './pixelfont.js';
import { PALETTE, shadeColor, setupCanvas } from './palette.js';

/**
 * The main signal readout: a large bitmap dBm value, a segmented strength bar
 * and a scrolling history strip. Everything is drawn as whole squares so it
 * reads as an LCD rather than as styled text.
 */

const BAR_SEGMENTS = 20;

/** Maps 0-100 quality onto the four shades used by the bar and legend. */
function qualityShade(quality) {
  if (quality >= 70) return 3;
  if (quality >= 45) return 2;
  if (quality >= 20) return 1;
  return 0;
}

export class PixelMeter {
  #canvas;
  #width;
  #height;
  #ghost = null; // previous rendered value, drawn faintly behind the current one

  constructor(canvas, { width = 464, height = 208 } = {}) {
    this.#canvas = canvas;
    this.#width = width;
    this.#height = height;
  }

  render(state = {}) {
    const { rssi, bandLabel, quality = 0, exact = true, connected = true, message } = state;
    const ctx = setupCanvas(this.#canvas, this.#width, this.#height);
    const W = this.#width;
    const H = this.#height;
    const pad = 12;

    ctx.fillStyle = PALETTE[3];
    ctx.fillRect(0, 0, W, H);

    if (!connected) {
      this.#ghost = null;
      this.#drawOffline(ctx, W, H, message ?? 'NO SIGNAL');
      return;
    }

    // Header row: band on the left, exactness marker on the right.
    drawText(ctx, bandLabel ?? '', pad, pad, { scale: 3, color: PALETTE[0] });
    if (!exact) {
      drawTextRight(ctx, 'APPROX', W - pad, pad, { scale: 2, color: PALETTE[1] });
    }

    // Large value. "~" prefixes any figure derived from a percentage rather
    // than measured in dBm, so an approximation never looks like a reading.
    const value = rssi == null ? '--' : `${exact ? '' : '~'}${Math.round(rssi)}`;
    const scale = 13;
    const valueY = pad + 30;
    const valueW = measureText(value, scale);

    if (this.#ghost && this.#ghost !== value) {
      drawText(ctx, this.#ghost, pad, valueY, { scale, color: PALETTE[2] });
    }
    drawText(ctx, value, pad, valueY, { scale, color: PALETTE[0] });
    this.#ghost = value;

    // Unit sits on the value's baseline.
    drawText(ctx, 'DBM', pad + valueW + 14, valueY + 7 * scale - 7 * 4, {
      scale: 4,
      color: PALETTE[1],
    });

    this.#drawBar(ctx, pad, H - 64, W - pad * 2, 30, quality);

    drawText(ctx, `${Math.round(quality)}% STRENGTH`, pad, H - 24, {
      scale: 2,
      color: PALETTE[1],
    });
    drawTextRight(ctx, `${-90} .. ${-30} DBM`, W - pad, H - 24, { scale: 2, color: PALETTE[1] });
  }

  #drawBar(ctx, x, y, width, height, quality) {
    const gap = 3;
    const segW = (width - gap * (BAR_SEGMENTS - 1)) / BAR_SEGMENTS;
    const lit = Math.round((quality / 100) * BAR_SEGMENTS);

    for (let i = 0; i < BAR_SEGMENTS; i++) {
      const sx = Math.round(x + i * (segW + gap));
      const w = Math.round(segW);
      // Each lit segment takes the shade of the level it represents, so the
      // bar is a gradient of meaning rather than a solid block.
      ctx.fillStyle = i < lit ? shadeColor(qualityShade(((i + 1) / BAR_SEGMENTS) * 100)) : PALETTE[2];
      ctx.fillRect(sx, y, w, height);
      ctx.fillStyle = PALETTE[0];
      ctx.fillRect(sx, y, w, 2);
      ctx.fillRect(sx, y + height - 2, w, 2);
      ctx.fillRect(sx, y, 2, height);
      ctx.fillRect(sx + w - 2, y, 2, height);
    }
  }

  #drawOffline(ctx, W, H, message) {
    ctx.fillStyle = PALETTE[2];
    ctx.fillRect(0, 0, W, H);
    drawText(ctx, '--', 12, 42, { scale: 13, color: PALETTE[1] });
    const text = message.slice(0, 34).toUpperCase();
    drawText(ctx, text, 12, H - 40, { scale: 2, color: PALETTE[0] });
  }
}

/**
 * Rolling RSSI history. Each sample is one column, quantised to the four
 * shades -- walking away from the router draws a visible staircase down.
 */
export class Sparkline {
  #canvas;
  #width;
  #height;
  #values = [];
  #capacity;
  #floor;
  #ceiling;

  constructor(canvas, { width = 464, height = 96, capacity = 116, floor = -90, ceiling = -30 } = {}) {
    this.#canvas = canvas;
    this.#width = width;
    this.#height = height;
    this.#capacity = capacity;
    this.#floor = floor;
    this.#ceiling = ceiling;
  }

  push(value) {
    if (value == null || !Number.isFinite(value)) return;
    this.#values.push(value);
    if (this.#values.length > this.#capacity) this.#values.shift();
  }

  clear() {
    this.#values = [];
  }

  render() {
    const ctx = setupCanvas(this.#canvas, this.#width, this.#height);
    const W = this.#width;
    const H = this.#height;

    ctx.fillStyle = PALETTE[3];
    ctx.fillRect(0, 0, W, H);

    // Reference line at the -67 dBm streaming floor.
    const refY = this.#toY(-67, H);
    ctx.fillStyle = PALETTE[2];
    for (let x = 0; x < W; x += 6) ctx.fillRect(x, refY, 3, 2);
    drawText(ctx, '-67', 2, Math.max(0, refY - 10), { scale: 1, color: PALETTE[1] });

    const colW = Math.max(2, Math.floor(W / this.#capacity));
    const start = Math.max(0, this.#values.length - this.#capacity);

    for (let i = start; i < this.#values.length; i++) {
      const v = this.#values[i];
      const x = (i - start) * colW;
      const y = this.#toY(v, H);
      const shade = v >= -60 ? 3 : v >= -67 ? 2 : v >= -75 ? 1 : 0;
      ctx.fillStyle = shade === 3 ? PALETTE[1] : shadeColor(shade);
      ctx.fillRect(x, y, colW - 1, H - y);
    }

    ctx.fillStyle = PALETTE[0];
    ctx.fillRect(0, H - 2, W, 2);
  }

  #toY(value, H) {
    const t = (value - this.#floor) / (this.#ceiling - this.#floor);
    return Math.round(H - Math.max(0, Math.min(1, t)) * (H - 4)) - 2;
  }
}
