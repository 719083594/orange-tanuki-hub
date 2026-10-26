import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/verify-private-audio.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'orange-private-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), temporary = path.join(root, 'temporary'), cache = path.join(root, 'existing-cache');
  await Promise.all([mkdir(source), mkdir(temporary), mkdir(cache)]);
  await writeFile(path.join(cache, 'keep.txt'), 'unchanged');
  const speaker = 'PrivateFixtureCharacter';
  const rows = [1, 2].map(i => ({ record_type: 'audio', source_id: String(i).padStart(64, '0'), speaker,
    language: 'zh', audio: speaker + '/' + i + '.wav', text_file: speaker + '/' + i + '.txt' }));
  await mkdir(path.join(source, speaker));
  await writeFile(path.join(source, 'api-index.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  // Clip 2 deliberately has no media: metadata pagination must not pre-download it.
  const wavPath = path.join(source, speaker, '1.wav'), textPath = path.join(source, speaker, '1.txt');
  await writeFile(wavPath, Buffer.from('RIFF____WAVEfmt ' + 'a'.repeat(32)));
  await writeFile(textPath, 'private fixture text');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VOICE_') && name !== 'CATALOG_PATH'));
  Object.assign(env, { TMPDIR: temporary, TMP: temporary, TEMP: temporary, VOICE_CACHE_DIR: cache,
    VOICE_VERIFY_EXPECT_GAMES: '2', VOICE_VERIFY_EXPECT_CLIPS: '4',
    VOICE_DATASETS_JSON: JSON.stringify(['one', 'two'].map(id => ({ id, name: 'PrivateFixtureWork', aliases: [],
      layout: 'character', local_root: source, index_filename: 'api-index.jsonl' }))) });
  const run = overrides => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...env, ...overrides } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { run, temporary, cache, wavPath, textPath };
}

test('private verifier uses real loopback HTTP, validates metadata and media, and preserves existing cache', async t => {
  const data = await fixture(t), result = await data.run();
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true); assert.equal(report.games, 2); assert.equal(report.clips, 4);
  assert.equal(report.sampled_audio, 2); assert.equal(report.listening_verified, false);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('PrivateFixture'));
  assert.equal(await readFile(path.join(data.cache, 'keep.txt'), 'utf8'), 'unchanged');
  assert.deepEqual(await readdir(data.temporary), []);
});

test('private verifier fails on incorrect inventory expectations without printing private values', async t => {
  const data = await fixture(t), result = await data.run({ VOICE_VERIFY_EXPECT_CLIPS: '5' });
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, stage: 'expected_clip_count' });
  assert.equal(result.stdout, '');
  assert.deepEqual(await readdir(data.temporary), []);
});

test('private verifier rejects invalid WAV data and a missing paired text file', async t => {
  const data = await fixture(t);
  await writeFile(data.wavPath, 'not a wave file');
  let result = await data.run();
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).stage, 'wav');
  await writeFile(data.wavPath, 'RIFF____WAVEfmt ' + 'a'.repeat(32));
  await rm(data.textPath);
  result = await data.run();
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).stage, 'text');
  assert.ok(!result.stderr.includes('PrivateFixture'));
  assert.deepEqual(await readdir(data.temporary), []);
});
