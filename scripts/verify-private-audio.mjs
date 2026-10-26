import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';
import { readConfig } from '../config.mjs';
import { createVoiceServiceFromEnv } from '../voice.mjs';

// Only fixed check names and numeric counts leave this process. Never log errors,
// environment values, response bodies, dataset mappings, characters or URLs.
class CheckFailure extends Error {
  constructor(stage) { super(stage); this.stage = stage; }
}
const requireCheck = (condition, stage) => { if (!condition) throw new CheckFailure(stage); };
function positiveInteger(raw, fallback, maximum) {
  const value = raw === undefined ? fallback : Number(raw);
  requireCheck(/^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(value) && value <= maximum, 'expectations');
  return value;
}

export async function verifyPrivateAudio(env = process.env) {
  let stage = 'configuration', temporary, server;
  try {
    const expectedGames = positiveInteger(env.VOICE_VERIFY_EXPECT_GAMES, 5, 9);
    const expectedClips = env.VOICE_VERIFY_EXPECT_CLIPS === undefined ? null
      : positiveInteger(env.VOICE_VERIFY_EXPECT_CLIPS, undefined, Number.MAX_SAFE_INTEGER);
    const timeoutMs = positiveInteger(env.VOICE_DOWNLOAD_TIMEOUT_MS, 120000, 600000) + 5000;
    temporary = await mkdtemp(path.join(tmpdir(), 'orange-private-check-'));
    const privateEnv = { ...env, VOICE_CACHE_DIR: temporary };
    const { catalogPath } = readConfig({ ...env, PORT: '7860', HOST: '127.0.0.1', PUBLIC_ORIGIN: '' });
    const local = JSON.parse(await readFile(catalogPath, 'utf8'));
    const voice = createVoiceServiceFromEnv(privateEnv);
    stage = 'index_ready';
    await voice.ready;
    server = createServer({ catalogPath, voiceService: voice });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = async (endpoint, status = 200, options = {}) => {
      const response = await fetch(base + endpoint, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== status) {
        await response.body?.cancel();
        throw new CheckFailure(stage);
      }
      return response;
    };
    const json = async endpoint => await (await request(endpoint)).json();
    const endpoint = (name, query) => '/api/v1/audio/' + name + '?' + new URLSearchParams(query);
    const gamesResponse = await json('/api/v1/audio/games');
    requireCheck(gamesResponse.configuration_error === false, stage);
    const games = gamesResponse.games.filter(game => game.status !== 'not_configured');
    requireCheck(games.length === expectedGames && games.every(game => game.status === 'ready' && game.clips > 0), stage);
    const total = games.reduce((sum, game) => sum + game.clips, 0);
    requireCheck(expectedClips === null || total === expectedClips, 'expected_clip_count');
    stage = 'catalog_counts';
    const stats = (await json('/api/v1/stats')).data;
    requireCheck(stats.totals.assets === local.assets.length + total, stage);
    requireCheck(stats.by_type.audio === local.assets.filter(asset => asset.type === 'audio').length + total, stage);
    requireCheck((await json('/api/v1/works')).meta.total === local.works.length + games.length, stage);
    requireCheck((await json('/api/v1/characters')).meta.total === local.characters.length + games.reduce((sum, game) => sum + game.characters, 0), stage);
    let audioBytes = 0, textBytes = 0;
    for (const game of games) {
      stage = 'character_counts';
      const { characters } = await json(endpoint('characters', { game: game.id }));
      requireCheck(characters.length === game.characters, stage);
      requireCheck(characters.reduce((sum, character) => sum + Object.values(character.counts).reduce((a, b) => a + b, 0), 0) === game.clips, stage);
      const character = characters[0], language = character.languages[0];
      const selection = { game: game.id, character: character.name, language };
      stage = 'clip_pagination';
      const first = await json(endpoint('clips', { ...selection, page: '1', limit: '1' }));
      const second = await json(endpoint('clips', { ...selection, page: '2', limit: '1' }));
      requireCheck(first.total === character.counts[language] && first.clips.length === 1, stage);
      requireCheck(second.total === first.total && second.clips.length === (first.total > 1 ? 1 : 0), stage);
      requireCheck(first.total === 1 || first.clips[0].id !== second.clips[0].id, stage);
      const pastEnd = await json(endpoint('clips', { ...selection, page: String(Math.ceil(first.total / 100) + 1), limit: '100' }));
      requireCheck(pastEnd.clips.length === 0 && pastEnd.total === first.total, stage);
      stage = 'asset_pagination';
      const assetPath = '/api/v1/assets?' + new URLSearchParams({ type: 'audio', work: 'voice_' + game.id, page_size: '1' });
      const assets = await json(assetPath), nextAssets = await json(assetPath + '&page=2');
      requireCheck(assets.meta.total === game.clips && assets.data.length === 1, stage);
      requireCheck(nextAssets.data.length === (game.clips > 1 ? 1 : 0), stage);
      requireCheck(game.clips === 1 || assets.data[0].id !== nextAssets.data[0].id, stage);
      stage = 'wav';
      const clipId = first.clips[0].id;
      const audioPath = endpoint('voice', { ...selection, clip_id: clipId, output: 'audio' });
      const audio = await request(audioPath), wav = Buffer.from(await audio.arrayBuffer());
      requireCheck(audio.headers.get('content-type') === 'audio/wav' && audio.headers.get('x-clip-id') === clipId, stage);
      requireCheck(wav.length >= 12 && wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE', stage);
      requireCheck(Number(audio.headers.get('content-length')) === wav.length, stage);
      audioBytes += wav.length;
      stage = 'head';
      const head = await request(audioPath, 200, { method: 'HEAD' });
      requireCheck(Number(head.headers.get('content-length')) === wav.length && (await head.arrayBuffer()).byteLength === 0, stage);
      stage = 'range';
      const range = await request(audioPath, 206, { headers: { Range: 'bytes=0-11' } });
      requireCheck(range.headers.get('content-range') === 'bytes 0-11/' + wav.length, stage);
      requireCheck(Buffer.from(await range.arrayBuffer()).equals(wav.subarray(0, 12)), stage);
      const invalidRange = await request(audioPath, 416, { headers: { Range: 'bytes=' + wav.length + '-' } });
      requireCheck(invalidRange.headers.get('content-range') === 'bytes */' + wav.length && (await invalidRange.arrayBuffer()).byteLength === 0, stage);
      stage = 'text';
      const text = await request(endpoint('voice', { ...selection, clip_id: clipId, output: 'text' }));
      const textBuffer = await text.arrayBuffer();
      requireCheck(text.headers.get('content-type') === 'text/plain; charset=utf-8' && text.headers.get('x-clip-id') === clipId, stage);
      new TextDecoder('utf-8', { fatal: true }).decode(textBuffer);
      textBytes += textBuffer.byteLength;
      stage = 'invalid_parameters';
      for (const invalid of [{ page: '0' }, { limit: '101' }, { page: 'abc' }]) {
        const failure = await request(endpoint('clips', { ...selection, ...invalid }), 400);
        requireCheck((await failure.json()).error?.code === 'invalid_request', stage);
      }
      stage = 'cache_limits';
      const { cache, mode } = await json(endpoint('health', { game: game.id }));
      requireCheck(cache.bytes <= cache.max_bytes && cache.inflight === 0, stage);
      requireCheck(mode !== 'private_dataset' || cache.misses === 2, stage);
    }
    return { ok: true, games: games.length, clips: total, sampled_audio: games.length, sampled_text: games.length,
      audio_bytes: audioBytes, text_bytes: textBytes, checks: ['index', 'catalog', 'pagination', 'wav_header', 'text_utf8', 'head', 'range_206_416', 'invalid_parameters', 'cache_limits'], listening_verified: false };
  } catch (error) {
    throw error instanceof CheckFailure ? error : new CheckFailure(stage);
  } finally {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyPrivateAudio())); }
  catch (error) {
    console.error(JSON.stringify({ ok: false, stage: error instanceof CheckFailure ? error.stage : 'cleanup' }));
    process.exitCode = 1;
  }
}
