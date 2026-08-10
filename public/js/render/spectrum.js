import { PALETTE, setupCanvas } from './palette.js';
import { drawText, drawTextRight, drawTextCentered } from './pixelfont.js';
import { CHANNEL_RANGE } from './spectrum-map.js';

/**
 * A channel-power chart for one band: every access point drawn as a vertical
 * bar at its channel, as tall as its signal is strong.
 *
 * NOT an SDR spectrum -- the radio gives one RSSI per AP, not a swept power
 * trace -- so this shows the envelope of discrete marks, and the caption says
 * so. Built from fillRect on a coarse grid like meter.js/radar.js, never
 * ctx.arc or a smooth path, so every edge stays hard with smoothing off. The
 * geometry it draws comes entirely from spectrum-map.js, which `node --test`
 * covers; this class only turns fractions into rectangles.
 */

const CELL = 8; // grid unit in CSS px, = --u
const PLOT_W = 320; // 40 cells
const PLOT_H = 120; // signal axis height
const TOP_STRIP = 28; // band label + AP count
const BOTTOM_STRIP = 40; // channel axis labels + caption
const WIDTH = PLOT_W;
const HEIGHT = TOP_STRIP + PLOT_H + BOTTOM_STRIP;
const BAR_HALF_W = CELL; // bars are two cells wide

export class PixelSpectrum {
  #canvas;
  #spectrum = null;

  constructor(canvas) {
    this.#canvas = canvas;
  }

  /** Draw one band's spectrum ({ band, points }) from spectrum-map.js, or clear on null. */
  render(spectrum) {
    this.#spectrum = spectrum;
    const ctx = setupCanvas(this.#canvas, WIDTH, HEIGHT);
    ctx.fillStyle = PALETTE[3];
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    if (!spectrum || !spectrum.points.length) {
      drawTextCentered(ctx, 'NO NETWORKS IN BAND', 0, TOP_STRIP + PLOT_H / 2, WIDTH, {
        scale: 2,
        color: PALETTE[1],
      });
      return;
    }

    this.#drawHeader(ctx, spectrum);
    this.#drawBars(ctx, spectrum);
    this.#drawAxis(ctx, spectrum);
  }

  #drawHeader(ctx, spectrum) {
    drawText(ctx, spectrum.band, 4, 6, { scale: 2, color: PALETTE[0] });
    const n = spectrum.points.length;
    drawTextRight(ctx, `${n} AP${n === 1 ? '' : 'S'}`, WIDTH - 4, 6, { scale: 2, color: PALETTE[1] });
  }

  #drawBars(ctx, spectrum) {
    const baseline = TOP_STRIP + PLOT_H;
    // Faint baseline so empty channels still read as "measured, nothing here".
    ctx.fillStyle = PALETTE[2];
    ctx.fillRect(0, baseline, WIDTH, 2);

    for (const point of spectrum.points) {
      const x = Math.round((point.xFraction ?? 0) * (PLOT_W - 2 * BAR_HALF_W)) + BAR_HALF_W;
      const barHeight = Math.max(CELL, Math.round(point.heightFraction * PLOT_H));
      // Stronger signal draws darker so the loud, close APs stand out against
      // the light LCD ground; height carries the same information redundantly.
      const shade = point.heightFraction > 0.66 ? 0 : point.heightFraction > 0.33 ? 1 : 2;
      ctx.fillStyle = PALETTE[shade];
      ctx.fillRect(x - BAR_HALF_W, baseline - barHeight, BAR_HALF_W * 2, barHeight);
    }
  }

  #drawAxis(ctx, spectrum) {
    const [lo, hi] = CHANNEL_RANGE[spectrum.band] ?? [1, 14];
    const y = TOP_STRIP + PLOT_H + 6;
    drawText(ctx, `CH ${lo}`, 4, y, { scale: 1, color: PALETTE[1] });
    drawTextRight(ctx, `CH ${hi}`, WIDTH - 4, y, { scale: 1, color: PALETTE[1] });
    // The one honesty line: this is per-AP power, not a swept spectrum.
    drawText(ctx, 'PER-AP POWER, NOT A SWEPT SPECTRUM', 4, y + 14, { scale: 1, color: PALETTE[1] });
  }
}
