import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

/**
 * Self-signed TLS for the local daemon.
 *
 * Phones are the reason this exists. When a phone opens the UI at
 * http://192.168.1.x:3000 the origin is plain HTTP and non-localhost, so
 * `window.isSecureContext` is false and the browser refuses getUserMedia, the
 * Magnetometer API and Web Bluetooth -- exactly the sensors a phone has and a
 * laptop does not. Serving the same page over HTTPS restores all of them.
 *
 * The certificate is self-signed, so the phone shows a warning once per device
 * and grants a secure context after you accept. Hosting the UI on a public
 * HTTPS origin instead would not work: that page could not reach this daemon
 * at all, because a secure page may not fetch a plain-HTTP LAN address.
 *
 * Generated with the openssl CLI rather than a library, because node:crypto
 * cannot sign an X.509 certificate and this project ships no dependencies.
 */

export const CERT_DIR = join(homedir(), '.signalboy');

const KEY_PATH = join(CERT_DIR, 'key.pem');
const CERT_PATH = join(CERT_DIR, 'cert.pem');
const META_PATH = join(CERT_DIR, 'cert.json');

/** Chrome rejects certificates valid for longer than 825 days. */
const VALID_DAYS = 825;

/**
 * Names the certificate must cover. Browsers match against subjectAltName and
 * ignore the common name entirely, so every address the daemon might be
 * reached on has to be listed here.
 */
function subjectAltNames(addresses) {
  const ips = [...new Set(['127.0.0.1', ...addresses])];
  return ['DNS:localhost', ...ips.map((ip) => `IP:${ip}`)];
}

async function readExistingCert(required) {
  try {
    const [key, cert, meta] = await Promise.all([
      readFile(KEY_PATH, 'utf8'),
      readFile(CERT_PATH, 'utf8'),
      readFile(META_PATH, 'utf8').then(JSON.parse),
    ]);
    // A laptop that moved to a different network needs a new certificate, or
    // the phone will refuse the IP it is actually connecting to.
    const covered = new Set(meta.sans ?? []);
    if (!required.every((name) => covered.has(name))) return null;
    if (new Date(meta.expires ?? 0) < new Date()) return null;
    return { key, cert, path: CERT_PATH, generated: false };
  } catch {
    return null;
  }
}

async function generateCert(sans) {
  try {
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-keyout',
      KEY_PATH,
      '-out',
      CERT_PATH,
      '-days',
      String(VALID_DAYS),
      '-subj',
      '/CN=signalboy',
      '-addext',
      `subjectAltName=${sans.join(',')}`,
    ]);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        'openssl was not found on PATH, so no certificate could be generated.\n' +
          '  macOS and Linux ship it; on Windows it comes with Git for Windows.\n' +
          '  Run without --https to serve over plain HTTP instead.',
      );
    }
    throw new Error(`openssl failed to generate a certificate: ${err.message}`);
  }

  // openssl writes the key with the ambient umask, which usually leaves it
  // world-readable. The directory is 0700, but narrow the key itself too.
  await chmod(KEY_PATH, 0o600);

  const expires = new Date(Date.now() + VALID_DAYS * 86400_000).toISOString();
  await writeFile(META_PATH, JSON.stringify({ sans, expires }, null, 2));

  const [key, cert] = await Promise.all([readFile(KEY_PATH, 'utf8'), readFile(CERT_PATH, 'utf8')]);
  return { key, cert, path: CERT_PATH, generated: true };
}

/**
 * Returns a key/cert pair covering `addresses`, reusing the stored one when it
 * already covers them so a phone only has to accept the warning once.
 */
export async function ensureCert(addresses = []) {
  const sans = subjectAltNames(addresses);
  await mkdir(CERT_DIR, { recursive: true, mode: 0o700 });

  const existing = await readExistingCert(sans);
  if (existing) return existing;

  return generateCert(sans);
}
