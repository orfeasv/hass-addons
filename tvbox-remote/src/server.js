#!/usr/bin/env node
// TV Box Remote: a remote control for Android TV boxes over authenticated adb.
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { androidPublicKey } from './adb.js';
import { createApp } from './app.js';
import { Boxes } from './boxes.js';
import { loadConfig } from './config.js';
import { homeAssistantFromEnv } from './ha.js';
import { scan } from './scan.js';

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
boxes.load(config.boxHost, config.boxPort);

const app = createApp({ config, boxes, publicKey, scan: sharedScan });
const server = http.createServer(app.handle);
server.listen(config.port, config.host, () => {
  console.log(`TV Box Remote ${config.version}`);
  console.log(`  Open:   http://localhost:${config.port}/`);
  console.log(`  Boxes:  ${boxes.list().map((b) => `${b.name} (${b.host}:${b.port})`).join(', ') || 'none yet: add one on the remote page'}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  boxes.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
