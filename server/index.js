import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publish, subscribe, replay } from './bus.js';
import { serveStatic, sendJson, openEventStream } from './http.js';
import { platformInfo, hostPlatformId } from './platform/index.js';
import { readWifi, scanAccessPoints, startWifiPolling } from './sensors/wifi.js';
import { Kalman1D, Ewma } from '../public/js/core/filter.js';
import { applyFilters } from '../public/js/core/derive.js';
import { ensureCert, CERT_DIR } from './tls.js';
import { encodeQr } from './qr/index.js';
import { renderQr } from './qr/terminal.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 3000);
const WIFI_INTERVAL_MS = Number(process.env.SIGNALBOY_WIFI_INTERVAL ?? 1000);
const USE_HTTPS = process.env.SIGNALBOY_HTTPS === '1';

// One filter pair for the live stream. Kalman drives the displayed number
// (steady, converges on the true value); EWMA drives the sparkline (responsive
// enough to show you walking).
const kalman = new Kalman1D({ processNoise: 0.01, measurementNoise: 6 });
const ewma = new Ewma(0.3);

let latestWifi = null;

function onWifiReading(result) {
  // Same pipeline the APK runs locally in public/js/sources/native.js -- moved
  // to core/derive.js so tuning it once tunes it for both.
  latestWifi = applyFilters(result, { kalman, ewma });
  publish('wifi', latestWifi);
}

/** Every non-internal IPv4 address, so the user can reach the UI from a phone. */
function lanAddresses() {
  return Object.entries(networkInterfaces())
    .flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ ...a, name })))
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => ({ interface: a.name, address: a.address, cidr: a.cidr }));
}

const routes = {
  'GET /api/platform': (req, res) => sendJson(res, 200, platformInfo()),

  'GET /api/wifi': async (req, res) => sendJson(res, 200, latestWifi ?? (await readWifi())),

  'GET /api/wifi/aps': async (req, res) => sendJson(res, 200, await scanAccessPoints()),

  // Reports the port actually bound, which may not be PORT if it was taken.
  'GET /api/host': (req, res) =>
    sendJson(res, 200, {
      platform: hostPlatformId,
      port: server.address()?.port ?? PORT,
      addresses: lanAddresses(),
    }),

  'GET /api/stream': (req, res) => {
    const stream = openEventStream(req, res);
    // Catch the new client up on the latest value for every channel so the UI
    // paints immediately instead of waiting for the next poll tick.
    for (const event of replay()) stream.send(event);
    const unsubscribe = subscribe((event) => stream.send(event));
    req.on('close', unsubscribe);
  },
};

/** Assigned during boot; the /api/host route reads the port back off it. */
let server;

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    const handler = routes[key];
    if (handler) return await handler(req, res, url);

    if (req.method === 'GET' || req.method === 'HEAD') {
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      if (await serveStatic(res, PUBLIC_DIR, path)) return;
    }

    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
}

function announce(port) {
  const info = platformInfo();
  const scheme = USE_HTTPS ? 'https' : 'http';

  // Before any printing. This whole function runs inside a 'listening' handler,
  // where a throw is an uncaught exception -- so nothing to do with drawing a
  // banner may be able to leave the daemon dead, or alive with no sensor loop
  // and every browser stuck on WAITING FOR DAEMON.
  startWifiPolling(WIFI_INTERVAL_MS, onWifiReading);
  publish('platform', info);

  console.log(`\n  SIGNAL BOY  ->  platform ${info.label}${info.forced ? ' (forced)' : ''}`);
  console.log(`  local       ->  ${scheme}://localhost:${port}`);
  const addresses = lanAddresses();
  for (const { address, interface: iface } of addresses) {
    console.log(`  network     ->  ${scheme}://${address}:${port}  (${iface})`);
  }

  // Nobody wants to type an IP address on a phone keyboard. Only the first LAN
  // address gets a code -- printing one per interface would bury the banner.
  const [primary] = addresses;
  if (primary) {
    const url = `${scheme}://${primary.address}:${port}`;

    // The code is built before anything is printed, so a failure costs a QR
    // rather than half a banner. Skipped entirely when stdout is not a
    // terminal: `npx signalboy | tee run.log` would otherwise write ANSI
    // escapes and half-block glyphs into the log.
    let qr = null;
    if (process.stdout.isTTY) {
      try {
        qr = renderQr(encodeQr(url));
      } catch {
        qr = null;
      }
    }

    if (qr) {
      console.log('\n  Scan to open on your phone:\n');
      console.log(qr);
    }
    // Always printed, code or no code. lanAddresses() returns interfaces in
    // enumeration order, and on a developer machine the first is as likely to
    // be docker0, a WSL adapter or a VPN as the WiFi card -- so the encoded URL
    // has to be visible beside the code it encodes. If they disagree, that is
    // now something the user can see rather than a scan that goes nowhere.
    console.log(`\n  ${qr ? 'That code is' : 'Open on your phone:'}  ${url}  (${primary.interface})`);
  }

  if (USE_HTTPS) {
    console.log(`\n  Certificate is self-signed (${CERT_DIR}). Your phone will warn once;`);
    console.log('  accept it to unlock the camera, magnetometer and Web Bluetooth.');
  } else {
    console.log('\n  Phone sensors (camera, magnetometer, BLE) stay locked over plain HTTP.');
    console.log('  Restart with --https to enable them.');
  }
  console.log('');
}

/**
 * Builds the listener. Under --https the certificate has to cover every LAN
 * address up front, since that is what a phone will actually connect to and
 * browsers match the address against subjectAltName.
 */
async function createAppServer() {
  if (!USE_HTTPS) return createServer(handleRequest);

  const { key, cert, generated } = await ensureCert(lanAddresses().map((a) => a.address));
  if (generated) console.log(`  generated a self-signed certificate in ${CERT_DIR}`);
  return createSecureServer({ key, cert }, handleRequest);
}

/**
 * Binds on all interfaces so phones on the same WiFi can open the UI.
 *
 * Port 3000 is heavily contested by other dev servers, so walk forward a few
 * ports rather than dying -- the actual URL is printed on startup either way.
 */
const MAX_PORT_ATTEMPTS = 10;
const MAX_PORT = 65535;
let attempt = 0;
/** The port currently being tried, so error messages name the right one. */
let currentPort = PORT;

function die(...lines) {
  console.error(`\n  ${lines.join('\n  ')}\n`);
  process.exit(1);
}

// Checked before listening rather than caught afterwards: `--port abc` becomes
// NaN, and net.Server#listen throws ERR_SOCKET_BAD_PORT synchronously for that
// -- at module top level, where it would surface as a raw stack trace instead
// of the friendly message every other bad flag gets.
if (!Number.isInteger(PORT) || PORT < 0 || PORT > MAX_PORT) {
  die(
    `${JSON.stringify(process.env.PORT ?? '')} is not a port number.`,
    `--port takes a whole number from 0 to ${MAX_PORT}.`,
  );
}

try {
  server = await createAppServer();
} catch (err) {
  die(err.message);
}

server.on('error', (err) => {
  // Bind failures arrive here as events, so a bare `throw` would be an uncaught
  // exception with a stack trace. Each of these has a fix the user can act on.
  if (err.code === 'EACCES') {
    die(
      `Port ${currentPort} is reserved: binding it needs administrator privileges.`,
      'Pick a port above 1023 instead, for example --port 8080.',
    );
  }
  if (err.code !== 'EADDRINUSE') {
    die(`Could not bind ${currentPort}: ${err.message}`);
  }

  attempt += 1;
  const next = PORT + attempt;
  if (attempt >= MAX_PORT_ATTEMPTS || next > MAX_PORT) {
    die(`Ports ${PORT}-${currentPort} are all in use. Pass --port to choose one.`);
  }
  console.warn(`  port ${currentPort} in use, trying ${next}...`);
  currentPort = next;
  server.listen(next, '0.0.0.0');
});

server.on('listening', () => announce(server.address().port));
server.listen(PORT, '0.0.0.0');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
