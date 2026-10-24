// The host's ARP table: which IP address each MAC address has right now. Lets a box be found again after DHCP
// gives it a new address. Linux (Home Assistant) reads /proc/net/arp; Windows (development) parses `arp -a`.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** @param {string} mac */
export const normalizeMac = (mac) => mac.toLowerCase().replace(/-/g, ':');

/** @param {string} text /proc/net/arp → Map<mac, ip> (complete entries only) */
export function parseProcArp(text) {
  const table = new Map();
  for (const line of text.split('\n').slice(1)) {
    const [ip, , flags, mac] = line.trim().split(/\s+/);
    if (ip && mac && flags !== '0x0' && mac !== '00:00:00:00:00:00') table.set(normalizeMac(mac), ip);
  }
  return table;
}

/** @param {string} text `arp -a` output (Windows) → Map<mac, ip> */
export function parseArpA(text) {
  const table = new Map();
  for (const m of text.matchAll(/^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+dynamic/gim)) {
    table.set(normalizeMac(m[2]), m[1]);
  }
  return table;
}

/** Current MAC → IP table; empty if it can't be read. */
export async function neighbors() {
  try {
    if (process.platform === 'win32') {
      const stdout = await new Promise((resolve, reject) =>
        execFile('arp', ['-a'], { windowsHide: true }, (err, out) => (err ? reject(err) : resolve(out))));
      return parseArpA(stdout);
    }
    return parseProcArp(await readFile('/proc/net/arp', 'utf8'));
  } catch {
    return new Map();
  }
}
