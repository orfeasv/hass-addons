import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ROOT_DIR } from '../src/config.js';
import { HomeAssistant } from '../src/ha.js';
import { pickInstallHost, watchTls } from '../src/tls.js';

const fixture = (name) => path.join(ROOT_DIR, 'test', 'fixtures', name);
const CERT = fs.readFileSync(fixture('tls-cert.pem'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { log() {}, warn() {} };

test('install host: Home Assistant\'s own name when the certificate covers it, else the certificate\'s name', () => {
  assert.equal(pickInstallHost(CERT, 'tvbox.example.test'), 'tvbox.example.test');
  assert.equal(pickInstallHost(CERT, 'ha.lan.example.test'), 'ha.lan.example.test'); // through the wildcard
  assert.equal(pickInstallHost(CERT, 'homeassistant.local'), 'tvbox.example.test'); // not covered: Chrome won't trust it
  assert.equal(pickInstallHost(CERT, null), 'tvbox.example.test');
  assert.equal(pickInstallHost(fs.readFileSync(fixture('tls-cert-no-names.pem')), 'homeassistant.local'), null);
  assert.equal(pickInstallHost('not a certificate', 'x'), null);
});

test('Home Assistant\'s host name comes from its internal URL, else the external one', async () => {
  const ha = (config) => new HomeAssistant({ url: 'http://ha', token: 'T', fetch: async () => ({ ok: true, json: async () => config }) });
  assert.equal(await ha({ internal_url: 'https://ha.lan.example.test:8123', external_url: 'https://x.example.test' }).internalHost(), 'ha.lan.example.test');
  assert.equal(await ha({ internal_url: null, external_url: 'https://x.example.test' }).internalHost(), 'x.example.test');
  assert.equal(await ha({}).internalHost(), null);
  assert.equal(await new HomeAssistant({}).internalHost(), null);
});

let dir;
let config;
let loads;
let stop;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvbox-tls-'));
  config = { tlsCert: path.join(dir, 'cert.pem'), tlsKey: path.join(dir, 'key.pem') };
  fs.copyFileSync(fixture('tls-cert.pem'), config.tlsCert);
  fs.copyFileSync(fixture('tls-key.pem'), config.tlsKey);
  loads = [];
});

afterEach(() => {
  stop?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a renewed certificate is loaded into the running server', async () => {
  stop = watchTls({ setSecureContext: (options) => loads.push(options) }, config, { intervalMs: 20, logger: silent });
  await wait(80);
  assert.equal(loads.length, 0);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(config.tlsCert, later, later);
  await wait(80);
  assert.equal(loads.length, 1);
  assert.deepEqual(loads[0].cert, fs.readFileSync(config.tlsCert));
});

test('a certificate that is being replaced is tried again, keeping the old one meanwhile', async () => {
  let fail = true;
  const fussy = { setSecureContext: (options) => { if (fail) throw new Error('key does not match'); loads.push(options); } };
  stop = watchTls(fussy, config, { intervalMs: 20, logger: silent });
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(config.tlsCert, later, later);
  await wait(80);
  assert.equal(loads.length, 0);
  fail = false;
  await wait(80);
  assert.equal(loads.length, 1);
});
