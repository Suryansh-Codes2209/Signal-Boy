#!/usr/bin/env node
/**
 * Regenerates the inline-SVG favicon used by public/index.html and
 * site/index.html, replacing whatever data URI currently sits in each
 * `<link rel="icon">`.
 *
 * Same "reuse the renderer, don't redraw the bot" rule as tools/bot-icon.html,
 * but here the renderer's OWN draw calls become the SVG markup directly,
 * rather than a screenshot of them. bot.js calls ctx.fillRect() through a
 * tiny `px()` helper for every shape it draws; this script hands PixelBot a
 * fake canvas/context whose fillRect() records {x, y, w, h, fillStyle}
 * instead of painting pixels, then turns that call log into one <rect> per
 * call, in the same order (so later shapes still draw over earlier ones,
 * same as canvas painter's-algorithm order). No coordinate, shape or colour
 * in the output is hand-authored -- it is bot.js's own render() trace.
 *
 * scale: 1 is deliberate. bot.js's px(x, y, w, h) multiplies every
 * coordinate by the scale before calling fillRect; at scale 1 those
 * fillRect calls land exactly on the 24x24 logical grid bot.js draws on
 * (GRID_W/GRID_H in bot.js), so the SVG's viewBox can be that same 24x24
 * without any further conversion.
 *
 * Mood/bars match tools/bot-icon.html (happy, 4 bars) so the favicon and the
 * launcher icon read as the same face -- see that file's comment for why.
 *
 * The minimal percent-encoding below (only '<', '>', '#', '"') matches the
 * signal-bars favicon this replaces: a data URI is not a query string, so
 * browsers tolerate literal spaces/colons/slashes in it, and encoding only
 * the characters that would otherwise break HTML-attribute or URI parsing
 * keeps the href readable in a diff instead of turning it into one solid
 * percent-escaped blob.
 *
 * Run: node tools/gen-favicon.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);

// palette.js's setupCanvas() reads window.devicePixelRatio; this script runs
// in plain Node, so supply the one property it needs rather than pulling in
// a DOM shim.
globalThis.window = { devicePixelRatio: 1 };

class FakeCtx {
  fillStyle = '#000';
  imageSmoothingEnabled = true;
  setTransform() {}
  fillRect(x, y, w, h) {
    this.calls.push({ x, y, w, h, color: this.fillStyle });
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  style = {};
  #ctx = new FakeCtx();
  constructor() {
    this.#ctx.calls = [];
  }
  getContext() {
    return this.#ctx;
  }
  get calls() {
    return this.#ctx.calls;
  }
}

const { PixelBot, MOODS } = await import('../public/js/render/bot.js');

const canvas = new FakeCanvas();
const bot = new PixelBot(canvas, { scale: 1 });
bot.setMood(MOODS.happy);
bot.setBars(4);
bot.render();

const rects = canvas.calls
  .map(({ x, y, w, h, color }) => `<rect x='${x}' y='${y}' width='${w}' height='${h}' fill='${color}'/>`)
  .join('');
const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>${rects}</svg>`;

const encode = (s) => s.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23').replace(/"/g, '%22');
const href = `data:image/svg+xml,${encode(svg)}`;

const targets = ['public/index.html', 'site/index.html'];
const linkPattern = /<link\s+rel="icon"\s+href="data:image\/svg\+xml,[^"]*"\s*\/>/;

for (const rel of targets) {
  const file = path.join(repoRoot, rel);
  const html = readFileSync(file, 'utf8');
  if (!linkPattern.test(html)) {
    throw new Error(`${rel}: no <link rel="icon" href="data:image/svg+xml,..."/> found to replace`);
  }
  const next = html.replace(linkPattern, `<link\n      rel="icon"\n      href="${href}"\n    />`);
  writeFileSync(file, next);
  console.log(`updated ${rel}`);
}
