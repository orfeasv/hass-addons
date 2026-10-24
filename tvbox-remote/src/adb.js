// Minimal adb client over TCP: CNXN (with RSA key authentication), then one OPEN/WRTE/CLSE stream per shell command.
import crypto from 'node:crypto';
import net from 'node:net';

export const CMD = Object.freeze({
  CNXN: 0x4e584e43,
  AUTH: 0x48545541,
  OPEN: 0x4e45504f,
  OKAY: 0x59414b4f,
  CLSE: 0x45534c43,
  WRTE: 0x45545257,
});

const VERSION = 0x01000000; // protocol version that still expects payload checksums
const MAX_DATA = 256 * 1024;
const HEADER = 24;

// AUTH packet types (arg0)
const AUTH_TOKEN = 1;
const AUTH_SIGNATURE = 2;
const AUTH_RSAPUBLICKEY = 3;

// adbd verifies the token with RSA_verify(NID_sha1): PKCS#1 v1.5 over a SHA-1 DigestInfo whose digest is the token
const SHA1_DIGEST_INFO = Buffer.from('3021300906052b0e03021a05000414', 'hex');

/** @param {Buffer} token @param {crypto.KeyObject} privateKey */
export function signToken(token, privateKey) {
  return crypto.privateEncrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.concat([SHA1_DIGEST_INFO, token]),
  );
}

/** @param {bigint} value @param {number} words */
function toWordsLE(value, words) {
  const buffer = Buffer.alloc(words * 4);
  for (let i = 0; i < words; i++) {
    buffer.writeUInt32LE(Number(value & 0xffffffffn), i * 4);
    value >>= 32n;
  }
  return buffer;
}

/** @param {bigint} base @param {bigint} exponent @param {bigint} modulus */
function powMod(base, exponent, modulus) {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

/**
 * Public key in Android's adb_keys format: base64 of {words, n0inv, modulus, rr, exponent} (little-endian u32s) + " name".
 * @param {crypto.KeyObject} publicKey @param {string} name
 */
export function androidPublicKey(publicKey, name) {
  const jwk = publicKey.export({ format: 'jwk' });
  const n = BigInt('0x' + Buffer.from(jwk.n, 'base64url').toString('hex'));
  const e = Number(BigInt('0x' + Buffer.from(jwk.e, 'base64url').toString('hex')));
  const words = 64; // 2048-bit key
  const n0 = n & 0xffffffffn;
  const n0inv = (2n ** 32n - powMod(n0, 2n ** 31n - 1n, 2n ** 32n)) % 2n ** 32n; // -1/n0 mod 2^32 (n0 is odd)
  const rr = powMod(2n, BigInt(words * 32 * 2), n);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(words, 0);
  header.writeUInt32LE(Number(n0inv), 4);
  const exponent = Buffer.alloc(4);
  exponent.writeUInt32LE(e, 0);
  const blob = Buffer.concat([header, toWordsLE(n, words), toWordsLE(rr, words), exponent]);
  return `${blob.toString('base64')} ${name}`;
}

/** @param {number} command @param {number} arg0 @param {number} arg1 @param {Buffer} [data] */
export function encodePacket(command, arg0, arg1, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(HEADER);
  let checksum = 0;
  for (const byte of data) checksum = (checksum + byte) >>> 0;
  header.writeUInt32LE(command, 0);
  header.writeUInt32LE(arg0 >>> 0, 4);
  header.writeUInt32LE(arg1 >>> 0, 8);
  header.writeUInt32LE(data.length, 12);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([header, data]);
}

/**
 * Splits complete packets off the front of a buffer.
 * @param {Buffer} buffer
 * @returns {{ packets: {command: number, arg0: number, arg1: number, data: Buffer}[], rest: Buffer }}
 */
export function decodePackets(buffer) {
  const packets = [];
  let offset = 0;
  while (buffer.length - offset >= HEADER) {
    // check the header before waiting for a payload, so non-adb data fails at once
    const command = buffer.readUInt32LE(offset);
    if (((command ^ 0xffffffff) >>> 0) !== buffer.readUInt32LE(offset + 20)) throw new Error('adb: bad packet magic');
    const length = buffer.readUInt32LE(offset + 12);
    if (buffer.length - offset < HEADER + length) break;
    packets.push({
      command,
      arg0: buffer.readUInt32LE(offset + 4),
      arg1: buffer.readUInt32LE(offset + 8),
      data: buffer.subarray(offset + HEADER, offset + HEADER + length),
    });
    offset += HEADER + length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

export class AdbClient {
  /**
   * @param {{host: string, port: number, privateKey: crypto.KeyObject, keyName?: string,
   *   timeoutMs?: number, approvalTimeoutMs?: number}} options
   * approvalTimeoutMs: how long to wait while someone accepts the key on the TV the first time.
   */
  constructor({ host, port, privateKey, keyName = 'tvbox-remote@homeassistant', timeoutMs = 5000, approvalTimeoutMs = 60000 }) {
    this.host = host;
    this.port = port;
    this.privateKey = privateKey;
    this.keyName = keyName;
    this.timeoutMs = timeoutMs;
    this.approvalTimeoutMs = approvalTimeoutMs;
    /** true while the box shows its "Allow debugging?" prompt for our key */
    this.awaitingApproval = false;
    this.socket = null;
    this.connecting = null;
    this.nextLocalId = 1;
    /** @type {Map<number, {remoteId: number, chunks: Buffer[], resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.streams = new Map();
    this.banner = null;
  }

  get connected() {
    return this.socket !== null && this.banner !== null;
  }

  /** Points the client at another address; takes effect on the next connect. */
  retarget(host, port = this.port) {
    if (host === this.host && port === this.port) return;
    this.close();
    this.host = host;
    this.port = port;
  }

  /**
   * Connects once; concurrent callers share the same attempt.
   * @param {number} [timeoutMs] how long to wait for the box to answer (not for approval on the TV)
   */
  connect(timeoutMs = this.timeoutMs) {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let buffer = Buffer.alloc(0);
      let signed = false;
      let timer = setTimeout(() => fail(new Error(`adb: no answer from ${this.host}:${this.port}`)), timeoutMs);
      const fail = (err) => {
        clearTimeout(timer);
        this.awaitingApproval = false;
        socket.destroy();
        this.drop(err);
        reject(err);
      };
      socket.on('connect', () => socket.write(encodePacket(CMD.CNXN, VERSION, MAX_DATA, Buffer.from('host::\0'))));
      socket.on('data', (chunk) => {
        let decoded;
        try {
          decoded = decodePackets(Buffer.concat([buffer, chunk]));
        } catch (err) {
          fail(err);
          return;
        }
        buffer = decoded.rest;
        for (const packet of decoded.packets) {
          if (packet.command === CMD.CNXN) {
            clearTimeout(timer);
            this.awaitingApproval = false;
            this.socket = socket;
            this.banner = packet.data.toString('utf8').replace(/\0+$/, '');
            resolve();
          } else if (packet.command === CMD.AUTH && packet.arg0 === AUTH_TOKEN) {
            if (!signed) {
              // first challenge: prove we hold a key the box already trusts
              signed = true;
              socket.write(encodePacket(CMD.AUTH, AUTH_SIGNATURE, 0, signToken(packet.data, this.privateKey)));
            } else {
              // key unknown: offer it; the box shows "Allow debugging?" and answers with CNXN once accepted
              clearTimeout(timer);
              timer = setTimeout(() => fail(new Error('adb: key not accepted on the TV in time')), this.approvalTimeoutMs);
              this.awaitingApproval = true;
              const key = androidPublicKey(crypto.createPublicKey(this.privateKey), this.keyName);
              socket.write(encodePacket(CMD.AUTH, AUTH_RSAPUBLICKEY, 0, Buffer.from(key + '\0')));
            }
          } else {
            this.handle(packet);
          }
        }
      });
      socket.on('error', fail);
      socket.on('close', () => this.drop(new Error('adb: connection closed')));
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** @param {{command: number, arg0: number, arg1: number, data: Buffer}} packet */
  handle(packet) {
    const stream = this.streams.get(packet.arg1);
    if (!stream) return;
    if (packet.command === CMD.OKAY) {
      stream.remoteId = packet.arg0;
    } else if (packet.command === CMD.WRTE) {
      stream.chunks.push(Buffer.from(packet.data));
      this.socket?.write(encodePacket(CMD.OKAY, packet.arg1, packet.arg0));
    } else if (packet.command === CMD.CLSE) {
      if (stream.remoteId) this.socket?.write(encodePacket(CMD.CLSE, packet.arg1, packet.arg0));
      this.finish(packet.arg1).resolve(Buffer.concat(stream.chunks).toString('utf8'));
    }
  }

  /** @param {number} localId */
  finish(localId) {
    const stream = this.streams.get(localId);
    clearTimeout(stream.timer);
    this.streams.delete(localId);
    return stream;
  }

  /** @param {Error} err */
  drop(err) {
    this.socket = null;
    this.banner = null;
    for (const localId of [...this.streams.keys()]) this.finish(localId).reject(err);
  }

  /**
   * Runs a shell command on the box and returns its output.
   * @param {string} command
   */
  async shell(command) {
    await this.connect();
    const localId = this.nextLocalId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(localId);
        reject(new Error(`adb: "${command}" timed out`));
      }, this.timeoutMs);
      this.streams.set(localId, { remoteId: 0, chunks: [], resolve, reject, timer });
      this.socket.write(encodePacket(CMD.OPEN, localId, 0, Buffer.from(`shell:${command}\0`)));
    });
  }

  close() {
    this.socket?.destroy();
    this.drop(new Error('adb: closed'));
  }
}
