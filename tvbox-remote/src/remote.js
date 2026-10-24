// Remote keys. On first use per connection the box is examined: the input device that best covers the remote's keys
// is picked, and each key is mapped through that device's own key layout (so layout overrides are respected).
// Keys found there are written as raw input events into the device (~15 ms on the box); the rest, and Sleep/Wake,
// go through Android's `input keyevent` (~1 s).

/** Remote keys and the Android key each one means (first match wins). */
export const KEYS = Object.freeze({
  up: ['DPAD_UP'],
  down: ['DPAD_DOWN'],
  left: ['DPAD_LEFT'],
  right: ['DPAD_RIGHT'],
  ok: ['DPAD_CENTER', 'ENTER'],
  back: ['BACK'],
  home: ['HOME'],
  menu: ['MENU'],
  volume_up: ['VOLUME_UP'],
  volume_down: ['VOLUME_DOWN'],
  mute: ['VOLUME_MUTE'],
  backspace: ['DEL'],
  sleep: ['SLEEP'],
  wake: ['WAKEUP'],
  ...Object.fromEntries([...'0123456789'].map((d) => [d, [d]])),
});

// Never injected as raw events: on some boxes these keys are handled by firmware (power off) rather than Android
const KEYEVENT_ONLY = new Set(['sleep', 'wake']);

const EVENT_DIR = '/data/local/tmp/tvremote';
const GENERIC_LAYOUT = /\/Generic\.kl$/;

/** One 24-byte struct input_event (64-bit: timeval, type, code, value), zero time (the kernel stamps it). */
function inputEvent(type, code, value) {
  const event = Buffer.alloc(24);
  event.writeUInt16LE(type, 16);
  event.writeUInt16LE(code, 18);
  event.writeInt32LE(value, 20);
  return event;
}

/** Press and release with sync reports: the 96 bytes written in one go for a key. */
export function keyPressBytes(code) {
  return Buffer.concat([inputEvent(1, code, 1), inputEvent(0, 0, 0), inputEvent(1, code, 0), inputEvent(0, 0, 0)]);
}

/**
 * Input devices from `dumpsys input` (Event Hub State): name, path and key layout file.
 * @param {string} dump
 */
export function parseInputDevices(dump) {
  const devices = [];
  let device = null;
  for (const line of dump.split('\n')) {
    if (/^Input Reader State/.test(line)) break;
    const head = line.match(/^ {4}-?\d+: (.*)$/);
    if (head) devices.push(device = { name: head[1].trim(), path: null, layout: null });
    const field = device && line.match(/^ {6}(Path|KeyLayoutFile): ?(.*)$/);
    if (field?.[1] === 'Path') device.path = field[2].trim();
    if (field?.[1] === 'KeyLayoutFile') device.layout = field[2].trim() || null;
  }
  return devices.filter((d) => d.path?.startsWith('/dev/input/') && d.layout);
}

/** Android key name → Linux code, from a .kl file (plain `key` lines only). @param {string} kl */
export function parseKeyLayout(kl) {
  const map = new Map();
  for (const line of kl.split('\n')) {
    const m = line.match(/^\s*key\s+(\d+)\s+([A-Z0-9_]+)/);
    if (m && !map.has(m[2])) map.set(m[2], Number(m[1]));
  }
  return map;
}

/** Key codes a device declares, from `getevent -p <path>`. @param {string} text */
export function parseCapabilities(text) {
  const block = text.match(/KEY \(0001\):([\s\S]*?)(?:\n\s+[A-Z]+ \(|\n\s*input props|$)/);
  return new Set((block?.[1].match(/\b[0-9a-f]{4}\b/g) ?? []).map((hex) => parseInt(hex, 16)));
}

/** Remote key → code on this device, for keys its layout maps and it declares. */
export function mapKeys(layout, capabilities) {
  const codes = {};
  for (const [name, androidKeys] of Object.entries(KEYS)) {
    if (KEYEVENT_ONLY.has(name)) continue;
    const code = androidKeys.map((k) => layout.get(k)).find((c) => c !== undefined && capabilities.has(c));
    if (code !== undefined) codes[name] = code;
  }
  return codes;
}

/** Single-quotes a string for the box's shell. */
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class Remote {
  /** @param {{adb: {shell(cmd: string): Promise<string>, connected: boolean, banner: string|null}, log?: (msg: string) => void}} options */
  constructor({ adb, log = () => {} }) {
    this.adb = adb;
    this.log = log;
    this.prepared = false;
    this.device = null; // {name, path}
    this.codes = {}; // remote key → Linux key code on that device
  }

  /** Picks the input device and writes one event file per key it covers; again after a reconnect. */
  async prepare() {
    if (this.prepared && this.adb.connected) return;
    const devices = parseInputDevices(await this.adb.shell('dumpsys input'));
    let best = null;
    for (const device of devices) {
      const out = await this.adb.shell(
        `test -w ${device.path} && cat ${shellQuote(device.layout)} && echo ==CAPS== && getevent -p ${device.path}`);
      const [kl, caps] = out.split('==CAPS==');
      if (caps === undefined) continue; // not writable by the adb shell
      const codes = mapKeys(parseKeyLayout(kl), parseCapabilities(caps));
      // most keys first; on a tie, a device with its own layout (a remote) over a generic keyboard
      const score = Object.keys(codes).length * 2 + (GENERIC_LAYOUT.test(device.layout) ? 0 : 1);
      if (!best || score > best.score) best = { device, codes, score };
    }
    this.device = best && Object.keys(best.codes).length >= 4 ? best.device : null;
    this.codes = this.device ? best.codes : {};
    if (this.device) {
      const files = Object.values(this.codes).map((code) =>
        `echo ${keyPressBytes(code).toString('base64')} | base64 -d > ${EVENT_DIR}/${code}.ev`);
      await this.adb.shell([`mkdir -p ${EVENT_DIR}`, ...files].join(' && '));
    }
    this.log(this.device
      ? `Keys through ${this.device.name} (${this.device.path}): ${Object.keys(this.codes).join(' ')}`
      : 'No suitable input device: all keys through input keyevent');
    this.prepared = true;
  }

  /** @param {string} name */
  async press(name) {
    if (!Object.hasOwn(KEYS, name)) throw new RangeError(`unknown key: ${name}`);
    await this.prepare();
    const code = this.codes[name];
    // dd writes the whole press in one write(); the evdev node rejects partial events
    await this.adb.shell(code !== undefined
      ? `dd if=${EVENT_DIR}/${code}.ev of=${this.device.path} bs=96 2>/dev/null`
      : `input keyevent KEYCODE_${KEYS[name][0]}`);
  }

  /** Types text into the focused field. @param {string} text */
  async type(text) {
    const clean = text.replace(/[\r\n\t]/g, ' ').slice(0, 500);
    if (!clean) return;
    // input text: spaces must be %s
    await this.adb.shell(`input text ${shellQuote(clean.replace(/ /g, '%s'))}`);
  }
}
