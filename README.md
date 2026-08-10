# Signal Boy

WiFi survey tool that runs on your own machine. Walk around your house and watch the dBm move.

```
npx signalboy
```

No install, no config, no dependencies. Node 20+.

---

## What it does

Signal Boy reads the WiFi signal strength of the machine it is running on, once a second, and renders it on a Game Boy-style LCD in your browser. A Kalman filter drives the displayed number so it settles on the true value instead of jittering; an EWMA drives the sparkline so it stays responsive enough to show you walking.

Use it to find dead zones, pick a router location, work out whether a wall is the problem, or verify a mesh node actually helped.

## How you use it

**1. Run it on the machine you want to measure.**

```
npx signalboy
```

It prints where to reach it — a local URL, one line per LAN address, and a QR
code for the first of those addresses:

```
  SIGNAL BOY  ->  platform MACOS
  local       ->  http://localhost:3000
  network     ->  http://192.168.1.14:3000  (en0)

  Scan to open on your phone:

    █▀▀▀▀▀█ ▀▄█ ▄▀ █▀▀▀▀▀█
    █ ███ █ █▄▀▀█▄ █ ███ █
    █ ▀▀▀ █ ▀ ▄█▀▀ █ ▀▀▀ █
    ▀▀▀▀▀▀▀ ▀ █ ▀▄ ▀▀▀▀▀▀▀
    ( ... )

  That code is  http://192.168.1.14:3000  (en0)
```

The URL beneath the code is the one the code encodes, interface name included,
so the two can never quietly disagree. Worth a glance: addresses come back in
the order the OS enumerates them, and on a machine with a Docker bridge, a WSL
adapter or a VPN, one of those can come first and take the code. If the address
under the QR is not your WiFi one, use the matching `network` line instead.

The QR is skipped when output is piped or redirected, since half-block glyphs
and colour escapes are no use in a log file.

**2. Open the local URL.** You get a live dBm readout, a quality band, the noise floor and SNR where your OS reports it, plus the channel, band and PHY mode you are connected on.

**3. Open the network URL on your phone.** Same data, served off your laptop, in
a display sized for walking. Carry the laptop — it holds the radio doing the
measuring — and read the phone. Both devices must be on the same WiFi.

**4. Walk.** Stand somewhere, wait two or three seconds for the filter to settle, note the number. Repeat. Anything at −67 dBm or better is comfortable; below −80 you are in trouble.

### Reading the number

| dBm | What it means |
|---|---|
| −30 to −50 | Excellent. You are next to the router. |
| −50 to −67 | Good. Video calls and streaming are fine. |
| −67 to −70 | Usable. Fine for browsing, marginal for calls. |
| −70 to −80 | Weak. Expect stalls. |
| below −80 | Effectively unusable. |

Signal is logarithmic: −60 dBm is ten times the power of −70 dBm, not 17% more.

## Options

```
npx signalboy --https           # serve over TLS (see below)
npx signalboy --port 8080       # bind a specific port
npx signalboy --interval 500    # poll twice a second
npx signalboy --platform linux  # force a backend
npx signalboy --version         # -v also works
npx signalboy --help            # -h also works
```

## Phones, and the `--https` flag

A phone browser **cannot read WiFi signal strength.** There is no Web API for it on Android or iOS — the OS reserves that for native apps. So on a phone, Signal Boy shows you *the host machine's* readings over the network. That is still the useful thing: the laptop measures, the phone displays.

You do not have to type that address. Signal Boy prints a QR code for it at
startup — point your phone camera at the terminal.

Open the network URL on a phone and Signal Boy defaults to **walk mode**: the
dBm value sized to the screen and the history strip, with none of the extra
chrome the LIVE and PLATFORM tabs carry. When the phone drops off the WiFi the
reading dims and starts counting its own age rather than presenting a stale
number as current.

A `KEEP AWAKE` button tries to hold the screen on for the survey. Over HTTPS,
or on localhost, it uses the browser's Wake Lock API and holds reliably. Over
plain HTTP — what a plain `npx signalboy` run gives you — that API does not
exist, so the button falls back to a muted, looping video, which is not
guaranteed to work on every device. Either way the button says which
mechanism it is actually using, or tells you plainly that it could not hold
the screen, in which case the fix is `--https` or a longer screen timeout on
the phone itself.

Phones do carry sensors a laptop doesn't — a rear camera, a magnetometer, and on Android, Web Bluetooth. But browsers only expose those in a **secure context**, and `http://192.168.1.14:3000` is not one. Over plain HTTP they stay greyed out.

```
npx signalboy --https
```

generates a self-signed certificate in `~/.signalboy` covering localhost and your current LAN addresses, and serves over TLS. Your phone shows a certificate warning once; accept it and the camera, magnetometer and Web Bluetooth all become available while the page still talks to your laptop.

The certificate is reused across restarts, and regenerated automatically when you join a network where your machine gets a different IP.

> **Why not just host it on the internet?** A page served from an HTTPS origin cannot fetch `http://192.168.1.14:3000` — browsers block mixed content with no override. A hosted copy would get a secure context and lose every reading. The daemon has to serve the page it wants a phone to use.

Requires the `openssl` CLI, which macOS and Linux ship by default and Git for Windows provides on Windows.

## Android

```
Download the APK from the landing page: https://signalboy.suryansh.work
```

On Android the browser limitation above does not apply. The app is a native
shell around the same UI, and it reads `WifiManager` directly, so the phone
measures its own signal — the number describes where you are standing, not
where a laptop is sitting. It needs no daemon, no laptop, and no network.

It is also the only platform here that scans neighbouring access points with
exact per-AP dBm, not a converted percentage. The trade is that Android
exposes no noise floor, so SNR is unavailable, and the OS throttles scans to
four per two minutes, so the NEARBY list refreshes on demand rather than
live.

Signal strength needs no permission at all. The network name and the nearby
list do — Android classifies WiFi identity as location data — and the app
asks only when you open something that needs it. Deny it and the meter still
works.

### HUNT

HUNT scans for nearby Bluetooth Low Energy devices and lets you lock onto one
to track by an audio tone (pitch, or a metal-detector click rate) and a
proximity display built from the same RSSI. It finds devices that
**advertise** — it cannot see one that stays silent.

**It shows no direction, ever.** A single antenna cannot resolve a bearing, so
the display is drawn as a motion tracker without the one thing a motion
tracker is famous for: there is no cone and no blip sitting at an angle. The
contact is a full ring at its radius, which is true at every angle at once.

**Distance is shown only when it is measured.** From an advertisement it never
is: an advertisement carries an RSSI and sometimes a claimed transmit power,
and neither converts to metres through walls and furniture. Treat rising RSSI
as "closer" and falling as "farther," nothing more precise than that. On
Android 16 and newer, the RANGE panel can measure a real distance to a peer
whose radio answers, using Bluetooth Channel Sounding — that number is timed
rather than inferred, and it is labelled as such. Most devices you will find
cannot range, and they say so instead of guessing.

HUNT also names what it can: Eddystone, Apple Find My and vendor identity are
read from the advertisement as a hint, never a claim. Modern trackers
(AirTag-class) rotate their advertised MAC every roughly 15 minutes, so a
lost track offers you a likely continuation — offered, never adopted
automatically, because a re-association is a guess.

A hidden camera is far more likely to show up in the NEARBY WiFi list than in
HUNT — most stream over WiFi, not BLE — and a device with no radio at all is
invisible to both tabs.

### CELL, LINK and NEARBY

**CELL** reads the cellular modem: serving and neighbour cells, band, RSRP and
RSRQ. It is read-only and cannot be otherwise — the baseband is locked
firmware with no app-accessible transmit path.

**LINK** reports how steady the connected link is over time without sending
anything. It also offers an active latency, jitter and throughput test, which
is the only part of this app that puts packets on the wire and the only part
behind a consent gate. Everything else is offline.

**NEARBY** gained the busiest-channel summary, rogue-AP detection (one SSID
advertising from BSSIDs that disagree) and a channel-power chart. That chart
is not a spectrum: the radio reports one RSSI per access point, not a swept
power trace, so it draws discrete marks and says so.

iPhone has no equivalent and never will: Apple exposes no public API for
WiFi signal strength. On iOS, walk mode over the LAN (above) remains the way
to carry the number around.

Installing the APK requires allowing installs from your browser once — the
app is not distributed through the Play Store.

## What works where

Capabilities differ sharply by OS, and they do **not** form a hierarchy — Windows sees every nearby access point while macOS refuses to.

| | macOS | Windows | Linux | Android app |
|---|---|---|---|---|
| Own signal (dBm) | yes, exact | yes, approximate on older builds | yes, exact | yes, exact |
| Scan neighbouring APs | **no** | yes, full | partial, via NetworkManager | yes, full |
| See your own SSID | **no** | yes | yes | yes, with permission |
| Noise floor / SNR | yes | no | driver-dependent | **no** |
| BLE hunting | **no** | **no** | **no** | yes |
| Cell info | **no** | **no** | **no** | yes |
| True distance | **no** | **no** | **no** | Android 16+, to a peer that answers |

**macOS** removed the `airport` CLI in 14.4 and reclassified WiFi metadata as location data. `system_profiler` still reports your connected network's signal and noise without sudo, which is enough to survey your own network, but neighbouring SSIDs come back `<redacted>` with no signal values.

**Windows** is the strongest platform here: `netsh` lists every visible AP with SSID, BSSID, band, channel and signal, with no admin rights. It reports no noise floor, so SNR is unavailable.

**Linux** reads true dBm from `/proc/net/wireless` with no root.

The app reads this matrix at runtime and greys out what your platform cannot do, with the reason printed next to it. It never shows you a number it had to invent.

## Development

```
git clone <repo>
cd signalboy
npm start          # same entrypoint as npx
npm test           # node --test, no test framework, no dev dependencies
```

Zero runtime dependencies and zero dev dependencies. Sensor data flows server→browser over Server-Sent Events; OS-specific parsing is isolated in `server/platform/wifi/*`; the capability matrix in `server/platform/capabilities.js` is pure data and tested directly.

```
bin/signalboy.js      CLI entrypoint, flag parsing
server/index.js       routes, filter wiring, boot
server/tls.js         self-signed certificate handling
server/platform/      OS detection + per-OS WiFi backends
server/analysis/      Kalman/EWMA filters, path loss + RSSI grading
server/qr/            the startup QR code, encoder to terminal renderer
public/               the LCD UI (vanilla ES modules, no build step)
site/                 the landing page at signalboy.suryansh.work
```

## License

MIT
