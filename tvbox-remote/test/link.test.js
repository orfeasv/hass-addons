import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import { IDENTIFY, parseIdentity } from '../src/link.js';
import { parseArpA, parseProcArp } from '../src/neighbors.js';
import { makeBoxes, twoBoxes } from './fakes.js';

test('identity: serial, physical interfaces with MAC and current address', () => {
  const text = `SERIAL0001
==
dummy0 02:00:00:00:00:04
eth0 02:00:00:00:00:01
lo 00:00:00:00:00:00
p2p0 02:00:00:00:00:03
wlan0 02:00:00:00:00:02
==
1: lo    inet 127.0.0.1/8 scope host lo
3: eth0    inet 192.0.2.38/24 brd 192.0.2.255 scope global eth0\\       valid_lft forever
`;
  assert.ok(IDENTIFY.includes('ro.serialno'));
  assert.deepEqual(parseIdentity(text), {
    serial: 'SERIAL0001',
    links: [{ iface: 'eth0', mac: '02:00:00:00:00:01', ip: '192.0.2.38' }, { iface: 'wlan0', mac: '02:00:00:00:00:02', ip: null }],
  });
});

test('ARP tables from Linux and Windows', () => {
  const proc = 'IP address       HW type     Flags       HW address            Mask     Device\n'
    + '192.0.2.38     0x1         0x2         02:00:00:00:00:01     *        eth0\n'
    + '192.0.2.77     0x1         0x0         00:00:00:00:00:00     *        eth0\n';
  assert.deepEqual([...parseProcArp(proc)], [['02:00:00:00:00:01', '192.0.2.38']]);
  const win = 'Interface: 192.0.2.10 --- 0x5\n  Internet Address      Physical Address      Type\n'
    + '  192.0.2.38          02-00-00-00-00-01     dynamic   \n  192.0.2.255         ff-ff-ff-ff-ff-ff     static    \n';
  assert.deepEqual([...parseArpA(win)], [['02:00:00:00:00:01', '192.0.2.38']]);
});

test('the other link takes over when one goes down', async () => {
  const net = twoBoxes();
  const boxes = makeBoxes(net);
  const box = boxes.add({ host: '10.0.0.6' });
  await tick();
  assert.equal(boxes.view(box).via, 'Ethernet');
  net.devices[1].ifaces.eth0.ip = null; // cable unplugged; Wi-Fi (10.0.0.16) stays
  await box.remote.press('home');
  assert.equal(boxes.view(box).via, 'Wi-Fi');
  assert.equal(box.record.last, '10.0.0.16');
  assert.equal(box.record.links.find((l) => l.iface === 'eth0').ip, '10.0.0.6'); // last known address kept
});

test('a box that DHCP moved is found again by MAC after a scan', async () => {
  const net = twoBoxes();
  const boxes = makeBoxes(net);
  const box = boxes.add({ host: '10.0.0.5' });
  await tick();
  box.link.close();
  net.devices[0].ifaces.eth0.ip = '10.0.0.55';
  await box.remote.press('up');
  assert.equal(box.record.last, '10.0.0.55');
  assert.equal(net.devices[0].seen, true); // needed the scan to fill the ARP table
});

test('another device at a known address is never used', async () => {
  const net = twoBoxes();
  const boxes = makeBoxes(net);
  const box = boxes.add({ host: '10.0.0.5' });
  await tick();
  box.link.close();
  net.devices[0].ifaces.eth0.ip = null; // box A is gone…
  net.devices[1].ifaces.eth0.ip = '10.0.0.5'; // …and box B got its address
  await assert.rejects(box.remote.press('up'), /not found/);
  assert.equal(box.link.connected, false);
});

test('the same device added over a second link is merged into the first', async () => {
  const net = twoBoxes();
  const boxes = makeBoxes(net);
  const first = boxes.add({ host: '10.0.0.6', name: 'Bedroom' });
  await tick();
  boxes.add({ host: '10.0.0.16' }); // its Wi-Fi address
  await tick();
  assert.deepEqual(boxes.list().map((b) => [b.id, b.name, b.serial]), [[first.id, 'Bedroom', 'BBB']]);
});
