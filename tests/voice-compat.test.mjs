import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';
import { VoiceError, VoiceIndex, VoiceService, VoiceLibraryService, readVoiceDatasets,
  createVoiceServiceFromEnv, parseRange, resolveSelector } from '../voice.mjs';

const speaker = 'FixtureSpeaker';
const rows = ['zh', 'en', 'ja', 'ko'].map((language, i) => ({ record_type: 'audio',
  source_id: String(i + 1).padStart(64, '0'), speaker, language,
  audio: speaker + '/' + language + '.wav', text_file: speaker + '/' + language + '.txt' }));
const indexBytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n'));
const wav = Buffer.alloc(48);
wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(4, 40);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'orange-voice-compat-'));
  let server;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, speaker));
  await writeFile(path.join(root, 'api-index.jsonl'), indexBytes);
  for (const row of rows) {
    await writeFile(path.join(root, row.audio), wav);
    await writeFile(path.join(root, row.text_file), 'Fixture transcript ' + row.language);
  }
  const voice = createVoiceServiceFromEnv({ VOICE_DATASETS_JSON: JSON.stringify([
    { id: 'fixture', layout: 'character', local_root: root }
  ]) });
  await voice.ready;
  server = createServer({ voiceService: voice });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (name, params = {}, options = {}) => fetch(base + '/api/v1/audio/' + name + '?' +
    new URLSearchParams({ game: 'fixture', ...params }), { redirect: 'manual', ...options });
  return { request, service: voice.games.get('fixture').service };
}

test('legacy language aliases remain accepted by clip lists and natural-language selectors', async t => {
  const { request, service } = await fixture(t);
  for (const [alias, language] of [['普通话', 'zh'], ['英文', 'en'], ['日文', 'ja'], ['韩文', 'ko']]) {
    let response = await request('clips', { character: speaker, language: alias });
    assert.equal(response.status, 200, alias);
    assert.equal((await response.json()).language, language);
    response = await request('voice', { q: speaker + ' ' + alias + ' 音频' });
    assert.equal(response.status, 307, alias);
    assert.equal(new URL(response.headers.get('location'), 'http://localhost').searchParams.get('language'), language);
    await response.arrayBuffer();
    assert.equal(resolveSelector(service.index, { character: speaker, language: alias }).language, language);
  }
});

test('media and health responses preserve revision, timing and range metadata', async t => {
  const { request, service } = await fixture(t);
  const selection = { character: speaker, clip_id: rows[0].source_id };
  let response = await request('health');
  const health = await response.json();
  assert.equal(health.revision, service.revision);
  assert.ok(Number.isFinite(health.initialization_ms) && health.initialization_ms >= 0);
  for (const [params, options, status] of [
    [selection, {}, 200], [selection, { method: 'HEAD' }, 200],
    [{ ...selection, output: 'text' }, {}, 200],
    [selection, { headers: { Range: 'bytes=0-11' } }, 206],
    [selection, { headers: { Range: 'bytes=48-' } }, 416]
  ]) {
    response = await request('voice', params, options);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('x-dataset-revision'), service.revision);
    assert.match(response.headers.get('server-timing'), /^select;dur=\d+\.\d{3}, fetch;dur=\d+\.\d{3}$/);
    assert.equal(response.headers.get('x-voice-cache'), 'local');
    assert.ok(response.headers.get('etag'));
    if (status === 416) {
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(response.headers.get('content-range'), 'bytes */48');
    }
    await response.arrayBuffer();
  }
  response = await request('voice', { character: speaker });
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('x-dataset-revision'), service.revision);
  assert.equal(response.headers.get('x-voice-cache'), 'not-fetched');
  assert.match(response.headers.get('server-timing'), /^select;dur=\d+\.\d{3}$/);
  await response.arrayBuffer();
});

test('not-ready and busy responses retain retry guidance', async t => {
  const { request, service } = await fixture(t);
  service.state = 'initializing';
  let response = await request('health');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '2');
  assert.equal((await response.json()).error.code, 'audio_initializing');
  service.state = 'ready';
  service.store.acquire = async () => { throw new VoiceError(503, 'audio_cache_busy', 'Busy'); };
  response = await request('voice', { character: speaker, clip_id: rows[0].source_id });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '2');
  assert.equal((await response.json()).error.code, 'audio_cache_busy');
});

test('explicit downloads preserve original bytes, filenames and range support', async t => {
  const { request } = await fixture(t);
  const selection = { character: speaker, clip_id: rows[0].source_id };
  for (const output of ['audio', 'text']) {
    const expected = output === 'audio' ? wav : Buffer.from('Fixture transcript zh');
    const filename = output === 'audio' ? 'zh.wav' : 'zh.txt';
    for (const method of ['GET', 'HEAD']) {
      const response = await request('voice', { ...selection, output, download: '1' }, { method });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-disposition'), "attachment; filename*=UTF-8''" + filename);
      assert.equal(Number(response.headers.get('content-length')), expected.length);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), method === 'HEAD' ? Buffer.alloc(0) : expected);
    }
    const inline = await request('voice', { ...selection, output });
    assert.match(inline.headers.get('content-disposition'), /^inline;/);
    assert.deepEqual(Buffer.from(await inline.arrayBuffer()), expected);
  }
  const range = await request('voice', { ...selection, download: '1' }, { headers: { Range: 'bytes=0-11' } });
  assert.equal(range.status, 206);
  assert.match(range.headers.get('content-disposition'), /^attachment;/);
  assert.equal(range.headers.get('content-range'), 'bytes 0-11/' + wav.length);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), wav.subarray(0, 12));
});

test('random audio redirects retain download intent and selected library', async t => {
  const { request } = await fixture(t);
  for (const method of ['GET', 'HEAD']) {
    const response = await request('voice', { character: speaker, download: '1' }, { method });
    assert.equal(response.status, 307);
    const url = new URL(response.headers.get('location'), 'http://localhost');
    assert.equal(url.searchParams.get('download'), '1');
    assert.equal(url.searchParams.get('game'), 'fixture');
    assert.equal(url.searchParams.get('clip_id'), rows[0].source_id);
    const selected = await request('voice', Object.fromEntries(url.searchParams), { method });
    assert.equal(selected.status, 200);
    assert.match(selected.headers.get('content-disposition'), /^attachment;/);
    await selected.arrayBuffer();
  }
});

test('download flags are strict and cannot be duplicated or used on unrelated endpoints', async t => {
  const { request } = await fixture(t);
  const selection = { character: speaker, clip_id: rows[0].source_id };
  for (const download of ['', '0', 'true', '2', '1\r\nUnexpected: injected']) {
    const response = await request('voice', { ...selection, download });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_request');
  }
  const redirect = await request('voice', { ...selection, download: '1' });
  const duplicated = await fetch(redirect.url + '&download=1');
  assert.equal(duplicated.status, 400);
  assert.equal((await duplicated.json()).error.code, 'invalid_request');
  await redirect.arrayBuffer();
  assert.equal((await request('clips', { character: speaker, download: '1' })).status, 400);
});

test('dataset configuration accepts BOM and optional descriptors while retaining the strict allowlist', () => {
  const row = { id: 'fixture', layout: 'character', local_root: tmpdir() };
  const read = value => readVoiceDatasets({ VOICE_DATASETS_JSON: value });
  for (const prefix of ['', '\uFEFF']) {
    const [entry] = read(prefix + JSON.stringify([row]));
    assert.equal(entry.name, row.id);
    assert.deepEqual(entry.aliases, []);
  }
  const [fromFile] = readVoiceDatasets({}, { readDefaultConfig: () => '\uFEFF' + JSON.stringify([row]) });
  assert.equal(fromFile.id, row.id);
  for (const changes of [{ token: 'must-not-be-accepted' }, { unknown: true }, { name: ' padded ' },
    { name: 'x'.repeat(65) }, { aliases: [' padded '] }, { aliases: null }, { local_root: 'relative/path' }]) {
    assert.throws(() => read(JSON.stringify([{ ...row, ...changes }])));
  }
});

test('armor and category metadata must agree with the indexed path', () => {
  const row = { ...rows[0], audio: speaker + '/FixtureArmor/FixtureCategory/clip.wav',
    text_file: speaker + '/FixtureArmor/FixtureCategory/clip.txt' };
  const read = changes => new VoiceIndex(Buffer.from(JSON.stringify({ ...row, ...changes })),
    { layout: 'character_armor_category' });
  const clip = read({ armor: 'FixtureArmor', category: 'FixtureCategory' }).byId.get(row.source_id);
  assert.equal(clip.armor, 'FixtureArmor');
  assert.equal(clip.category, 'FixtureCategory');
  assert.throws(() => read({ armor: 'WrongArmor' }), /classification/);
  assert.throws(() => read({ category: 'WrongCategory' }), /classification/);
});

test('transient index failures retry, but permanent authorization failures do not', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'orange-index-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { localRoot: null, datasetId: 'fixture/corpus', revision: 'a'.repeat(40), token: 'fixture-token',
    indexFilename: 'api-index.jsonl', cacheRoot: root, cacheBytes: 1000, maxFileBytes: 1000,
    maxIndexBytes: 4096, maxDownloads: 1, timeoutMs: 3000, layout: 'character' };
  let attempts = 0;
  const service = new VoiceService(config, { fetchImpl: async () => {
    if (++attempts === 1) return new Response(null, { status: 503 });
    return new Response(indexBytes);
  } });
  await service.ready;
  assert.equal(service.state, 'ready');
  assert.equal(attempts, 2);
  let deniedAttempts = 0;
  const denied = new VoiceService(config, { fetchImpl: async () => {
    deniedAttempts++; return new Response(null, { status: 401 });
  } });
  await denied.ready;
  assert.equal(denied.state, 'unavailable');
  assert.equal(deniedAttempts, 1);
});

test('legacy range bounds and primary service status remain available', () => {
  assert.equal(parseRange('bytes=0-' + '9'.repeat(200), 48), null);
  assert.deepEqual(parseRange('bytes=-4', 48), { start: 44, end: 47 });
  const primary = new VoiceService(null);
  const library = new VoiceLibraryService(primary);
  assert.equal(library.state, 'not_configured');
  primary.state = 'unavailable';
  assert.equal(library.state, 'unavailable');
});
