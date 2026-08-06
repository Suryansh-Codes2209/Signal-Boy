import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

/**
 * Minimal static file serving and SSE plumbing.
 *
 * Signal Boy has no dependencies: sensor data flows server->browser over
 * Server-Sent Events (a built-in browser API) and commands flow back as JSON
 * POSTs. That covers everything here, including chat, without pulling in a
 * WebSocket library.
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export async function readJsonBody(req, limitBytes = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Serves a file from `root`, rejecting any path that escapes it.
 * Returns false when the file does not exist, so the caller can 404.
 */
export async function serveStatic(res, root, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  if (rel.split(/[/\\]/).includes('..')) {
    res.writeHead(403).end('forbidden');
    return true;
  }

  const filePath = join(root, rel);
  if (!filePath.startsWith(root + sep) && filePath !== root) {
    res.writeHead(403).end('forbidden');
    return true;
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  res.writeHead(200, {
    'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    // The UI is developed live and served locally; never cache it.
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
  return true;
}

/**
 * Upgrades a response to an SSE stream and returns a handle for pushing
 * events. Sends a comment line every 20s so proxies and sleeping phones do not
 * drop the connection.
 */
export function openEventStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  let closed = false;
  const keepAlive = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 20000);
  keepAlive.unref?.();

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    res.end();
  };

  req.on('close', close);

  return {
    send(event) {
      if (closed) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    get closed() {
      return closed;
    },
    close,
  };
}
