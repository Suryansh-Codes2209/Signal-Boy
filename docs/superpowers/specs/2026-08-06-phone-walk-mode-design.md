# Phone walk mode, and the first npm release

Date: 2026-08-06
Status: approved

## Problem

Signal Boy prints a LAN URL and invites you to open it on your phone. Today that
path is the weakest one in the tool.

A phone browser cannot read WiFi signal strength — no Web API exposes it on
Android or iOS. So the phone is a remote display for the daemon host's readings,
and that is the design, not a shortcoming. But three things make the display
worse than it needs to be:

1. The phone gets the desktop LIVE view — meter, companion strip, legend, stats
   table — none of it sized to be read while walking.
2. When the phone drops off WiFi (the dead zone you are hunting), the last
   reading stays on screen looking live. `EventSource` reconnects on its own and
   the LED flips to RECONNECTING, but the number itself lies.
3. The screen sleeps mid-walk on the phone's normal timeout.

The goal: a user opens the printed URL on their phone, with no flags and no
certificate prompt, and gets something genuinely useful.

## Non-goals

- Making the phone measure its own WiFi. There is no Web API for RSSI. A derived
  proxy from latency and throughput was considered and rejected as a separate
  idea, not part of this work.
- A publicly hosted version. A page served from an HTTPS origin cannot fetch a
  LAN `http://` daemon; browsers block mixed content with no override.
- Wiring up the phone sensors (camera, magnetometer, Web Bluetooth) that
  `capabilities.js` already detects. They remain detected and displayed, unused.
- Backfilling the sparkline gap after a reconnect. `server/bus.js` exports
  `replay()` and it would work, but the simpler stale treatment covers the need.

## Design

### Walk mode view

New `public/js/views/walk.js`, exposing `createWalkView(root, { platform })` and
returning `{ render(reading) }` — the same shape `createLiveView` already
returns, so `app.js` routes the stream to it with no special-casing.

Very little new rendering code. `PixelMeter` in `render/meter.js` already draws
the large bitmap dBm value and the segmented strength bar; `Sparkline` already
draws the history strip. Walk mode is those two at a larger scale, with the band
legend, detail stats and companion strip omitted. New CSS sizes the canvas to the
viewport instead of the 464x208 default.

### Default view selection

`capabilities.js` already exports `isLocalHost()`. In `app.js`, when
`location.hash` is empty and `isLocalHost()` is false, mount `walk` rather than
`live`. Opening on the host machine is unchanged. The tab bar stays visible, so
LIVE and PLATFORM remain one tap away and an explicit `#live` hash still wins.

### Freshness

New `public/js/freshness.js`. Pure time logic, no DOM: it records the timestamp
of the most recent reading, ticks on an interval, and exposes `{ fresh, ageMs }`.

Above a 3s staleness threshold, the meter renders dimmed with a `STALE 7s` age
counter and the sparkline dashes out. Below it, nothing changes. On reconnect the
display jumps to the current reading; the gap walked through is lost, by choice.

Both walk and live consume it. It is a separate module because it is the one
piece of this work testable without a browser, and `test/` today is exactly three
pure-logic suites (`filter`, `pathloss`, `platform`) with no DOM harness.

### Keeping the screen awake

**The Wake Lock API is secure-context-only.** `navigator.wakeLock` does not exist
at `http://192.168.1.14:3000` — precisely the URL this feature targets. "No
`--https`" and "the screen stays awake" are in direct tension, and the design has
to resolve it rather than ship a silent no-op.

New `public/js/wakelock.js`:

- Try `navigator.wakeLock.request('screen')`. This works on localhost and under
  `--https`. Re-acquire on `visibilitychange`, since the lock is released when
  the tab hides.
- On plain HTTP, fall back to the NoSleep technique: a hidden muted looping
  video, which does hold an Android screen awake over HTTP but requires a user
  gesture to begin playback.

Because the fallback needs a gesture, walk mode carries an explicit `KEEP AWAKE`
toggle rather than fighting autoplay policy. One tap. The control reports which
mechanism it actually got.

### Adjacent correctness fixes

Both in `capabilities.js`, the module this work already touches:

- `wakeLock: 'wakeLock' in navigator` lacks an `&& secure` guard, so it reports
  YES over plain HTTP where the API is absent.
- `webBluetooth` has the same missing guard. Chrome does not expose
  `navigator.bluetooth` in insecure contexts, so an Android Chrome user on plain
  HTTP is told "This browser has no Web Bluetooth. Chrome or Edge is required" —
  the wrong reason.

## Testing

`freshness.js` gets a unit suite under `test/`, following the existing
`node --test` pattern with no framework and no new dependencies: threshold
crossing, age reporting, and reset on a fresh reading.

View modules stay untested, consistent with current practice — there is no DOM
harness in the project and this work does not add one.

Manual verification: load the LAN URL on an Android phone, confirm walk mode is
the default view, confirm the stale treatment by disabling WiFi on the phone, and
confirm the KEEP AWAKE toggle holds the screen on over plain HTTP.

## npm release

Verified against the registry and a dry-run pack:

- `signalboy` is unclaimed (`signal-boy` too). Authenticated as
  `suryansh_codes2209`.
- `npm pack --dry-run` is already clean: 31 files, 39.8 kB, correctly excluding
  `site/` and `test/` via the `files` whitelist in `package.json`.
- The shebang is present at `bin/signalboy.js:1`; npm sets the exec bit on `bin`
  entries at install time.

Before publishing, add `repository`, `bugs` and `author` to `package.json`. npm
warns without them and `repository` is what wires up provenance later.

Release sequence: `npm pack`, then run `npx ./signalboy-0.1.0.tgz` locally — the
exact path a stranger hits, which catches a bad `files` list before the version
number is burned — then `npm publish`. The package is unscoped, so it is public
by default and needs no `--access` flag.

**Ordering decision:** walk mode ships first; the first published version is
`0.1.0`. npm version numbers are permanent and unpublish is restricted after 72
hours, so a first release whose headline path is the weakest one is worse than a
short delay. Squatting risk on this name is negligible.
