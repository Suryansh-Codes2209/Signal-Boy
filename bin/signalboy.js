#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CLI entrypoint.
 *
 * Flags are translated into environment variables and the server module is
 * imported for its side effect of listening. Keeping the server env-driven
 * means `npm start` and `npx signalboy` take exactly the same code path.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HELP = `
  Signal Boy -- WiFi survey and RF tool that runs on your own machine.

  Usage
    npx signalboy [options]

  Options
    --https           Serve over HTTPS with a self-signed certificate.
                      Needed for camera, magnetometer and Web Bluetooth
                      when you open the UI on a phone over the LAN.
    --port <number>   Port to bind (default 3000, walks forward if taken).
    --interval <ms>   WiFi poll interval (default 1000).
    --platform <id>   Force a backend: darwin | win32 | linux.
    -v, --version     Print the version.
    -h, --help        Print this message.

  Readings come from the machine running this command. Open the printed
  network URL on a phone to carry the display around while you survey.
`;

function parseArgs(argv) {
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`${arg} needs a value`);
      }
      i += 1;
      return next;
    };

    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '--https':
        options.https = true;
        break;
      case '--port':
        options.port = value();
        break;
      case '--interval':
        options.interval = value();
        break;
      case '--platform':
        options.platform = value();
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }

  return options;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`\n  ${err.message}\n  Run with --help to see the options.\n`);
  process.exit(1);
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

if (options.version) {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

if (options.https) process.env.SIGNALBOY_HTTPS = '1';
if (options.port) process.env.PORT = options.port;
if (options.interval) process.env.SIGNALBOY_WIFI_INTERVAL = options.interval;
if (options.platform) process.env.SIGNALBOY_PLATFORM = options.platform;

await import('../server/index.js');
