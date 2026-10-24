// Test stand-ins: a small network of boxes (by IP) and an adb client that talks to it, never to a real network.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Boxes } from '../src/boxes.js';

const DUMPSYS = 'Event Hub State:\n    1: ir\n      Path: /dev/input/event0\n      KeyLayoutFile: /ir.kl\n';
const IR = 'key 28 ENTER\nkey 158 BACK\nkey 102 HOME\nkey 103 DPAD_UP\n==CAPS==\n    KEY (0001): 001c  0066  0067  009e\n';

/**
 * A network: ip → device. A device has a serial and interfaces {eth0: {mac, ip}, wlan0: {mac, ip}}; an interface
 * with ip null is down. Change ips in place to simulate DHCP or an unplugged cable.
 */
export function fakeNetwork(devices) {
  const at = (ip) => devices.find((d) => Object.values(d.ifaces).some((i) => i.ip === ip));
  return {
    devices,
    at,
    /** MAC → IP, like the host's ARP table */
    async neighbors() {
      const table = new Map();
      for (const d of devices) for (const i of Object.values(d.ifaces)) if (i.ip && d.seen) table.set(i.mac, i.ip);
      return table;
    },
    /** a scan "sees" every device, filling the ARP table */
    async scan() {
      for (const d of devices) d.seen = true;
      return [];
    },
    createClient({ host, port }) {
      return {
        host, port, banner: null, awaitingApproval: false, commands: [],
        get connected() { return this.banner !== null && at(this.host) !== undefined; },
        retarget(h, p = this.port) { if (h !== this.host) this.close(); this.host = h; this.port = p; },
        async connect() {
          if (!at(this.host)) throw new Error(`adb: no answer from ${this.host}:${this.port}`);
          this.banner = 'device::';
        },
        async shell(cmd) {
          const device = at(this.host);
          if (!device || this.banner === null) throw new Error('adb: connection closed');
          this.commands.push(cmd);
          if (cmd.startsWith('getprop ro.serialno')) {
            const macs = Object.entries(device.ifaces).map(([n, i]) => `${n} ${i.mac}`).join('\n');
            const ips = Object.entries(device.ifaces).filter(([, i]) => i.ip)
              .map(([n, i], k) => `${k + 2}: ${n}    inet ${i.ip}/24 brd x scope global ${n}`).join('\n');
            return `${device.serial}\n==\nlo 00:00:00:00:00:00\n${macs}\n==\n1: lo    inet 127.0.0.1/8 scope host lo\n${ips}\n`;
          }
          if (cmd.startsWith('getprop ro.product.model')) return `${device.model ?? 'box'}\n`;
          if (cmd === 'dumpsys input') return DUMPSYS;
          if (cmd.startsWith('test -w')) return IR;
          return '';
        },
        close() { this.banner = null; },
      };
    },
  };
}

/** Two boxes with Ethernet and Wi-Fi each. */
export function twoBoxes() {
  return fakeNetwork([
    { serial: 'AAA', model: 'rk3566', ifaces: { eth0: { mac: 'aa:00:00:00:00:01', ip: '10.0.0.5' }, wlan0: { mac: 'aa:00:00:00:00:02', ip: null } } },
    { serial: 'BBB', model: 'tv', ifaces: { eth0: { mac: 'bb:00:00:00:00:01', ip: '10.0.0.6' }, wlan0: { mac: 'bb:00:00:00:00:02', ip: '10.0.0.16' } } },
  ]);
}

/** A box list on a fake network, saved in a fresh temporary folder. */
export function makeBoxes(net = twoBoxes()) {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'tvbox-')), 'boxes.json');
  return new Boxes({ file, privateKey: null, keyName: 'k', createClient: (o) => net.createClient(o),
    neighbors: () => net.neighbors(), scan: () => net.scan(), log: () => {} });
}
