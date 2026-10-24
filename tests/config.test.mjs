import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, rm } from 'node:fs/promises';
import { readConfig } from '../config.mjs';
import { createServer } from '../server.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePrefix = 'orange-tanuki-config-test-';

function request(base, target, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base, { path: target, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function externalServer(t, env = {}) {
  const tempBase = await realpath(os.tmpdir());
  const folder = await mkdtemp(path.join(tempBase, fixturePrefix));
  let server;
  t.after(async () => {
    try {
      if (server) {
        server.closeAllConnections();
        if (server.listening) await new Promise((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      // Only this test's freshly created ordinary directory may be removed.
      assert.equal(path.dirname(folder), tempBase);
      assert.ok(path.basename(folder).startsWith(fixturePrefix));
      assert.equal((await lstat(folder)).isSymbolicLink(), false);
      assert.equal(await realpath(folder), folder);
      await rm(folder, { recursive: true, force: true });
    }
  });
  const cwd = path.join(folder, 'unrelated-working-directory');
  const catalogPath = path.join(folder, 'private-catalog', 'catalog.json');
  await mkdir(cwd);
  await mkdir(path.dirname(catalogPath));
  const catalog = {
    schema_version: '1.0',
    hub: { name: 'Portable fixture', english_name: 'Portable fixture',
      slug: 'portable-fixture', description: 'Synthetic test data only.' },
    storage: { configured: false, upload_enabled: false },
    works: [{ id: 'fixture-work', name: 'External catalog fixture' }],
    characters: [], assets: [], models: [], model_versions: []
  };
  const original = JSON.stringify(catalog);
  await writeFile(catalogPath, original, 'utf8');
  const config = readConfig({ CATALOG_PATH: '../private-catalog/catalog.json', ...env },
    { cwd, rootDir: project });
  assert.equal(config.catalogPath, catalogPath);
  server = createServer({ ...config });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, catalogPath, original, config };
}

test('defaults use a loopback host and project catalog, independent of cwd', () => {
  const rootDir = path.join(os.tmpdir(), 'synthetic-project-root');
  const cwd = path.join(os.tmpdir(), 'unrelated-cwd');
  assert.deepEqual(readConfig({}, { rootDir, cwd }), {
    host: '127.0.0.1', port: 7860,
    catalogPath: path.join(rootDir, 'data', 'catalog.json'), publicOrigin: null
  });
});

test('empty optional origin and catalog path use their documented defaults', () => {
  const config = readConfig({ PUBLIC_ORIGIN: '', CATALOG_PATH: '' },
    { rootDir: project, cwd: os.tmpdir() });
  assert.equal(config.publicOrigin, null);
  assert.equal(config.catalogPath, path.join(project, 'data', 'catalog.json'));
});

test('configured host and decimal port endpoints are preserved', () => {
  for (const [HOST, PORT] of [['0.0.0.0', '1'], ['::1', '65535'], ['localhost', '8788']]) {
    const config = readConfig({ HOST, PORT });
    assert.equal(config.host, HOST);
    assert.equal(config.port, Number(PORT));
  }
});

test('invalid or nondecimal ports cannot silently select a listening port', () => {
  for (const PORT of ['', ' ', '0', '-1', '65536', '99999999999999999999',
    '1.5', '7860.0', '0x1eb4', '1e3', '+7860', '7860junk', ' 7860', '7860 ',
    '7860\n', 'NaN', 'Infinity', '７８６０']) {
    assert.throws(() => readConfig({ PORT }), `PORT=${JSON.stringify(PORT)} must fail`);
  }
});

test('absolute catalog paths are preserved and relative ones resolve against supplied cwd', () => {
  const cwd = path.resolve(os.tmpdir(), 'external-catalog-cwd');
  const absolute = path.resolve(os.tmpdir(), 'absolute-catalog', 'catalog.json');
  assert.equal(readConfig({ CATALOG_PATH: absolute }, { cwd, rootDir: project }).catalogPath, absolute);
  assert.equal(readConfig({ CATALOG_PATH: './catalogs/../chosen.json' },
    { cwd, rootDir: project }).catalogPath, path.join(cwd, 'chosen.json'));
});

test('plain HTTP and HTTPS origins are normalized, including a trailing slash', () => {
  for (const [PUBLIC_ORIGIN, expected] of [
    ['https://EXAMPLE.invalid:443/', 'https://example.invalid'],
    ['http://example.invalid:80', 'http://example.invalid'],
    ['https://example.invalid:8443/', 'https://example.invalid:8443'],
    ['http://[::1]:7860/', 'http://[::1]:7860']
  ]) assert.equal(readConfig({ PUBLIC_ORIGIN }).publicOrigin, expected);
});

test('origin rejects credentials, nonroot paths, queries, fragments and non-HTTP schemes', () => {
  for (const PUBLIC_ORIGIN of [
    'https://user:synthetic@example.invalid', 'https://user@example.invalid',
    'https://example.invalid/hub', 'https://example.invalid/hub/',
    'https://example.invalid/?q=1', 'https://example.invalid/#section',
    'ftp://example.invalid', 'file:///tmp/app', 'javascript:alert(1)',
    '//example.invalid', 'example.invalid', 'https://'
  ]) assert.throws(() => readConfig({ PUBLIC_ORIGIN }), PUBLIC_ORIGIN);
});

test('configuration lookup does not modify caller environment values', () => {
  const env = Object.freeze({ HOST: '127.0.0.1', PORT: '8788',
    PUBLIC_ORIGIN: 'https://EXAMPLE.invalid/', CATALOG_PATH: './catalog.json' });
  const before = { ...env };
  readConfig(env, { cwd: os.tmpdir(), rootDir: project });
  assert.deepEqual(env, before);
});

test('external catalog works from an unrelated cwd while static pages remain project-relative', async (t) => {
  const fixture = await externalServer(t);
  const info = await request(fixture.base, '/api/v1/info');
  assert.equal(info.status, 200);
  assert.equal(JSON.parse(info.body).data.slug, 'portable-fixture');
  assert.equal(JSON.parse(info.body).data.totals.works, 1);
  const works = await request(fixture.base, '/api/v1/works');
  assert.equal(JSON.parse(works.body).data[0].id, 'fixture-work');
  const page = await request(fixture.base, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal((await request(fixture.base, '/docs/openapi.json')).status, 200);
  assert.equal(await readFile(fixture.catalogPath, 'utf8'), fixture.original);
});

test('external catalog is not exposed as a raw static file or by traversal', async (t) => {
  const fixture = await externalServer(t);
  for (const target of ['/data/catalog.json', '/catalog.json', '/private-catalog/catalog.json',
    '/../private-catalog/catalog.json', '/%2e%2e/private-catalog/catalog.json']) {
    const response = await request(fixture.base, target);
    assert.ok([400, 404].includes(response.status), `${target}: ${response.status}`);
    assert.equal(response.body.includes('portable-fixture'), false);
    assert.equal(response.body.includes(fixture.catalogPath), false);
  }
  assert.equal(await readFile(fixture.catalogPath, 'utf8'), fixture.original);
});

test('without PUBLIC_ORIGIN, OPTIONS accepts its own HTTP origin and rejects another origin', async (t) => {
  const { base } = await externalServer(t);
  const same = await request(base, '/api/v1/assets', 'OPTIONS', { Origin: base });
  assert.equal(same.status, 204);
  assert.equal(same.headers['access-control-allow-origin'], base);
  assert.equal(same.headers.vary, 'Origin');
  const cross = await request(base, '/api/v1/assets', 'OPTIONS', { Origin: 'https://other.invalid' });
  assert.equal(cross.status, 400);
  assert.equal(cross.headers['access-control-allow-origin'], undefined);
  const noOrigin = await request(base, '/api/v1/assets', 'OPTIONS');
  assert.equal(noOrigin.status, 204);
  assert.equal(noOrigin.headers['access-control-allow-origin'], undefined);
});

test('configured public origin governs proxy preflights instead of the internal HTTP listener', async (t) => {
  const { base, config } = await externalServer(t, { PUBLIC_ORIGIN: 'https://EXAMPLE.invalid:443/' });
  assert.equal(config.publicOrigin, 'https://example.invalid');
  const accepted = await request(base, '/api/v1/assets', 'OPTIONS', { Origin: config.publicOrigin });
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers['access-control-allow-origin'], config.publicOrigin);
  for (const origin of [base, 'https://other.invalid', 'http://example.invalid']) {
    const rejected = await request(base, '/api/v1/assets', 'OPTIONS', { Origin: origin });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
  }
});
