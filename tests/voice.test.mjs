import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, utimes, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';
import { VoiceIndex, VoiceService, VoiceLibraryService, readVoiceDatasets, createVoiceServiceFromEnv, fetchHubFile, parseRange } from '../voice.mjs';

const id='a'.repeat(64);
const bytes=Buffer.from('RIFF____WAVEfmt '+'a'.repeat(32));
const index=Buffer.from(JSON.stringify({record_type:'metadata',version:1})+'\n'+JSON.stringify({
  record_type:'audio',source_id:id,speaker:'丁原',language:'zh',audio:'丁原/001.wav',text_file:'丁原/001.txt'
})+'\n','utf8');

test('strict and reversible indexed audio mapping',()=>{
  const voice=new VoiceIndex(index,{layout:'character'});
  assert.equal(voice.byId.size,1);
  assert.deepEqual(voice.languages('丁原'),['zh']);
  assert.deepEqual(parseRange('bytes=0-3',20),{start:0,end:3});
  assert.deepEqual(parseRange('bytes=-4',20),{start:16,end:19});
  assert.equal(parseRange('bytes=22-',20),null);
  assert.throws(()=>new VoiceIndex(Buffer.from('{}\n'),{layout:'character'}),/Invalid audio index/);
});

test('private config is allowlisted, never creates arbitrary dataset URL',()=>{
  assert.deepEqual(readVoiceDatasets({VOICE_DATASETS_JSON:'[]'}),[]);
  assert.throws(()=>readVoiceDatasets({VOICE_DATASETS_JSON:JSON.stringify([{
    id:'bad',name:'Bad',aliases:[],layout:'character',dataset_id:'https://example.test/token',
    revision:'0'.repeat(40)
  }])}),/configuration/i);
});

test('redirected Hub download never exposes bearer token',async()=>{
  const seen=[];
  const config={datasetId:'owner/repo',revision:'a'.repeat(40),token:'private-fixture-token',timeoutMs:3000};
  const impl=async(url,options)=>{
    seen.push({url:String(url),token:options.headers.Authorization});
    if(seen.length===1)return new Response(null,{status:302,headers:{location:'https://cdn.hf.co/file'}});
    return new Response(Buffer.from('sample'),{status:200});
  };
  assert.equal((await fetchHubFile(config,'api-index.jsonl',1000,impl)).toString(),'sample');
  assert.equal(seen[0].token,'Bearer private-fixture-token');
  assert.equal(seen[1].token,undefined);
  await assert.rejects(fetchHubFile(config,'api-index.jsonl',1000,async()=>new Response(null,{
    status:302,headers:{location:'https://malicious.example/collect'}
  })),/audio_file_unavailable|私有音频/);
});

test('catalog + live audio + text + range remain consistent',async(t)=>{
  const root=await mkdtemp(path.join(tmpdir(),'orange-voice-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'丁原'));
  await writeFile(path.join(root,'api-index.jsonl'),index);
  await writeFile(path.join(root,'丁原','001.wav'),bytes);
  await writeFile(path.join(root,'丁原','001.txt'),'你是谁？\n');
  const datasets=[{id:'sgs',name:'测试作品',aliases:['测试'],layout:'character',
    local_root:root,index_filename:'api-index.jsonl'}];
  const voice=createVoiceServiceFromEnv({VOICE_DATASETS_JSON:JSON.stringify(datasets)});
  await voice.ready;
  const server=createServer({voiceService:voice});
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const get=async(url,options)=>await fetch(base+url,options);
  let r=await get('/api/v1/audio/games');
  let body=await r.json();assert.equal(r.status,200);assert.equal(body.configuration_error,false);
  assert.equal(body.games.find(x=>x.id==='sgs').clips,1);
  r=await get('/api/v1/stats');body=(await r.json()).data;assert.equal(body.totals.assets,1);
  assert.equal(body.by_type.audio,1);assert.equal(body.totals.works,1);
  r=await get('/api/v1/assets?type=audio&q=%E4%B8%81%E5%8E%9F');
  body=await r.json();assert.equal(body.meta.total,1);
  assert.equal(body.data[0].character_name,'丁原');
  assert.ok(body.data[0].play_url.startsWith('/api/v1/audio/voice?'));
  assert.ok(!JSON.stringify(body).includes('private-fixture-token'));
  r=await get('/api/v1/works');body=await r.json();assert.equal(body.meta.total,1);
  r=await get('/api/v1/characters?page_size=100');body=await r.json();assert.equal(body.meta.total,1);
  r=await get('/api/v1/audio/characters?game=sgs');body=await r.json();
  assert.equal(body.characters[0].counts.zh,1);
  r=await get('/api/v1/audio/clips?game=sgs&character=%E4%B8%81%E5%8E%9F');
  body=await r.json();assert.equal(body.total,1);
  for(const invalid of ['page=0','page=abc','page=1000001','limit=0','limit=101','limit=1.5','page=']) {
    r=await get('/api/v1/audio/clips?game=sgs&character=%E4%B8%81%E5%8E%9F&'+invalid);
    assert.equal(r.status,400,invalid+' must be a client error');
    assert.equal((await r.json()).error.code,'invalid_request');
  }
  const audio='/api/v1/audio/voice?game=sgs&character=%E4%B8%81%E5%8E%9F&language=zh&clip_id='+id;
  r=await get(audio);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'audio/wav');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
  r=await get(audio,{headers:{Range:'bytes=0-3'}});assert.equal(r.status,206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(0,4));
  r=await get(audio,{method:'HEAD'});assert.equal(r.status,200);assert.equal((await r.text()).length,0);
  r=await get(audio+'&output=text');assert.equal(r.status,200);
  assert.equal(await r.text(),'你是谁？\n');
  r=await get('/api/v1/audio/games?utm_source=chatgpt.com');assert.equal(r.status,400);
  r=await get('/api/v1/audio/characters?game=unknown');assert.equal(r.status,400);
});

async function remoteFixture(t,{cacheBytes=100,fetchMedia=async()=>new Response(Buffer.alloc(80))}={}) {
  const cacheRoot=await mkdtemp(path.join(tmpdir(),'orange-voice-cache-test-'));
  t.after(()=>rm(cacheRoot,{recursive:true,force:true}));
  const config={localRoot:null,datasetId:'fixture/corpus',revision:'a'.repeat(40),token:'fixture-token',
    indexFilename:'api-index.jsonl',layout:'character',cacheRoot,cacheBytes,maxFileBytes:80,
    maxIndexBytes:4096,maxDownloads:3,timeoutMs:3000};
  const service=new VoiceService(config,{fetchImpl:async(url)=>
    String(url).endsWith('/api-index.jsonl')?new Response(index):fetchMedia(url)});
  await service.ready;
  assert.equal(service.state,'ready');
  return service;
}

test('parallel downloads respect disk quota and retain pinned and shared readers',async(t)=>{
  let arrivals=0,releaseDownloads;
  const allArrived=new Promise(resolve=>{releaseDownloads=resolve;});
  const service=await remoteFixture(t,{fetchMedia:async()=>{
    if(++arrivals===3)releaseDownloads();
    await allArrived;
    return new Response(Buffer.alloc(80));
  }});
  const store=service.store;
  const paths=['丁原/001.wav','丁原/002.wav','丁原/003.wav'];
  const results=await Promise.allSettled(paths.map(relative=>store.acquire(relative)));
  const good=results.filter(r=>r.status==='fulfilled'),bad=results.filter(r=>r.status==='rejected');
  assert.equal(good.length,1,'one 80-byte lease fits the 100-byte quota');
  assert.equal(bad.length,2);
  assert.ok(bad.every(r=>r.reason.code==='audio_cache_busy'));
  assert.equal(store.stats().bytes,80);
  assert.equal((await readdir(store.root)).length,1);
  assert.equal((await readFile(good[0].value.filename)).length,80);

  const other=paths[results.findIndex(r=>r.status==='rejected')];
  await assert.rejects(store.acquire(other),error=>error.code==='audio_cache_busy');
  good[0].value.release();
  const before=arrivals;
  const [first,shared]=await Promise.all([store.acquire(other),store.acquire(other)]);
  assert.equal(arrivals,before+1,'identical requests share one download');
  assert.equal(first.filename,shared.filename);
  assert.equal(store.stats().bytes,80);
  assert.equal((await readdir(store.root)).length,1);
  const next=paths.find(relative=>relative!==other);
  first.release();
  await assert.rejects(store.acquire(next),error=>error.code==='audio_cache_busy','shared reader keeps its pin');
  shared.release();
  const afterRelease=await store.acquire(next);
  assert.equal((await readFile(afterRelease.filename)).length,80);
  afterRelease.release();
  assert.equal(store.stats().bytes,80);
});

test('failed cache commit cleans temporary bytes and allows a later retry',async(t)=>{
  const service=await remoteFixture(t);
  const store=service.store,relative='丁原/001.wav';
  const name=createHash('sha256').update(service.config.datasetId+'@'+service.config.revision+'\0'+relative).digest('hex')+'.wav';
  const obstruction=path.join(store.root,name);
  await mkdir(obstruction);
  await assert.rejects(store.acquire(relative));
  assert.equal(store.stats().bytes,0);
  assert.equal(store.stats().files,0);
  assert.equal(store.stats().inflight,0);
  assert.deepEqual(await readdir(store.root),[name],'failed rename must leave no .part file');
  await rm(obstruction,{recursive:true});
  const lease=await store.acquire(relative);
  assert.equal((await readFile(lease.filename)).length,80);
  assert.equal(store.stats().bytes,80);
  lease.release();
});

test('restarting the cache restores existing bytes and evicts within the same quota',async(t)=>{
  const original=await remoteFixture(t);
  const old=await original.store.acquire('丁原/001.wav');
  old.release();
  let downloads=0;
  const restarted=new VoiceService(original.config,{fetchImpl:async(url)=>{
    if(String(url).endsWith('/api-index.jsonl'))return new Response(index);
    downloads++;return new Response(Buffer.alloc(80));
  }});
  await restarted.ready;
  assert.equal(restarted.state,'ready');
  assert.equal(restarted.store.stats().bytes,80);
  assert.equal(restarted.store.stats().files,1);
  const reused=await restarted.store.acquire('丁原/001.wav');
  assert.equal(reused.cache,'hit');assert.equal(downloads,0);
  reused.release();
  const next=await restarted.store.acquire('丁原/002.wav');
  next.release();
  assert.equal(downloads,1);
  assert.equal(restarted.store.stats().bytes,80);
  assert.equal((await readdir(restarted.store.root)).length,1);
  await assert.rejects(lstat(old.filename),error=>error.code==='ENOENT');
});

test('startup trims old committed cache files without touching unknown files, directories or partial writes',async(t)=>{
  const original=await remoteFixture(t);
  const root=original.store.root;
  const oldest='a'.repeat(64)+'.wav',newest='b'.repeat(64)+'.wav',directory='c'.repeat(64)+'.txt';
  const oversized='e'.repeat(64)+'.wav',emptyAudio='f'.repeat(64)+'.wav',emptyText='0'.repeat(64)+'.txt';
  await writeFile(path.join(root,oldest),Buffer.alloc(80));
  await writeFile(path.join(root,newest),Buffer.alloc(80));
  await utimes(path.join(root,oldest),1,1);
  await utimes(path.join(root,newest),2,2);
  await writeFile(path.join(root,oversized),Buffer.alloc(81));
  await writeFile(path.join(root,emptyAudio),Buffer.alloc(0));
  await writeFile(path.join(root,emptyText),Buffer.alloc(0));
  await writeFile(path.join(root,'user-notes.txt'),'keep notes');
  await writeFile(path.join(root,'active-download.part'),'keep partial download');
  await mkdir(path.join(root,directory));
  await writeFile(path.join(root,directory,'keep'),'keep directory');
  const restarted=new VoiceService(original.config,{fetchImpl:async()=>new Response(index)});
  await restarted.ready;
  assert.equal(restarted.state,'ready');
  assert.equal(restarted.store.stats().bytes,80);
  assert.equal(restarted.store.stats().files,2,'empty text is valid; empty WAV and oversized files are not');
  await assert.rejects(lstat(path.join(root,oldest)),error=>error.code==='ENOENT');
  await assert.rejects(lstat(path.join(root,oversized)),error=>error.code==='ENOENT');
  await assert.rejects(lstat(path.join(root,emptyAudio)),error=>error.code==='ENOENT');
  assert.equal((await lstat(path.join(root,emptyText))).size,0);
  assert.equal((await readFile(path.join(root,newest))).length,80);
  assert.equal(await readFile(path.join(root,'user-notes.txt'),'utf8'),'keep notes');
  assert.equal(await readFile(path.join(root,'active-download.part'),'utf8'),'keep partial download');
  assert.equal(await readFile(path.join(root,directory,'keep'),'utf8'),'keep directory');
});

test('startup ignores cached-file symlinks and refuses a symlinked revision directory',async(t)=>{
  const original=await remoteFixture(t);
  const outside=path.join(original.config.cacheRoot,'outside');
  await mkdir(outside);
  const target=path.join(outside,'private.wav');
  await writeFile(target,Buffer.alloc(80));
  const linkedFile=path.join(original.store.root,'d'.repeat(64)+'.wav');
  try {await symlink(target,linkedFile,'file');}
  catch(error) {
    if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip('file symlinks unavailable on this host');return;}
    throw error;
  }
  const restarted=new VoiceService(original.config,{fetchImpl:async()=>new Response(index)});
  await restarted.ready;
  assert.equal(restarted.state,'ready');
  assert.equal(restarted.store.stats().bytes,0);
  assert.equal((await lstat(linkedFile)).isSymbolicLink(),true);
  assert.equal((await readFile(target)).length,80);
  await rm(linkedFile);
  await rm(original.store.root,{recursive:true});
  await symlink(outside,original.store.root,process.platform==='win32'?'junction':'dir');
  const linkedRoot=new VoiceService(original.config,{fetchImpl:async()=>new Response(index)});
  await linkedRoot.ready;
  assert.equal(linkedRoot.state,'unavailable');
  assert.equal((await readFile(target)).length,80);
});


test('46,598 synthetic clips aggregate without downloading media or returning giant lists', async (t) => {
  const cases = [['genshin',11254,127],['sanguosha',13910,416],['starrail',2937,82],
    ['zzz',4404,59],['bh3',14093,41]];
  function mock(name,count,characters) {
    const rows=Array.from({length:count},(_,i)=>{
      const speaker='角色'+(i%characters);
      const base=speaker+'/'+String(i).padStart(6,'0');
      return JSON.stringify({record_type:'audio',source_id:i.toString(16).padStart(64,'0'),
        speaker,language:'zh',audio:base+'.wav',text_file:base+'.txt'});
    });
    const index=new VoiceIndex(Buffer.from(rows.join('\n')+'\n'),{layout:'character'});
    return {state:'ready',index,ready:Promise.resolve()};
  }
  const primary=mock(...cases[0]);
  const library=new VoiceLibraryService(primary,[]);
  for(const [game,count,characters] of cases.slice(1))
    library.games.set(game,{id:game,name:game,aliases:[],service:mock(game,count,characters)});
  const snapshot=library.catalog();
  assert.equal(snapshot.assets.length,46598);
  assert.equal(snapshot.characters.length,725);
  assert.equal(snapshot.works.length,5);
  assert.strictEqual(library.catalog(),snapshot,'catalog should not rebuild on every request');
  const server=createServer({voiceService:library});
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const host='http://127.0.0.1:'+server.address().port;
  let response=await fetch(host+'/api/v1/stats');
  assert.equal(response.status,200);
  let body=(await response.json()).data;
  assert.equal(body.totals.assets,46598);
  assert.equal(body.by_type.audio,46598);
  response=await fetch(host+'/api/v1/assets?type=audio&page_size=24&page=2');
  body=await response.json();
  assert.equal(body.meta.total,46598);
  assert.equal(body.data.length,24,'browser receives only the requested page');
  assert.ok(body.data.every(row=>row.play_url?.startsWith('/api/v1/audio/voice?')));
});
