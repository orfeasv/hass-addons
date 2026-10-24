// The boxes the remote controls, saved in boxes.json. A box is one device (serial number) with one or more network
// links (Ethernet, Wi-Fi); every box uses the add-on's single adb key, whichever link it is reached over. A box can
// also be linked to its Android TV Remote pairing in Home Assistant (a remote.* entity), which is then tried first.
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { AdbClient } from './adb.js';
import { BoxLink, linkLabel } from './link.js';
import { neighbors as readNeighbors } from './neighbors.js';
import { Remote } from './remote.js';

export const HOST_RE = /^[a-zA-Z0-9.-]{1,253}$/; // IPv4 address or host name
export const ENTITY_RE = /^remote\.[a-z0-9_]+$/;
const NAME_MAX = 40;

/** @param {unknown} name @param {string} fallback */
function cleanName(name, fallback) {
  const text = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
  return text || fallback;
}

/** Saved form of a box; older files had a single host. */
function normalizeRecord(raw) {
  const links = Array.isArray(raw.links) ? raw.links.filter((l) => l && (HOST_RE.test(l.ip ?? '') || l.mac))
    : HOST_RE.test(raw.host ?? '') ? [{ iface: null, mac: null, ip: raw.host }] : [];
  return {
    id: raw.id, name: raw.name, serial: raw.serial ?? null, port: Number(raw.port) || 5555,
    links: links.map((l) => ({ iface: l.iface ?? null, mac: l.mac ?? null, ip: l.ip ?? null })),
    last: raw.last ?? links[0]?.ip ?? null,
    entity: ENTITY_RE.test(raw.entity ?? '') ? raw.entity : null,
  };
}

export class Boxes {
  /**
   * @param {{file: string, privateKey: import('node:crypto').KeyObject, keyName: string,
   *   createClient?: (options: object) => AdbClient, neighbors?: () => Promise<Map<string, string>>,
   *   scan?: () => Promise<unknown>, ha?: import('./ha.js').HomeAssistant, log?: (msg: string) => void}} options
   */
  constructor({ file, privateKey, keyName, createClient = (o) => new AdbClient(o), neighbors = readNeighbors,
    scan = async () => [], ha = null, log = console.log }) {
    this.ha = ha;
    this.file = file;
    this.privateKey = privateKey;
    this.keyName = keyName;
    this.createClient = createClient;
    this.neighbors = neighbors;
    this.scan = scan;
    this.log = log;
    /** @type {Map<string, {id: string, name: string, record: object, link: BoxLink, remote: Remote, model: string|null}>} */
    this.boxes = new Map();
  }

  /** Loads the saved boxes. */
  load() {
    let saved = [];
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      // first start
    }
    for (const raw of Array.isArray(saved) ? saved : []) {
      if (typeof raw?.id !== 'string') continue;
      const record = normalizeRecord(raw);
      if (record.links.length) this.attach(record);
    }
  }

  attach(record) {
    const name = cleanName(record.name, record.links[0]?.ip ?? 'TV Box');
    const log = (msg) => this.log(`${this.boxes.get(record.id)?.name ?? name}: ${msg}`);
    const client = this.createClient({ host: record.last, port: record.port, privateKey: this.privateKey, keyName: this.keyName });
    const link = new BoxLink({ record, client, neighbors: this.neighbors, scan: this.scan, log,
      onIdentity: () => this.identified(record.id) });
    // Android TV Remote through Home Assistant, when this box is linked to an available remote entity
    const atv = { send: async (androidKey) => {
      if (!record.entity || !this.ha?.enabled || !(await this.ha.available(record.entity))) return false;
      await this.ha.sendCommand(record.entity, androidKey);
      return true;
    } };
    const box = { id: record.id, name, record, link, remote: new Remote({ adb: link, log, atv }), model: null };
    this.boxes.set(record.id, box);
    this.connect(box);
    return box;
  }

  /** Connects in the background, so a new box shows its "Allow debugging?" prompt right away. */
  connect(box) {
    box.link.ensure().then(
      async () => {
        box.model = (await box.link.shell('getprop ro.product.model').catch(() => '')).trim() || null;
      },
      (err) => this.log(`${box.name}: not connected yet: ${err.message}`),
    );
  }

  /** After a box identifies itself: save, and fold it into an existing box with the same serial. */
  identified(id) {
    const box = this.boxes.get(id);
    if (!box) return;
    const twin = [...this.boxes.values()].find((b) => b.id !== id && b.record.serial && b.record.serial === box.record.serial);
    if (twin) {
      // the same device added twice (e.g. once over Wi-Fi): keep the older entry, with the fresh identity
      this.log(`${box.name} is ${twin.name} over another link: merged`);
      twin.record.links = box.record.links;
      twin.record.last = box.record.last;
      box.link.close();
      this.boxes.delete(id);
      box.mergedInto = twin.id;
    }
    this.save();
  }

  save() {
    const data = [...this.boxes.values()].map(({ name, record }) => ({ ...record, name }));
    writeFileSync(`${this.file}.tmp`, JSON.stringify(data, null, 1));
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** @param {{host: string, port?: number, name?: string}} spec */
  add({ host, port = 5555, name }) {
    if (typeof host !== 'string' || !HOST_RE.test(host)) throw new RangeError('invalid host');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('invalid port');
    const existing = this.findByAddress(host);
    if (existing) return existing;
    const record = { id: randomBytes(4).toString('hex'), name, serial: null, port, links: [{ iface: null, mac: null, ip: host }], last: host };
    const box = this.attach(record);
    this.save();
    return box;
  }

  /** @param {string} ip @param {Map<string, string>} [table] MAC → IP, to match a box that moved */
  findByAddress(ip, table) {
    const boxes = [...this.boxes.values()];
    const byIp = boxes.find((b) => b.record.links.some((l) => l.ip === ip));
    if (byIp || !table) return byIp;
    return boxes.find((b) => b.record.links.some((l) => l.mac && table.get(l.mac) === ip));
  }

  /** @param {string} id */
  get(id) {
    const box = this.boxes.get(id);
    if (!box) throw new RangeError('unknown box');
    return box;
  }

  /** The box used when an API call names none: the first one added. */
  first() {
    const box = this.boxes.values().next().value;
    if (!box) throw new RangeError('no box added yet');
    return box;
  }

  /** Renames a box and/or links it to an Android TV Remote entity (null unlinks). */
  update(id, { name, entity }) {
    const box = this.get(id);
    if (name !== undefined) box.name = cleanName(name, box.record.links[0]?.ip ?? box.name);
    if (entity !== undefined) {
      if (entity !== null && !ENTITY_RE.test(entity)) throw new RangeError('invalid entity');
      box.record.entity = entity;
    }
    this.save();
    return box;
  }

  remove(id) {
    const box = this.get(id);
    box.link.close();
    this.boxes.delete(id);
    this.save();
  }

  /** Public view of one box. */
  view(box) {
    const { record, link } = box;
    return {
      id: box.id, name: box.name, model: box.model, serial: record.serial, port: record.port,
      host: link.connected ? link.client.host : record.last,
      via: linkLabel(link.via),
      links: record.links.map((l) => ({ type: linkLabel(l.iface), ip: l.ip, mac: l.mac })),
      connected: link.connected, awaitingApproval: link.awaitingApproval,
      entity: record.entity, route: box.remote.route,
    };
  }

  list() {
    return [...this.boxes.values()].map((b) => this.view(b));
  }

  closeAll() {
    for (const box of this.boxes.values()) box.link.close();
  }
}
