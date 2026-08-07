import { PALETTE, setupCanvas } from './palette.js';
import { drawText, drawTextRight, drawTextCentered } from './pixelfont.js';
import { dbmToRadiusFraction, shadeForRadiusFraction, RSSI_FLOOR, RSSI_CEILING } from './radar-map.js';

/**
 * A concentric-ring proximity display for one selected BLE device.
 *
 * This is NOT a bearing radar -- a single antenna cannot resolve direction,
 * so nothing here is placed at an angle that means anything. The dartboard of
 * bands communicates "closer = stronger, drawn toward the centre" and
 * nothing else; the current reading and the peak-hold mark are each drawn as
 * a full ring at their radius, never as a dot at a point, because a dot
 * implies a direction this hardware cannot measure and a ring cannot.
 *
 * Drawn on a coarse cell grid rather than with canvas arcs: every other
 * renderer in this app (meter.js, bot.js) builds shapes out of fillRect so
 * edges stay hard with imageSmoothingEnabled off -- ctx.arc's fill still
 * antialiases regardless of that flag, which would be the only soft edge in
 * the whole UI.
 */

const CELL = 16; // grid unit in CSS px, a multiple of --u (8px)
const GRID = 16; // cells per side
const BOARD = CELL * GRID; // 256 -- the square dartboard
const TOP_STRIP = 40; // current / peak reading row
const BOTTOM_STRIP = 56; // NO DIRECTION caption + range
const WIDTH = BOARD;
const HEIGHT = TOP_STRIP + BOARD + BOTTOM_STRIP;

const RING_HALF_WIDTH_PX = CELL / 2;

// Blink cadence for the live ring, in animation frames (~60fps). Slow enough
// to read as "alive" rather than flicker, distinct from the peak ring, which
// never blinks -- the difference in behaviour is what tells the two apart at
// a glance, not just their colour.
const BLINK_FRAMES = 30;

export class PixelRadar {
  #canvas;
  #dbm = null;
  #peakDbm = null;
  #lost = false;
  #frame = 0;
  #raf = null;

  constructor(canvas) {
    this.#canvas = canvas;
  }

  /** Latest state to draw. Safe to call whether or not the animation loop is running. */
  render({ dbm = null, peakDbm = null, lost = false } = {}) {
    this.#dbm = dbm;
    this.#peakDbm = peakDbm;
    this.#lost = lost;
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
      // A blinking ring is motion for its own sake, not information -- the
      // reading is also printed as text every render(), so freezing the
      // blink loses nothing a reduced-motion user needs.
      this.#draw();
      return;
    }
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
  }

  get #blinkOn() {
    return Math.floor(this.#frame / BLINK_FRAMES) % 2 === 0;
  }

  #draw() {
    const ctx = setupCanvas(this.#canvas, WIDTH, HEIGHT);
    ctx.fillStyle = PALETTE[3];
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    this.#drawHeader(ctx);
    this.#drawBoard(ctx);
    this.#drawCaption(ctx);
  }

  #drawHeader(ctx) {
    const cur =
      this.#dbm == null ? (this.#lost ? 'LOST' : 'NO READING') : `${Math.round(this.#dbm)} DBM`;
    const peak = this.#peakDbm == null ? 'PEAK --' : `PEAK ${Math.round(this.#peakDbm)} DBM`;
    drawText(ctx, cur, 8, 10, { scale: 2, color: PALETTE[0] });
    drawTextRight(ctx, peak, WIDTH - 8, 10, { scale: 2, color: PALETTE[1] });
  }

  #drawBoard(ctx) {
    const top = TOP_STRIP;
    const cx = WIDTH / 2;
    const cy = top + BOARD / 2;
    const maxRadius = BOARD / 2;

    // The dartboard itself: every cell shaded by how far it sits from centre,
    // quantised to the same four colours as everything else. This is the
    // only geometry drawn -- no cell's shade depends on where the device
    // *appears* to be, only on the fixed rings.
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const px = gx * CELL + CELL / 2;
        const py = top + gy * CELL + CELL / 2;
        const dist = Math.hypot(px - cx, py - cy);
        const shade = shadeForRadiusFraction(dist / maxRadius);
        ctx.fillStyle = PALETTE[shade];
        ctx.fillRect(gx * CELL, top + gy * CELL, CELL, CELL);
      }
    }

    // Peak-hold: the strongest filtered reading since selection, drawn as a
    // dashed ring so it reads as "a past extreme" rather than "now" even when
    // it lands on the same radius as the live ring below. Never blinks --
    // a metal detector's max indicator doesn't either.
    if (this.#peakDbm != null) {
      this.#drawRing(ctx, cx, cy, dbmToRadiusFraction(this.#peakDbm) * maxRadius, {
        color: PALETTE[1],
        checkerboard: true,
      });
    }

    // Live ring: full circle at the current filtered dBm's radius, never a
    // point. A ring at radius r asserts only "the reading matches this
    // radius", true at every angle simultaneously -- the honest shape for
    // data with no bearing. Blinks so a live reading reads as "now" instead
    // of a second, competing peak mark.
    if (this.#dbm != null && this.#blinkOn) {
      this.#drawRing(ctx, cx, cy, dbmToRadiusFraction(this.#dbm) * maxRadius, {
        color: PALETTE[0],
        checkerboard: false,
      });
    }
  }

  #drawRing(ctx, cx, cy, radius, { color, checkerboard }) {
    const top = TOP_STRIP;
    ctx.fillStyle = color;
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        if (checkerboard && (gx + gy) % 2 !== 0) continue;
        const px = gx * CELL + CELL / 2;
        const py = top + gy * CELL + CELL / 2;
        const dist = Math.hypot(px - cx, py - cy);
        if (Math.abs(dist - radius) <= RING_HALF_WIDTH_PX) {
          ctx.fillRect(gx * CELL, top + gy * CELL, CELL, CELL);
        }
      }
    }
  }

  #drawCaption(ctx) {
    const y = TOP_STRIP + BOARD + 8;
    // The one line that must never be missed: this display cannot and does
    // not show which way to walk, only how the reading compares to the best
    // one seen.
    drawTextCentered(ctx, 'NO DIRECTION', 0, y, WIDTH, { scale: 3, color: PALETTE[0] });
    drawText(ctx, 'CENTRE=STRONGEST', 8, y + 28, { scale: 1, color: PALETTE[1] });
    drawTextRight(ctx, `${RSSI_FLOOR}..${RSSI_CEILING} DBM`, WIDTH - 8, y + 28, {
      scale: 1,
      color: PALETTE[1],
    });
  }
}
