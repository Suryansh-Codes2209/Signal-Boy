# Android APK: Signal Boy as a native on-device measuring tool

Date: 2026-08-07
Status: approved

## Problem

Signal Boy's README states that a phone cannot measure WiFi signal strength. That
is true of a phone *browser* — no Web API exposes RSSI on Android or iOS — and it
is the reason phone walk mode treats the phone as a remote display for the
daemon host's readings.

It is not true of Android itself. `WifiManager` gives a native app exact dBm with
no permission at all, and a full scan of every nearby access point with one. An
Android app is therefore not a workaround for the browser limitation; it removes
the limitation.

This matters because the phone is the device you actually want to walk with. The
current design has the laptop measure and the phone display, which means the
number you carry around describes where the *laptop* is sitting. A native app
measures where you are standing.

## Goals

- An APK a user downloads from the landing page, installs, and opens — with no
  laptop, no Node, no LAN, and no daemon anywhere in the picture.
- Full use of what Android exposes: exact connected RSSI, SSID/BSSID, and
  scanning of all nearby access points.
- The same Game Boy UI, from the same source files, with no second copy to keep
  in sync.
- The root `package.json` stays at zero dependencies.

## Non-goals

- **iOS.** Apple exposes no public API for RSSI. There is nothing to build.
- **Noise floor and SNR on Android.** AOSP does not expose it. It renders `N/A`
  with the reason attached, exactly as Windows does today.
- **Pairing with the desktop daemon.** The APK does not talk to a running
  daemon, does not push its readings anywhere, and does not scan the startup QR
  code. A two-point survey is a separate idea, not part of this work.
- **Replacing `npx signalboy`.** The daemon remains the desktop product.
- **Live AP scanning.** Android throttles scans to 4 per 2 minutes. This is an OS
  limit with no workaround outside developer options, so the AP view is
  manual-refresh by design.
- **Capacitor, Cordova, React Native, or Flutter.** See "Rejected alternatives".

## Design

### Repository layout

The Android project lives in `android/`, a plain Gradle/Kotlin project with no
npm packages of any kind. The root `package.json` is untouched, and its `files`
array already excludes `android/`, so the npm tarball is unaffected.

```
android/
  settings.gradle.kts
  build.gradle.kts
  app/
    build.gradle.kts
    src/main/
      AndroidManifest.xml
      assets/www/                        <- populated at build time from public/
      java/work/suryansh/signalboy/
        MainActivity.kt
        WifiBridge.kt
```

A Gradle task copies `public/` into `app/src/main/assets/www/` before
`mergeAssets`, so the asset tree is never checked in and can never drift from
the served UI. `assets/www/` is gitignored.

### WebView hosting

`MainActivity` hosts a `WebView` and serves the asset tree through
`WebViewAssetLoader` at `https://appassets.androidplatform.net/`.

This is not incidental. Loading `file://` would break the app outright: the
entire `public/js/` tree is ES modules, and module loading over `file://` fails
CORS. The asset-loader origin is also a **secure context**, so the Wake Lock API
and the device sensors that `capabilities.js` detects are available — the exact
capabilities the README documents as greyed out over plain HTTP, and the reason
the `--https` flag exists. On Android they come for free.

The activity sets `FLAG_KEEP_SCREEN_ON`. Walk mode's `wakelock.js` degrades
through three mechanisms because the Wake Lock API is secure-context-only; on
Android the native flag makes all three unnecessary, and `native.js` reports the
screen as already held so no mechanism is attempted.

### The bridge, and why Kotlin stays dumb

`WifiBridge` is registered as `window.SignalBoyNative` via `@JavascriptInterface`.
It returns **raw platform values as JSON and performs no interpretation**: no
unit conversion, no band inference, no normalization into the `reading()` shape,
no grading.

```
window.SignalBoyNative.readConnected()  -> raw WifiInfo fields
window.SignalBoyNative.scanResults()    -> raw ScanResult list + scan timing
window.SignalBoyNative.permissions()    -> which grants are held
window.SignalBoyNative.requestPermissions()
```

All interpretation happens in JavaScript. This is a testing decision: mapping
logic in Kotlin would need Robolectric or an instrumented test to exercise,
while the same logic in JS is covered by `node --test` against a fake bridge
object with no emulator and no new dependency. The project's test suite today is
four pure-logic suites with no harness, and this keeps it that way.

Kotlin drives cadence — a `Handler` loop at the configured interval calls
`evaluateJavascript` to push each reading, mirroring the server-push shape of
SSE so the JS side sees the same event flow it sees from the daemon.

### The refactor: `public/js/core/`

The Kalman filter, EWMA, and grading currently run **server-side**
(`server/index.js:38-51`), so the browser receives readings that are already
filtered and graded. With no Node in the APK, that logic must run client-side.

Three pure modules move to `public/js/core/`:

| from | to |
|---|---|
| `server/analysis/filter.js` | `public/js/core/filter.js` |
| `server/analysis/pathloss.js` | `public/js/core/pathloss.js` |
| pure half of `server/platform/capabilities.js` | `public/js/core/platforms.js` |

They move *under* the web root rather than into a sibling `shared/` directory
because `public/` is the HTTP server's document root and becomes `assets/www/`
verbatim. Code outside it is unreachable from the browser without either a new
server route or a build step, and this project has neither. Node has no such
restriction, so `server/index.js` imports upward:

```js
import { Kalman1D, Ewma } from '../public/js/core/filter.js';
```

`server/platform/capabilities.js` splits rather than moves wholesale:
`PLATFORMS`, `SUPPORT`, `ROLE` and `capabilityMatrix()` are pure data and go to
`core/platforms.js`; `detectHostPlatform()` reads `process.platform` and stays
server-side, importing the matrix back.

The filter then runs in both places — server-side for the daemon path, unchanged
in behaviour, and client-side for the APK — from one module with one set of
constants.

### Source abstraction

New directory `public/js/sources/`, exposing one interface with two
implementations:

```
createSource() -> { connect(), on(channel, fn), onStateChange(fn), platformInfo() }
```

- `sources/sse.js` wraps the existing `Stream` class and `apiGet('/api/platform')`.
  `Stream` itself is not modified.
- `sources/native.js` subscribes to bridge pushes, maps them through
  `sources/android-map.js`, applies `core/filter.js` and `core/pathloss.js`
  locally, and returns `core/platforms.js` data for `platformInfo()`.

`app.js` selects on one condition — `window.SignalBoyNative` present means
native, absent means SSE — and is otherwise unchanged. Views are entirely
unaware of which source is mounted.

`sources/android-map.js` is the pure mapper: raw `WifiInfo`/`ScanResult` fields
in, canonical `reading()` shape out. It handles the `getWifiStandard()` API-30
guard, frequency-to-channel-and-band conversion, and the `<unknown ssid>` and
`02:00:00:00:00:00` sentinels Android returns when location permission is
missing, translating both into the same `null`-plus-reason the UI already
renders for macOS.

### Connection state

The LED has no network to report on in the APK. `native.js` maps it to sensor
health instead: `live` while readings arrive, `error` when WiFi is off or the
bridge throws. `freshness.js` continues to drive the STALE treatment unchanged,
which correctly covers the case where WiFi is disabled mid-walk.

### Android in the capability matrix

`android` is added to `PLATFORMS` in `core/platforms.js` with `role: HOST` — the
first mobile host, since it now measures rather than displaying.

| capability | support | note |
|---|---|---|
| `connectedRssi` | FULL, `exact: true` | `WifiInfo.getRssi()`, no permission required |
| `scanAllAps` | FULL, `exact: true` | exact dBm per AP, better than Windows' converted percentage |
| `ssidVisible` | PARTIAL | requires location permission; redacted otherwise |
| `noiseFloor` | NONE | not exposed by AOSP |
| `magnetometer` | FULL | |
| `camera` | FULL | rear camera, unlike a laptop's webcam |
| `lanScan`, `mdns`, `bleScan` | NONE | no Node runtime in the APK |

The PLATFORM view renders whatever is in the matrix, so it picks up the fourth
platform with no changes to `views/platform.js`.

### Permissions

Declared in the manifest:

- `ACCESS_WIFI_STATE` — connected info
- `CHANGE_WIFI_STATE` — required to call `startScan()`
- `ACCESS_FINE_LOCATION` — SSID and BSSID, and scan results on API ≤ 32
- `NEARBY_WIFI_DEVICES` with `android:usesPermissionFlags="neverForLocation"` —
  API 33+, permits scanning without a location grant

Requested at first launch behind a short rationale screen explaining that
Android classifies WiFi identity as location data.

**Denial never blocks the meter.** dBm needs no permission and keeps working.
SSID, BSSID and the AP list degrade to `N/A` with `NEEDS LOCATION PERMISSION`
attached, reusing the greyed-out-with-a-reason treatment the UI already applies
to macOS. A tap target re-requests. The app never displays a number it did not
measure, and never blocks on a grant it does not strictly need.

### NEARBY view

New `public/js/views/aps.js`, registered in `VIEWS` as `NEARBY`.

Android hard-throttles foreground scans to 4 per 2 minutes, so this view is
manual-refresh with a countdown rather than live. Kotlin tracks scan timestamps
and returns `{ ok: false, supported: true, error: 'THROTTLED', retryInMs }`,
which the view renders as `THROTTLED · 47S` on the refresh control. A stale
result list is never presented as current.

The view consumes `{ ok, supported, networks[], source, exact }` — the shape
`server/platform/wifi/win32.js:145` and `linux.js:144` already return. So the
view also works for Windows and Linux daemon users over SSE, which requires a
`scanAps` channel on the existing bus and a `POST /api/scan` trigger. macOS
greys out with the reason already in its matrix entry.

Each row shows SSID, BSSID, dBm, band, channel and security, sorted by signal
descending. Rows reuse `PixelMeter`'s segmented strength bar at small scale.

## Testing

Everything meaningful stays pure and stays in `node --test` with no DOM harness
and no emulator:

- `test/filter.test.js` and `test/pathloss.test.js` — move with their modules,
  import paths updated, assertions unchanged.
- `test/platform.test.js` — updated to import the matrix from `core/platforms.js`;
  gains coverage of the `android` entry.
- `test/android-map.test.js` — **new.** Exercises `sources/android-map.js`
  against captured raw `WifiInfo`/`ScanResult` payloads: frequency-to-band
  conversion across 2.4/5/6 GHz, the API-30 `wifiStandard` guard, and both
  permission-denied sentinels (`<unknown ssid>`, `02:00:00:00:00:00`).
- `test/sources.test.js` — **new.** Drives `sources/native.js` against a fake
  bridge object, asserting filter application and connection-state mapping.

Kotlin carries no unit tests, which is the point of keeping it dumb. It is
verified by running the app.

## Distribution

`.github/workflows/android.yml`, triggered on `v*` tags: assemble release, sign
with a keystore restored from an Actions secret, attach `signalboy.apk` to the
GitHub Release.

The landing page links `releases/latest/download/signalboy.apk` — a stable URL
that needs no API call and no page redeploy per release.

- Package id `work.suryansh.signalboy`, matching the `signalboy.suryansh.work`
  homepage.
- `versionCode` derived from the `package.json` version.
- `minSdk 26`, `targetSdk 36`. `getWifiStandard()` is guarded to API 30+.

**Developer verification.** Google begins enforcing developer verification on
2026-09-30 in Brazil, Indonesia, Singapore and Thailand, expanding globally
through 2027. After enforcement, unverified apps are blocked from installation
on certified devices regardless of distribution channel. Registration requires
government ID and a $25 fee. This must be completed before the enforcement date
or the download link stops working for a growing share of users. It is an
administrative prerequisite, not an engineering task, and does not block
development.

Google Play and F-Droid are deliberately out of scope for this work.

## Sequencing

**The phone-walk-mode plan is finished first.** Its `walk.js` — large digits
sized to be read while walking — is precisely the view the APK wants as its
default. Building the APK first would mean shipping it with the cramped desktop
LIVE view or building walk mode twice.

Walk mode also remains independently valuable after the APK ships: it serves
iPhone users, who have no native option and never will, and any browser opening
the LAN URL.

## Rejected alternatives

**Capacitor.** Its value is cross-platform reach and a plugin ecosystem. This app
needs exactly one native API and has no iOS target, so both benefits are void —
leaving roughly 200 npm packages bought to avoid roughly 50 lines of Kotlin, in a
project whose zero-dependency status is a stated property.

**A separate `signalboy-android` repository.** Keeps the main repo pristine, but
`public/` would have to be vendored or submoduled across, permitting the APK's UI
to drift from the npx tool's. One repo, one copy of the UI.

**A headless probe.** A minimal Kotlin app with no WebView that serves readings
over HTTP on the LAN, letting any browser consume the phone as a sensor. Rejected
as a different product: it still requires a second device to be useful, which is
the constraint this work exists to remove.

**A PWA or Trusted Web Activity.** Neither can reach `WifiManager`. No amount of
web packaging changes what the browser sandbox exposes.
