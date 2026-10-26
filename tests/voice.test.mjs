import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';
import { VoiceIndex, readVoiceDatasets, createVoiceServiceFromEnv, fetchHubFile, parseRange } from '../voice.mjs';

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
