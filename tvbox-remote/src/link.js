// One box, several network paths (Ethernet, Wi-Fi). Picks a working address, checks it is still the same box
// (serial number), and finds the box again by MAC address when DHCP has moved it.

const ATTEMPT_MS = 1500; // per address; a box that is up answers well within this
const WIRED = /^(eth|en)/;
const PHYSICAL = /^(eth|en|wlan|wl)/;

/**
 * Serial, interfaces (MAC) and current IPv4 addresses, from the identify command's output.
 * @param {string} text
 */
export function parseIdentity(text) {
  const [serialPart = '', macPart = '', ipPart = ''] = text.split('==');
  const serial = serialPart.trim() || null;
  const ips = new Map();
  for (const m of ipPart.matchAll(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\//gm)) ips.set(m[1], m[2]);
  const links = [];
  for (const line of macPart.trim().split('\n')) {
    const [iface, mac] = line.trim().split(/\s+/);
    if (PHYSICAL.test(iface ?? '') && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac ?? '')) {
      links.push({ iface, mac, ip: ips.get(iface) ?? null });
    }
  }
  return { serial, links };
}

export const IDENTIFY = 'getprop ro.serialno; echo ==; for i in /sys/class/net/*; do echo ${i##*/} $(cat $i/address); done; echo ==; ip -o -4 addr show';

/** Readable name of a network interface. @param {string|null} iface */
export const linkLabel = (iface) => (!iface ? null : WIRED.test(iface) ? 'Ethernet' : 'Wi-Fi');

export class BoxLink {
  /**
   * @param {{record: {serial: string|null, port: number, links: {iface: string|null, mac: string|null, ip: string|null}[], last: string|null},
   *   client: import('./adb.js').AdbClient, neighbors: () => Promise<Map<string, string>>, scan: () => Promise<unknown>,
   *   onIdentity?: () => void, log?: (msg: string) => void}} options
   */
  constructor({ record, client, neighbors, scan, onIdentity = () => {}, log = () => {} }) {
    this.record = record;
    this.client = client;
    this.neighbors = neighbors;
    this.scan = scan;
    this.onIdentity = onIdentity;
    this.log = log;
    this.ensuring = null;
  }

  get connected() { return this.client.connected; }
  get banner() { return this.client.banner; }
  get awaitingApproval() { return this.client.awaitingApproval; }

  /** The interface the current connection uses. */
  get via() {
    if (!this.connected) return null;
    return this.record.links.find((l) => l.ip === this.client.host)?.iface ?? null;
  }

  /** Addresses to try: the last one that worked, then wired before wireless. */
  candidates() {
    const ordered = [...this.record.links].sort((a, b) => Number(WIRED.test(b.iface ?? '')) - Number(WIRED.test(a.iface ?? '')));
    const ips = [this.record.last, ...ordered.map((l) => l.ip)].filter(Boolean);
    return [...new Set(ips)];
  }

  /** Connects over the best working path; concurrent callers share one attempt. */
  ensure() {
    if (this.connected) return Promise.resolve();
    this.ensuring ??= this.find().finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  async find() {
    const tried = new Set();
    const tryAll = async (ips) => {
      for (const ip of ips) {
        if (tried.has(ip)) continue;
        tried.add(ip);
        if (await this.attempt(ip)) return true;
      }
      return false;
    };
    if (await tryAll(this.candidates())) return;

    // Moved (DHCP): look the known MAC addresses up, first in the current ARP table, then after a scan fills it
    const macs = this.record.links.map((l) => l.mac).filter(Boolean);
    if (macs.length) {
      const lookup = async () => {
        const table = await this.neighbors();
        return macs.map((mac) => table.get(mac)).filter(Boolean);
      };
      if (await tryAll(await lookup())) return;
      this.log('not at its known addresses: scanning the network');
      await this.scan();
      if (await tryAll(await lookup())) return;
    }
    throw new Error('box not found on the network');
  }

  /** Tries one address: connects, then checks the serial so a different device is never used by mistake. */
  async attempt(ip) {
    this.client.retarget(ip, this.record.port);
    try {
      await this.client.connect(ATTEMPT_MS);
    } catch (err) {
      // A box that asks for approval is the right address; waiting for the TV is not a reason to try another one
      if (/not accepted|authentication/.test(err.message)) throw err;
      return false;
    }
    const identity = parseIdentity(await this.client.shell(IDENTIFY).catch(() => ''));
    if (this.record.serial && identity.serial && identity.serial !== this.record.serial) {
      this.log(`${ip} is another device (serial ${identity.serial}), not this box`);
      this.client.close();
      return false;
    }
    this.update(identity, ip);
    return true;
  }

  /** Stores the serial and each interface's MAC and current address. */
  update(identity, ip) {
    const record = this.record;
    if (identity.serial) record.serial = identity.serial;
    if (identity.links.length) {
      record.links = identity.links.map((link) => ({
        ...link,
        ip: link.ip ?? record.links.find((old) => old.iface === link.iface)?.ip ?? null, // keep the last known address of an interface that is down
      }));
    }
    record.last = ip;
    this.log(`connected via ${linkLabel(this.via) ?? ip} (${ip})`);
    this.onIdentity();
  }

  async shell(command) {
    await this.ensure();
    try {
      return await this.client.shell(command);
    } catch (err) {
      if (this.client.connected) throw err;
      await this.ensure(); // the connection dropped: find the box again (maybe over the other link) and retry once
      return this.client.shell(command);
    }
  }

  close() {
    this.client.close();
  }
}
