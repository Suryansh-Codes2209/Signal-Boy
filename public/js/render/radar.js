import { PALETTE, setupCanvas } from './palette.js';
import { drawText, drawTextRight, drawTextCentered } from './pixelfont.js';
import {
  dbmToRadiusFraction,
  ringHalfWidthForVariance,
  RING_MIN_HALF_WIDTH,
  RSSI_FLOOR,
  RSSI_CEILING,
} from './radar-map.js';
import {
  graduationRadii,
  pingRadius,
  pingFraction,
  pingShade,
  scanlineRow,
  tickPositions,
} from './tracker-map.js';

/**
 * A proximity display for one selected BLE device, dressed as a motion tracker.
 *
 * The face is modelled on the M314 from Aliens -- dark phosphor field, bracket
 * frame with tick marks, graduated range arcs, an outward ping, a scanline --
 * with one deliberate omission that is the whole point of the design. The M314
 * is remembered for a forward cone and a blip sitting at a bearing inside it.
 * A single BLE antenna resolves no direction, so a blip at an angle would be
 * inventing the most important value on the display.
 *
 * So the contact is drawn as a full ring at its radius, never as a dot. A ring
 * at radius r asserts only "the reading matches this radius", which is true at
 * every angle at once; a dot asserts a heading. Everything borrowed from the
 * reference is radial or axial, and NO DIRECTION stays on the face. See
 * tracker-map.js, whose test suite fails if trigonometry ever appears in the
 * geometry at all.
 *
 * The arcs are graduations rather than decoration in waiting: once a ranging
 * fix drives this display instead of dBm, ruler-map.js already computes the
 * metre value each arc stands for, and the ruler becomes literal.
 *
 * Drawn on a coarse cell grid rather than with canvas arcs: every other
 * renderer in this app (meter.js, bot.js) builds shapes out of fillRect so
 * edges stay hard with imageSmoothingEnabled off -- ctx.arc's fill still
 * antialiases regardless of that flag, which would be the only soft edge in
 * the whole UI.
 */

// 8px cells rather than 16px, and twice as many of them across the same board.
// At 16px a ring near the centre had a radius of barely one cell and could not
// be resolved as a ring at all -- it merged with the emitter mark into a solid
// blob, and the graduation arcs broke into scattered specks because too few
// cell centres fell within a thin band. 8px is still --u, so the face stays
// chunky and hard-edged; it just has enough resolution to draw a circle.
const CELL = 8; // grid unit in CSS px, = --u
const GRID = 32; // cells per side
const BOARD = CELL * GRID; // 256 -- the square field
const GUTTER = 16; // bracket frame + tick marks down each side
const CHROME_STRIP = 18; // instrument labels above the readouts
const TOP_STRIP = 40; // current / peak reading row
const BOTTOM_STRIP = 76; // NO DIRECTION caption + range + trend line

const WIDTH = BOARD + GUTTER * 2;
const HEIGHT = CHROME_STRIP + TOP_STRIP + BOARD + BOTTOM_STRIP;

const BOARD_X = GUTTER;
const BOARD_Y = CHROME_STRIP + TOP_STRIP;

const TICKS_PER_EDGE = 8;
const TICK_LEN = 8;
const TICK_THICK = 4;

// Blink cadence for the live ring, in animation frames (~60fps). Slow enough
// to read as "alive" rather than flicker, distinct from the peak ring, which
// never blinks -- the difference in behaviour is what tells the two apart at
// a glance, not just their colour.
const BLINK_FRAMES = 30;

/**
 * The M314's ATT/SUS/DEC column, carrying the real trend instead of flavour
 * text. Same three-slot shape as the reference, but the lit slot is the actual
 * approach/recede state from trendFromDelta -- decoration that had to earn its
 * place by meaning something.
 */
const TREND_SLOTS = [
  { trend: 'WARMER', label: 'WRM' },
  { trend: 'STEADY', label: 'STY' },
  { trend: 'COLDER', label: 'CLD' },
];

export class PixelRadar {
  #canvas;
  #dbm = null;
  #peakDbm = null;
  #lost = false;
  #variance = null;
  #trend = 'STEADY';
  #frame = 0;
  #raf = null;
  #animating = false;

  constructor(canvas) {
    this.#canvas = canvas;
  }

  /**
   * Latest state to draw. Safe to call whether or not the animation loop is
   * running. `variance` is the Kalman filter's confidence in `dbm` (widens the
   * live ring); `trend` is 'WARMER' | 'COLDER' | 'STEADY' from trendFromDelta.
   */
  render({ dbm = null, peakDbm = null, lost = false, variance = null, trend = 'STEADY' } = {}) {
    this.#dbm = dbm;
    this.#peakDbm = peakDbm;
    this.#lost = lost;
    this.#variance = variance;
    this.#trend = trend;
    this.#draw();
  }

  /**
   * Starts the blink loop. A device deselected, a scan stopped, or the tab
   * backgrounded must all be able to call stop() -- see ble.js -- so this
   * follows the exact start/stop shape PixelBot uses rather than inventing a
   * second animation pattern in the same app.
   */
  start() {
    if (this.#raf != null) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Blink, ping and scanline are all motion for its own sake, not
      // information -- the reading is printed as text every render(), so
      // freezing them loses nothing a reduced-motion user needs. The flag is
      // read here and honoured in the draw so the face renders as a still
      // instrument rather than a half-animated one.
      this.#animating = false;
      this.#draw();
      return;
    }
    this.#animating = true;
    const loop = () => {
      this.#frame++;
      this.#draw();
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.#raf != null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
    this.#animating = false;
  }

  get #blinkOn() {
    return !this.#animating || Math.floor(this.#frame / BLINK_FRAMES) % 2 === 0;
  }

  #draw() {
    const ctx = setupCanvas(this.#canvas, WIDTH, HEIGHT);
    // Inverted against the rest of the app: this one widget is a phosphor
    // screen, so it is dark with bright marks while every other surface is a
    // light LCD with dark marks. The four palette entries are unchanged --
    // only which end of them carries the ink.
    ctx.fillStyle = PALETTE[0];
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    this.#drawChrome(ctx);
    this.#drawHeader(ctx);
    this.#drawFrame(ctx);
    this.#drawBoard(ctx);
    this.#drawCaption(ctx);
  }

  /** Instrument labels: what radio, and what quantity. Both facts, not flavour. */
  #drawChrome(ctx) {
    drawText(ctx, 'BLE', GUTTER, 5, { scale: 1, color: PALETTE[2] });
    drawTextRight(ctx, 'RSSI', WIDTH - GUTTER, 5, { scale: 1, color: PALETTE[2] });
  }

  #drawHeader(ctx) {
    const cur =
      this.#dbm == null ? (this.#lost ? 'LOST' : 'NO READING') : `${Math.round(this.#dbm)} DBM`;
    const peak = this.#peakDbm == null ? 'PEAK --' : `PEAK ${Math.round(this.#peakDbm)} DBM`;
    drawText(ctx, cur, GUTTER, CHROME_STRIP + 10, { scale: 2, color: PALETTE[3] });
    drawTextRight(ctx, peak, WIDTH - GUTTER, CHROME_STRIP + 10, { scale: 2, color: PALETTE[2] });
  }

  /**
   * Bracket frame and edge ticks.
   *
   * Pure instrument housing, and honest precisely because it is fixed: the
   * ticks are evenly spaced furniture that never move with the reading, so
   * they cannot be misread as a scale for something.
   */
  #drawFrame(ctx) {
    ctx.fillStyle = PALETTE[1];
    for (const offset of tickPositions(BOARD, TICKS_PER_EDGE)) {
      const y = BOARD_Y + offset - TICK_THICK / 2;
      ctx.fillRect(GUTTER - TICK_LEN - 2, y, TICK_LEN, TICK_THICK);
      ctx.fillRect(BOARD_X + BOARD + 2, y, TICK_LEN, TICK_THICK);
    }

    // Corner brackets, drawn as four L shapes rather than a full rectangle so
    // the field reads as framed rather than boxed in.
    ctx.fillStyle = PALETTE[2];
    const arm = 20;
    const t = 2;
    const x0 = BOARD_X - 4;
    const y0 = BOARD_Y - 4;
    const x1 = BOARD_X + BOARD + 4;
    const y1 = BOARD_Y + BOARD + 4;
    for (const [cx, cy, dx, dy] of [
      [x0, y0, 1, 1],
      [x1, y0, -1, 1],
      [x0, y1, 1, -1],
      [x1, y1, -1, -1],
    ]) {
      ctx.fillRect(dx > 0 ? cx : cx - arm, dy > 0 ? cy : cy - t, arm, t);
      ctx.fillRect(dx > 0 ? cx : cx - t, dy > 0 ? cy : cy - arm, t, arm);
    }
  }

  #drawBoard(ctx) {
    const cx = BOARD_X + BOARD / 2;
    const cy = BOARD_Y + BOARD / 2;
    const maxRadius = BOARD / 2;

    // Graduation arcs: fixed furniture at even radii, the ruler the contact
    // ring is read against. Checkerboarded so they read as graduations rather
    // than competing with the solid contact ring.
    // halfWidth is a hair over half a cell so consecutive cells along the arc
    // always overlap the band -- any less and the arc breaks into specks at the
    // diagonals, which reads as noise on the field rather than as a graduation.
    for (const radius of graduationRadii(maxRadius)) {
      this.#drawRing(ctx, cx, cy, radius, {
        color: PALETTE[1],
        checkerboard: true,
        halfWidth: CELL * 0.75,
      });
    }

    // The outward ping. A liveness indicator only -- it travels centre to rim
    // and restarts, never inward, because an inward wave would read as
    // something approaching, which is a claim about the device this display
    // has no basis to make.
    if (this.#animating) {
      const fraction = pingFraction(this.#frame);
      this.#drawRing(ctx, cx, cy, pingRadius(this.#frame, maxRadius), {
        color: PALETTE[pingShade(fraction)],
        checkerboard: true,
        halfWidth: CELL * 0.75,
      });
    }

    // Peak-hold: the strongest filtered reading since selection, drawn as a
    // dashed ring so it reads as "a past extreme" rather than "now" even when
    // it lands on the same radius as the live ring below. Never blinks --
    // a metal detector's max indicator doesn't either. Kept at the minimum
    // width: a peak is a single number, not an estimate with a live variance.
    if (this.#peakDbm != null) {
      this.#drawRing(ctx, cx, cy, dbmToRadiusFraction(this.#peakDbm) * maxRadius, {
        color: PALETTE[2],
        checkerboard: true,
        halfWidth: RING_MIN_HALF_WIDTH,
      });
    }

    // Contact ring: full circle at the current filtered dBm's radius, never a
    // point. This is the line the whole design is built around -- see the
    // module comment. Blinks so a live reading reads as "now" instead of a
    // second, competing peak mark. Its width grows with the filter's variance,
    // so a shaky or just-selected reading draws as a fuzzy band rather than a
    // crisp line it hasn't earned.
    if (this.#dbm != null && this.#blinkOn) {
      this.#drawRing(ctx, cx, cy, dbmToRadiusFraction(this.#dbm) * maxRadius, {
        color: PALETTE[3],
        checkerboard: false,
        halfWidth: ringHalfWidthForVariance(this.#variance),
      });
    }

    // The emitter: you, at the centre. Drawn as a small cross rather than a
    // filled block so that a strong reading -- whose contact ring sits close to
    // the centre and is drawn wide while the filter is still unsure -- reads
    // through it instead of merging with it into one solid mass.
    ctx.fillStyle = PALETTE[2];
    ctx.fillRect(cx - CELL * 1.5, cy - 1, CELL * 3, 2);
    ctx.fillRect(cx - 1, cy - CELL * 1.5, 2, CELL * 3);

    // CRT scanline, last so it passes over everything. Runs top to bottom
    // rather than rotating: a rotating sweep would imply the sensor is
    // scanning a bearing, which is the one thing this face must never suggest.
    if (this.#animating) {
      const row = scanlineRow(this.#frame, GRID);
      if (row >= 0) {
        ctx.fillStyle = PALETTE[1];
        ctx.fillRect(BOARD_X, BOARD_Y + row * CELL, BOARD, 2);
      }
    }
  }

  #drawRing(ctx, cx, cy, radius, { color, checkerboard, halfWidth = RING_MIN_HALF_WIDTH }) {
    ctx.fillStyle = color;
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        if (checkerboard && (gx + gy) % 2 !== 0) continue;
        const px = BOARD_X + gx * CELL + CELL / 2;
        const py = BOARD_Y + gy * CELL + CELL / 2;
        const dist = Math.hypot(px - cx, py - cy);
        if (Math.abs(dist - radius) <= halfWidth) {
          ctx.fillRect(BOARD_X + gx * CELL, BOARD_Y + gy * CELL, CELL, CELL);
        }
      }
    }
  }

  #drawCaption(ctx) {
    const y = BOARD_Y + BOARD + 8;
    // The one line that must never be missed, and the counterweight to every
    // borrowed piece of instrument styling above it: this display cannot and
    // does not show which way to walk, only how the reading compares to the
    // best one seen.
    drawTextCentered(ctx, 'NO DIRECTION', 0, y, WIDTH, { scale: 3, color: PALETTE[3] });
    drawText(ctx, 'CENTRE=STRONGEST', GUTTER, y + 28, { scale: 1, color: PALETTE[2] });
    drawTextRight(ctx, `${RSSI_FLOOR}..${RSSI_CEILING} DBM`, WIDTH - GUTTER, y + 28, {
      scale: 1,
      color: PALETTE[2],
    });

    // The reference's ATT/SUS/DEC column, carrying the real approach/recede
    // state. Honest -- it says the reading is improving, never which heading
    // to take. Every slot stays drawn so the column reads as an instrument
    // with one lamp lit rather than a label that appears and vanishes; all
    // three dim to unlit while there is no live reading, so a stale lamp
    // cannot imply movement.
    const live = this.#dbm != null;
    let slotX = GUTTER;
    for (const slot of TREND_SLOTS) {
      const lit = live && this.#trend === slot.trend;
      drawText(ctx, slot.label, slotX, y + 44, { scale: 2, color: PALETTE[lit ? 3 : 1] });
      slotX += 60;
    }
  }
}
