// Optional https with Home Assistant's own certificate, so Chrome can install the remote as an app.
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';

/** @param {{tlsCert: string, tlsKey: string}} config */
export const readTls = ({ tlsCert, tlsKey }) => ({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) });

/**
 * Host names the certificate lists (its DNS subject alternative names); wildcards are kept as written.
 * @param {X509Certificate} cert
 */
function certificateNames(cert) {
  return (cert.subjectAltName ?? '').split(/,\s*/)
    .filter((entry) => entry.startsWith('DNS:'))
    .map((entry) => entry.slice(4).trim())
    .filter(Boolean);
}

/**
 * The host to install the app from: Chrome only trusts names the certificate is valid for. Home Assistant's own
 * host name wins when the certificate covers it (also through a wildcard); else the certificate's first exact name.
 * @param {Buffer|string} pem @param {string|null} preferred
 * @returns {string|null}
 */
export function pickInstallHost(pem, preferred) {
  let cert;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return null;
  }
  if (preferred && cert.checkHost(preferred)) return preferred;
  return certificateNames(cert).find((name) => !name.startsWith('*.')) ?? null;
}

/**
 * Hot-reloads the certificate when Home Assistant renews it.
 * @param {{setSecureContext(options: {cert: Buffer, key: Buffer}): void}} server
 * @param {{tlsCert: string, tlsKey: string}} config
 * @param {{intervalMs?: number, logger?: {log(message: string): void, warn(message: string): void}}} [options]
 * @returns {() => void} stops watching
 */
export function watchTls(server, config, { intervalMs = 10 * 60_000, logger = console } = {}) {
  const stamp = () => {
    try {
      return `${fs.statSync(config.tlsCert).mtimeMs}:${fs.statSync(config.tlsKey).mtimeMs}`;
    } catch {
      return null; // mid-replace: try again next time
    }
  };
  let loaded = stamp();
  const timer = setInterval(() => {
    const now = stamp();
    if (!now || now === loaded) return;
    try {
      server.setSecureContext(readTls(config));
      loaded = now;
      logger.log('https certificate reloaded');
    } catch (err) {
      logger.warn(`Could not load the renewed https certificate yet: ${err.message}`);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
