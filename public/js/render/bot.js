import { PALETTE, setupCanvas } from './palette.js';

/**
 * TRK, the pixel companion.
 *
 * Drawn procedurally on a unit grid rather than from sprite sheets: every
 * feature is a whole number of units, so expressions can be recombined and the
 * antenna can show live signal bars without maintaining a sprite per state.
 *
 * The bot is the guide -- its mood is how signal quality reads at a glance,
 * before you parse any number.
 */

/** Logical drawing grid. One unit renders as `scale` device pixels. */
const GRID_W = 24;
const GRID_H = 24;

export const MOODS = {
  happy: 'happy',
  neutral: 'neutral',
  worried: 'worried',
  alarmed: 'alarmed',
  scanning: 'scanning',
  alert: 'alert',
  asleep: 'asleep',
};

/** Signal band -> mood. The bot's face is a redundant encoding of the reading. */
export function moodForBand(bandKey) {
  return {
    excellent: MOODS.happy,
    good: MOODS.happy,
    fair: MOODS.neutral,
    weak: MOODS.worried,
    dead: MOODS.alarmed,
  }[bandKey] ?? MOODS.neutral;
}

export class PixelBot {
  #canvas;
  #scale;
  #mood = MOODS.neutral;
  #bars = 0;
  #frame = 0;
  #blinkUntil = 0;
  #nextBlink = 40;
  #raf = null;

  constructor(canvas, { scale = 4 } = {}) {
    this.#canvas = canvas;
    this.#scale = scale;
  }

  setMood(mood) {
    if (MOODS[mood]) this.#mood = mood;
  }

  /** 0-4 antenna bars, mirroring the strength meter. */
  setBars(bars) {
    this.#bars = Math.max(0, Math.min(4, Math.round(bars)));
  }

  start() {
    if (this.#raf != null) return;
    const loop = () => {
      this.#frame++;
      this.#tickBlink();
      this.render();
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.#raf != null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
  }

  #tickBlink() {
    if (this.#frame >= this.#nextBlink && this.#frame > this.#blinkUntil) {
      this.#blinkUntil = this.#frame + 5;
      // Irregular intervals so it reads as alive rather than mechanical.
      this.#nextBlink = this.#frame + 90 + Math.floor(Math.random() * 150);
    }
  }

  get #isBlinking() {
    return this.#frame <= this.#blinkUntil && this.#mood !== MOODS.asleep;
  }

  render() {
    const s = this.#scale;
    const ctx = setupCanvas(this.#canvas, GRID_W * s, GRID_H * s);

    ctx.fillStyle = PALETTE[3];
    ctx.fillRect(0, 0, GRID_W * s, GRID_H * s);

    const px = (x, y, w, h, shade) => {
      ctx.fillStyle = PALETTE[shade];
      ctx.fillRect(x * s, y * s, w * s, h * s);
    };

    this.#drawAntenna(px);
    this.#drawHead(px);
    this.#drawEyes(px);
    this.#drawMouth(px);
    this.#drawBody(px);
  }

  #drawAntenna(px) {
    // Stalk
    px(11, 3, 2, 3, 0);

    // Tip pulses when there is signal, sits dark when there is none.
    const pulsing = this.#bars > 0 && Math.floor(this.#frame / 20) % 2 === 0;
    px(10, 1, 4, 2, pulsing ? 1 : 0);

    // Signal arcs to the right of the tip, one per bar.
    for (let i = 0; i < this.#bars; i++) {
      const x = 15 + i * 2;
      const h = 2 + i * 2;
      px(x, 3 - Math.floor(h / 2) + 1, 1, h, i < this.#bars ? 0 : 2);
    }
  }

  #drawHead(px) {
    // Outline, then face, with the corners cut one unit for a pixel bevel.
    px(4, 6, 16, 12, 0);
    px(3, 7, 18, 10, 0);
    px(5, 7, 14, 10, 2);
    px(4, 8, 16, 8, 2);
  }

  #drawEyes(px) {
    const mood = this.#mood;
    const leftX = 7;
    const rightX = 14;
    const y = 10;

    if (this.#isBlinking || mood === MOODS.asleep) {
      px(leftX, y + 1, 3, 1, 0);
      px(rightX, y + 1, 3, 1, 0);
      return;
    }

    if (mood === MOODS.alarmed) {
      // Crossed eyes.
      for (const x of [leftX, rightX]) {
        px(x, y, 1, 1, 0);
        px(x + 2, y, 1, 1, 0);
        px(x + 1, y + 1, 1, 1, 0);
        px(x, y + 2, 1, 1, 0);
        px(x + 2, y + 2, 1, 1, 0);
      }
      return;
    }

    if (mood === MOODS.alert) {
      // Wide eyes with a bright centre.
      for (const x of [leftX, rightX]) {
        px(x, y - 1, 3, 4, 0);
        px(x + 1, y, 1, 1, 3);
      }
      return;
    }

    if (mood === MOODS.scanning) {
      // A bar sweeping left to right across both eyes.
      const offset = Math.floor(this.#frame / 8) % 3;
      for (const x of [leftX, rightX]) {
        px(x, y, 3, 3, 2);
        px(x + offset, y, 1, 3, 0);
      }
      return;
    }

    if (mood === MOODS.happy) {
      // Upward arcs.
      for (const x of [leftX, rightX]) {
        px(x, y + 1, 1, 1, 0);
        px(x + 1, y, 1, 1, 0);
        px(x + 2, y + 1, 1, 1, 0);
      }
      return;
    }

    // neutral / worried: plain square eyes.
    for (const x of [leftX, rightX]) {
      px(x, y, 3, 3, 0);
    }
  }

  #drawMouth(px) {
    const y = 14;
    const mood = this.#mood;

    if (mood === MOODS.happy) {
      px(9, y, 1, 1, 0);
      px(10, y + 1, 4, 1, 0);
      px(14, y, 1, 1, 0);
      return;
    }
    if (mood === MOODS.worried) {
      px(9, y + 1, 1, 1, 0);
      px(10, y, 4, 1, 0);
      px(14, y + 1, 1, 1, 0);
      return;
    }
    if (mood === MOODS.alarmed || mood === MOODS.alert) {
      px(10, y, 4, 3, 0);
      px(11, y + 1, 2, 1, 2);
      return;
    }
    if (mood === MOODS.asleep) {
      px(11, y + 1, 2, 1, 0);
      return;
    }
    if (mood === MOODS.scanning) {
      // Flat mouth with a moving segment, like a readout.
      px(9, y + 1, 6, 1, 1);
      px(9 + (Math.floor(this.#frame / 6) % 6), y + 1, 1, 1, 0);
      return;
    }
    px(10, y + 1, 4, 1, 0);
  }

  #drawBody(px) {
    px(8, 18, 8, 2, 0);
    px(6, 20, 12, 3, 0);
    px(7, 21, 10, 1, 2);
    // Feet
    px(6, 23, 3, 1, 0);
    px(15, 23, 3, 1, 0);
  }
}
