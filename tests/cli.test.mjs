import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(project, 'server.mjs');

async function withFolder(fn) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'orange-tanuki-cli-test-'));
  try { await fn(folder); }
  finally {
    assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('orange-tanuki-cli-test-'));
    await rm(folder, { recursive: true, force: true });
  }
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['HOST', 'PORT', 'PUBLIC_ORIGIN', 'CATALOG_PATH', 'NODE_OPTIONS'].includes(key.toUpperCase())) delete env[key];
  }
  return { ...env, ...extra };
}

async function availablePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('CLI loads optional .env from another working directory and respects environment precedence', { timeout: 15000 }, async () => {
  await withFolder(async (folder) => {
    const catalog = JSON.parse(await readFile(path.join(project, 'data/catalog.json'), 'utf8'));
    catalog.hub.name = 'Portable CLI fixture';
    await writeFile(path.join(folder, 'catalog.json'), JSON.stringify(catalog));
    const port = await availablePort();
    await writeFile(path.join(folder, '.env'), 'PORT=1\nHOST=127.0.0.1\nCATALOG_PATH=./catalog.json\nPUBLIC_ORIGIN=https://hub.example.com\n');
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', script], {
      cwd: folder, env: cleanEnv({ PORT: String(port) }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const closed = once(child, 'close');
    let logs = '';
    child.stdout.on('data', (chunk) => { logs += chunk; });
    child.stderr.on('data', (chunk) => { logs += chunk; });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CLI startup timed out: ${logs}`)), 5000);
        child.stdout.on('data', () => {
          if (logs.includes('listening on')) { clearTimeout(timer); resolve(); }
        });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`CLI exited ${code}: ${logs}`)); });
      });
      const base = `http://127.0.0.1:${port}`;
      const info = await fetch(`${base}/api/v1/info`).then((response) => response.json());
      assert.equal(info.data.name, 'Portable CLI fixture');
      assert.equal((await fetch(base)).status, 200);
      assert.equal((await fetch(`${base}/api/v1/assets`, { method: 'OPTIONS', headers: { Origin: 'https://hub.example.com' } })).status, 204);
      assert.equal((await fetch(`${base}/catalog.json`)).status, 404);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await closed;
    }
  });
});

test('CLI missing optional .env does not mask invalid catalog startup failure', { timeout: 15000 }, async () => {
  await withFolder(async (folder) => {
    await writeFile(path.join(folder, 'invalid.json'), '{');
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', script], {
      cwd: folder, env: cleanEnv({ CATALOG_PATH: './invalid.json' }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    child.stdout.on('data', (chunk) => { logs += chunk; });
    child.stderr.on('data', (chunk) => { logs += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    assert.match(logs, /startup failed/);
    assert.doesNotMatch(logs, /listening on/);
  });
});
