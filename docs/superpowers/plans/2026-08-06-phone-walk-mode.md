# Phone Walk Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user opens the printed LAN URL on their phone, with no flags and no certificate prompt, and gets a readable walking display that never shows a stale number as if it were live.

**Architecture:** A new `walk` view reuses the existing `PixelMeter` and `Sparkline` renderers at a larger scale, and becomes the default view when the page is not on localhost. A pure `Freshness` module tracks reading age and drives a dimmed STALE treatment. A `wakelock` module keeps the screen on, degrading through three mechanisms because the Wake Lock API is secure-context-only.

**Tech Stack:** Vanilla ES modules, no build step, no runtime or dev dependencies. Tests are `node --test` with `node:assert/strict`.

## Global Constraints

- **Zero dependencies.** No runtime and no dev dependencies may be added. This is a stated property of the project.
- **Node >= 20** (`engines` in `package.json`).
- **Four colours only.** `PALETTE` in `public/js/render/palette.js`. No gradients, shadows, or border radius.
- **Every dimension is a multiple of 8px**, matching `--u: 8px`, so layout sits on the bitmap font grid.
- **Never display a number the tool did not measure.** Missing values render `N/A` with the reason attached, never blank and never zero.
- **All UI text is uppercase** (`text-transform: uppercase` on `body`).
- **Staleness threshold is 3000ms**, defined once in `public/js/freshness.js`.
- **View contract:** views are created as `createXView(root, context)` and return an object; views that consume readings expose `update(reading)`.

---

## File Structure

**Create:**
- `public/js/freshness.js` — pure reading-age logic. No DOM, no timers of its own.
- `test/freshness.test.js` — unit suite for the above.
- `public/js/wakelock.js` — screen-awake, with mechanism degradation.
- `public/js/views/walk.js` — the walking display.
- `server/qr/galois.js` — GF(256) arithmetic and Reed-Solomon remainder.
- `server/qr/encode.js` — byte-mode data encoding and version selection.
- `server/qr/matrix.js` — module placement, masking, format info.
- `server/qr/index.js` — `encodeQr(text)`, the one entry point.
- `server/qr/terminal.js` — matrix to printable ANSI text.
- `test/qr-galois.test.js`, `test/qr-encode.test.js`, `test/qr-matrix.test.js` — suites for the above.
- `test/fixtures/qr-golden.json` — known-good matrix, the encoder's target.

**Modify:**
- `public/js/render/meter.js` — make the big-value `scale` a constructor option (currently hardcoded at line 57).
- `public/js/app.js` — register the walk view, pick it as default off-localhost, route the stream to all views instead of only `live`.
- `public/js/capabilities.js` — add the missing `&& secure` guards.
- `public/css/pixel.css` — walk mode layout.
- `server/index.js` — print the QR code in the startup banner.
- `package.json` — `repository`, `bugs`, `author`.
- `README.md` — document walk mode and the QR code; correct the survey description.

---

### Task 1: Freshness module

The one piece of this work testable without a browser. A clock is injected so tests need no fake timers.

**Files:**
- Create: `public/js/freshness.js`
- Test: `test/freshness.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `class Freshness`, constructed as `new Freshness({ staleAfterMs = 3000, now = () => Date.now() } = {})`, with methods `mark()` (record that a reading just arrived, returns undefined), `state()` (returns `{ hasReading: boolean, fresh: boolean, ageMs: number|null }`), and `reset()` (returns undefined). Also exports `const STALE_AFTER_MS = 3000`.

- [ ] **Step 1: Write the failing test**

Create `test/freshness.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { Freshness, STALE_AFTER_MS } from '../public/js/freshness.js';

/** A clock the test drives by hand, so no timers are involved. */
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('reports no reading before the first mark', () => {
  const f = new Freshness({ now: fakeClock().now });
  assert.deepEqual(f.state(), { hasReading: false, fresh: false, ageMs: null });
});

test('a just-marked reading is fresh with zero age', () => {
  const clock = fakeClock();
  const f = new Freshness({ now: clock.now });
  f.mark();
  assert.deepEqual(f.state(), { hasReading: true, fresh: true, ageMs: 0 });
});

test('stays fresh right up to the threshold', () => {
  const clock = fakeClock();
  const f = new Freshness({ staleAfterMs: 3000, now: clock.now });
  f.mark();
  clock.advance(2999);
  assert.equal(f.state().fresh, true);
});

test('goes stale at the threshold', () => {
  const clock = fakeClock();
  const f = new Freshness({ staleAfterMs: 3000, now: clock.now });
  f.mark();
  clock.advance(3000);
  const state = f.state();
  assert.equal(state.fresh, false);
  assert.equal(state.ageMs, 3000);
});

test('a new reading restores freshness', () => {
  const clock = fakeClock();
  const f = new Freshness({ staleAfterMs: 3000, now: clock.now });
  f.mark();
  clock.advance(10000);
  assert.equal(f.state().fresh, false);
  f.mark();
  assert.deepEqual(f.state(), { hasReading: true, fresh: true, ageMs: 0 });
});

test('reset clears the reading entirely', () => {
  const clock = fakeClock();
  const f = new Freshness({ now: clock.now });
  f.mark();
  f.reset();
  assert.deepEqual(f.state(), { hasReading: false, fresh: false, ageMs: null });
});

test('defaults to a three second threshold', () => {
  assert.equal(STALE_AFTER_MS, 3000);
  const clock = fakeClock();
  const f = new Freshness({ now: clock.now });
  f.mark();
  clock.advance(3000);
  assert.equal(f.state().fresh, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module` for `../public/js/freshness.js`.

- [ ] **Step 3: Write minimal implementation**

Create `public/js/freshness.js`:

```javascript
/**
 * How long a reading stays believable.
 *
 * The phone loses the LAN exactly where the survey gets interesting -- you walk
 * into the dead zone you were hunting and Android falls back to cellular. The
 * EventSource reconnects on its own, but until it does the last number on screen
 * is a lie. This tracks how old that number is so the UI can say so.
 *
 * Pure time arithmetic: the clock is injected, nothing here touches the DOM or
 * owns a timer. Callers decide when to ask.
 */

export const STALE_AFTER_MS = 3000;

export class Freshness {
  #staleAfterMs;
  #now;
  #markedAt = null;

  constructor({ staleAfterMs = STALE_AFTER_MS, now = () => Date.now() } = {}) {
    this.#staleAfterMs = staleAfterMs;
    this.#now = now;
  }

  /** Record that a reading just arrived. */
  mark() {
    this.#markedAt = this.#now();
  }

  reset() {
    this.#markedAt = null;
  }

  state() {
    if (this.#markedAt == null) return { hasReading: false, fresh: false, ageMs: null };

    const ageMs = this.#now() - this.#markedAt;
    return { hasReading: true, fresh: ageMs < this.#staleAfterMs, ageMs };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all 7 new tests, plus the existing suites still green.

- [ ] **Step 5: Commit**

```bash
git add public/js/freshness.js test/freshness.test.js
git commit -m "Add Freshness: tracks how old the displayed reading is"
```

---

### Task 2: Configurable meter scale

`PixelMeter` hardcodes `const scale = 13` at `meter.js:57`, so enlarging the canvas alone does not enlarge the digits. Walk mode needs bigger digits, so scale becomes a constructor option. Default preserved, so the live view is untouched.

**Files:**
- Modify: `public/js/render/meter.js:26-31` (constructor), `meter.js:57` (the hardcoded scale)

**Interfaces:**
- Consumes: nothing.
- Produces: `new PixelMeter(canvas, { width = 464, height = 208, scale = 13 } = {})`. The `scale` option sets the pixel size of the large dBm digits. `render(state)` is unchanged.

- [ ] **Step 1: Add the constructor option**

In `public/js/render/meter.js`, add a `#scale` field alongside the existing private fields and accept it in the constructor:

```javascript
export class PixelMeter {
  #canvas;
  #width;
  #height;
  #scale;
  #ghost = null; // previous rendered value, drawn faintly behind the current one

  constructor(canvas, { width = 464, height = 208, scale = 13 } = {}) {
    this.#canvas = canvas;
    this.#width = width;
    this.#height = height;
    this.#scale = scale;
  }
```

- [ ] **Step 2: Use it in render**

Replace the hardcoded line (`const scale = 13;`) with:

```javascript
    const scale = this.#scale;
```

- [ ] **Step 3: Verify the live view is visually unchanged**

Run: `npm start`, open `http://localhost:3000`, confirm the LIVE view readout looks exactly as before. The default of 13 means this is a no-op refactor for existing callers.

- [ ] **Step 4: Commit**

```bash
git add public/js/render/meter.js
git commit -m "PixelMeter: make the big-value scale configurable"
```

---

### Task 3: The walk view

**Files:**
- Create: `public/js/views/walk.js`
- Modify: `public/css/pixel.css` (append a walk mode section)

**Interfaces:**
- Consumes: `PixelMeter` and `Sparkline` from `../render/meter.js`; `Freshness` from `../freshness.js`; `el` and `clear` from `../dom.js`.
- Produces: `createWalkView(root, context)` returning `{ update(reading) }`, matching the contract `createLiveView` already uses. No teardown method: `app.js` builds every view once at startup and toggles them with CSS, so views live for the page lifetime and a `destroy()` would be dead code.

- [ ] **Step 1: Write the view**

Create `public/js/views/walk.js`:

```javascript
import { el } from '../dom.js';
import { PixelMeter, Sparkline } from '../render/meter.js';
import { Freshness } from '../freshness.js';

/**
 * The phone view: one number, big enough to read at arm's length while walking.
 *
 * A phone cannot measure WiFi -- no browser exposes RSSI -- so every figure here
 * belongs to the daemon host. That makes staleness the thing worth designing
 * around: when the phone drops off the LAN, the last reading must stop claiming
 * to be current. It dims and starts counting its own age instead.
 */

const TICK_MS = 500;

export function createWalkView(root) {
  const meterCanvas = el('canvas');
  const sparkCanvas = el('canvas');
  const statusEl = el('p', { class: 'walk-status', role: 'status', 'aria-live': 'polite' });

  const wrap = el(
    'div',
    { class: 'walk' },
    el('div', { class: 'walk-meter' }, meterCanvas),
    el('div', { class: 'walk-spark' }, sparkCanvas),
    statusEl,
  );
  root.append(wrap);

  let meter = null;
  let spark = null;
  let lastReading = null;
  let builtWidth = 0;
  const freshness = new Freshness();

  /**
   * Sized to the viewport so the digits are as large as the screen allows.
   *
   * Driven by a ResizeObserver rather than measured at construction: the app
   * shell builds every view before mounting it, and a hidden view has zero
   * width, so measuring here at startup would pick the fallback on every load
   * on every device. The observer fires when the element actually gains layout,
   * which covers becoming visible and the window resizing in one mechanism.
   */
  function build(width) {
    const w = Math.max(280, Math.floor(width));
    if (w === builtWidth) return;
    builtWidth = w;

    // Scale the digits to the width; 13 is the desktop default at 464px.
    const scale = Math.max(8, Math.floor((w / 464) * 13));
    // Snapped to the 8px grid the rest of the layout sits on.
    const height = Math.round((w * 0.45) / 8) * 8;

    const kept = spark;
    meter = new PixelMeter(meterCanvas, { width: w, height, scale });
    spark = new Sparkline(sparkCanvas, { width: w, height: 96, capacity: Math.floor(w / 4) });
    // Carry history across a rebuild rather than losing the walk so far.
    if (kept) for (const v of kept.values) spark.push(v);
    draw();
  }

  function draw() {
    // Nothing to draw until the element has had a width, and so a renderer.
    if (!meter || !spark) return;

    const { hasReading, fresh, ageMs } = freshness.state();

    if (!hasReading || !lastReading?.ok) {
      meter.render({ connected: false, message: lastReading?.error ?? 'WAITING FOR DAEMON' });
      spark.render();
      statusEl.textContent = 'NO READING';
      wrap.dataset.stale = 'false';
      return;
    }

    meter.render({
      rssi: lastReading.filtered ?? lastReading.rssi,
      bandLabel: lastReading.bandLabel,
      quality: lastReading.quality,
      exact: lastReading.exact !== false,
      connected: true,
    });
    spark.render();

    wrap.dataset.stale = String(!fresh);
    statusEl.textContent = fresh
      ? `LIVE${lastReading.interface ? ` · ${lastReading.interface}` : ''}`
      : `STALE ${Math.floor(ageMs / 1000)}S · RECONNECTING`;
  }

  const observer = new ResizeObserver(([entry]) => {
    const { width } = entry.contentRect;
    if (width > 0) build(width);
  });
  observer.observe(wrap);

  const tick = setInterval(draw, TICK_MS);

  return {
    update(reading) {
      lastReading = reading;
      if (reading?.ok) {
        freshness.mark();
        spark.push(reading.smoothed ?? reading.rssi);
      } else {
        freshness.reset();
      }
      draw();
    },
  };
}
```

The `tick` interval and the ResizeObserver are deliberately never torn down — see the interface note above.

- [ ] **Step 2: Expose sparkline values so a resize does not lose history**

The view above reads `kept.values`. `Sparkline` keeps `#values` private, so add a read-only getter in `public/js/render/meter.js`, next to the existing `push`/`clear`/`render` methods:

```javascript
  /** Read-only copy, so a rebuilt sparkline can inherit the walk so far. */
  get values() {
    return [...this.#values];
  }
```

- [ ] **Step 3: Add the CSS**

Append to `public/css/pixel.css`:

```css
/* ---------- walk mode ---------- */

.walk {
  display: flex;
  flex-direction: column;
  gap: var(--u);
  align-items: center;
}

.walk-meter,
.walk-spark {
  width: 100%;
  display: flex;
  justify-content: center;
}

.walk-status {
  margin: 0;
  padding: var(--u);
  width: 100%;
  text-align: center;
  background: var(--lcd-3);
  border: var(--border) solid var(--lcd-0);
}

/* Stale readings dim, so an old number never passes for a current one. */
.walk[data-stale='true'] .walk-meter,
.walk[data-stale='true'] .walk-spark {
  opacity: 0.4;
}

.walk[data-stale='true'] .walk-status {
  background: var(--lcd-1);
  color: var(--lcd-3);
}
```

- [ ] **Step 4: Commit**

```bash
git add public/js/views/walk.js public/js/render/meter.js public/css/pixel.css
git commit -m "Add walk view: large readout with stale treatment"
```

---

### Task 4: Wire the walk view into the shell

Two changes in `app.js`. The stream currently reaches only the `live` view (`app.js:113`), and the default view is always `VIEWS[0]`.

**Files:**
- Modify: `public/js/app.js`

**Interfaces:**
- Consumes: `createWalkView` from `./views/walk.js`; `state.client.isHostMachine`, already populated by `clientProfile()` at `app.js:22`.
- Produces: a `walk` entry in `VIEWS`; stream readings delivered to every view exposing `update`.

- [ ] **Step 1: Import and register the view**

Add the import alongside the existing view imports:

```javascript
import { createWalkView } from './views/walk.js';
```

Then put `walk` first in `VIEWS`, so its tab leads:

```javascript
const VIEWS = [
  { id: 'walk', label: 'WALK', create: createWalkView },
  { id: 'live', label: 'LIVE', create: createLiveView },
  { id: 'platform', label: 'PLATFORM', create: createPlatformView },
];
```

- [ ] **Step 2: Route the stream to every view**

Replace the hardcoded `live` lookup in `start()`:

```javascript
  stream.on('wifi', (reading) => {
    // Every view that consumes readings gets them; PLATFORM has no update and
    // is skipped by the optional call.
    for (const { api } of state.views.values()) api.update?.(reading);
    state.companion.update(reading);
  });
```

- [ ] **Step 3: Default to walk mode off the host machine**

Replace the initial mount so localhost keeps today's behaviour and a phone lands on WALK. An explicit hash still wins:

```javascript
  const initial = location.hash.slice(1);
  const fallback = state.client.isHostMachine ? 'live' : 'walk';
  mount(VIEWS.some((v) => v.id === initial) ? initial : fallback);
```

- [ ] **Step 4: Verify on the host machine**

Run: `npm start`, open `http://localhost:3000` with no hash.
Expected: LIVE is the mounted view, unchanged from before. A WALK tab is present and switches correctly.

- [ ] **Step 5: Verify from a phone**

Open the printed network URL on an Android phone on the same WiFi.
Expected: WALK is the default view; the dBm number fills the screen width; disabling WiFi on the phone dims it and shows `STALE Ns · RECONNECTING`; re-enabling restores `LIVE`.

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js
git commit -m "Default to walk mode when the page is not on the host machine"
```

---

### Task 5: Keeping the screen awake

The Wake Lock API is secure-context-only, so `navigator.wakeLock` does not exist at `http://192.168.1.14:3000`. This degrades through three mechanisms and is honest about which one it got. The video fallback needs a user gesture, hence an explicit toggle rather than an autoplay fight.

**Files:**
- Create: `public/js/wakelock.js`
- Modify: `public/js/views/walk.js` (add the toggle)

**Interfaces:**
- Consumes: nothing.
- Produces: `createWakeLock({ onChange } = {})` returning `{ enable(): Promise<string>, disable(): void, get mechanism(): string|null }`. `enable()` resolves to the mechanism actually obtained: `'wakelock'`, `'video'`, or `'none'`. `mechanism` is `null` whenever nothing is held — `'none'` is an outcome `enable()` reports, never a state the object rests in, so `mechanism` can be tested for truth without a failed attempt reading as success. `onChange(mechanism)` fires on every transition, including an involuntary downgrade to `null` when a lock cannot be re-acquired after the tab was hidden.

- [ ] **Step 1: Write the module**

Create `public/js/wakelock.js`:

```javascript
/**
 * Keeping a phone screen on during a walk.
 *
 * The Wake Lock API is secure-context-only, so it is absent at
 * http://192.168.1.14:3000 -- exactly the URL this tool tells you to open. The
 * fallback is a muted looping video, which browsers do treat as active playback
 * over plain HTTP, but which needs a user gesture to start. Hence a toggle: one
 * tap, and the UI reports which mechanism it actually got rather than pretending.
 */

export function createWakeLock({ onChange = () => {} } = {}) {
  let sentinel = null;
  let video = null;
  let mechanism = null;
  let pending = null;

  // `mechanism` is null whenever nothing is actually held. 'none' is an
  // outcome that enable() reports, never a state the object sits in -- so
  // callers can test `mechanism` for truth without a failed attempt reading
  // as success.
  function setMechanism(next) {
    if (mechanism === next) return;
    mechanism = next;
    onChange(next);
  }

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
  // avoids shipping a binary asset for the sake of a fallback. The play()
  // promise is awaited rather than fired and forgotten: reporting 'video'
  // before playback is confirmed would claim a screen hold that never started.
  async function startVideo() {
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

      await video.play();
      return true;
    } catch {
      video?.remove();
      video = null;
      return false;
    }
  }

  // The sentinel is released whenever the tab hides; take it again on return.
  // If that re-acquisition fails, the hold is genuinely gone -- downgrade so
  // the UI stops claiming it rather than pointing at a released sentinel.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (mechanism !== 'wakelock' || !sentinel?.released) return;

    if (!(await requestNative())) {
      sentinel = null;
      setMechanism(null);
    }
  });

  return {
    /** Resolves to the mechanism obtained: 'wakelock', 'video', or 'none'. */
    async enable() {
      // A second tap while the first attempt is in flight must not start a
      // rival mechanism and orphan the first one.
      if (pending) return pending;

      pending = (async () => {
        if (await requestNative()) setMechanism('wakelock');
        else if (await startVideo()) setMechanism('video');
        else setMechanism(null);
        return mechanism ?? 'none';
      })();

      try {
        return await pending;
      } finally {
        pending = null;
      }
    },

    disable() {
      sentinel?.release?.();
      sentinel = null;
      video?.remove();
      video = null;
      setMechanism(null);
    },

    get mechanism() {
      return mechanism;
    },
  };
}
```

- [ ] **Step 2: Add the toggle to the walk view**

In `public/js/views/walk.js`, add the import:

```javascript
import { createWakeLock } from '../wakelock.js';
```

Add the button and its wiring inside `createWalkView`, after `root.append(wrap)`:

```javascript
  const wakeBtn = el('button', { class: 'btn walk-wake', type: 'button', text: 'KEEP AWAKE', 'aria-pressed': 'false' });
  const wakeNote = el('p', { class: 'note walk-wake-note' });
  wrap.append(wakeBtn, wakeNote);

  const WAKE_LABEL = {
    wakelock: 'SCREEN HELD AWAKE.',
    video: 'SCREEN HELD AWAKE VIA VIDEO FALLBACK (PLAIN HTTP).',
    none: 'CANNOT HOLD THE SCREEN AWAKE HERE. RESTART WITH --HTTPS, OR RAISE YOUR PHONE SCREEN TIMEOUT.',
  };

  // Every button state change goes through here, including a downgrade the
  // user did not ask for -- if the lock is lost on returning to the tab, both
  // the button and the note must stop saying it is held.
  function showWakeState(mechanism) {
    const held = mechanism != null;
    wakeBtn.textContent = held ? 'AWAKE ON' : 'KEEP AWAKE';
    wakeBtn.setAttribute('aria-pressed', String(held));
    wakeNote.textContent = held ? WAKE_LABEL[mechanism] : '';
  }

  const wakeLock = createWakeLock({ onChange: showWakeState });

  wakeBtn.addEventListener('click', async () => {
    if (wakeLock.mechanism) {
      wakeLock.disable();
      wakeNote.textContent = '';
      return;
    }
    const got = await wakeLock.enable();
    // 'none' never becomes a mechanism, so onChange does not fire for it.
    if (got === 'none') wakeNote.textContent = WAKE_LABEL.none;
  });
```

The lock needs no teardown hook: the walk view lives for the page lifetime, the toggle releases it on a second tap, and closing the tab releases it automatically.

- [ ] **Step 3: Verify on the host machine**

Run: `npm start`, open `http://localhost:3000/#walk`, tap KEEP AWAKE.
Expected: the note reads `SCREEN HELD AWAKE.` — localhost is a secure context, so the native API is used.

- [ ] **Step 4: Verify on an Android phone over plain HTTP**

Open the network URL on the phone, tap KEEP AWAKE, then leave the phone untouched past its normal screen timeout.

Expected: the note reads the video-fallback message and the screen stays on.

If the screen still sleeps, the canvas-capture stream is not counting as playback on that device. Record the finding and change `startVideo()` to use a real muted looping asset: add a small silent `.webm` to `public/`, set `video.src` to it instead of `srcObject`, and add `"public"` coverage in the `files` whitelist (already present). Do not leave a fallback in place that does not work — if neither mechanism holds, make `enable()` return `'none'` so the honest advisory shows instead.

- [ ] **Step 5: Commit**

```bash
git add public/js/wakelock.js public/js/views/walk.js
git commit -m "Add KEEP AWAKE toggle with wake lock, video fallback and honest advisory"
```

---

### Task 6: Correct the capability guards

Both bugs are the same shape: a secure-context-gated API reported as available over plain HTTP, producing a misleading reason string.

**Files:**
- Modify: `public/js/capabilities.js:46` and `capabilities.js:55`

**Interfaces:**
- Consumes: the existing `secure` local in `detectClientFeatures()`.
- Produces: `webBluetooth` and `wakeLock` in the returned features object now false over plain HTTP.

- [ ] **Step 1: Guard both fields**

In `detectClientFeatures()`, change the two lines:

```javascript
    webBluetooth: typeof navigator.bluetooth?.requestDevice === 'function' && secure,
```

```javascript
    wakeLock: 'wakeLock' in navigator && secure,
```

- [ ] **Step 2: Give the insecure case the right reason**

In `unavailableReason()`, add both features to the secure-context branch so an Android Chrome user on plain HTTP is told the actual cause rather than "this browser has no Web Bluetooth":

```javascript
  if (
    !features.secureContext &&
    ['camera', 'magnetometer', 'geolocation', 'webBluetooth', 'wakeLock'].includes(feature)
  ) {
    return 'Browsers block this over plain HTTP. Restart the daemon with --https, or open Signal Boy at localhost on the host machine.';
  }
```

- [ ] **Step 3: Verify**

Open the network URL on a phone, go to the PLATFORM tab.
Expected: `WEB BLUETOOTH` reads `NO`, and the explanatory note names plain HTTP as the cause rather than the browser.

- [ ] **Step 4: Commit**

```bash
git add public/js/capabilities.js
git commit -m "Report secure-context APIs as blocked by HTTP, not by the browser"
```

---

### Task 7: QR code for the network URL

Nobody wants to type `http://192.168.1.14:3000` on a phone keyboard. The daemon prints a scannable QR alongside the URL it already prints.

Written in-house to preserve the zero-dependency property. **Four facts make this far smaller than a general QR encoder**, and the implementation should exploit all of them rather than building the general case:

1. Only **byte mode** is needed — URLs are arbitrary ASCII.
2. Only **error correction level L** and **versions 1-4** are needed. A URL like `https://192.168.100.100:3000` is 28 bytes; version 2 holds 32 and version 4 holds 78.
3. **At level L, versions 1-4 each use exactly one error-correction block.** Data/ECC interleaving — normally the fiddliest part — is therefore not required at all. Just data codewords followed by EC codewords.
4. **Version info blocks are only present from version 7.** Versions 1-4 need none. Format info bits are still required.

Block structure, all single-block at level L:

| Version | Modules | Data codewords | EC codewords | Byte capacity | Alignment pattern |
|---|---|---|---|---|---|
| 1 | 21x21 | 19 | 7 | 17 | none |
| 2 | 25x25 | 34 | 10 | 32 | (18,18) |
| 3 | 29x29 | 55 | 15 | 53 | (22,22) |
| 4 | 33x33 | 80 | 20 | 78 | (26,26) |

The byte-mode character count indicator is 8 bits for versions 1-9, so it is uniform across all four.

**Files:**
- Create: `server/qr/galois.js`, `server/qr/encode.js`, `server/qr/matrix.js`, `server/qr/terminal.js`, `server/qr/index.js`
- Create: `test/qr-galois.test.js`, `test/qr-encode.test.js`, `test/qr-matrix.test.js`
- Create: `test/fixtures/qr-golden.json`
- Modify: `server/index.js` (the URL banner)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `galois.js`: `exp(n)`, `log(n)`, `mul(a, b)` over GF(256) with primitive polynomial 0x11d; `generatorPoly(degree)` returning `number[]`; `remainder(data, degree)` returning the EC codewords as `number[]`.
  - `encode.js`: `pickVersion(byteLength)` returning `{ version, dataCodewords, ecCodewords, size }` or throwing on overflow; `toCodewords(text)` returning `number[]` of data-plus-EC codewords.
  - `matrix.js`: `buildMatrix(codewords, version)` returning `boolean[][]` with the best mask applied.
  - `index.js`: `encodeQr(text)` returning `boolean[][]`, `true` meaning a dark module.
  - `terminal.js`: `renderQr(matrix, { quietZone = 4 })` returning a printable string.

- [ ] **Step 1: Establish the golden fixture**

The encoder needs a known-good target, and the project has no QR reference. Generate one **once** from an independent implementation, in the scratchpad so it never touches the repo as a dependency:

```bash
cd /private/tmp/claude-501/-Users-suryansh-Documents-Projects-Tracker-public/98442697-a2e3-4e7a-9f5b-94c8f2033322/scratchpad
npx --yes qrcode --output-format=terminal "http://192.168.1.14:3000" > golden.txt
cat golden.txt
```

Scan `golden.txt` with a phone to confirm it resolves to the URL, then transcribe the module matrix into `test/fixtures/qr-golden.json` as `{ "text": "http://192.168.1.14:3000", "version": 2, "modules": [[0,1,...], ...] }` using 1 for dark.

This fixture is committed and depended on forever; the `npx` tool is used once and never added to `package.json`.

- [ ] **Step 2: Write the failing Galois field tests**

Create `test/qr-galois.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { exp, log, mul, generatorPoly, remainder } from '../server/qr/galois.js';

test('exp and log are inverses across the field', () => {
  for (let i = 1; i < 255; i++) assert.equal(log(exp(i)), i);
});

test('multiplication by zero is zero', () => {
  assert.equal(mul(0, 123), 0);
  assert.equal(mul(123, 0), 0);
});

test('multiplication by one is identity', () => {
  assert.equal(mul(1, 123), 123);
});

test('multiplication matches known GF(256) products', () => {
  // Standard results for the QR primitive polynomial 0x11d.
  assert.equal(mul(2, 2), 4);
  assert.equal(mul(0x80, 2), 0x1d);
});

test('generator polynomial has the expected degree and leading coefficient', () => {
  const g = generatorPoly(10);
  assert.equal(g.length, 11);
  assert.equal(g[0], 1);
});

test('remainder produces the requested number of EC codewords', () => {
  const ec = remainder([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236], 10);
  assert.equal(ec.length, 10);
  assert.ok(ec.every((b) => b >= 0 && b <= 255));
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../server/qr/galois.js'`.

- [ ] **Step 4: Implement the field arithmetic**

Create `server/qr/galois.js`:

```javascript
/**
 * GF(256) arithmetic for QR Reed-Solomon error correction.
 *
 * Every byte except zero is a power of 2 in this field, so multiplication
 * becomes addition of logarithms and the whole thing reduces to two 256-entry
 * tables built once at module load. The primitive polynomial 0x11d is fixed by
 * the QR specification.
 */

const PRIMITIVE = 0x11d;

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIMITIVE;
  }
  EXP[255] = EXP[0];
}

export function exp(n) {
  return EXP[n % 255];
}

export function log(n) {
  if (n === 0) throw new RangeError('log(0) is undefined in GF(256)');
  return LOG[n];
}

export function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

/** The generator polynomial whose roots are a^0 .. a^(degree-1). */
export function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], exp(i));
    }
    poly = next;
  }
  return poly;
}

/** Polynomial long division; the remainder is the EC codeword block. */
export function remainder(data, degree) {
  const gen = generatorPoly(degree);
  const buf = [...data, ...new Array(degree).fill(0)];

  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], coef);
  }

  return buf.slice(data.length);
}
```

- [ ] **Step 5: Run to verify the field tests pass**

Run: `npm test`
Expected: PASS for all six Galois tests.

- [ ] **Step 6: Commit the field layer**

```bash
git add server/qr/galois.js test/qr-galois.test.js
git commit -m "Add GF(256) arithmetic and Reed-Solomon remainder for QR"
```

- [ ] **Step 7: Write the failing encoder tests**

Create `test/qr-encode.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { pickVersion, toCodewords } from '../server/qr/encode.js';

test('picks the smallest version that fits', () => {
  assert.equal(pickVersion(10).version, 1);
  assert.equal(pickVersion(17).version, 1);
  assert.equal(pickVersion(18).version, 2);
  assert.equal(pickVersion(32).version, 2);
  assert.equal(pickVersion(53).version, 3);
  assert.equal(pickVersion(78).version, 4);
});

test('version metadata matches the level L single-block table', () => {
  assert.deepEqual(pickVersion(32), {
    version: 2,
    dataCodewords: 34,
    ecCodewords: 10,
    size: 25,
  });
});

test('refuses input too long for version 4', () => {
  assert.throws(() => pickVersion(79), /too long/i);
});

test('produces a full codeword block of data plus error correction', () => {
  const words = toCodewords('http://192.168.1.14:3000');
  // Version 2 at level L: 34 data + 10 EC.
  assert.equal(words.length, 44);
  assert.ok(words.every((b) => b >= 0 && b <= 255));
});

test('starts with the byte-mode indicator and length', () => {
  const text = 'HI';
  const words = toCodewords(text);
  // Mode 0100 then an 8-bit length: 0100 0000 0010 ....
  assert.equal(words[0], 0x40 | (text.length >> 4));
  assert.equal(words[1], ((text.length & 0x0f) << 4) | ('H'.charCodeAt(0) >> 4));
});

test('pads with the alternating pad bytes', () => {
  const words = toCodewords('HI');
  // Version 1 at level L is 19 data codewords; the tail must alternate.
  assert.equal(words[17], 0x11);
  assert.equal(words[18], 0xec);
});
```

- [ ] **Step 8: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../server/qr/encode.js'`.

- [ ] **Step 9: Implement the encoder**

Create `server/qr/encode.js`:

```javascript
import { remainder } from './galois.js';

/**
 * Byte-mode QR data encoding at error correction level L.
 *
 * Restricted to versions 1-4 deliberately: a LAN URL never exceeds 78 bytes,
 * and at level L those four versions each use a single error-correction block.
 * That removes data/ECC interleaving entirely -- the codeword stream is simply
 * the data block followed by its remainder.
 */

const VERSIONS = [
  { version: 1, dataCodewords: 19, ecCodewords: 7, size: 21 },
  { version: 2, dataCodewords: 34, ecCodewords: 10, size: 25 },
  { version: 3, dataCodewords: 55, ecCodewords: 15, size: 29 },
  { version: 4, dataCodewords: 80, ecCodewords: 20, size: 33 },
];

const PAD_BYTES = [0xec, 0x11];

/** Smallest version holding `byteLength` bytes, allowing 2 codewords of overhead. */
export function pickVersion(byteLength) {
  // Mode indicator (4 bits) + length (8 bits) = 12 bits, plus a 4-bit
  // terminator, rounds to 2 codewords of overhead.
  const found = VERSIONS.find((v) => byteLength + 2 <= v.dataCodewords);
  if (!found) throw new RangeError(`Text too long for a version 4 QR code: ${byteLength} bytes`);
  return { ...found };
}

export function toCodewords(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const spec = pickVersion(bytes.length);

  const bits = [];
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // count indicator is 8 bits for versions 1-9
  for (const b of bytes) push(b, 8);

  // Terminator, up to four zero bits, then pad to a byte boundary.
  const capacityBits = spec.dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  // Alternating pad bytes fill the remaining capacity.
  while (data.length < spec.dataCodewords) data.push(PAD_BYTES[data.length % 2 === 0 ? 0 : 1]);

  return [...data, ...remainder(data, spec.ecCodewords)];
}
```

Note on the pad-byte order, worked through so you do not have to: for the 2-byte input `"HI"`, `pickVersion(2)` gives version 1 with 19 data codewords. The bit stream is `0100` + `00000010` + `01001000` + `01001001` + a 4-bit terminator = 32 bits = 4 bytes `[0x40, 0x24, 0x84, 0x90]`. Padding then starts at index 4, and since `4 % 2 === 0` the first pad byte is `0xec`, as the specification requires. Even indices take `0xec` and odd indices `0x11` from there, so index 17 is `0x11` and index 18 is `0xec`. The test assertions and the implementation agree; if you observe otherwise, the bug is real — do not adjust the test to match.

- [ ] **Step 10: Run to verify the encoder tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 11: Commit the encoder**

```bash
git add server/qr/encode.js test/qr-encode.test.js
git commit -m "Add byte-mode QR data encoding for versions 1-4"
```

- [ ] **Step 12: Write the failing matrix test against the golden fixture**

Create `test/qr-matrix.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { encodeQr } from '../server/qr/index.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/qr-golden.json', import.meta.url), 'utf8'),
);

test('reproduces the golden matrix exactly', () => {
  const matrix = encodeQr(golden.text);
  const asInts = matrix.map((row) => row.map((cell) => (cell ? 1 : 0)));
  assert.deepEqual(asInts, golden.modules);
});

test('matrix is square and sized for its version', () => {
  const matrix = encodeQr(golden.text);
  assert.equal(matrix.length, 25); // version 2
  for (const row of matrix) assert.equal(row.length, 25);
});

test('finder patterns sit in three corners', () => {
  const m = encodeQr(golden.text);
  const n = m.length;
  // Each finder is a 7x7 block with a dark border and a 3x3 dark centre.
  for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.equal(m[r][c], true);
    assert.equal(m[r + 3][c + 3], true);
    assert.equal(m[r + 1][c + 1], false);
  }
  // The fourth corner must NOT have one.
  assert.equal(m[n - 1][n - 1], false);
});
```

- [ ] **Step 13: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../server/qr/index.js'`.

- [ ] **Step 14: Implement matrix construction and masking**

Create `server/qr/matrix.js` implementing, in this order:

1. **Function patterns.** Three 7x7 finders at the top-left, top-right and bottom-left, each with a one-module light separator. Timing patterns: alternating modules along row 6 and column 6. One alignment pattern (5x5) at the version's centre coordinate from the table above — versions 2, 3 and 4 only. The dark module at `(4 * version + 9, 8)`, always dark.
2. **Reserved areas.** Format information occupies the modules around the finders; reserve them before laying data so the data walk skips them.
3. **Data placement.** Walk two columns at a time from the bottom-right leftwards, skipping column 6 (the vertical timing pattern), alternating upward and downward, placing bits into every non-function module.
4. **Masking.** Apply each of the eight mask patterns to the data modules only, score each with the four penalty rules (N1 = 3 for each run of 5+ same-colour modules plus 1 per extra; N2 = 3 per 2x2 same-colour block; N3 = 40 per finder-like 1:1:3:1:1 pattern; N4 = 10 per 5% deviation from an even dark/light split), and keep the lowest-scoring result.
5. **Format information.** 15 bits: 2 bits of EC level (01 for L), 3 bits of mask number, BCH(15,5) error correction, XORed with `0x5412`. Written twice, around the top-left finder and split across the other two.

No version information block is written — that begins at version 7.

Create `server/qr/index.js`:

```javascript
import { pickVersion, toCodewords } from './encode.js';
import { buildMatrix } from './matrix.js';

/**
 * Encodes text as a QR matrix. `true` is a dark module.
 *
 * Byte mode, error correction level L, versions 1-4 -- enough for any LAN URL
 * and small enough to print in a terminal without wrapping.
 */
export function encodeQr(text) {
  const { version } = pickVersion([...new TextEncoder().encode(text)].length);
  return buildMatrix(toCodewords(text), version);
}
```

- [ ] **Step 15: Run until the golden matrix matches**

Run: `npm test`
Expected: PASS. If the matrix differs from the fixture, the mismatch is almost always one of: the data walk skipping column 6, the mask penalty scoring, or the format-info bit order. Compare row by row against the fixture to localise it.

- [ ] **Step 16: Commit the matrix layer**

```bash
git add server/qr/matrix.js server/qr/index.js test/qr-matrix.test.js test/fixtures/qr-golden.json
git commit -m "Add QR matrix construction, masking and format info"
```

- [ ] **Step 17: Render to the terminal**

Create `server/qr/terminal.js`:

```javascript
/**
 * Renders a QR matrix as text.
 *
 * Half-block characters put two matrix rows in one terminal row, which keeps a
 * version 2 code at 13 lines instead of 25 -- small enough to sit in the startup
 * banner without scrolling it away.
 *
 * Colours are written explicitly rather than inherited: scanners need dark
 * modules on a light background, and most terminals are dark. The quiet zone is
 * four modules, as the specification requires -- without it, many scanners will
 * not lock on.
 */

const UPPER = '▀'; // upper half block
const RESET = '[0m';
const LIGHT_BG = '[47m'; // white background
const DARK_FG = '[30m'; // black foreground

export function renderQr(matrix, { quietZone = 4 } = {}) {
  const n = matrix.length;
  const size = n + quietZone * 2;
  const at = (r, c) => {
    const y = r - quietZone;
    const x = c - quietZone;
    return y >= 0 && y < n && x >= 0 && x < n ? matrix[y][x] : false;
  };

  const lines = [];
  for (let r = 0; r < size; r += 2) {
    let line = LIGHT_BG + DARK_FG;
    for (let c = 0; c < size; c++) {
      const top = at(r, c);
      const bottom = r + 1 < size ? at(r + 1, c) : false;
      // The cell background is light, so an unset half stays light.
      if (top && bottom) line += '█';
      else if (top) line += UPPER;
      else if (bottom) line += '▄';
      else line += ' ';
    }
    lines.push(line + RESET);
  }
  return lines.join('\n');
}
```

- [ ] **Step 18: Print it in the startup banner**

In `server/index.js`, where the network URL is printed, add the QR beneath it. Import at the top:

```javascript
import { encodeQr } from './qr/index.js';
import { renderQr } from './qr/terminal.js';
```

Then after the network URL line, print the code for the first LAN address:

```javascript
  const [primary] = lanAddresses();
  if (primary) {
    const url = `${USE_HTTPS ? 'https' : 'http'}://${primary.address}:${server.address()?.port ?? PORT}`;
    console.log('\n  Scan to open on your phone:\n');
    console.log(renderQr(encodeQr(url)));
  }
```

- [ ] **Step 19: Verify by scanning**

Run: `npm start`. Point an Android phone camera at the terminal.

Expected: the phone offers to open the network URL, and opening it lands on walk mode. If the camera will not lock on, the usual causes are a missing quiet zone, a terminal font with non-square character cells, or a colour scheme overriding the explicit background — try widening the terminal or increasing its font size before suspecting the encoder, since the golden-matrix test already proves the modules are correct.

- [ ] **Step 20: Commit**

```bash
git add server/qr/terminal.js server/index.js
git commit -m "Print a scannable QR code for the network URL at startup"
```

---

### Task 8: First npm release

Everything here was verified against the registry before the plan was written: `signalboy` is unclaimed, `npm pack --dry-run` is already clean at 31 files / 39.8 kB, and the shebang is present at `bin/signalboy.js:1`.

**Files:**
- Modify: `package.json`, `README.md`

**Interfaces:**
- Consumes: the finished walk mode and QR code from Tasks 1-7.
- Produces: `signalboy@0.1.0` on the public registry.

- [ ] **Step 1: Add the missing package metadata**

npm warns without these, and `repository` is what wires up provenance later. Add to `package.json` after `homepage`:

```json
  "author": "Suryansh",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Suryansh-Codes2209/Signal-Boy.git"
  },
  "bugs": {
    "url": "https://github.com/Suryansh-Codes2209/Signal-Boy/issues"
  },
```

These URLs were read from `git remote -v` at planning time. Note the repository is
`Signal-Boy` while the npm package is `signalboy` — that mismatch is intentional
and both spellings are correct in their own context.

- [ ] **Step 2: Document walk mode in the README**

In the "Phones, and the `--https` flag" section, add after the first paragraph:

```markdown
You do not have to type that address. Signal Boy prints a QR code for it at
startup — point your phone camera at the terminal.

Open the network URL on a phone and Signal Boy defaults to **walk mode**: the
dBm value sized to the screen, the history strip, and nothing else. When the
phone drops off the WiFi the reading dims and starts counting its own age
rather than presenting a stale number as current. A `KEEP AWAKE` button holds
the screen on for the length of a survey.
```

- [ ] **Step 3: Correct the survey description**

The current step 3 under "How you use it" says the phone lets you "carry the number around while the laptop stays put." That is backwards: a stationary laptop reports a constant signal. Replace that step with:

```markdown
**3. Open the network URL on your phone.** Same data, served off your laptop, in
a display sized for walking. Carry the laptop — it holds the radio doing the
measuring — and read the phone. Both devices must be on the same WiFi.
```

- [ ] **Step 4: Verify the package as a stranger receives it**

```bash
npm test
npm pack
npx ./signalboy-0.1.0.tgz --help
```

Expected: tests green; the tarball runs and prints help. This is the exact path a new user hits, and it catches a bad `files` whitelist before the version number is permanently burned.

- [ ] **Step 5: Clean up and commit**

```bash
rm -f signalboy-0.1.0.tgz
git add package.json README.md
git commit -m "Add package metadata and document walk mode"
```

- [ ] **Step 6: Publish**

The package is unscoped, so it is public by default and needs no `--access` flag.

```bash
npm publish
```

Then confirm it resolves from the registry rather than from disk:

```bash
cd /tmp && npx signalboy@0.1.0 --help
```

- [ ] **Step 7: Tag the release**

```bash
git tag v0.1.0
git push origin phone-walk-mode --tags
```

---

## Notes for the implementer

- **Do not add dependencies.** Zero runtime and zero dev dependencies is a stated property of this project, repeated in the README. Everything here is achievable with platform APIs.
- **The phone cannot measure WiFi.** If a task seems to call for reading signal strength in the browser, it does not — no Web API exposes RSSI on Android or iOS. Every number in walk mode comes from the daemon over SSE.
- **View modules have no test harness.** `test/` holds three pure-logic suites and this plan adds a fourth. Do not introduce jsdom or a browser runner to test the views; they are verified by hand, as specified in each task.
- **Task 5, Step 4 may fail on a real device.** That step tells you what to do if it does. Do not mark it complete on the strength of the code being written — it needs an actual Android phone and an actual screen timeout.
