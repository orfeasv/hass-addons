import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

// Env vars are set by the Home Assistant add-on's run.sh; /data persists the adb key and the boxes.
// https is off unless HTTPS_PORT, TLS_CERT and TLS_KEY are all set.
export function loadConfig(env = process.env) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  // outside the repository, so a development key can never be committed
  const keyFile = env.KEY_FILE || path.join(os.homedir(), '.tvbox-remote', 'adbkey.pem');

  return Object.freeze({
    version: pkg.version,
    port: parsePort(env.PORT) ?? 3400,
    host: env.HOST || '0.0.0.0',
    httpsPort: parsePort(env.HTTPS_PORT),
    tlsCert: env.TLS_CERT || null,
    tlsKey: env.TLS_KEY || null,
    boxPort: parsePort(env.BOX_PORT) ?? 5555,
    keyFile,
    boxesFile: path.join(path.dirname(keyFile), 'boxes.json'),
    publicDir: path.join(ROOT_DIR, 'public'),
  });
}
