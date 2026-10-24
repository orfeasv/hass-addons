#!/usr/bin/env node
// TV Box Remote: a remote control for Android TV boxes over authenticated adb.
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { androidPublicKey } from './adb.js';
import { createApp } from './app.js';
import { Boxes } from './boxes.js';
import { loadConfig } from './config.js';
import { homeAssistantFromEnv } from './ha.js';
import { scan } from './scan.js';
import { pickInstallHost, readTls, watchTls } from './tls.js';

const config = loadConfig();
mkdirSync(path.dirname(config.keyFile), { recursive: true });

// One key per installation, kept in /data: each box trusts it after one "Allow debugging?" on its TV
if (!existsSync(config.keyFile)) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(config.keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`New adb key in ${config.keyFile}`);
}
const privateKey = crypto.createPrivateKey(readFileSync(config.keyFile));
const keyName = 'tvbox-remote@homeassistant';
const publicKey = androidPublicKey(crypto.createPublicKey(privateKey), keyName);

// One network scan at a time, shared by the page's "Find boxes" and by boxes looking for a moved link
let scanning = null;
const sharedScan = () => (scanning ??= scan({ port: config.boxPort }).finally(() => { scanning = null; }));

const ha = homeAssistantFromEnv();
const boxes = new Boxes({ file: config.boxesFile, privateKey, keyName, scan: sharedScan, ha });
boxes.load();

// The https address Chrome installs the app from: a name the certificate is valid for, else Home Assistant's
// own internal URL host (which then has to be covered by the certificate too)
const install = { url: null };

const app = createApp({ config, boxes, publicKey, scan: sharedScan, install });
const servers = [http.createServer(app.handle)];
servers[0].listen(config.port, config.host, () => {
  console.log(`TV Box Remote ${config.version}`);
  console.log(`  Open:     http://localhost:${config.port}/`);
  console.log(`  Boxes:    ${boxes.list().map((b) => `${b.name} (${b.host}:${b.port})`).join(', ') || 'none yet: add one on the remote page'}`);
});

// Optional https, so Chrome can install the remote as an app
if (config.httpsPort && config.tlsCert && config.tlsKey) {
  try {
    const tls = readTls(config);
    const secure = https.createServer(tls, app.handle);
    secure.on('error', (err) => console.warn(`https not available: ${err.message}`));
    secure.listen(config.httpsPort, config.host, () => console.log(`  Secure:   https on port ${config.httpsPort}`));
    watchTls(secure, config);
    servers.push(secure);
    resolveInstallUrl(tls.cert).then((url) => {
      install.url = url;
      console.log(url ? `  Install:  ${url} (Chrome: ⋮ → Install app)` : '  Install:  the certificate names no host; open https://<its domain>:' + config.httpsPort + '/');
    });
  } catch (err) {
    console.warn(`https not available: ${err.message}`);
  }
}

/** @param {Buffer} cert */
async function resolveInstallUrl(cert) {
  // the name Home Assistant itself is reached by, when the certificate covers it; else the certificate's first name
  const internal = await ha.internalHost().catch(() => null);
  const host = pickInstallHost(cert, internal);
  return host ? `https://${host}:${config.httpsPort}/` : null;
}

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  boxes.closeAll();
  let open = servers.length;
  for (const server of servers) server.close(() => { if (--open === 0) process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
