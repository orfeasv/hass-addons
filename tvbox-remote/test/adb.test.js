import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { test } from 'node:test';
import { AdbClient, androidPublicKey, CMD, decodePackets, encodePacket, signToken } from '../src/adb.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

test('packets round-trip with checksum and magic', () => {
  const data = Buffer.from('shell:id\0');
  const packet = encodePacket(CMD.OPEN, 7, 0, data);
  assert.equal(packet.readUInt32LE(16), [...data].reduce((a, b) => a + b, 0));
  const { packets, rest } = decodePackets(Buffer.concat([packet, packet.subarray(0, 10)]));
  assert.equal(packets.length, 1);
  assert.equal(rest.length, 10);
  assert.deepEqual(packets[0], { command: CMD.OPEN, arg0: 7, arg1: 0, data });
});

test('signature verifies as PKCS#1 v1.5 over a SHA-1 DigestInfo of the token', () => {
  const token = crypto.randomBytes(20);
  const plain = crypto.publicDecrypt(
    { key: crypto.createPublicKey(privateKey), padding: crypto.constants.RSA_PKCS1_PADDING },
    signToken(token, privateKey),
  );
  assert.deepEqual(plain.subarray(-20), token);
  assert.equal(plain.subarray(0, 15).toString('hex'), '3021300906052b0e03021a05000414');
});

test('android public key has the RSAPublicKey layout', () => {
  const [b64, name] = androidPublicKey(crypto.createPublicKey(privateKey), 'me@host').split(' ');
  const blob = Buffer.from(b64, 'base64');
  assert.equal(name, 'me@host');
  assert.equal(blob.length, 4 + 4 + 256 + 256 + 4);
  assert.equal(blob.readUInt32LE(0), 64);
  const n0 = BigInt(blob.readUInt32LE(8));
  const n0inv = BigInt(blob.readUInt32LE(4));
  assert.equal((n0 * n0inv) % 2n ** 32n, 2n ** 32n - 1n); // n0inv = -1/n0 mod 2^32
  assert.equal(blob.readUInt32LE(blob.length - 4), 65537);
});

/** Fake adbd: asks for auth, trusts keys in `trusted`, learns offered keys when `approve` is set, runs `id`. */
function fakeAdbd({ trusted = [], approve = false }) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let token = crypto.randomBytes(20);
    socket.on('data', (chunk) => {
      const { packets, rest } = decodePackets(Buffer.concat([buffer, chunk]));
      buffer = rest;
      for (const p of packets) {
        if (p.command === CMD.CNXN) {
          socket.write(encodePacket(CMD.AUTH, 1, 0, token));
        } else if (p.command === CMD.AUTH && p.arg0 === 2) {
          const ok = trusted.some((key) => {
            try {
              const plain = crypto.publicDecrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, p.data);
              return plain.subarray(-20).equals(token);
            } catch {
              return false;
            }
          });
          token = crypto.randomBytes(20);
          socket.write(ok ? encodePacket(CMD.CNXN, 0x01000000, 4096, Buffer.from('device::fake\0'))
            : encodePacket(CMD.AUTH, 1, 0, token));
        } else if (p.command === CMD.AUTH && p.arg0 === 3) {
          server.offered = p.data.toString().replace(/\0$/, '');
          if (approve) socket.write(encodePacket(CMD.CNXN, 0x01000000, 4096, Buffer.from('device::fake\0')));
        } else if (p.command === CMD.OPEN) {
          const cmd = p.data.toString().replace(/\0$/, '');
          socket.write(encodePacket(CMD.OKAY, 100, p.arg0));
          socket.write(encodePacket(CMD.WRTE, 100, p.arg0, Buffer.from(`ran ${cmd}\n`)));
          socket.write(encodePacket(CMD.CLSE, 100, p.arg0));
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('trusted key connects by signature and runs shell commands', async () => {
  const server = await fakeAdbd({ trusted: [crypto.createPublicKey(privateKey)] });
  const adb = new AdbClient({ host: '127.0.0.1', port: server.address().port, privateKey });
  assert.equal(await adb.shell('id'), 'ran shell:id\n');
  assert.equal(adb.connected, true);
  assert.equal(server.offered, undefined);
  adb.close();
  server.close();
});

test('unknown key is offered and connects once approved', async () => {
  const server = await fakeAdbd({ approve: true });
  const adb = new AdbClient({ host: '127.0.0.1', port: server.address().port, privateKey, keyName: 'test@ha' });
  await adb.connect();
  assert.match(server.offered, / test@ha$/);
  adb.close();
  server.close();
});

test('unapproved key times out', async () => {
  const server = await fakeAdbd({});
  const adb = new AdbClient({ host: '127.0.0.1', port: server.address().port, privateKey, approvalTimeoutMs: 200 });
  await assert.rejects(adb.connect(), /not accepted/);
  assert.equal(adb.awaitingApproval, false);
  server.close();
});
