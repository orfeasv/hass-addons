// Network scan for adb: hosts with the port open, and whether they answer the adb handshake.
import net from 'node:net';
import os from 'node:os';
import { CMD, decodePackets, encodePacket } from './adb.js';

const MAX_HOSTS = 1024; // larger networks are cut to the /24 around our own address

/** @param {string} ip */
const toInt = (ip) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
/** @param {number} n */
const toIp = (n) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');

/**
 * Host addresses of the IPv4 networks this machine is on (each at most /22, otherwise its /24).
 * @param {ReturnType<typeof os.networkInterfaces>} interfaces
 */
export function localHosts(interfaces = os.networkInterfaces()) {
  const hosts = new Set();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = toInt(entry.address);
      let mask = toInt(entry.netmask);
      if (2 ** 32 - mask > MAX_HOSTS) mask = 0xffffff00;
      const network = (ip & mask) >>> 0;
      const broadcast = (network | (~mask >>> 0)) >>> 0;
      for (let n = network + 1; n < broadcast; n++) if (n !== ip) hosts.add(toIp(n));
    }
  }
  return [...hosts];
}

/**
 * Connects and sends CNXN. adb devices answer AUTH (authentication on) or CNXN (open, with a banner).
 * @param {string} host @param {number} port @param {number} timeoutMs
 * @returns {Promise<null | {host: string, port: number, adb: 'auth' | 'open' | 'no', model?: string}>}
 */
export function probe(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let result = null;
    const done = () => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, done);
    socket.on('connect', () => {
      result = { host, port, adb: 'no' };
      socket.write(encodePacket(CMD.CNXN, 0x01000000, 4096, Buffer.from('host::\0')));
    });
    socket.on('data', (chunk) => {
      try {
        const { packets, rest } = decodePackets(Buffer.concat([buffer, chunk]));
        buffer = rest;
        const packet = packets[0];
        if (packet?.command === CMD.AUTH) result.adb = 'auth';
        if (packet?.command === CMD.CNXN) {
          result.adb = 'open';
          result.model = packet.data.toString('utf8').match(/ro\.product\.model=([^;\0]*)/)?.[1];
        }
        if (packet) done();
      } catch {
        done(); // not adb
      }
    });
    socket.on('error', done);
    socket.on('close', done);
  });
}

/**
 * Probes every local host on the adb port, a batch at a time.
 * @param {{port?: number, hosts?: string[], concurrency?: number, timeoutMs?: number}} options
 */
export async function scan({ port = 5555, hosts = localHosts(), concurrency = 128, timeoutMs = 700 } = {}) {
  const found = [];
  for (let i = 0; i < hosts.length; i += concurrency) {
    const results = await Promise.all(hosts.slice(i, i + concurrency).map((host) => probe(host, port, timeoutMs)));
    found.push(...results.filter(Boolean));
  }
  return found.sort((a, b) => toInt(a.host) - toInt(b.host));
}
