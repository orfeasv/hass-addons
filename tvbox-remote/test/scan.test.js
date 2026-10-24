import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { CMD, encodePacket } from '../src/adb.js';
import { localHosts, probe, scan } from '../src/scan.js';

test('local hosts cover each IPv4 network without our own, network and broadcast addresses', () => {
  const hosts = localHosts({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    eth0: [{ family: 'IPv4', internal: false, address: '192.0.2.10', netmask: '255.255.255.0' },
      { family: 'IPv6', internal: false, address: 'fe80::1', netmask: 'ffff::' }],
    docker: [{ family: 'IPv4', internal: false, address: '10.1.2.3', netmask: '255.0.0.0' }], // too big: its /24
  });
  assert.equal(hosts.length, 253 + 253);
  assert.ok(hosts.includes('192.0.2.1') && hosts.includes('192.0.2.254') && !hosts.includes('192.0.2.10'));
  assert.ok(hosts.includes('10.1.2.1') && !hosts.includes('10.1.3.1'));
});

/** @param {(socket: net.Socket) => void} onConnection */
function listen(onConnection) {
  const server = net.createServer(onConnection);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('probe tells adb with authentication, open adb and other services apart', async () => {
  const auth = await listen((s) => s.once('data', () => s.write(encodePacket(CMD.AUTH, 1, 0, Buffer.alloc(20)))));
  const open = await listen((s) => s.once('data', () =>
    s.write(encodePacket(CMD.CNXN, 0x01000000, 4096, Buffer.from('device::ro.product.name=x;ro.product.model=rk3566;\0')))));
  const other = await listen((s) => s.once('data', () => s.end('HTTP/1.0 400 Bad Request\r\n\r\n')));
  assert.equal((await probe('127.0.0.1', auth.address().port)).adb, 'auth');
  assert.deepEqual(await probe('127.0.0.1', open.address().port), { host: '127.0.0.1', port: open.address().port, adb: 'open', model: 'rk3566' });
  assert.equal((await probe('127.0.0.1', other.address().port)).adb, 'no');
  [auth, open, other].forEach((s) => s.close());
});

test('scan returns only hosts with the port open', async () => {
  const auth = await listen((s) => s.once('data', () => s.write(encodePacket(CMD.AUTH, 1, 0, Buffer.alloc(20)))));
  const found = await scan({ port: auth.address().port, hosts: ['127.0.0.1', '127.0.0.2'], timeoutMs: 300 });
  // 127.0.0.2 also reaches the listener on some systems; every result must be the adb listener
  assert.ok(found.length >= 1 && found.every((d) => d.adb === 'auth'));
  auth.close();
});
