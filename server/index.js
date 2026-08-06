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
import { gradeRssi, qualityPercent } from '../public/js/core/pathloss.js';
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
  if (!result.ok) {
    kalman.reset();
    ewma.reset();
    latestWifi = result;
    publish('wifi', result);
    return;
  }

  const filtered = kalman.update(result.rssi);
  const smoothed = ewma.update(result.rssi);
  const grade = gradeRssi(filtered);

  latestWifi = {
    ...result,
    filtered,
    smoothed,
    // Named qualityBand, not band: `band` already means the radio frequency
    // band (2.4/5/6GHz) on the reading and must not be clobbered.
    qualityBand: grade?.key ?? null,
    bandLabel: grade?.label ?? null,
    shade: grade?.shade ?? 0,
    quality: qualityPercent(filtered),
    variance: kalman.variance,
  };
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
    console.log('\n  Scan to open on your phone:\n');
    console.log(renderQr(encodeQr(`${scheme}://${primary.address}:${port}`)));
  }

  if (USE_HTTPS) {
    console.log(`\n  Certificate is self-signed (${CERT_DIR}). Your phone will warn once;`);
    console.log('  accept it to unlock the camera, magnetometer and Web Bluetooth.');
  } else {
    console.log('\n  Phone sensors (camera, magnetometer, BLE) stay locked over plain HTTP.');
    console.log('  Restart with --https to enable them.');
  }
  console.log('');

  startWifiPolling(WIFI_INTERVAL_MS, onWifiReading);
  publish('platform', info);
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
let attempt = 0;

try {
  server = await createAppServer();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  attempt += 1;
  if (attempt >= MAX_PORT_ATTEMPTS) {
    console.error(`\n  Ports ${PORT}-${PORT + attempt - 1} are all in use. Set PORT to choose one.\n`);
    process.exit(1);
  }
  const next = PORT + attempt;
  console.warn(`  port ${next - 1} in use, trying ${next}...`);
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
