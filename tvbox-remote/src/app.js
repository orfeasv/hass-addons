// HTTP routes: the remote page, its static files, and the API used by the page and by Home Assistant (rest_command).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { KEYS } from './remote.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

/**
 * @param {{config: {publicDir: string, version: string}, boxes: import('./boxes.js').Boxes, publicKey: string,
 *   scan: () => Promise<{host: string, port: number, adb: string, model?: string}[]>}} deps
 */
export function createApp({ config, boxes, publicKey, scan }) {
  let scanning = null; // one scan at a time; callers during a scan share its result

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new RangeError('invalid JSON'));
      }
    });
    req.on('error', reject);
  });

  const run = async (res, action) => {
    try {
      send(res, 200, (await action()) ?? { ok: true });
    } catch (err) {
      send(res, err instanceof RangeError ? 400 : 502, { ok: false, error: err.message });
    }
  };

  const press = (box, key) => box.remote.press(key);
  const type = async (req, box) => {
    const body = await readJson(req);
    if (typeof body.text !== 'string') throw new RangeError('text missing');
    await box.remote.type(body.text);
  };

  async function handle(req, res) {
    // Ingress serves the add-on under a path prefix; only the last part of the path matters here
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const m = route.match(/^\/api\/boxes\/([a-f0-9]+)(?:\/(key|text)(?:\/([a-z0-9_]+))?)?$/);

    if (req.method === 'GET' && route === '/api/status') {
      return send(res, 200, { version: config.version, keys: Object.keys(KEYS), publicKey });
    }
    if (req.method === 'GET' && route === '/api/boxes') return send(res, 200, { boxes: boxes.list() });
    if (req.method === 'POST' && route === '/api/boxes') {
      return run(res, async () => {
        const body = await readJson(req);
        const port = body.port === undefined ? 5555 : Number(body.port);
        return boxes.view(boxes.add({ host: body.host, port, name: body.name }));
      });
    }
    if (req.method === 'GET' && route === '/api/scan') {
      return run(res, async () => {
        scanning ??= scan().finally(() => { scanning = null; });
        const found = await scanning;
        // the probes filled the ARP table: a known box at a new address is recognised by its MAC
        const table = await boxes.neighbors();
        return { found: found.map((d) => ({ ...d, added: boxes.findByAddress(d.host, table)?.id ?? null })) };
      });
    }
    if (m && !m[2] && req.method === 'PATCH') {
      return run(res, async () => boxes.view(boxes.rename(m[1], (await readJson(req)).name)));
    }
    if (m && !m[2] && req.method === 'DELETE') return run(res, () => boxes.remove(m[1]));
    if (m && m[2] === 'key' && m[3] && req.method === 'POST') return run(res, () => press(boxes.get(m[1]), m[3]));
    if (m && m[2] === 'text' && !m[3] && req.method === 'POST') return run(res, () => type(req, boxes.get(m[1])));

    // Short forms for rest_command: the box from ?box=<id>, else the first box
    const pick = () => (url.searchParams.get('box') ? boxes.get(url.searchParams.get('box')) : boxes.first());
    const key = route.match(/^\/api\/key\/([a-z0-9_]+)$/);
    if (req.method === 'POST' && key) return run(res, () => press(pick(), key[1]));
    if (req.method === 'POST' && route === '/api/text') return run(res, () => type(req, pick()));

    if (req.method === 'GET' && !route.startsWith('/api/')) {
      const name = route === '/' ? 'index.html' : path.basename(route);
      const contentType = TYPES[path.extname(name)];
      if (contentType) {
        try {
          return send(res, 200, await readFile(path.join(config.publicDir, name)), contentType);
        } catch {
          // fall through to 404
        }
      }
    }
    send(res, 404, { ok: false, error: 'not found' });
  }

  return { handle };
}
