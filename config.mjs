import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export function normalizePublicOrigin(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    if (!/^https?:\/\/[^\s/?#]+\/?$/i.test(value)) throw new Error();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || value !== value.trim()) throw new Error();
    return url.origin;
  } catch {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin, without credentials, a path, query or fragment');
  }
}

export function readConfig(env = process.env, { cwd = process.cwd(), rootDir = ROOT } = {}) {
  const rawPort = env.PORT ?? '7860';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('PORT must be a decimal integer between 1 and 65535');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (!host || (!isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))) {
    throw new Error('HOST must be an IP address or hostname, without a protocol or port');
  }
  const catalogPath = env.CATALOG_PATH
    ? path.resolve(cwd, env.CATALOG_PATH)
    : path.resolve(rootDir, 'data', 'catalog.json');
  return { host, port: Number(rawPort), catalogPath,
    publicOrigin: normalizePublicOrigin(env.PUBLIC_ORIGIN) };
}
