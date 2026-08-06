# Android APK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A downloadable Android APK that measures WiFi on the phone itself via `WifiManager`, running the existing Game Boy UI from the same source files, with no daemon and no LAN.

**Architecture:** The pure analysis and platform-matrix modules move under `public/js/core/` so they are reachable from both Node and the WebView. A source abstraction gives `app.js` two interchangeable reading providers — SSE from the daemon, or a Kotlin bridge. The Android project is a plain Gradle/Kotlin WebView shell in `android/` with zero npm packages, and its Kotlin performs no interpretation: it returns raw platform values that pure, `node --test`-covered JavaScript maps into the canonical reading shape.

**Tech Stack:** Vanilla ES modules (no build step, no bundler), Node >= 20, `node --test` with `node:assert/strict`, Kotlin + Gradle + AndroidX WebKit.

## Global Constraints

- **Zero npm dependencies.** No runtime and no dev dependencies may be added to the root `package.json`. This is a stated property of the project. Gradle/AndroidX dependencies inside `android/` are not npm packages and do not violate this.
- **Node >= 20** (`engines` in `package.json`).
- **Four colours only.** `PALETTE` in `public/js/render/palette.js`. No gradients, shadows, or border radius.
- **Every dimension is a multiple of 8px**, matching `--u: 8px`, so layout sits on the bitmap font grid.
- **Never display a number the tool did not measure.** Missing values render `N/A` with the reason attached, never blank and never zero.
- **All UI text is uppercase** (`text-transform: uppercase` on `body`).
- **Kotlin stays dumb.** No unit conversion, no band inference, no normalization, no grading in Kotlin. Raw platform values only. All interpretation happens in JavaScript so it is testable with `node --test`.
- **View contract:** views are created as `createXView(root, context)` and return an object; views that consume readings expose `update(reading)`.
- **Reading shape** is defined by `reading()` in `server/platform/wifi/common.js` and must be matched exactly by any new producer.
- **Package id** is `work.suryansh.signalboy`. **minSdk 26, targetSdk 36.**

---

## File Structure

**Create:**
- `public/js/core/platforms.js` — pure capability matrix data and queries, moved from `server/platform/capabilities.js`.
- `public/js/core/filter.js` — moved from `server/analysis/filter.js`.
- `public/js/core/pathloss.js` — moved from `server/analysis/pathloss.js`.
- `public/js/sources/sse.js` — daemon reading source, wrapping the existing `Stream`.
- `public/js/sources/native.js` — Android bridge reading source.
- `public/js/sources/android-map.js` — pure raw-Android-values to canonical-shape mapper.
- `public/js/sources/index.js` — `createSource()` factory.
- `public/js/views/aps.js` — the NEARBY access-point list view.
- `test/android-map.test.js`, `test/sources.test.js` — suites for the above.
- `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`, `android/.gitignore`
- `android/app/build.gradle.kts`, `android/app/proguard-rules.pro`
- `android/app/src/main/AndroidManifest.xml`
- `android/app/src/main/java/work/suryansh/signalboy/MainActivity.kt`
- `android/app/src/main/java/work/suryansh/signalboy/WifiBridge.kt`
- `.github/workflows/android.yml`

**Modify:**
- `server/index.js` — import filter/pathloss from `../public/js/core/`; add the `aps` bus channel and `POST /api/scan`.
- `server/platform/capabilities.js` — reduce to `detectHostPlatform()`, re-exporting the matrix from `core/platforms.js`.
- `server/platform/index.js` — import matrix pieces from their new home.
- `public/js/app.js` — use `createSource()`; register the `aps` view.
- `public/css/pixel.css` — NEARBY list styles.
- `test/platform.test.js`, `test/filter.test.js`, `test/pathloss.test.js` — import paths.
- `README.md` — document the APK.
- `site/index.html` — download button.
- `.gitignore` — `android/app/src/main/assets/www/`.

**Delete (by moving):** `server/analysis/filter.js`, `server/analysis/pathloss.js`.

---

### Task 1: Move the capability matrix to `public/js/core/platforms.js`

The matrix is pure data that both Node and the WebView need. It moves under the web root because `public/` is the HTTP document root and becomes the APK's asset tree verbatim; anything outside it is unreachable from the browser without a new route or a build step, and this project has neither. Node has no such restriction and imports upward.

`detectHostPlatform()` reads `process.platform` and must not move.

**Files:**
- Create: `public/js/core/platforms.js`
- Modify: `server/platform/capabilities.js`, `server/platform/index.js`
- Test: `test/platform.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `public/js/core/platforms.js` exports `SUPPORT`, `ROLE`, `PLATFORMS`, `CAPABILITY_KEYS`, `CAPABILITY_LABELS`, `getPlatform(id)`, `capability(platformId, key)`, `supports(platformId, key)`, `hostPlatforms()`, `capabilityMatrix()` — all with signatures identical to their current ones in `server/platform/capabilities.js`. `server/platform/capabilities.js` continues to export all of those (re-exported) plus `detectHostPlatform(processPlatform = process.platform)`, so no existing importer breaks.

- [ ] **Step 1: Point the existing test at the new module**

In `test/platform.test.js`, split the first import block so the matrix comes from its new home and only detection comes from the server module:

```js
import {
  PLATFORMS,
  SUPPORT,
  ROLE,
  CAPABILITY_KEYS,
  capability,
  supports,
  capabilityMatrix,
  hostPlatforms,
} from '../public/js/core/platforms.js';
import { detectHostPlatform } from '../server/platform/capabilities.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/platform.test.js`
Expected: FAIL — `Cannot find module` for `public/js/core/platforms.js`.

- [ ] **Step 3: Create the new module**

Create `public/js/core/platforms.js` containing lines 1–213 of the current `server/platform/capabilities.js` verbatim — everything from the file header comment through the end of `capabilityMatrix()`, but **not** `detectHostPlatform()`. Update the header comment's final line to read:

```js
/**
 * ... (existing header text unchanged) ...
 *
 * Pure data and pure functions: no I/O, no process access. Lives under the web
 * root because the browser and the Android WebView need it as much as the
 * daemon does, and public/ is the only directory both can reach.
 */
```

- [ ] **Step 4: Reduce the server module to detection plus a re-export**

Replace the entire contents of `server/platform/capabilities.js` with:

```js
export * from '../../public/js/core/platforms.js';

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
```

- [ ] **Step 5: Update `server/platform/index.js`**

Change its import line from:

```js
import { PLATFORMS, detectHostPlatform, capabilityMatrix } from './capabilities.js';
```

to:

```js
import { PLATFORMS, capabilityMatrix } from '../../public/js/core/platforms.js';
import { detectHostPlatform } from './capabilities.js';
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — all four existing suites.

- [ ] **Step 7: Verify the daemon still boots and serves the matrix**

Run: `node bin/signalboy.js --port 3999 &` then `curl -s localhost:3999/api/platform | head -c 200` then kill it.
Expected: JSON containing `"host"`, `"label"` and `"matrix"`.

- [ ] **Step 8: Commit**

```bash
git add public/js/core/platforms.js server/platform/capabilities.js server/platform/index.js test/platform.test.js
git commit -m "Move the capability matrix under the web root"
```

---

### Task 2: Move the filter and pathloss modules to `public/js/core/`

The Kalman filter and grading currently run only server-side (`server/index.js:38-51`), so the browser receives pre-filtered readings. The APK has no server, so this logic must be reachable from the WebView.

**Files:**
- Create: `public/js/core/filter.js`, `public/js/core/pathloss.js`
- Delete: `server/analysis/filter.js`, `server/analysis/pathloss.js`
- Modify: `server/index.js:11-12`
- Test: `test/filter.test.js`, `test/pathloss.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `public/js/core/filter.js` exports `Ewma`, `Kalman1D`, `stdDev`. `public/js/core/pathloss.js` exports `BANDS`, `DEAD_ZONE_THRESHOLD`, `RSSI_FLOOR`, `RSSI_CEILING`, `gradeRssi`, `snr`, `qualityPercent`, `ENVIRONMENTS`, `DEFAULT_PATH_LOSS`, `distanceToRssi`, `rssiToDistance`, `fitPathLossExponent`. All signatures unchanged.

- [ ] **Step 1: Update both test files' imports**

In `test/filter.test.js`, change `from '../server/analysis/filter.js'` to `from '../public/js/core/filter.js'`.
In `test/pathloss.test.js`, change `from '../server/analysis/pathloss.js'` to `from '../public/js/core/pathloss.js'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/filter.test.js test/pathloss.test.js`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Move the files**

```bash
git mv server/analysis/filter.js public/js/core/filter.js
git mv server/analysis/pathloss.js public/js/core/pathloss.js
rmdir server/analysis
```

- [ ] **Step 4: Update the daemon's imports**

In `server/index.js`, replace lines 11–12:

```js
import { Kalman1D, Ewma } from './analysis/filter.js';
import { gradeRssi, qualityPercent } from './analysis/pathloss.js';
```

with:

```js
import { Kalman1D, Ewma } from '../public/js/core/filter.js';
import { gradeRssi, qualityPercent } from '../public/js/core/pathloss.js';
```

- [ ] **Step 5: Confirm nothing else referenced the old paths**

Run: `grep -rn "analysis/" server/ public/ bin/ test/`
Expected: no output.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Verify a live reading is still filtered**

Run: `node bin/signalboy.js --port 3999 &` then `sleep 6 && curl -s localhost:3999/api/wifi` then kill it.
Expected: JSON containing both `"rssi"` and `"filtered"` with numeric values.

Six seconds, not three: macOS `system_profiler` takes ~5s on its first call, and `GET /api/wifi` falls back to an unfiltered direct read when the polling loop has not produced a value yet. A short sleep therefore returns a reading with no `filtered` key and looks like a failure that isn't one.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Move the filter and pathloss modules under the web root"
```

---

### Task 3: Add the Android app to the capability matrix

**Read this before writing any code.** `PLATFORMS` **already has** an `android` entry, at `server/platform/capabilities.js:112` (now `public/js/core/platforms.js` after Task 1). It has `role: ROLE.GUEST` and describes Android **in Chrome**, which genuinely cannot read RSSI. That entry is correct and must not be modified or removed — a phone opening the LAN URL is exactly that platform, and walk mode exists to serve it.

The APK is a different platform. It gets a **new** entry, `androidApp`, with `role: ROLE.HOST`. The two coexist, and the comparison panel showing `ANDROID` (measures nothing) beside `ANDROID APP` (measures everything) is the honest presentation of the same hardware.

They cannot be distinguished by user agent — the APK's WebView reports an Android UA just as Chrome does — so client detection probes for the bridge instead.

**Files:**
- Modify: `public/js/core/platforms.js`, `public/js/capabilities.js`
- Test: `test/platform.test.js`

**Interfaces:**
- Consumes: `PLATFORMS` from Task 1.
- Produces: `PLATFORMS.androidApp`, with `role: ROLE.HOST` and every key in `CAPABILITY_KEYS` declared. `detectClientPlatform(scope = globalThis)` in `public/js/capabilities.js` returns `'androidApp'` when `scope.SignalBoyNative` is present.

- [ ] **Step 1: Write the failing test**

Append to the capability-matrix section of `test/platform.test.js`:

```js
test('the android app is a host platform that measures exactly', () => {
  const app = PLATFORMS.androidApp;
  assert.ok(app, 'androidApp must be in the matrix');
  assert.equal(app.role, ROLE.HOST);
  assert.equal(app.capabilities.connectedRssi.support, SUPPORT.FULL);
  assert.equal(app.capabilities.connectedRssi.exact, true);
});

test('android-in-a-browser survives as a separate guest platform', () => {
  // The APK does not replace the browser case: a phone opening the LAN URL is
  // still a guest that cannot read RSSI, and walk mode exists to serve it.
  assert.equal(PLATFORMS.android.role, ROLE.GUEST);
  assert.equal(PLATFORMS.android.capabilities.connectedRssi.support, SUPPORT.NONE);
});

test('the android app is the only platform scanning APs with exact dBm', () => {
  const exactScanners = Object.values(PLATFORMS).filter(
    (p) => p.capabilities.scanAllAps.support === SUPPORT.FULL && p.capabilities.scanAllAps.exact === true,
  );
  assert.deepEqual(exactScanners.map((p) => p.id), ['androidApp']);
});

test('the android app reports no noise floor, so SNR is unavailable', () => {
  assert.equal(PLATFORMS.androidApp.capabilities.noiseFloor.support, SUPPORT.NONE);
  assert.ok(PLATFORMS.androidApp.capabilities.noiseFloor.detail);
});
```

Add to `test/platform.test.js`, importing `detectClientPlatform` from `../public/js/capabilities.js` at the top:

```js
test('the bridge, not the user agent, identifies the android app', () => {
  // The APK's WebView sends an Android UA exactly as Chrome does, so sniffing
  // cannot tell them apart. Probing for the bridge can.
  const ua = { userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' };
  assert.equal(detectClientPlatform({ navigator: ua }), 'android');
  assert.equal(detectClientPlatform({ navigator: ua, SignalBoyNative: {} }), 'androidApp');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/platform.test.js`
Expected: FAIL — "androidApp must be in the matrix".

- [ ] **Step 3: Add the new entry, leaving `android` untouched**

In `public/js/core/platforms.js`, add to `PLATFORMS` **after** the existing `ios` entry — do not touch the existing `android` entry:

```js
  androidApp: {
    id: 'androidApp',
    label: 'ANDROID APP',
    role: ROLE.HOST,
    note: 'The only platform that measures where you are actually standing. WifiManager gives exact dBm with no permission at all, and exact per-AP dBm with one -- but scans are throttled to 4 per 2 minutes and no noise floor is exposed.',
    capabilities: {
      connectedRssi: {
        support: SUPPORT.FULL,
        exact: true,
        via: 'WifiManager.getConnectionInfo()',
        detail: 'Real dBm, no permission required.',
      },
      scanAllAps: {
        support: SUPPORT.FULL,
        exact: true,
        via: 'WifiManager.getScanResults()',
        detail: 'Exact dBm per access point, unlike netsh. Hard-throttled to 4 scans per 2 minutes, so the list is refreshed on demand rather than live.',
      },
      ssidVisible: {
        support: SUPPORT.PARTIAL,
        detail: 'Android classifies WiFi identity as location data. Without the location grant, SSID reads <unknown ssid> and BSSID reads 02:00:00:00:00:00.',
      },
      noiseFloor: { support: SUPPORT.NONE, detail: 'AOSP exposes no noise floor, so SNR cannot be computed.' },
      lanScan: { support: SUPPORT.NONE, detail: 'No Node runtime in the APK; raw sockets are unavailable to a WebView.' },
      mdns: { support: SUPPORT.NONE, detail: 'No Node runtime in the APK.' },
      bleScan: { support: SUPPORT.NONE, detail: 'Not wired up. The APK ships WiFi sensing only.' },
      camera: { support: SUPPORT.FULL, detail: 'Rear camera, unlike a laptop webcam.' },
      magnetometer: { support: SUPPORT.FULL, detail: 'Phones carry a real magnetometer.' },
    },
  },
```

- [ ] **Step 4: Teach client detection to probe for the bridge**

In `public/js/capabilities.js`, replace `detectClientPlatform()` with a version that takes an injectable scope (so the test above needs no DOM) and checks the bridge before sniffing:

```js
export function detectClientPlatform(scope = globalThis) {
  // The APK's WebView sends an Android user agent exactly as Chrome does, so
  // sniffing cannot separate them. The bridge only exists in the APK.
  if (scope.SignalBoyNative) return 'androidApp';

  const ua = scope.navigator.userAgent;
  const touchMac = scope.navigator.platform === 'MacIntel' && scope.navigator.maxTouchPoints > 1;

  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || touchMac) return 'ios';
  if (/windows/i.test(ua)) return 'win32';
  if (/mac os x/i.test(ua)) return 'darwin';
  if (/linux|x11/i.test(ua)) return 'linux';
  return 'linux';
}
```

Callers pass no argument and are unaffected.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. The pre-existing test "every platform declares every capability" also covers the new entry — if a key is missing it fails there.

- [ ] **Step 6: Confirm the browser case did not regress**

Run the daemon and open the UI on a phone browser over the LAN.
Expected: the PLATFORM tab identifies the client as `ANDROID` (not `ANDROID APP`), and still reports that it cannot read RSSI. The comparison panel now lists both entries.

- [ ] **Step 7: Commit**

```bash
git add public/js/core/platforms.js public/js/capabilities.js test/platform.test.js
git commit -m "Add the Android app as a host platform, distinct from Android in a browser"
```

---

### Task 4: Source abstraction, with the SSE path preserved

One interface, two implementations. This task adds the interface and the SSE implementation only — behaviour must be identical to today.

**Files:**
- Create: `public/js/sources/sse.js`, `public/js/sources/index.js`
- Modify: `public/js/app.js`

**Interfaces:**
- Consumes: `Stream`, `apiGet`, `apiPost` from `public/js/stream.js`.
- Produces: `createSseSource()` and `createSource()`, both returning an object shaped
  `{ connect(): void, on(channel: string, handler: Function): () => void, onStateChange(handler: (state: string) => void): () => void, loadPlatform(): Promise<object>, requestScan(): Promise<object>, isNative: boolean }`.
  `state` is one of `'connecting' | 'live' | 'error'`. `loadPlatform()` resolves to the same object `GET /api/platform` returns today.

- [ ] **Step 1: Create the SSE source**

Create `public/js/sources/sse.js`:

```js
import { Stream, apiGet, apiPost } from '../stream.js';

/**
 * Readings from a Signal Boy daemon over the network.
 *
 * The daemon has already applied the Kalman filter and grading before it
 * publishes, so this source passes readings straight through. Its counterpart,
 * sources/native.js, has no server to do that and filters locally instead.
 */
export function createSseSource() {
  const stream = new Stream();

  return {
    isNative: false,
    connect: () => stream.connect(),
    on: (channel, handler) => stream.on(channel, handler),
    onStateChange: (handler) => stream.onStateChange(handler),
    loadPlatform: () => apiGet('/api/platform'),
    requestScan: () => apiPost('/api/scan'),
  };
}
```

- [ ] **Step 2: Create the factory**

Create `public/js/sources/index.js`:

```js
import { createSseSource } from './sse.js';
import { createNativeSource, nativeBridge } from './native.js';

/**
 * Picks where readings come from.
 *
 * In the Android APK there is no daemon and no network: MainActivity installs a
 * WifiManager bridge on the window, and readings arrive by push from Kotlin. In
 * every browser there is no bridge, and readings arrive over SSE. Views never
 * learn which one they are attached to.
 */
export function createSource() {
  const bridge = nativeBridge();
  return bridge ? createNativeSource(bridge) : createSseSource();
}
```

- [ ] **Step 3: Rewrite `app.js` to consume a source**

In `public/js/app.js`:

1. Replace the `Stream` import line with:

```js
import { createSource } from './sources/index.js';
```

(`apiGet` is no longer needed; `el, clear, $` and the view imports stay.)

2. Replace `const stream = new Stream();` with `const source = createSource();`.

3. In `buildViews()`, change the context object's `stream` key to `source`:

```js
  const context = {
    platform: state.platform,
    client: state.client,
    source,
    companion: state.companion,
  };
```

4. In `start()`, replace `state.platform = await apiGet('/api/platform');` with `state.platform = await source.loadPlatform();`.

5. Replace the three `stream.` calls near the end of `start()` with `source.`:

```js
  source.onStateChange(setConnectionState);
  source.on('wifi', (reading) => {
    // Every view that consumes readings gets them; PLATFORM has no update and
    // is skipped by the optional call.
    for (const { api } of state.views.values()) api.update?.(reading);
    state.companion.update(reading);
  });
  source.connect();
```

- [ ] **Step 4: Verify the daemon path is unchanged**

Run: `node bin/signalboy.js --port 3999` and open `http://localhost:3999`.
Expected: LIVE view renders a moving dBm number exactly as before; the LED reads LIVE. Browser console shows no errors.

Note: `sources/index.js` imports `./native.js`, which does not exist until Task 6. Create a one-line placeholder now so the module graph resolves, and replace it wholesale in Task 6:

```js
// public/js/sources/native.js -- replaced in full by Task 6.
export function nativeBridge() { return null; }
export function createNativeSource() { throw new Error('not implemented'); }
```

- [ ] **Step 5: Commit**

```bash
git add public/js/sources/ public/js/app.js
git commit -m "Introduce a reading-source abstraction behind the SSE path"
```

---

### Task 5: The pure Android mapper

Everything Kotlin refuses to do. This is where raw `WifiInfo` and `ScanResult` values become the canonical reading shape, and it is fully testable without an emulator.

**Files:**
- Create: `public/js/sources/android-map.js`
- Test: `test/android-map.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `frequencyToBand(mhz: number|null): '2.4GHz'|'5GHz'|'6GHz'|null`
  - `frequencyToChannel(mhz: number|null): number|null`
  - `wifiStandardToPhyMode(code: number|null): string|null`
  - `cleanSsid(raw: string|null): string|null` — strips surrounding quotes, returns `null` for the redaction sentinel
  - `cleanBssid(raw: string|null): string|null` — returns `null` for the redaction sentinel
  - `mapConnected(raw: object): object` — canonical `reading()` shape plus `platform: 'android'`
  - `mapScanResults(raw: object): { ok, supported, networks, source, exact, error?, retryInMs? }`
  - `REDACTED_SSID`, `REDACTED_BSSID` constants

- [ ] **Step 1: Write the failing tests**

Create `test/android-map.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  frequencyToBand,
  frequencyToChannel,
  wifiStandardToPhyMode,
  cleanSsid,
  cleanBssid,
  mapConnected,
  mapScanResults,
} from '../public/js/sources/android-map.js';
import { reading } from '../server/platform/wifi/common.js';

/* ---------- frequency ---------- */

test('frequency maps onto the three bands', () => {
  assert.equal(frequencyToBand(2412), '2.4GHz');
  assert.equal(frequencyToBand(2484), '2.4GHz');
  assert.equal(frequencyToBand(5180), '5GHz');
  assert.equal(frequencyToBand(5895), '5GHz');
  assert.equal(frequencyToBand(6115), '6GHz');
  assert.equal(frequencyToBand(null), null);
  assert.equal(frequencyToBand(1000), null);
});

test('frequency maps onto channel numbers, including the two irregular ones', () => {
  assert.equal(frequencyToChannel(2412), 1);
  assert.equal(frequencyToChannel(2437), 6);
  // Channel 14 breaks the 5MHz spacing and needs its own case.
  assert.equal(frequencyToChannel(2484), 14);
  assert.equal(frequencyToChannel(5180), 36);
  assert.equal(frequencyToChannel(5955), 1);
  // 6GHz channel 2 sits below the band's base frequency, also a special case.
  assert.equal(frequencyToChannel(5935), 2);
  assert.equal(frequencyToChannel(null), null);
});

/* ---------- PHY mode ---------- */

test('wifi standard codes map onto readable PHY modes', () => {
  assert.equal(wifiStandardToPhyMode(4), '802.11N');
  assert.equal(wifiStandardToPhyMode(5), '802.11AC');
  assert.equal(wifiStandardToPhyMode(6), '802.11AX');
  assert.equal(wifiStandardToPhyMode(8), '802.11BE');
});

test('an unknown or absent wifi standard is null, never a guess', () => {
  // 0 is WIFI_STANDARD_UNKNOWN; null is what pre-API-30 devices report.
  assert.equal(wifiStandardToPhyMode(0), null);
  assert.equal(wifiStandardToPhyMode(null), null);
  assert.equal(wifiStandardToPhyMode(99), null);
});

/* ---------- permission redaction ---------- */

test('ssid quotes are stripped and the redaction sentinel becomes null', () => {
  assert.equal(cleanSsid('"HOME-5G"'), 'HOME-5G');
  assert.equal(cleanSsid('<unknown ssid>'), null);
  assert.equal(cleanSsid('"<unknown ssid>"'), null);
  assert.equal(cleanSsid(null), null);
});

test('the redacted bssid becomes null rather than a fake address', () => {
  assert.equal(cleanBssid('a4:2b:8c:00:11:22'), 'a4:2b:8c:00:11:22');
  assert.equal(cleanBssid('02:00:00:00:00:00'), null);
  assert.equal(cleanBssid(null), null);
});

/* ---------- connected reading ---------- */

const RAW_CONNECTED = {
  rssi: -58,
  frequency: 5180,
  linkSpeed: 780,
  ssid: '"HOME-5G"',
  bssid: 'a4:2b:8c:00:11:22',
  wifiStandard: 6,
  networkId: 1,
};

test('a connected reading produces every key of the canonical shape', () => {
  const mapped = mapConnected(RAW_CONNECTED);
  for (const key of Object.keys(reading({}))) {
    assert.ok(key in mapped, `mapped reading is missing "${key}"`);
  }
});

test('a connected reading carries the measured values through', () => {
  const mapped = mapConnected(RAW_CONNECTED);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.rssi, -58);
  assert.equal(mapped.exact, true);
  assert.equal(mapped.ssid, 'HOME-5G');
  assert.equal(mapped.channel, 36);
  assert.equal(mapped.band, '5GHz');
  assert.equal(mapped.phyMode, '802.11AX');
  assert.equal(mapped.txRate, 780);
  assert.equal(mapped.platform, 'androidApp');
});

test('android never reports a noise floor or an SNR', () => {
  const mapped = mapConnected(RAW_CONNECTED);
  assert.equal(mapped.noise, null);
  assert.equal(mapped.snr, null);
});

test('a denied location permission redacts identity but keeps the signal', () => {
  const mapped = mapConnected({
    ...RAW_CONNECTED,
    ssid: '<unknown ssid>',
    bssid: '02:00:00:00:00:00',
  });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.rssi, -58, 'dBm needs no permission and must survive');
  assert.equal(mapped.ssid, null);
  assert.equal(mapped.bssid, null);
});

test('a disconnected radio is a failure, not a zero reading', () => {
  // WifiManager reports -127 and networkId -1 when not associated.
  const mapped = mapConnected({ rssi: -127, networkId: -1, frequency: -1 });
  assert.equal(mapped.ok, false);
  assert.match(mapped.error, /NOT CONNECTED/i);
});

/* ---------- scan results ---------- */

test('scan results map to the shape the daemon backends already return', () => {
  const mapped = mapScanResults({
    ok: true,
    results: [
      { ssid: 'FAR', bssid: 'aa:bb:cc:00:00:01', level: -81, frequency: 2412, capabilities: '[WPA2-PSK-CCMP][ESS]' },
      { ssid: 'NEAR', bssid: 'aa:bb:cc:00:00:02', level: -42, frequency: 5180, capabilities: '[WPA3-SAE][ESS]' },
    ],
  });

  assert.equal(mapped.ok, true);
  assert.equal(mapped.supported, true);
  assert.equal(mapped.exact, true, 'android reports true dBm per AP, unlike netsh');
  assert.equal(mapped.source, 'WifiManager.getScanResults()');
  assert.deepEqual(mapped.networks.map((n) => n.ssid), ['NEAR', 'FAR'], 'sorted by signal descending');
  assert.equal(mapped.networks[0].rssi, -42);
  assert.equal(mapped.networks[0].channel, 36);
  assert.equal(mapped.networks[0].band, '5GHz');
  assert.equal(mapped.networks[0].security, 'WPA3-SAE');
});

test('a hidden network keeps its bssid and reports a null ssid', () => {
  const mapped = mapScanResults({
    ok: true,
    results: [{ ssid: '', bssid: 'aa:bb:cc:00:00:03', level: -60, frequency: 2412, capabilities: '[ESS]' }],
  });
  assert.equal(mapped.networks[0].ssid, null);
  assert.equal(mapped.networks[0].bssid, 'aa:bb:cc:00:00:03');
  assert.equal(mapped.networks[0].security, 'OPEN');
});

test('a throttled scan reports how long is left and returns no networks', () => {
  const mapped = mapScanResults({ ok: false, throttled: true, retryInMs: 47000 });
  assert.equal(mapped.ok, false);
  assert.equal(mapped.supported, true);
  assert.equal(mapped.retryInMs, 47000);
  assert.match(mapped.error, /THROTTLED/i);
  assert.deepEqual(mapped.networks, []);
});

test('a missing permission is reported as a permission problem, not a scan failure', () => {
  const mapped = mapScanResults({ ok: false, permissionDenied: true });
  assert.equal(mapped.ok, false);
  assert.equal(mapped.supported, true);
  assert.match(mapped.error, /PERMISSION/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/android-map.test.js`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Write the mapper**

Create `public/js/sources/android-map.js`:

```js
/**
 * Raw Android values in, canonical Signal Boy readings out.
 *
 * The Kotlin bridge deliberately performs no interpretation -- it hands over
 * WifiInfo and ScanResult fields exactly as the platform reports them. All the
 * conversion lives here instead, because a pure JS module is covered by
 * `node --test` against captured payloads, while the same logic in Kotlin would
 * need Robolectric or a device.
 *
 * Output matches reading() in server/platform/wifi/common.js exactly, so the
 * views cannot tell an Android reading from a macOS one.
 */

/** WifiManager.UNKNOWN_SSID, returned when the location grant is missing. */
export const REDACTED_SSID = '<unknown ssid>';
/** WifiInfo returns this fixed address rather than the real BSSID when redacted. */
export const REDACTED_BSSID = '02:00:00:00:00:00';

/** ScanResult.WIFI_STANDARD_* -> label. Unlisted codes stay null rather than guessing. */
const PHY_MODES = {
  1: '802.11A/B/G',
  4: '802.11N',
  5: '802.11AC',
  6: '802.11AX',
  7: '802.11AD',
  8: '802.11BE',
};

export function frequencyToBand(mhz) {
  if (mhz == null || mhz <= 0) return null;
  if (mhz >= 2401 && mhz <= 2495) return '2.4GHz';
  if (mhz >= 5150 && mhz <= 5895) return '5GHz';
  if (mhz >= 5925 && mhz <= 7125) return '6GHz';
  return null;
}

export function frequencyToChannel(mhz) {
  if (mhz == null || mhz <= 0) return null;
  // Channel 14 sits 12MHz above channel 13 instead of the usual 5, and 6GHz
  // channel 2 sits below its band's base. Both break the arithmetic.
  if (mhz === 2484) return 14;
  if (mhz === 5935) return 2;
  if (mhz >= 2401 && mhz <= 2483) return Math.round((mhz - 2407) / 5);
  if (mhz >= 5150 && mhz <= 5895) return Math.round((mhz - 5000) / 5);
  if (mhz >= 5925 && mhz <= 7125) return Math.round((mhz - 5950) / 5);
  return null;
}

export function wifiStandardToPhyMode(code) {
  if (code == null) return null;
  return PHY_MODES[code] ?? null;
}

export function cleanSsid(raw) {
  if (raw == null) return null;
  const unquoted = String(raw).replace(/^"(.*)"$/s, '$1').trim();
  if (!unquoted || unquoted === REDACTED_SSID) return null;
  return unquoted;
}

export function cleanBssid(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value || value === REDACTED_BSSID) return null;
  return value;
}

/**
 * ScanResult.capabilities is a bracketed flag string like
 * "[WPA2-PSK-CCMP][WPS][ESS]". The first flag that is not an infrastructure
 * marker is the security mode; nothing left means an open network.
 */
function parseSecurity(capabilities) {
  if (!capabilities) return 'OPEN';
  const flags = [...String(capabilities).matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  const security = flags.find((f) => !/^(ESS|IBSS|WPS|RSN)$/i.test(f));
  return security ? security.toUpperCase() : 'OPEN';
}

export function mapConnected(raw) {
  // WifiManager reports rssi -127 with networkId -1 when the radio is on but
  // not associated. Reporting that as a reading would draw a real-looking bar.
  if (!raw || raw.networkId === -1 || raw.rssi == null || raw.rssi <= -127) {
    return { ok: false, error: 'NOT CONNECTED TO A NETWORK', platform: 'androidApp' };
  }

  const frequency = raw.frequency ?? null;

  return {
    ok: true,
    rssi: raw.rssi,
    // AOSP exposes no noise floor, so SNR cannot be derived. Both stay null and
    // the UI prints the reason from the capability matrix.
    noise: null,
    snr: null,
    exact: true,
    ssid: cleanSsid(raw.ssid),
    bssid: cleanBssid(raw.bssid),
    channel: frequencyToChannel(frequency),
    band: frequencyToBand(frequency),
    width: null,
    phyMode: wifiStandardToPhyMode(raw.wifiStandard ?? null),
    txRate: raw.linkSpeed ?? null,
    security: null,
    interface: 'wlan0',
    source: 'WifiManager.getConnectionInfo()',
    platform: 'androidApp',
  };
}

export function mapScanResults(raw) {
  const base = { supported: true, networks: [], source: 'WifiManager.getScanResults()', exact: true };

  if (!raw || raw.ok !== true) {
    if (raw?.permissionDenied) {
      return { ...base, ok: false, error: 'NEEDS LOCATION PERMISSION TO LIST NEARBY NETWORKS' };
    }
    if (raw?.throttled) {
      return { ...base, ok: false, error: 'THROTTLED BY ANDROID', retryInMs: raw.retryInMs ?? null };
    }
    return { ...base, ok: false, error: raw?.error ?? 'SCAN FAILED' };
  }

  const networks = (raw.results ?? [])
    .map((r) => ({
      ssid: cleanSsid(r.ssid),
      bssid: cleanBssid(r.bssid),
      rssi: r.level ?? null,
      channel: frequencyToChannel(r.frequency),
      band: frequencyToBand(r.frequency),
      security: parseSecurity(r.capabilities),
      exact: true,
    }))
    .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));

  return { ...base, ok: true, networks };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/android-map.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add public/js/sources/android-map.js test/android-map.test.js
git commit -m "Map raw Android WiFi values into the canonical reading shape"
```

---

### Task 6: The native source

Replaces the Task 4 placeholder. This is where the filter runs client-side, because there is no daemon to have run it.

**Files:**
- Modify: `public/js/sources/native.js` (replacing the placeholder wholesale)
- Test: `test/sources.test.js`

**Interfaces:**
- Consumes: `mapConnected`, `mapScanResults` from `android-map.js`; `Kalman1D`, `Ewma` from `core/filter.js`; `gradeRssi`, `qualityPercent` from `core/pathloss.js`; `PLATFORMS`, `capabilityMatrix` from `core/platforms.js`.
- Produces: `nativeBridge(scope = globalThis)` returning the bridge object or `null`; `createNativeSource(bridge)` returning the same source interface Task 4 defined.

> **As implemented:** `applyFilters(reading, { kalman, ewma })` did not stay in `native.js`. The whole-branch review found the daemon's `onWifiReading` and this module implementing the same pipeline with the same constants and nothing keeping them in sync — a silent divergence waiting for whoever tunes `measurementNoise` in one place. It now lives in `public/js/core/derive.js` and both `server/index.js` and `native.js` import it. Behaviour is identical: `applyFilters` returns the failure object unchanged after resetting both filters, which is exactly what the daemon published before.

- [ ] **Step 1: Write the failing tests**

Create `test/sources.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { nativeBridge, createNativeSource } from '../public/js/sources/native.js';
import { PLATFORMS } from '../public/js/core/platforms.js';

/** Stands in for the Kotlin @JavascriptInterface object. */
function fakeBridge(overrides = {}) {
  return {
    intervalMs: () => 1000,
    permissions: () => JSON.stringify({ location: true, nearbyDevices: true }),
    requestPermissions: () => {},
    scan: () => JSON.stringify({ ok: true, results: [] }),
    ...overrides,
  };
}

test('the bridge is absent in a plain browser', () => {
  assert.equal(nativeBridge({}), null);
});

test('the bridge is found when Kotlin has installed it', () => {
  const bridge = fakeBridge();
  assert.equal(nativeBridge({ SignalBoyNative: bridge }), bridge);
});

test('a pushed reading reaches wifi subscribers filtered and graded', () => {
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const seen = [];
  source.on('wifi', (r) => seen.push(r));
  source.connect();

  scope.__signalboyPush(JSON.stringify({ rssi: -58, frequency: 5180, networkId: 1, linkSpeed: 780 }));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].rssi, -58, 'the measured value is preserved');
  assert.equal(typeof seen[0].filtered, 'number', 'the Kalman estimate is added client-side');
  assert.equal(typeof seen[0].smoothed, 'number');
  assert.equal(typeof seen[0].quality, 'number');
  assert.ok(seen[0].qualityBand, 'the reading is graded');
});

test('the filter converges towards the true value across repeated pushes', () => {
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const seen = [];
  source.on('wifi', (r) => seen.push(r));
  source.connect();

  for (let i = 0; i < 40; i += 1) {
    scope.__signalboyPush(JSON.stringify({ rssi: -60, frequency: 2412, networkId: 1 }));
  }

  const last = seen.at(-1).filtered;
  assert.ok(Math.abs(last - -60) < 1, `expected the estimate to settle near -60, got ${last}`);
});

test('state goes live on the first reading and errors when the radio drops', () => {
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const states = [];
  source.onStateChange((s) => states.push(s));
  source.connect();

  assert.equal(states[0], 'connecting');

  scope.__signalboyPush(JSON.stringify({ rssi: -58, frequency: 5180, networkId: 1 }));
  assert.equal(states.at(-1), 'live');

  scope.__signalboyPush(JSON.stringify({ rssi: -127, networkId: -1 }));
  assert.equal(states.at(-1), 'error', 'a disconnected radio is not a live reading');
});

test('a failed reading resets the filter so it cannot carry a stale estimate back', () => {
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const seen = [];
  source.on('wifi', (r) => seen.push(r));
  source.connect();

  for (let i = 0; i < 20; i += 1) {
    scope.__signalboyPush(JSON.stringify({ rssi: -40, frequency: 5180, networkId: 1 }));
  }
  scope.__signalboyPush(JSON.stringify({ rssi: -127, networkId: -1 }));
  scope.__signalboyPush(JSON.stringify({ rssi: -85, frequency: 5180, networkId: 1 }));

  const resumed = seen.at(-1).filtered;
  assert.ok(resumed < -70, `estimate should restart near -85, not drift down from -40 (got ${resumed})`);
});

test('platform info is served locally, with the app as the host', async () => {
  const source = createNativeSource(fakeBridge(), {});
  const info = await source.loadPlatform();

  assert.equal(info.host, 'androidApp');
  assert.equal(info.label, 'ANDROID APP');
  assert.equal(info.detected, 'androidApp');
  assert.equal(info.forced, false);
  assert.ok(info.matrix.length > 0);
  assert.ok(info.platforms.androidApp);
});

test('the app reports itself able to read rssi, unlike android in a browser', () => {
  // Getting these two confused would grey out a meter that works perfectly.
  assert.equal(PLATFORMS.androidApp.capabilities.connectedRssi.support, 'full');
  assert.equal(PLATFORMS.android.capabilities.connectedRssi.support, 'none');
});

test('a scan request goes through the bridge and comes back mapped', async () => {
  const bridge = fakeBridge({
    scan: () =>
      JSON.stringify({
        ok: true,
        results: [{ ssid: '"NEAR"', bssid: 'aa:bb:cc:00:00:02', level: -42, frequency: 5180, capabilities: '[ESS]' }],
      }),
  });
  const source = createNativeSource(bridge, {});
  const result = await source.requestScan();

  assert.equal(result.ok, true);
  assert.equal(result.networks.length, 1);
  assert.equal(result.networks[0].ssid, 'NEAR');
});

test('a bridge that throws surfaces as an error rather than crashing the view', async () => {
  const bridge = fakeBridge({
    scan: () => {
      throw new Error('binder died');
    },
  });
  const result = await createNativeSource(bridge, {}).requestScan();

  assert.equal(result.ok, false);
  assert.match(result.error, /binder died/i);
});

test('malformed JSON from the bridge is ignored rather than thrown', () => {
  const scope = {};
  const source = createNativeSource(fakeBridge(), scope);
  const seen = [];
  source.on('wifi', (r) => seen.push(r));
  source.connect();

  assert.doesNotThrow(() => scope.__signalboyPush('not json'));
  assert.equal(seen.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/sources.test.js`
Expected: FAIL — `not implemented` from the placeholder.

- [ ] **Step 3: Write the native source**

Replace the entire contents of `public/js/sources/native.js`:

```js
import { mapConnected, mapScanResults } from './android-map.js';
import { Kalman1D, Ewma } from '../core/filter.js';
import { gradeRssi, qualityPercent } from '../core/pathloss.js';
import { PLATFORMS, capabilityMatrix } from '../core/platforms.js';

/**
 * Readings from the phone's own radio, via the Kotlin WifiManager bridge.
 *
 * The daemon filters and grades before publishing; here there is no daemon, so
 * this source does it locally with the same modules and the same constants. A
 * view cannot tell the two apart, which is the whole point of the abstraction.
 *
 * Kotlin owns the cadence and pushes into window.__signalboyPush, mirroring the
 * server-push shape of SSE rather than making JS poll across the bridge.
 */

const PUSH_HOOK = '__signalboyPush';

/** The @JavascriptInterface object MainActivity installs, or null in a browser. */
export function nativeBridge(scope = globalThis) {
  return scope?.SignalBoyNative ?? null;
}

/** Kotlin hands JSON strings across the bridge; nothing else survives the boundary. */
function parse(json, fallback = null) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function createNativeSource(bridge, scope = globalThis) {
  // One filter pair, matching server/index.js exactly: Kalman drives the
  // displayed number, EWMA drives the sparkline.
  const kalman = new Kalman1D({ processNoise: 0.01, measurementNoise: 6 });
  const ewma = new Ewma(0.3);

  const listeners = new Map();
  const stateListeners = new Set();
  let state = 'connecting';

  function setState(next) {
    if (state === next) return;
    state = next;
    for (const fn of stateListeners) fn(next);
  }

  function emit(channel, payload) {
    for (const fn of listeners.get(channel) ?? []) fn(payload);
  }

  function onReading(result) {
    if (!result.ok) {
      // Without this the estimate would resume from wherever it was when the
      // radio dropped, and the first reading after reconnecting would be a lie.
      kalman.reset();
      ewma.reset();
      setState('error');
      emit('wifi', result);
      return;
    }

    const filtered = kalman.update(result.rssi);
    const smoothed = ewma.update(result.rssi);
    const grade = gradeRssi(filtered);

    setState('live');
    emit('wifi', {
      ...result,
      filtered,
      smoothed,
      qualityBand: grade?.key ?? null,
      bandLabel: grade?.label ?? null,
      shade: grade?.shade ?? 0,
      quality: qualityPercent(filtered),
      variance: kalman.variance,
    });
  }

  return {
    isNative: true,

    connect() {
      setState('connecting');
      scope[PUSH_HOOK] = (json) => {
        const raw = parse(json);
        if (raw == null) return;
        onReading(mapConnected(raw));
      };
    },

    on(channel, handler) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(handler);
      return () => listeners.get(channel)?.delete(handler);
    },

    onStateChange(handler) {
      stateListeners.add(handler);
      handler(state);
      return () => stateListeners.delete(handler);
    },

    /** No /api/platform to fetch: the matrix is in the bundle already. */
    async loadPlatform() {
      // androidApp, not android: the latter describes this same phone in Chrome,
      // which cannot read RSSI at all. Both entries exist and mean different
      // things, and picking the wrong one would grey out the working meter.
      const app = PLATFORMS.androidApp;
      return {
        host: 'androidApp',
        label: app.label,
        note: app.note,
        detected: 'androidApp',
        forced: false,
        capabilities: app.capabilities,
        platforms: Object.fromEntries(
          Object.entries(PLATFORMS).map(([id, p]) => [
            id,
            { id, label: p.label, role: p.role, note: p.note, capabilities: p.capabilities },
          ]),
        ),
        matrix: capabilityMatrix(),
      };
    },

    async requestScan() {
      try {
        return mapScanResults(parse(bridge.scan(), { ok: false, error: 'BRIDGE RETURNED NOTHING' }));
      } catch (err) {
        return { ok: false, supported: true, networks: [], error: err.message };
      }
    },

    permissions() {
      return parse(bridge.permissions(), { location: false, nearbyDevices: false });
    },

    requestPermissions() {
      bridge.requestPermissions();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/sources.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/js/sources/native.js test/sources.test.js
git commit -m "Add the native reading source, filtering on-device"
```

---

### Task 7: The Android shell

A Gradle project that builds an APK, loads the existing UI over the asset-loader origin, and shows the daemon-unreachable state. No WiFi yet — this task proves the WebView and the ES-module loading work.

**Files:**
- Create: `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`, `android/.gitignore`, `android/app/build.gradle.kts`, `android/app/proguard-rules.pro`, `android/app/src/main/AndroidManifest.xml`, `android/app/src/main/java/work/suryansh/signalboy/MainActivity.kt`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `public/` as the asset tree.
- Produces: an installable debug APK whose WebView loads `https://appassets.androidplatform.net/www/index.html`.

- [ ] **Step 1: Create the Gradle wrapper and project files**

```bash
mkdir -p android/app/src/main/java/work/suryansh/signalboy
```

Create `android/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "SignalBoy"
include(":app")
```

Create `android/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application") version "8.7.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
```

Create `android/gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
kotlin.code.style=official
```

Create `android/.gitignore`:

```gitignore
.gradle/
build/
local.properties
app/src/main/assets/www/
*.keystore
*.jks
```

Create `android/app/proguard-rules.pro`:

```proguard
# The bridge is reached by name from JavaScript, so its methods must survive
# shrinking even though nothing in Kotlin calls them.
-keepclassmembers class work.suryansh.signalboy.WifiBridge {
    public *;
}
```

- [ ] **Step 2: Create the app module build file, including the asset sync**

Create `android/app/build.gradle.kts`:

```kotlin
import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/** Version comes from the root package.json so npm and the APK never disagree. */
val packageVersion: String = File(rootDir.parentFile, "package.json")
    .readText()
    .let { Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(it)!!.groupValues[1] }

android {
    namespace = "work.suryansh.signalboy"
    compileSdk = 36

    defaultConfig {
        applicationId = "work.suryansh.signalboy"
        minSdk = 26
        targetSdk = 36
        versionName = packageVersion
        versionCode = packageVersion.split(".").let {
            it[0].toInt() * 10000 + it[1].toInt() * 100 + it[2].toInt()
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    signingConfigs {
        // Populated only in CI, where the keystore is restored from a secret.
        // A local `./gradlew assembleRelease` produces an unsigned APK.
        if (System.getenv("SIGNALBOY_KEYSTORE") != null) {
            create("release") {
                storeFile = File(System.getenv("SIGNALBOY_KEYSTORE"))
                storePassword = System.getenv("SIGNALBOY_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SIGNALBOY_KEY_ALIAS")
                keyPassword = System.getenv("SIGNALBOY_KEY_PASSWORD")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

/**
 * The UI is not vendored into the Android project -- it is copied from public/
 * at build time, so the APK can never drift from what `npx signalboy` serves.
 */
val syncWebAssets by tasks.registering(Copy::class) {
    from(File(rootDir.parentFile, "public"))
    into(layout.projectDirectory.dir("src/main/assets/www"))
}

tasks.named("preBuild") { dependsOn(syncWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
```

- [ ] **Step 3: Create the manifest**

Create `android/app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />

    <!-- Android classifies WiFi identity as location data. Needed for SSID and
         BSSID, and for scan results up to API 32. -->
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />

    <!-- API 33+ can scan without a location grant, provided the app declares it
         is not deriving location from the results. -->
    <uses-permission
        android:name="android.permission.NEARBY_WIFI_DEVICES"
        android:usesPermissionFlags="neverForLocation" />

    <uses-feature android:name="android.hardware.wifi" android:required="true" />

    <application
        android:label="Signal Boy"
        android:theme="@style/Theme.AppCompat.NoActionBar"
        android:supportsRtl="false"
        android:allowBackup="false">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden|screenLayout">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

- [ ] **Step 4: Write the activity**

Create `android/app/src/main/java/work/suryansh/signalboy/MainActivity.kt`:

```kotlin
package work.suryansh.signalboy

import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

/**
 * Hosts the Signal Boy UI in a WebView.
 *
 * The assets are served through WebViewAssetLoader rather than loaded from
 * file://, and that is load-bearing rather than tidy. The whole public/js tree
 * is ES modules, and module loading over file:// fails CORS -- the app would not
 * start. The loader's origin is also a secure context, so the Wake Lock API and
 * the sensor APIs the UI feature-detects are available, which over plain HTTP on
 * a LAN they are not. On Android the --https flag's problem simply does not
 * exist.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Supersedes the three-mechanism degradation in public/js/wakelock.js:
        // the native flag always works, so walk mode never has to fall back.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // The UI draws its own pixel grid and must not be re-laid-out.
            settings.useWideViewPort = false
            settings.loadWithOverviewMode = false

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            }
        }

        setContentView(webView)
        webView.loadUrl("https://appassets.androidplatform.net/www/index.html")
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
```

- [ ] **Step 5: Ignore the synced assets from the repo root too**

Append to `.gitignore`:

```gitignore

# Copied from public/ at build time by android/app/build.gradle.kts
android/app/src/main/assets/www/
```

- [ ] **Step 6: Build the debug APK**

Run: `cd android && gradle wrapper --gradle-version 8.11.1 && ./gradlew assembleDebug`
Expected: `BUILD SUCCESSFUL`, and `android/app/build/outputs/apk/debug/app-debug.apk` exists.

If `gradle` is not on PATH, install it (`brew install gradle`) — the wrapper only needs generating once and is then committed.

- [ ] **Step 7: Install and confirm the UI loads**

Run: `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` and open the app.
Expected: the Game Boy chrome renders with the tab bar. Because there is no daemon and no bridge yet, `createSource()` falls through to SSE and the page shows the "Daemon unreachable" note. That is the correct state for this task — it proves the asset tree, ES modules and CSS all loaded.

Verify with `adb logcat -s chromium` that there are no module-loading or CORS errors.

- [ ] **Step 8: Commit**

```bash
git add android/ .gitignore
git commit -m "Add the Android WebView shell serving the UI from assets"
```

---

### Task 8: The WiFi bridge

Raw values only. Kotlin's whole job is to call `WifiManager` and hand the result across as JSON.

**Files:**
- Create: `android/app/src/main/java/work/suryansh/signalboy/WifiBridge.kt`
- Modify: `android/app/src/main/java/work/suryansh/signalboy/MainActivity.kt`

**Interfaces:**
- Consumes: `mapConnected` and `createNativeSource` from Tasks 5–6 (the JS side is already written and tested).
- Produces: `window.SignalBoyNative` with `intervalMs(): Int`, `scan(): String`, `permissions(): String`, `requestPermissions()`. Readings are pushed to `window.__signalboyPush(json)` on the main thread at the interval.

- [ ] **Step 1: Write the bridge**

Create `android/app/src/main/java/work/suryansh/signalboy/WifiBridge.kt`:

```kotlin
package work.suryansh.signalboy

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * WifiManager, exposed to JavaScript as raw values and nothing more.
 *
 * There is deliberately no interpretation here: no frequency-to-channel
 * arithmetic, no band inference, no unit conversion, no grading. All of that
 * lives in public/js/sources/android-map.js, where `node --test` covers it
 * against captured payloads. Testing the same logic here would require
 * Robolectric or a device, and this project's test suite has neither.
 *
 * Everything crosses the boundary as a JSON string, because that is all
 * @JavascriptInterface can carry reliably.
 */
class WifiBridge(
    private val context: Context,
    private val intervalMs: Int,
    private val onRequestPermissions: () -> Unit,
) {

    private val wifi: WifiManager =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    /** Android allows 4 foreground scans per 2 minutes. Tracked so we can say how long is left. */
    private val scanTimestamps = ArrayDeque<Long>()

    @JavascriptInterface
    fun intervalMs(): Int = intervalMs

    /**
     * getConnectionInfo() is deprecated since API 31 in favour of reading
     * WifiInfo off a NetworkCallback's NetworkCapabilities. It still returns
     * correct values through API 36, and the callback route would put state
     * management in Kotlin -- exactly what this class exists to avoid.
     */
    @Suppress("DEPRECATION")
    @JavascriptInterface
    fun readConnected(): String {
        val info = wifi.connectionInfo ?: return JSONObject().put("networkId", -1).toString()

        return JSONObject().apply {
            put("rssi", info.rssi)
            put("frequency", info.frequency)
            put("linkSpeed", info.linkSpeed)
            put("networkId", info.networkId)
            put("ssid", info.ssid)
            put("bssid", info.bssid)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                put("wifiStandard", info.wifiStandard)
            } else {
                put("wifiStandard", JSONObject.NULL)
            }
        }.toString()
    }

    @JavascriptInterface
    fun permissions(): String = JSONObject().apply {
        put("location", granted(Manifest.permission.ACCESS_FINE_LOCATION))
        put(
            "nearbyDevices",
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                granted(Manifest.permission.NEARBY_WIFI_DEVICES)
            } else {
                granted(Manifest.permission.ACCESS_FINE_LOCATION)
            },
        )
    }.toString()

    @JavascriptInterface
    fun requestPermissions() {
        onRequestPermissions()
    }

    @Suppress("DEPRECATION")
    @JavascriptInterface
    fun scan(): String {
        if (!canScan()) {
            return JSONObject().put("ok", false).put("permissionDenied", true).toString()
        }

        val remaining = throttleRemainingMs()
        if (remaining > 0) {
            return JSONObject().put("ok", false).put("throttled", true).put("retryInMs", remaining).toString()
        }

        scanTimestamps.addLast(System.currentTimeMillis())
        wifi.startScan()

        // getScanResults() returns the most recent completed scan immediately.
        // startScan() above refreshes it for the next call rather than blocking
        // this one, which keeps the bridge synchronous.
        val results = JSONArray()
        for (r in wifi.scanResults) {
            results.put(
                JSONObject().apply {
                    put("ssid", r.SSID)
                    put("bssid", r.BSSID)
                    put("level", r.level)
                    put("frequency", r.frequency)
                    put("capabilities", r.capabilities)
                },
            )
        }

        return JSONObject().put("ok", true).put("results", results).toString()
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun canScan(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            granted(Manifest.permission.NEARBY_WIFI_DEVICES)
        } else {
            granted(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    /** Milliseconds until a 5th scan would be allowed, or 0 if one is allowed now. */
    private fun throttleRemainingMs(): Long {
        val now = System.currentTimeMillis()
        val windowStart = now - SCAN_WINDOW_MS
        while (scanTimestamps.isNotEmpty() && scanTimestamps.first() < windowStart) {
            scanTimestamps.removeFirst()
        }
        if (scanTimestamps.size < SCANS_PER_WINDOW) return 0
        return scanTimestamps.first() + SCAN_WINDOW_MS - now
    }

    companion object {
        private const val SCAN_WINDOW_MS = 120_000L
        private const val SCANS_PER_WINDOW = 4
    }
}
```

- [ ] **Step 2: Install the bridge and start the push loop**

In `MainActivity.kt`, add these imports:

```kotlin
import android.os.Handler
import android.os.Looper
```

Add these fields to the class, above `onCreate`:

```kotlin
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var bridge: WifiBridge
    private var pushing = false

    /** Matches SIGNALBOY_WIFI_INTERVAL's default in the daemon. */
    private val intervalMs = 1000
```

Inside `onCreate`, after the `webView = WebView(this).apply { ... }` block and before `setContentView`, add:

```kotlin
        bridge = WifiBridge(this, intervalMs) { requestWifiPermissions() }
        webView.addJavascriptInterface(bridge, "SignalBoyNative")
```

Then extend the existing `webViewClient` object with a page-finished hook, so pushing only begins once the JS has installed its receiver:

```kotlin
                override fun onPageFinished(view: WebView, url: String) {
                    startPushing()
                }
```

Add these methods to the class:

```kotlin
    /**
     * Kotlin owns the cadence and pushes, rather than JavaScript polling across
     * the bridge. That mirrors the daemon's server-push SSE shape, so the JS
     * side sees the same event flow either way.
     */
    private fun startPushing() {
        if (pushing) return
        pushing = true

        val tick = object : Runnable {
            override fun run() {
                val json = bridge.readConnected()
                webView.evaluateJavascript("window.__signalboyPush($json)", null)
                handler.postDelayed(this, intervalMs.toLong())
            }
        }
        handler.post(tick)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        webView.destroy()
        super.onDestroy()
    }
```

Delete the previous standalone `onDestroy` so there is exactly one.

Note: `readConnected()` returns a JSON *object* string, so it interpolates directly as the argument — no quoting needed.

- [ ] **Step 3: Build and install**

Run: `cd android && ./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Verify a real on-device reading**

Open the app on a phone connected to WiFi.
Expected: the WALK view (the default off-`localhost`) shows a live dBm number that changes as you move. The LED reads LIVE. The PLATFORM tab shows **ANDROID APP** as the host with `connectedRssi` full — if it shows `ANDROID` instead, the source picked the browser platform entry and the meter will be wrongly greyed out.

SSID reads `N/A` at this point — that is correct, the permission is not requested until Task 9.

Cross-check the number against the phone's own WiFi settings screen, which shows signal strength; they should agree within a few dBm.

- [ ] **Step 5: Commit**

```bash
git add android/
git commit -m "Expose WifiManager to the WebView as raw values"
```

---

### Task 9: Permissions

One rationale, one request, and per-field degradation. The meter must never be blocked by a denial, because dBm needs no permission at all.

**Files:**
- Modify: `android/app/src/main/java/work/suryansh/signalboy/MainActivity.kt`

**Interfaces:**
- Consumes: `bridge.requestPermissions()` from Task 8.
- Produces: a runtime permission request covering `ACCESS_FINE_LOCATION` and, on API 33+, `NEARBY_WIFI_DEVICES`. After the result, `window.__signalboyPermissions(json)` is called if the page defines it.

- [ ] **Step 1: Add the request flow**

In `MainActivity.kt`, add imports:

```kotlin
import android.Manifest
import android.os.Build
import androidx.activity.result.contract.ActivityResultContracts
```

Add the launcher as a field:

```kotlin
    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            // The JS side re-reads the grants rather than trusting this payload,
            // so the two can never disagree.
            webView.evaluateJavascript("window.__signalboyPermissions?.()", null)
        }
```

Add the request method:

```kotlin
    /**
     * Requested on demand, not at launch.
     *
     * dBm needs no permission, so the meter works the instant the app opens. Only
     * network identity and the nearby list need a grant, and asking for Location
     * before showing anything reads as a WiFi app demanding your position.
     */
    private fun requestWifiPermissions() {
        val wanted = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            wanted.add(Manifest.permission.NEARBY_WIFI_DEVICES)
        }
        permissionLauncher.launch(wanted.toTypedArray())
    }
```

- [ ] **Step 2: Build, install, and verify the denial path first**

Run: `cd android && ./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk`

Open the app and **deny** when prompted (the prompt is triggered from the NEARBY view in Task 11; until then trigger it from the console with `adb shell` or simply confirm no prompt appears at launch).
Expected at this task: no permission prompt appears at launch, and the dBm meter works. This is the requirement being verified — the app is fully useful with zero grants.

- [ ] **Step 3: Verify the grant path**

Run: `adb shell pm grant work.suryansh.signalboy android.permission.ACCESS_FINE_LOCATION` and relaunch.
Expected: the SSID now appears on the LIVE tab instead of `N/A`.

Then revoke and confirm it returns to `N/A` with its reason, not to a blank or a stale value:

```bash
adb shell pm revoke work.suryansh.signalboy android.permission.ACCESS_FINE_LOCATION
```

- [ ] **Step 4: Commit**

```bash
git add android/
git commit -m "Request WiFi identity permissions on demand, never at launch"
```

---

### Task 10: Access-point scanning on the daemon side

The NEARBY view is built once and works for every platform that can scan. The daemon already has `scanAccessPoints()` and a `GET /api/wifi/aps` route, but nothing publishes to the bus, so the view has no push channel and no way to trigger a refresh.

**Files:**
- Modify: `server/index.js`

**Interfaces:**
- Consumes: `scanAccessPoints` from `server/sensors/wifi.js` (already imported); `publish` from `server/bus.js` (already imported); `sendJson` from `server/http.js` (already imported).
- Produces: a bus channel `aps` carrying `{ ok, supported, networks, source, exact, error? }`, and a route `POST /api/scan` that performs a scan, publishes it, and returns it.

- [ ] **Step 1: Add the scan route**

In `server/index.js`, add to the `routes` object after the `'GET /api/wifi/aps'` entry:

```js
  // The client asks for a scan rather than the daemon polling for one: scans are
  // slow everywhere and rate-limited on some platforms, so they happen when
  // somebody is looking at the list.
  'POST /api/scan': async (req, res) => {
    const result = await scanAccessPoints();
    publish('aps', result);
    return sendJson(res, 200, result);
  },
```

- [ ] **Step 2: Verify against a platform that can scan**

On Windows or Linux:

Run: `node bin/signalboy.js --port 3999 &` then `curl -s -X POST localhost:3999/api/scan | head -c 300` then kill it.
Expected: `{"ok":true,"supported":true,"networks":[...]}` with at least one network.

On macOS, expect `supported` to reflect the matrix and the list to be empty — that is the correct, honest result, and the view will render the matrix's reason.

- [ ] **Step 3: Verify replay catches a new client up**

Run the daemon, `curl -X POST localhost:3999/api/scan`, then open `curl -N localhost:3999/api/stream` and confirm the first events include a channel `aps` event.
Expected: the `aps` event is replayed, because `publish()` records the last value per channel.

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "Publish access-point scans on the bus and add POST /api/scan"
```

---

### Task 11: The NEARBY view

**Files:**
- Create: `public/js/views/aps.js`
- Modify: `public/js/app.js`, `public/css/pixel.css`

**Interfaces:**
- Consumes: `context.source.requestScan()` and `context.source.on('aps', handler)`; `context.platform.capabilities.scanAllAps`; `shadeColor` from `render/palette.js`; `el, clear` from `dom.js`.
- Produces: `createApsView(root, context)` returning `{}` — it has no `update(reading)`, so `app.js`'s optional call skips it, exactly as PLATFORM is skipped.

- [ ] **Step 1: Write the view**

Create `public/js/views/aps.js`:

```js
import { el, clear } from '../dom.js';
import { shadeColor } from '../render/palette.js';
import { gradeRssi } from '../core/pathloss.js';

/**
 * Every access point the radio can see, refreshed on demand.
 *
 * On demand rather than live because Android hard-throttles foreground scans to
 * four per two minutes, and a list that silently stopped updating would be
 * indistinguishable from a quiet neighbourhood. The countdown makes the limit
 * visible instead of hiding it.
 *
 * The shape this consumes is the one win32.js and linux.js already return, so
 * the view works for a daemon on those platforms as well as for the APK.
 */

const TICK_MS = 1000;

export function createApsView(root, context) {
  const support = context.platform?.capabilities?.scanAllAps ?? {};
  const unsupported = support.support === 'none';

  const button = el('button', { class: 'btn', type: 'button', text: 'SCAN' });
  const note = el('p', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'aps-list' });

  root.append(el('div', { class: 'aps' }, el('div', { class: 'aps-bar' }, button, note), list));

  if (unsupported) {
    button.disabled = true;
    note.textContent = support.detail ?? 'THIS PLATFORM CANNOT SCAN NEARBY NETWORKS.';
    return {};
  }

  let retryUntil = 0;
  let scanning = false;

  function render(result) {
    clear(list);

    if (!result.ok) {
      note.textContent = result.error ?? 'SCAN FAILED.';
      return;
    }
    if (!result.networks.length) {
      note.textContent = 'NO NETWORKS VISIBLE.';
      return;
    }

    note.textContent = `${result.networks.length} NETWORKS${result.exact ? '' : ' (APPROXIMATE DBM)'}`;

    for (const n of result.networks) {
      const grade = gradeRssi(n.rssi);
      list.append(
        el(
          'div',
          { class: 'ap' },
          el('span', { class: 'ap-swatch', style: `background:${shadeColor(grade?.shade ?? 0)}` }),
          el('span', { class: 'ap-ssid', text: n.ssid ?? 'HIDDEN' }),
          el('span', { class: 'ap-rssi', text: n.rssi == null ? 'N/A' : `${result.exact ? '' : '~'}${n.rssi} DBM` }),
          el('span', { class: 'ap-meta', text: [n.band, n.channel != null ? `CH ${n.channel}` : null, n.security].filter(Boolean).join(' · ') }),
          el('span', { class: 'ap-bssid', text: n.bssid ?? '' }),
        ),
      );
    }
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    button.disabled = true;
    note.textContent = 'SCANNING...';

    try {
      const result = await context.source.requestScan();
      // A throttled result carries how long is left; hold the button until then
      // rather than letting the user hammer it into more refusals.
      retryUntil = result.retryInMs ? Date.now() + result.retryInMs : 0;
      render(result);
    } catch (err) {
      note.textContent = err.message.toUpperCase();
    } finally {
      scanning = false;
      button.disabled = retryUntil > Date.now();
    }
  }

  button.addEventListener('click', scan);

  // Readings pushed by another client's scan land here too, so two phones
  // looking at the same daemon stay in step.
  context.source.on('aps', render);

  const timer = setInterval(() => {
    if (!retryUntil) return;
    const left = retryUntil - Date.now();
    if (left > 0) {
      button.disabled = true;
      button.textContent = `THROTTLED · ${Math.ceil(left / 1000)}S`;
      return;
    }
    retryUntil = 0;
    button.disabled = false;
    button.textContent = 'SCAN';
  }, TICK_MS);
  timer.unref?.();

  return {};
}
```

- [ ] **Step 2: Register the view**

In `public/js/app.js`, add the import:

```js
import { createApsView } from './views/aps.js';
```

and add to `VIEWS`, after the `live` entry:

```js
  { id: 'aps', label: 'NEARBY', create: createApsView },
```

- [ ] **Step 3: Add the styles**

Append to `public/css/pixel.css`:

```css
/* NEARBY: one row per access point, on the same 8px grid as everything else. */
.aps-bar {
  display: flex;
  align-items: center;
  gap: var(--u);
  margin-bottom: var(--u);
}

.aps-list {
  display: flex;
  flex-direction: column;
  gap: var(--u);
}

.ap {
  display: grid;
  grid-template-columns: var(--u) 1fr auto;
  grid-template-areas:
    'swatch ssid rssi'
    'swatch meta bssid';
  gap: 0 var(--u);
  align-items: center;
  border: var(--border) solid var(--lcd-0);
  padding: var(--u);
}

.ap-swatch { grid-area: swatch; align-self: stretch; }
.ap-ssid   { grid-area: ssid; }
.ap-rssi   { grid-area: rssi; }
.ap-meta   { grid-area: meta; color: var(--lcd-1); }
.ap-bssid  { grid-area: bssid; color: var(--lcd-1); text-align: right; }
```

These are the tokens `pixel.css` already defines: `--lcd-0` (darkest, text and borders) through `--lcd-3` (lightest), `--u: 8px`, `--border: 2px`. Do not introduce new custom properties.

- [ ] **Step 4: Verify on the daemon**

Run the daemon on Windows or Linux, open the UI, click NEARBY, click SCAN.
Expected: a list of networks sorted strongest first, each with a shade swatch, dBm, band, channel and security. On Windows the dBm values carry the `~` prefix because `exact` is false there.

On macOS: the button is disabled and the note reads the matrix's reason for `scanAllAps`.

- [ ] **Step 5: Verify on the APK**

Run: `cd android && ./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk`

Open NEARBY and tap SCAN with the permission not yet granted.
Expected: `NEEDS LOCATION PERMISSION TO LIST NEARBY NETWORKS`.

Grant it, tap SCAN four times in quick succession.
Expected: the fourth or fifth attempt shows `THROTTLED · NNS` counting down, then the button re-enables. No stale list is presented as current.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public/js/views/aps.js public/js/app.js public/css/pixel.css
git commit -m "Add the NEARBY access-point view"
```

---

### Task 12: Release build, CI and the download link

**Files:**
- Create: `.github/workflows/android.yml`
- Modify: `site/index.html`, `README.md`

**Interfaces:**
- Consumes: the Gradle release config from Task 7, which reads `SIGNALBOY_KEYSTORE`, `SIGNALBOY_KEYSTORE_PASSWORD`, `SIGNALBOY_KEY_ALIAS` and `SIGNALBOY_KEY_PASSWORD` from the environment.
- Produces: a signed `signalboy.apk` attached to every `v*` GitHub Release, reachable at a stable `releases/latest/download/signalboy.apk` URL.

- [ ] **Step 1: Generate a keystore and record it as a secret**

Run locally, once, and keep the file somewhere safe and out of the repo:

```bash
keytool -genkeypair -v -keystore signalboy-release.jks \
  -keyalg RSA -keysize 4096 -validity 10000 -alias signalboy
base64 -i signalboy-release.jks | pbcopy
```

Add four repository secrets in GitHub: `ANDROID_KEYSTORE_BASE64` (the clipboard contents), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`signalboy`), `ANDROID_KEY_PASSWORD`.

Losing this keystore means never being able to update the app for anyone who installed it. Back it up.

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/android.yml`:

```yaml
name: android

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: write

jobs:
  apk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - name: Restore the signing keystore
        run: echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 -d > "$RUNNER_TEMP/release.jks"

      - name: Build the signed release APK
        working-directory: android
        env:
          SIGNALBOY_KEYSTORE: ${{ runner.temp }}/release.jks
          SIGNALBOY_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          SIGNALBOY_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          SIGNALBOY_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: ./gradlew assembleRelease

      # A fixed asset name is what makes releases/latest/download/signalboy.apk
      # a stable link, so the landing page never needs redeploying per release.
      - name: Name the artifact predictably
        run: cp android/app/build/outputs/apk/release/app-release.apk signalboy.apk

      - uses: softprops/action-gh-release@v2
        with:
          files: signalboy.apk
```

- [ ] **Step 3: Verify the workflow without cutting a release**

Trigger it manually from the Actions tab (`workflow_dispatch`).
Expected: `BUILD SUCCESSFUL` and a `signalboy.apk` artifact. The release-upload step is skipped for a non-tag run.

Download the APK from the run and confirm it is signed:

```bash
apksigner verify --print-certs signalboy.apk
```

Expected: the certificate details print with no "DOES NOT VERIFY" error.

- [ ] **Step 4: Add the download link to the landing page**

In `site/index.html`, add a download link next to the existing `npx signalboy` install instruction:

```html
<a class="btn" href="https://github.com/Suryansh-Codes2209/signalboy/releases/latest/download/signalboy.apk">
  DOWNLOAD FOR ANDROID
</a>
<p class="note">
  Android measures its own WiFi, so the phone is the instrument rather than a
  second screen. Requires allowing installs from your browser once.
</p>
```

Check the repository slug in the URL against `git remote -v` before committing.

- [ ] **Step 5: Document the APK in the README**

In `README.md`, revise the "Phones, and the `--https` flag" section. It currently states a phone browser cannot read WiFi signal strength and stops there; that remains true, but it is now only half the story. Add after that section:

```markdown
## Android

```
Download the APK from the landing page.
```

On Android the browser limitation does not apply. The app reads `WifiManager`
directly, so the phone measures its own signal — the number describes where you
are standing, not where your laptop is sitting. It needs no daemon, no laptop and
no network.

It is also the only platform that scans neighbouring access points with exact
dBm. Windows scans, but reports a percentage it converts. The trade is that
Android exposes no noise floor, so SNR is unavailable, and it throttles scans to
four per two minutes, so the NEARBY list refreshes on demand rather than live.

Signal strength needs no permission at all. The network name and the nearby list
do — Android classifies WiFi identity as location data — and the app asks only
when you open something that needs it. Deny it and the meter still works.

iPhone has no equivalent and never will: Apple exposes no public API for signal
strength. On iOS, walk mode over the LAN remains the way to carry the number
around.
```

Also update the "What works where" table to add an **Android app** column — `yes, exact` for own signal, `yes, full` for scanning, `no` for noise floor, and `yes, with permission` for SSID. Label the column "Android app", not "Android": the phone browser still measures nothing, and the table would otherwise contradict the paragraph above it that explains why walk mode exists.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/android.yml site/index.html README.md
git commit -m "Build and publish a signed APK, and link it from the site"
```

---

### Task 13: Cut the first release

**Files:** none created; this is a verification and release task.

- [ ] **Step 1: Run everything**

Run: `npm test`
Expected: PASS across all six suites (`filter`, `pathloss`, `platform`, `freshness`, `android-map`, `sources`), plus the QR suites from the previous plan.

- [ ] **Step 2: Verify the daemon is unchanged by all of this**

Run: `node bin/signalboy.js` on your own machine, open `http://localhost:3000`.
Expected: LIVE view identical to before this plan started — same meter, same filtering behaviour, same QR banner in the terminal.

- [ ] **Step 3: Verify the APK end to end on a real phone**

Install the release APK. Walk from next to the router to the far corner of the building.
Expected: the number falls as you walk and settles within two or three seconds of stopping; NEARBY lists real networks with the throttle countdown behaving; the screen never sleeps; PLATFORM shows ANDROID APP as host, with ANDROID listed separately as a guest that cannot measure.

- [ ] **Step 4: Confirm developer verification is registered**

Confirm the verified developer account at the Android Developer Console is complete for `work.suryansh.signalboy` before 2026-09-30. Without it, installs begin failing in Brazil, Indonesia, Singapore and Thailand on that date and progressively elsewhere through 2027.

This is administrative, not an engineering step, and nothing in the build depends on it.

- [ ] **Step 5: Tag and push**

```bash
git tag v0.2.0
git push origin v0.2.0
```

Expected: the `android` workflow runs and attaches `signalboy.apk` to the release. Confirm `https://github.com/<slug>/releases/latest/download/signalboy.apk` resolves.

- [ ] **Step 6: Verify the download path a user would take**

On a phone that has never had the app, open the landing page in Chrome and tap DOWNLOAD FOR ANDROID.
Expected: the APK downloads, Chrome asks for permission to install unknown apps once, and the app installs and runs.

---

## Notes for the implementer

**The one thing that will look wrong and is not:** `server/index.js` imports from `../public/js/core/`. Server code reaching into the web root is unusual. It is deliberate — `public/` is the HTTP document root *and* the APK's asset tree, so anything the browser needs must live under it, and the alternatives are a build step or a second copy of the filter. The project has no build step and duplication is worse.

**Do not add unit tests for the Kotlin.** Its correctness is that it faithfully returns what `WifiManager` said, and asserting that requires a device or Robolectric. The interpretation that *can* be wrong is all in `android-map.js`, which is tested thoroughly. If you find yourself wanting to test Kotlin, the logic you want to test probably belongs in JavaScript.

**`gradle wrapper` is generated once in Task 7 and committed.** After that, always use `./gradlew`, never a system `gradle`.
