import test from 'node:test';
import assert from 'node:assert/strict';

import { meterScaleForWidth, meterHeightForScale } from '../public/js/render/meter.js';

/**
 * The meter lays out from both ends of its canvas, so the height cannot be
 * chosen independently of the digit scale.
 *
 * Walk mode used to derive it from a 0.45 aspect ratio, which put the strength
 * bar inside the digits on every phone narrower than about 410px -- and since
 * the bar is drawn second, it painted over the number. A Pixel 6 at 412px
 * cleared by exactly zero pixels, which is why hand-checking one device missed
 * it. These are the numbers, asserted rather than eyeballed.
 */

// PixelMeter's own geometry, restated here as the requirement the height has
// to satisfy. If render() ever moves the digits or the bar, this fails.
const VALUE_TOP = 42; // pad (12) + 30
const BAR_FROM_BOTTOM = 64;
const GRID = 8;

const digitsBottom = (scale) => VALUE_TOP + 7 * scale;
const barTop = (height) => height - BAR_FROM_BOTTOM;
/** Pixels between the bottom of the digits and the top of the bar. */
const clearance = (scale) => barTop(meterHeightForScale(scale)) - digitsBottom(scale);

/** Walk mode's own sizing: the wrap width, floored so digits stay legible. */
const walkWidth = (viewport) => Math.max(280, Math.floor(viewport - 28));

test('the digits always clear the strength bar', () => {
  for (let scale = 1; scale <= 120; scale++) {
    assert.ok(
      clearance(scale) >= 0,
      `scale ${scale}: digits end at ${digitsBottom(scale)}, bar starts at ${barTop(meterHeightForScale(scale))}`,
    );
  }
});

test('leaves at least one grid row of clearance, never exactly zero', () => {
  for (let scale = 1; scale <= 120; scale++) {
    assert.ok(clearance(scale) >= GRID, `scale ${scale} cleared by only ${clearance(scale)}px`);
  }
});

test('every height is a whole number of 8px grid rows', () => {
  for (let scale = 1; scale <= 120; scale++) {
    assert.equal(meterHeightForScale(scale) % GRID, 0);
  }
});

test('the height grows monotonically with the scale', () => {
  for (let scale = 2; scale <= 120; scale++) {
    assert.ok(meterHeightForScale(scale) >= meterHeightForScale(scale - 1));
  }
});

test('the scale floors at 8 so a narrow phone keeps legible digits', () => {
  assert.equal(meterScaleForWidth(0), 8);
  assert.equal(meterScaleForWidth(280), 8);
  assert.equal(meterScaleForWidth(100), 8);
});

test('the scale matches the desktop default at the default width', () => {
  // PixelMeter's own defaults are 464px wide at scale 13; the phone sizing is
  // that same pair scaled down, not an independent guess.
  assert.equal(meterScaleForWidth(464), 13);
});

test('common phone viewports all clear, including the 412px Pixel', () => {
  // 412 is the case the aspect-ratio version cleared by exactly zero pixels.
  const viewports = [320, 360, 375, 390, 393, 412, 414, 430];
  for (const viewport of viewports) {
    const w = walkWidth(viewport);
    const scale = meterScaleForWidth(w);
    assert.ok(
      clearance(scale) >= GRID,
      `viewport ${viewport} (canvas ${w}, scale ${scale}) cleared by ${clearance(scale)}px`,
    );
  }
});

test('clears across every viewport from a small phone to a wide desktop', () => {
  for (let viewport = 200; viewport <= 2560; viewport++) {
    const scale = meterScaleForWidth(walkWidth(viewport));
    assert.ok(clearance(scale) >= GRID, `viewport ${viewport} cleared by ${clearance(scale)}px`);
  }
});

test('the shipped default height clears at the shipped default scale', () => {
  // 464x208 at scale 13 is what the live view constructs with no options.
  assert.ok(barTop(208) - digitsBottom(13) >= 0);
  assert.ok(meterHeightForScale(13) <= 208, 'the derived height must not exceed the default');
});
