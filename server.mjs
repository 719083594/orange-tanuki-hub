import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readConfig, normalizePublicOrigin } from './config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = new Set(['audio', 'image', 'video', 'text', 'model']);
const IMAGE_SCOPES = new Set(['character', 'standalone']);
const COLLECTIONS = ['works', 'characters', 'assets', 'models', 'model_versions'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2'
}));

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = (message) => new ApiError(400, 'invalid_request', message);
const missing = () => new ApiError(404, 'not_found', '请求的资源不存在。');
const requireValue = (condition, message) => { if (!condition) throw new Error(`Invalid catalog: ${message}`); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);
const shape = (value, allowed, required = []) => {
  requireValue(isObject(value) && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key)), 'unknown or missing fields');
};

function validateCatalog(catalog) {
  requireValue(isObject(catalog) && catalog.schema_version === '1.0', 'schema_version');
  shape(catalog, ['schema_version', 'hub', 'storage', ...COLLECTIONS]);
  requireValue(isObject(catalog.hub), 'hub');
  shape(catalog.hub, ['name', 'english_name', 'slug', 'description']);
  shape(catalog.storage, ['configured', 'upload_enabled']);
  for (const key of ['name', 'english_name', 'slug', 'description']) {
    requireValue(typeof catalog.hub[key] === 'string' && catalog.hub[key].length > 0, `hub.${key}`);
  }
  requireValue(catalog.storage?.configured === false && catalog.storage?.upload_enabled === false,
    'this scaffold does not implement storage or uploads');
  const sets = {};
  const recordFields = {
    works: ['id', 'name', 'description', 'aliases'],
    characters: ['id', 'work_id', 'name', 'description', 'aliases'],
    assets: ['id', 'type', 'image_scope', 'title', 'description', 'work_id', 'character_id', 'language', 'categories', 'tags', 'emotions', 'file', 'audio_text'],
    models: ['id', 'name', 'description', 'work_id', 'character_id', 'language', 'categories', 'tags'],
    model_versions: ['id', 'model_id', 'version', 'framework', 'dependencies', 'description', 'files']
  };
  for (const name of COLLECTIONS) {
    requireValue(Array.isArray(catalog[name]), name);
    sets[name] = new Set();
    for (const row of catalog[name]) {
      shape(row, recordFields[name]);
      requireValue(isObject(row) && typeof row.id === 'string' && ID.test(row.id), `${name}.id`);
      requireValue(!sets[name].has(row.id), `duplicate ${name}.id`);
      sets[name].add(row.id);
      for (const key of ['aliases', 'categories', 'tags', 'emotions']) {
        requireValue(row[key] === undefined || strings(row[key]), `${name}.${key}`);
      }
      requireValue(row.description === undefined || typeof row.description === 'string', 'description');
      requireValue(row.language == null || typeof row.language === 'string', 'language');
    }
  }
  for (const row of catalog.characters) {
    requireValue(sets.works.has(row.work_id) && typeof row.name === 'string', 'character work/name');
  }
  for (const row of catalog.works) requireValue(typeof row.name === 'string', 'work name');
  for (const row of [...catalog.assets, ...catalog.models]) {
    requireValue(row.work_id == null || sets.works.has(row.work_id), 'unknown work');
    requireValue(row.character_id == null || sets.characters.has(row.character_id), 'unknown character');
    if (row.character_id != null && row.work_id != null) {
      requireValue(catalog.characters.find((x) => x.id === row.character_id).work_id === row.work_id,
        'character belongs to another work');
    }
  }
  for (const row of catalog.assets) {
    requireValue(TYPES.has(row.type) && typeof row.title === 'string', 'asset type/title');
    if (row.type === 'image') {
      requireValue(IMAGE_SCOPES.has(row.image_scope), 'image_scope required for images');
      if (row.image_scope === 'character') {
        const character = catalog.characters.find((entry) => entry.id === row.character_id);
        requireValue(character !== undefined && row.work_id === character.work_id, 'character image work/character binding');
      } else {
        requireValue(row.work_id == null && row.character_id == null, 'standalone image cannot bind a work or character');
      }
    } else {
      requireValue(!Object.hasOwn(row, 'image_scope'), 'image_scope is only valid for images');
    }
    requireValue(row.file == null || isObject(row.file), 'asset file');
    if (row.file != null) validateFile(row.file);
    if (row.audio_text != null) {
      const binding = row.audio_text;
      requireValue(row.type === 'audio' && isObject(binding) && typeof binding.source_id === 'string', 'audio binding');
      shape(binding, ['source_id', 'text_asset_id', 'text', 'units'], ['source_id', 'text', 'units']);
      requireValue(typeof binding.text === 'string' && Array.isArray(binding.units), 'audio text/units');
      requireValue(binding.text_asset_id == null || catalog.assets.some((a) => a.id === binding.text_asset_id && a.type === 'text'), 'text asset');
      let cursor = 0;
      for (const [index, unit] of binding.units.entries()) {
        shape(unit, ['id', 'kind', 'char_start', 'char_end', 'text', 'emotions', 'intensity', 'delivery',
          'confidence', 'uncertainty', 'acoustic_evidence', 'annotation_source', 'needs_confirmation'],
        ['id', 'kind', 'char_start', 'char_end', 'text', 'emotions', 'annotation_source', 'needs_confirmation']);
        requireValue(unit.id === `u${String(index + 1).padStart(3, '0')}` && ['sentence', 'audio_event'].includes(unit.kind), 'unit id/kind');
        requireValue(Number.isSafeInteger(unit.char_start) && Number.isSafeInteger(unit.char_end) && unit.char_start === cursor && unit.char_end > cursor, 'unit span');
        requireValue(Array.from(binding.text).slice(cursor, unit.char_end).join('') === unit.text, 'unit text');
        requireValue(strings(unit.emotions) && (unit.emotions.length > 0 || unit.needs_confirmation === true), 'unit emotion or pending');
        requireValue(typeof unit.needs_confirmation === 'boolean' && ['audio_model', 'human', 'unannotated'].includes(unit.annotation_source), 'unit review provenance');
        for (const key of ['intensity', 'confidence', 'uncertainty', 'acoustic_evidence']) requireValue(unit[key] == null || typeof unit[key] === 'string', 'unit optional field');
        requireValue(unit.delivery == null || strings(unit.delivery), 'unit delivery');
        cursor = unit.char_end;
      }
      requireValue(cursor === Array.from(binding.text).length, 'complete character coverage');
    }
  }
  for (const row of catalog.models) requireValue(typeof row.name === 'string', 'model name');
  const versions = new Set();
  for (const row of catalog.model_versions) {
    requireValue(sets.models.has(row.model_id) && typeof row.version === 'string' && row.version.length > 0,
      'model version relation');
    const key = `${row.model_id}\0${row.version}`;
    requireValue(!versions.has(key), 'duplicate model version'); versions.add(key);
    requireValue(typeof row.framework === 'string' && strings(row.dependencies) && Array.isArray(row.files), 'model requirements');
    requireValue(row.files.length > 0, 'model files'); row.files.forEach(validateFile);
  }
  return catalog;
}

function validateFile(file) {
  requireValue(isObject(file) && typeof file.storage_key === 'string' && file.storage_key.length > 0, 'file storage key');
  shape(file, ['storage_key', 'media_type', 'size_bytes', 'sha256', 'download_url'], ['storage_key', 'media_type', 'size_bytes', 'sha256', 'download_url']);
  requireValue(typeof file.media_type === 'string' && Number.isSafeInteger(file.size_bytes) && file.size_bytes >= 0, 'file type/size');
  requireValue(/^[a-f0-9]{64}$/.test(file.sha256), 'file SHA-256');
  // No storage provider is connected: never fabricate an actionable download URL.
  requireValue(file.download_url == null, 'download URL requires implemented storage');
}

function parseTarget(req) {
  const target = req.url ?? '';
  if (!target.startsWith('/') || target.startsWith('//') || target.length > 4096) throw invalid('请求地址无效。');
  const rawPath = target.split('?')[0];
  let pathname;
  try { pathname = decodeURIComponent(rawPath); } catch { throw invalid('地址编码无效。'); }
  if (/[\\:\0-\x1f\x7f#]/.test(pathname) || pathname.includes('%')) throw invalid('不允许的地址字符。');
  const parts = pathname.split('/').slice(1);
  if (parts.some((p) => p.startsWith('.') || /^(?:secrets?|credentials?|tokens?)(?:[._-]|$)/i.test(p))) {
    throw invalid('不允许访问此路径。');
  }
  if (parts.slice(0, -1).some((p) => p === '')) throw invalid('不允许空路径段。');
  return { pathname, search: new URL(target, 'http://localhost').searchParams };
}

function readQuery(search, allowed = []) {
  const query = {};
  for (const [key, value] of search) {
    if (!['page', 'page_size', ...allowed].includes(key) || Object.hasOwn(query, key)) throw invalid('查询参数未知或重复。');
    if (value.length > 200) throw invalid('查询条件过长。');
    query[key] = value.trim();
  }
  for (const [key, fallback, maximum] of [['page', 1, 1000000], ['page_size', 24, 100]]) {
    const value = query[key];
    if (value !== undefined && (!/^[1-9]\d*$/.test(value) || Number(value) > maximum)) throw invalid(`${key} 超出允许范围。`);
    query[key] = value === undefined ? fallback : Number(value);
  }
  if (query.type && !TYPES.has(query.type)) throw invalid('资源类型无效。');
  if (Object.hasOwn(query, 'image_scope')) {
    if (!IMAGE_SCOPES.has(query.image_scope)) throw invalid('图片归属类型无效。');
    if (query.type && query.type !== 'image') throw invalid('图片归属筛选只能用于图片资源。');
  }
  return query;
}

function filtered(rows, query) {
  const needle = query.q?.normalize('NFKC').toLocaleLowerCase();
  return rows.filter((row) => {
    if (query.image_scope && (row.type !== 'image' || row.image_scope !== query.image_scope)) return false;
    for (const [parameter, key] of [['type', 'type'], ['work', 'work_id'], ['character', 'character_id'], ['language', 'language']]) {
      if (query[parameter] && row[key] !== query[parameter]) return false;
    }
    if (query.emotion && !(row.emotions ?? []).includes(query.emotion)) return false;
    if (query.category && !(row.categories ?? []).includes(query.category)) return false;
    if (needle) {
      const text = [row.id, row.name, row.title, row.description, row.audio_text?.text,
        ...(row.aliases ?? []), ...(row.tags ?? [])].filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase();
      if (!text.includes(needle)) return false;
    }
    return true;
  });
}

function paginated(rows, query) {
  const values = filtered(rows, query);
  return { data: values.slice((query.page - 1) * query.page_size, query.page * query.page_size),
    meta: { page: query.page, page_size: query.page_size, total: values.length,
      total_pages: Math.ceil(values.length / query.page_size) } };
}

function json(req, res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function staticFile(req, res, pathname, publicDir) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const contentType = MIME.get(path.extname(relative).toLowerCase());
  if (!contentType) throw missing();
  const base = path.resolve(publicDir);
  let filename = base;
  try {
    if ((await lstat(base)).isSymbolicLink()) throw missing();
    const canonicalBase = await realpath(base);
    for (const part of relative.split('/')) {
      filename = path.join(filename, part);
      if ((await lstat(filename)).isSymbolicLink()) throw missing();
    }
    const resolved = await realpath(filename);
    const fromBase = path.relative(canonicalBase, resolved);
    if (fromBase.startsWith('..') || path.isAbsolute(fromBase)) throw missing();
    const handle = await open(resolved, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw missing();
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') res.end();
      else res.end(await handle.readFile());
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw missing();
    throw error;
  }
}

/** Creates a server without listening. Only reads the catalog and public files. */
export function createServer({ rootDir = ROOT, publicDir = path.join(rootDir, 'public'),
  catalogPath = path.join(rootDir, 'data', 'catalog.json'),
  openApiPath = path.join(rootDir, 'docs', 'openapi.json'), publicOrigin = null } = {}) {
  publicOrigin = normalizePublicOrigin(publicOrigin);
  const catalog = validateCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')));
  const totals = Object.fromEntries(COLLECTIONS.map((name) => [name, catalog[name].length]));
  const group = (key) => catalog.assets.reduce((out, asset) => {
    if (typeof asset[key] === 'string') out[asset[key]] = (out[asset[key]] ?? 0) + 1;
    return out;
  }, Object.create(null));
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname, search } = parseTarget(req);
      if (req.method === 'OPTIONS') {
        const expectedOrigin = publicOrigin ?? `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== expectedOrigin) throw invalid('不接受跨来源预检。');
        res.writeHead(204, { Allow: 'GET, HEAD, OPTIONS, POST',
          ...(req.headers.origin ? { 'Access-Control-Allow-Origin': expectedOrigin,
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST', Vary: 'Origin' } : {}) });
        return res.end();
      }
      if (pathname === '/api/v1/uploads' && req.method === 'POST') {
        return json(req, res, 503, { error: { code: 'storage_not_configured', message: '尚未配置持久存储，上传不可用。' } });
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(400, 'method_not_allowed', '此入口不支持该请求方法。');
      if (pathname === '/healthz') return json(req, res, 200, { status: 'ok' });
      if (pathname === '/api/v1/info') return json(req, res, 200,
        { data: { ...catalog.hub, api_version: 'v1', storage: catalog.storage, totals } });
      if (pathname === '/api/v1/stats') return json(req, res, 200,
        { data: { totals, by_type: group('type'), by_language: group('language') } });
      const lists = {
        '/api/v1/works': ['works', ['q']],
        '/api/v1/characters': ['characters', ['q', 'work']],
        '/api/v1/assets': ['assets', ['q', 'type', 'image_scope', 'work', 'character', 'language', 'emotion', 'category']],
        '/api/v1/models': ['models', ['q', 'work', 'character', 'language', 'category']]
      };
      if (Object.hasOwn(lists, pathname)) {
        const [name, allowed] = lists[pathname];
        return json(req, res, 200, paginated(catalog[name], readQuery(search, allowed)));
      }
      const assetMatch = /^\/api\/v1\/assets\/([^/]+)$/.exec(pathname);
      if (assetMatch) {
        if (!ID.test(assetMatch[1])) throw invalid('资源 ID 无效。');
        const asset = catalog.assets.find((row) => row.id === assetMatch[1]);
        if (!asset) throw missing();
        return json(req, res, 200, { data: asset });
      }
      const versionsMatch = /^\/api\/v1\/models\/([^/]+)\/versions$/.exec(pathname);
      if (versionsMatch) {
        if (!ID.test(versionsMatch[1])) throw invalid('模型 ID 无效。');
        if (!catalog.models.some((row) => row.id === versionsMatch[1])) throw missing();
        return json(req, res, 200, paginated(catalog.model_versions.filter((row) => row.model_id === versionsMatch[1]), readQuery(search)));
      }
      if (pathname.startsWith('/api/') || pathname === '/api') throw missing();
      if (pathname === '/docs/openapi.json') return json(req, res, 200, JSON.parse(readFileSync(openApiPath, 'utf8')));
      await staticFile(req, res, pathname, publicDir);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      json(req, res, error instanceof ApiError ? error.status : 500,
        { error: { code: error instanceof ApiError ? error.code : 'internal_error',
          message: error instanceof ApiError ? error.message : '服务暂时无法完成请求。' } });
    } finally { req.resume(); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { port, host, catalogPath, publicOrigin } = readConfig();
    const server = createServer({ catalogPath, publicOrigin });
    server.on('error', (error) => {
      console.error(`OrangeTanuki Hub failed to listen (${error.code ?? 'unknown error'})`);
      process.exitCode = 1;
    });
    server.listen(port, host, () => console.log(`OrangeTanuki Hub listening on ${host}:${port}`));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10000);
      deadline.unref();
      server.close(() => { clearTimeout(deadline); });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (error) {
    console.error(`OrangeTanuki Hub startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
