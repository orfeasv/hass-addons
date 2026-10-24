import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { makeBoxes, twoBoxes } from './fakes.js';

function call(app, method, url, body) {
  return new Promise((resolve) => {
    const req = { method, url, setEncoding() {}, on(event, fn) {
      if (event === 'data' && body) fn(typeof body === 'string' ? body : JSON.stringify(body));
      if (event === 'end') fn();
      return req;
    } };
    const res = { status: 0, writeHead(status) { this.status = status; }, end(data) {
      let json = null;
      try { json = JSON.parse(String(data)); } catch { /* not JSON */ }
      resolve({ status: this.status, json });
    } };
    app.handle(req, res);
  });
}

const scan = async () => [{ host: '10.0.0.5', port: 5555, adb: 'auth' }, { host: '10.0.0.6', port: 5555, adb: 'open', model: 'X' }];
const lastCommand = (boxes, id) => boxes.get(id).link.client.commands.at(-1);

test('boxes are saved, de-duplicated, renamed and removed', async () => {
  const boxes = makeBoxes();
  const a = boxes.add({ host: '10.0.0.5' });
  assert.equal(boxes.add({ host: '10.0.0.5', port: 5555 }).id, a.id);
  boxes.add({ host: '10.0.0.6', name: '  Living   room ' });
  assert.deepEqual(boxes.list().map((b) => b.name), ['10.0.0.5', 'Living room']);
  boxes.update(a.id, { name: '' });
  assert.equal(boxes.get(a.id).name, '10.0.0.5'); // empty name falls back to the address
  boxes.remove(a.id);
  await tick();
  assert.equal(boxes.boxes.size, 1);
  const saved = JSON.parse(readFileSync(boxes.file, 'utf8'));
  assert.deepEqual(saved.map((b) => [b.serial, b.links.map((l) => l.ip)]), [['BBB', ['10.0.0.6', '10.0.0.16']]]);
  assert.throws(() => boxes.add({ host: 'bad host;' }), RangeError);
});

test('saved boxes load again, also from the old single-host format', async () => {
  const boxes = makeBoxes();
  writeFileSync(boxes.file, JSON.stringify([{ id: 'a1', name: 'Old', host: '10.0.0.5', port: 5555 }]));
  boxes.load();
  assert.deepEqual(boxes.list().map((b) => [b.name, b.host]), [['Old', '10.0.0.5']]);
  await tick();
  const again = makeBoxes();
  again.file = boxes.file;
  again.load();
  assert.deepEqual(again.list().map((b) => [b.id, b.serial]), [['a1', 'AAA']]); // identified and saved meanwhile
});

test('API: add, list, press keys on the chosen box, rename, remove', async () => {
  const boxes = makeBoxes();
  const app = createApp({ config: { publicDir: '.', version: '0' }, boxes, publicKey: 'KEY x', scan });
  const added = (await call(app, 'POST', '/api/boxes', { host: '10.0.0.5' })).json;
  const second = (await call(app, 'POST', '/api/boxes', { host: '10.0.0.6', name: 'Bedroom' })).json;
  await tick();
  const list = (await call(app, 'GET', '/api/boxes')).json.boxes;
  assert.deepEqual(list.map((b) => [b.serial, b.via]), [['AAA', 'Ethernet'], ['BBB', 'Ethernet']]);

  assert.equal((await call(app, 'POST', `/api/boxes/${second.id}/key/home`)).status, 200);
  assert.match(lastCommand(boxes, second.id), /^dd if=.*\/102\.ev/);
  assert.equal((await call(app, 'POST', `/api/boxes/${second.id}/key/nope`)).status, 400);
  assert.equal((await call(app, 'POST', '/api/boxes/ffff/key/home')).status, 400);

  // short form for rest_command: first box unless ?box= is given
  assert.equal((await call(app, 'POST', '/api/key/ok')).status, 200);
  assert.match(lastCommand(boxes, added.id), /\/28\.ev/);
  assert.equal((await call(app, 'POST', `/api/key/back?box=${second.id}`)).status, 200);
  assert.match(lastCommand(boxes, second.id), /\/158\.ev/);
  assert.equal((await call(app, 'POST', `/api/boxes/${second.id}/text`, { text: 'hi' })).status, 200);

  assert.equal((await call(app, 'PATCH', `/api/boxes/${added.id}`, { name: 'Living room' })).json.name, 'Living room');
  assert.equal((await call(app, 'DELETE', `/api/boxes/${added.id}`)).status, 200);
  assert.equal(boxes.boxes.size, 1);
  assert.equal((await call(app, 'POST', '/api/boxes', { host: 'x; reboot' })).status, 400);
  assert.equal((await call(app, 'POST', '/api/boxes', { host: '10.0.0.7', port: 70000 })).status, 400);
});

test('API: scan marks boxes that are already added, also at a new address', async () => {
  const net = twoBoxes();
  const boxes = makeBoxes(net);
  const box = boxes.add({ host: '10.0.0.5' });
  await tick(); // identified: MACs known
  net.devices[0].ifaces.eth0.ip = '10.0.0.50'; // DHCP moved it
  net.devices[0].seen = true;
  const app = createApp({ config: { publicDir: '.', version: '0' }, boxes, publicKey: '',
    scan: async () => [{ host: '10.0.0.50', port: 5555, adb: 'auth' }, { host: '10.0.0.6', port: 5555, adb: 'auth' }] });
  const { found } = (await call(app, 'GET', '/api/scan')).json;
  assert.deepEqual(found.map((d) => d.added), [box.id, null]);
});
