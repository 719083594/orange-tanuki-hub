import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server, folder, base, originalCatalog, filesBefore;

function request(target, method = 'GET', headers = {}, body = '', origin = base) {
  return new Promise((resolve, reject) => {
    const req = http.request(origin, { path: target, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(body);
  });
}
const decode = (response) => JSON.parse(response.body);

before(async () => {
  originalCatalog = await readFile(path.join(project, 'data/catalog.json'));
  folder = await mkdtemp(path.join(os.tmpdir(), 'orange-tanuki-api-test-'));
  await mkdir(path.join(folder, 'public', 'directory.json'), { recursive: true });
  await mkdir(path.join(folder, 'data'));
  await writeFile(path.join(folder, 'data/catalog.json'), originalCatalog);
  await writeFile(path.join(folder, 'public/index.html'), '<!doctype html><title>fixture</title>');
  await writeFile(path.join(folder, 'public/app.js'), 'export const fixture = true;');
  await writeFile(path.join(folder, 'public/.env'), 'synthetic-not-a-secret');
  await writeFile(path.join(folder, 'public/secrets.json'), '{}');
  await writeFile(path.join(folder, 'outside.txt'), 'must-not-be-exposed');
  await mkdir(path.join(folder, 'outside-dir'));
  await writeFile(path.join(folder, 'outside-dir/outside.txt'), 'must-not-be-exposed');
  filesBefore = await readFile(path.join(folder, 'data/catalog.json'));
  server = createServer({ rootDir: folder, openApiPath: path.join(project, 'docs/openapi.json') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (folder) {
    assert.ok(path.basename(folder).startsWith('orange-tanuki-api-test-'));
    assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    await rm(folder, { recursive: true, force: true });
  }
});

test('production catalog contains no sample records', () => {
  const catalog = JSON.parse(originalCatalog);
  for (const key of ['works', 'characters', 'assets', 'models', 'model_versions']) assert.deepEqual(catalog[key], []);
});

test('brand and capabilities truthfully expose zero resources and disabled storage', async () => {
  const r = await request('/api/v1/info'); assert.equal(r.status, 200);
  const info = decode(r).data;
  assert.equal(info.name, '橙狸集'); assert.equal(info.english_name, 'OrangeTanuki Hub');
  assert.equal(info.slug, 'orange-tanuki-hub'); assert.equal(info.description, '收藏声音与影像，连接你的创作。');
  assert.deepEqual(info.storage, { configured: false, upload_enabled: false });
  assert.deepEqual(info.totals, { works: 0, characters: 0, assets: 0, models: 0, model_versions: 0 });
  assert.deepEqual(decode(await request('/api/v1/stats')).data, { totals: info.totals, by_type: {}, by_language: {} });
  assert.deepEqual(decode(await request('/healthz')), { status: 'ok' });
});

test('all collection endpoints return empty paginated data', async () => {
  for (const name of ['works', 'characters', 'assets', 'models']) {
    const r = await request(`/api/v1/${name}`); assert.equal(r.status, 200);
    assert.deepEqual(decode(r), { data: [], meta: { page: 1, page_size: 24, total: 0, total_pages: 0 } });
  }
});

test('valid combined filters and pagination remain honest empty results', async () => {
  const r = await request('/api/v1/assets?q=%E6%B5%8B%E8%AF%95&type=audio&work=none&character=none&language=zh&emotion=%E5%B9%B3%E9%9D%99&category=dialogue&page=2&page_size=100');
  assert.equal(r.status, 200); assert.deepEqual(decode(r), { data: [], meta: { page: 2, page_size: 100, total: 0, total_pages: 0 } });
  assert.equal((await request('/api/v1/assets?type=&q=')).status, 200);
});

test('invalid, repeated and unknown query parameters return JSON 400', async () => {
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=Infinity', 'page=1000001',
    'page_size=0', 'page_size=101', 'page_size=', 'page=1&page=2', 'unknown=yes', 'type=executable', `q=${'x'.repeat(201)}`]) {
    const r = await request(`/api/v1/assets?${query}`);
    assert.equal(r.status, 400, query); assert.equal(decode(r).error.code, 'invalid_request');
  }
});

test('missing resources and unknown API routes are actual 404 errors', async () => {
  for (const target of ['/api/v1/assets/missing', '/api/v1/models/missing/versions', '/api/v1/absent', '/api/overview', '/download/missing.wav']) {
    const r = await request(target); assert.equal(r.status, 404, target); assert.equal(decode(r).error.code, 'not_found');
  }
});

test('uploads are explicitly unavailable and never alter catalog files', async () => {
  const r = await request('/api/v1/uploads', 'POST', { 'Content-Type': 'application/json' }, '{"name":"not-uploaded"}');
  assert.equal(r.status, 503); assert.equal(decode(r).error.code, 'storage_not_configured');
  assert.deepEqual(await readFile(path.join(folder, 'data/catalog.json')), filesBefore);
  assert.deepEqual(await readFile(path.join(project, 'data/catalog.json')), originalCatalog);
  assert.equal((await request('/api/v1/assets', 'DELETE')).status, 400);
});

test('static GET and HEAD serve only real public files', async () => {
  const get = await request('/'); assert.equal(get.status, 200); assert.match(get.body, /fixture/);
  const head = await request('/', 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.match((await request('/app.js')).headers['content-type'], /javascript/);
  for (const target of ['/directory.json', '/directory.json/', '/missing.html', '/server.mjs', '/data/catalog.json']) {
    assert.equal((await request(target)).status, 404, target);
  }
});

test('configured static root works beneath an aliased parent directory', async () => {
  // Windows short TEMP paths and linked parent directories resolve to a
  // different spelling; containment must compare canonical paths on both sides.
  const actualParent = path.join(folder, 'actual-parent');
  const aliasParent = path.join(folder, 'aliased-parent');
  await mkdir(path.join(actualParent, 'app', 'public'), { recursive: true });
  await writeFile(path.join(actualParent, 'app', 'public', 'index.html'), '<title>aliased fixture</title>');
  await symlink(actualParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasedServer = createServer({ rootDir: path.join(aliasParent, 'app'),
    catalogPath: path.join(folder, 'data/catalog.json') });
  try {
    await new Promise((resolve, reject) => {
      aliasedServer.once('error', reject);
      aliasedServer.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${aliasedServer.address().port}`;
    const get = await request('/', 'GET', {}, '', origin);
    assert.equal(get.status, 200);
    assert.match(get.body, /aliased fixture/);
    assert.equal((await request('/', 'HEAD', {}, '', origin)).status, 200);
    assert.equal((await request('/%2e%2e/outside.txt', 'GET', {}, '', origin)).status, 400);
  } finally {
    aliasedServer.closeAllConnections();
    await new Promise((resolve) => aliasedServer.close(resolve));
  }
});

test('raw and encoded traversal, dotfiles, secrets and Windows alternate streams are rejected', async () => {
  for (const target of ['/../outside.txt', '/%2e%2e/outside.txt', '/%252e%252e/outside.txt', '/a/%2e%2e/outside.txt',
    '/%2eenv', '/.env', '/secrets.json', '/a\\..\\outside.txt', '/a%5c..%5coutside.txt',
    '/index.html:secret.css', '/%00index.html', '/%ZZ', '//outside.txt']) {
    const r = await request(target); assert.equal(r.status, 400, target); assert.ok(!r.body.includes('must-not-be-exposed'));
  }
});

test('public directory symlinks or Windows junctions never expose external files', async () => {
  await symlink(path.join(folder, 'outside-dir'), path.join(folder, 'public/linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');
  const r = await request('/linked-dir/outside.txt'); assert.equal(r.status, 404); assert.ok(!r.body.includes('must-not-be-exposed'));
});

test('API HEAD returns GET status and length without a body, including errors', async () => {
  for (const target of ['/api/v1/assets', '/api/v1/assets/missing', '/api/v1/assets?page=0']) {
    const get = await request(target); const head = await request(target, 'HEAD');
    assert.equal(head.status, get.status); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], get.headers['content-length']);
  }
});

test('OPTIONS accepts same-origin only and never emits a wildcard', async () => {
  const good = await request('/api/v1/assets', 'OPTIONS', { Origin: base });
  assert.equal(good.status, 204); assert.equal(good.headers['access-control-allow-origin'], base);
  const other = await request('/api/v1/assets', 'OPTIONS', { Origin: 'https://example.invalid' });
  assert.equal(other.status, 400); assert.equal(other.headers['access-control-allow-origin'], undefined);
  const noOrigin = await request('/api/v1/assets', 'OPTIONS'); assert.equal(noOrigin.status, 204);
  assert.equal(noOrigin.headers['access-control-allow-origin'], undefined);
});

test('OpenAPI is reachable, relative and does not invent authentication or downloads', async () => {
  const r = await request('/docs/openapi.json'); assert.equal(r.status, 200);
  const spec = decode(r); assert.equal(spec.openapi, '3.1.0'); assert.equal(spec.servers[0].url, '/');
  for (const target of ['/api/v1/info', '/api/v1/stats', '/api/v1/works', '/api/v1/characters', '/api/v1/assets',
    '/api/v1/assets/{id}', '/api/v1/models', '/api/v1/models/{id}/versions', '/api/v1/uploads', '/healthz']) assert.ok(spec.paths[target], target);
  assert.equal(spec.components.securitySchemes, undefined);
  for (const method of ['get', 'head']) {
    const scope = spec.paths['/api/v1/assets'][method].parameters.find((p) => p.name === 'image_scope');
    assert.deepEqual(scope.schema.enum, ['character', 'standalone']);
  }
  const imageSchema = spec.components.schemas.Asset;
  assert.deepEqual(imageSchema.properties.image_scope.enum, ['character', 'standalone']);
  assert.equal(imageSchema.allOf.length, 3);
});

test('startup rejects enabled storage, duplicate IDs, broken relations and unknown fields', async () => {
  const mutate = [
    (c) => { c.storage.configured = true; },
    (c) => { c.characters.push({ id: 'fixture', work_id: 'missing', name: 'fixture' }); },
    (c) => { c.works.push({ id: 'fixture', name: 'fixture' }, { id: 'fixture', name: 'fixture' }); },
    (c) => { c.works.push({ id: 'fixture', name: 'fixture', secret: 'synthetic-marker' }); }
  ];
  for (const change of mutate) {
    const invalid = JSON.parse(originalCatalog); change(invalid);
    await writeFile(path.join(folder, 'data/invalid.json'), JSON.stringify(invalid));
    assert.throws(() => createServer({ catalogPath: path.join(folder, 'data/invalid.json') }), /Invalid catalog/);
  }
});

function imageFixture() {
  const catalog = JSON.parse(originalCatalog);
  catalog.works = [{ id: 'work-a', name: 'Test Work A' }, { id: 'work-b', name: 'Test Work B' }];
  catalog.characters = [{ id: 'character-a', work_id: 'work-a', name: 'Test Character A' }];
  catalog.assets = [
    { id: 'character-picture', type: 'image', image_scope: 'character', title: 'Test Portrait', work_id: 'work-a', character_id: 'character-a' },
    { id: 'standalone-picture', type: 'image', image_scope: 'standalone', title: 'Test Landscape' },
    { id: 'standalone-null-picture', type: 'image', image_scope: 'standalone', title: 'Test Abstract', work_id: null, character_id: null },
    { id: 'audio-fixture', type: 'audio', title: 'Test Audio Metadata', work_id: 'work-a', character_id: 'character-a',
      audio_text: { source_id: 'fixture-source', text: '嗯。', units: [{ id: 'u001', kind: 'sentence',
        char_start: 0, char_end: 2, text: '嗯。', emotions: [], annotation_source: 'unannotated', needs_confirmation: true }] } }
  ];
  return catalog;
}

test('nonempty temporary fixture isolates character and standalone images before pagination', async () => {
  const catalog = imageFixture(); const catalogPath = path.join(folder, 'data/images.json');
  await writeFile(catalogPath, JSON.stringify(catalog));
  const fixtureServer = createServer({ rootDir: folder, catalogPath });
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixtureServer.address().port}`;
  const get = (target) => request(target, 'GET', {}, '', origin);
  try {
    const character = decode(await get('/api/v1/assets?image_scope=character'));
    assert.deepEqual(character.data.map((a) => a.id), ['character-picture']); assert.equal(character.meta.total, 1);
    const standalone = decode(await get('/api/v1/assets?type=image&image_scope=standalone'));
    assert.deepEqual(standalone.data.map((a) => a.id), ['standalone-picture', 'standalone-null-picture']);
    assert.equal(standalone.meta.total, 2);
    const paged = decode(await get('/api/v1/assets?image_scope=standalone&page_size=1&page=2'));
    assert.deepEqual(paged.data.map((a) => a.id), ['standalone-null-picture']);
    assert.deepEqual(paged.meta, { page: 2, page_size: 1, total: 2, total_pages: 2 });
    assert.equal(decode(await get('/api/v1/assets?type=image')).meta.total, 3);
    assert.equal(decode(await get('/api/v1/assets')).meta.total, 4);
    assert.equal(decode(await get('/api/v1/assets?image_scope=standalone&work=work-a')).meta.total, 0);
    assert.equal(decode(await get('/api/v1/assets?image_scope=character&character=character-a&work=work-a')).meta.total, 1);
    assert.equal(decode(await get('/api/v1/assets?image_scope=character&work=work-b')).meta.total, 0);
    const detail = decode(await get('/api/v1/assets/character-picture')).data;
    assert.equal(detail.image_scope, 'character');
    const audio = decode(await get('/api/v1/assets/audio-fixture')).data;
    assert.deepEqual(audio.audio_text, catalog.assets[3].audio_text); assert.ok(!Object.hasOwn(audio, 'image_scope'));
    assert.deepEqual(await readFile(path.join(project, 'data/catalog.json')), originalCatalog);
  } finally {
    fixtureServer.closeAllConnections(); await new Promise((resolve) => fixtureServer.close(resolve));
  }
});

test('image_scope query rejects illegal enums and conflicting non-image types', async () => {
  for (const query of ['image_scope=', 'image_scope=unknown', 'image_scope=Character',
    ...['audio', 'video', 'text', 'model'].map((type) => `type=${type}&image_scope=standalone`),
    'image_scope=character&image_scope=standalone']) {
    const r = await request(`/api/v1/assets?${query}`);
    assert.equal(r.status, 400, query); assert.equal(decode(r).error.code, 'invalid_request');
  }
  assert.equal((await request('/api/v1/assets?image_scope=character')).status, 200);
  assert.equal((await request('/api/v1/assets?type=image&image_scope=standalone')).status, 200);
});

test('invalid image ownership is refused at startup without changing production catalog', async () => {
  const changes = [
    (c) => { delete c.assets[0].image_scope; },
    (c) => { c.assets[0].image_scope = 'other'; },
    (c) => { c.assets[0].character_id = 'missing'; },
    (c) => { delete c.assets[0].character_id; },
    (c) => { c.assets[0].character_id = null; },
    (c) => { delete c.assets[0].work_id; },
    (c) => { c.assets[0].work_id = null; },
    (c) => { c.assets[0].work_id = 'work-b'; },
    (c) => { c.assets[1].work_id = 'work-a'; },
    (c) => { c.assets[1].character_id = 'character-a'; },
    (c) => { c.assets[3].image_scope = 'character'; },
    (c) => { c.assets[3].image_scope = null; }
  ];
  for (const change of changes) {
    const catalog = imageFixture(); change(catalog); const target = path.join(folder, 'data/invalid-images.json');
    await writeFile(target, JSON.stringify(catalog));
    assert.throws(() => createServer({ catalogPath: target }), /Invalid catalog/);
  }
  assert.deepEqual(await readFile(path.join(project, 'data/catalog.json')), originalCatalog);
});
