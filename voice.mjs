import path from 'node:path';
import os from 'node:os';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, open, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export const AUDIO_PREFIX = '/api/v1/audio';
export const AUDIO_ROUTES = new Set(['games', 'health', 'characters', 'clips', 'voice'].map(name => AUDIO_PREFIX + '/' + name));
const LANGUAGES = ['zh', 'en', 'ja', 'ko'];
const LANG_NAMES = { zh: '中文', en: '英语', ja: '日语', ko: '韩语' };
const LANG_ALIASES = new Map(Object.entries({ zh:'zh', 'zh-cn':'zh', 中文:'zh', 汉语:'zh', chinese:'zh',
  en:'en', 英语:'en', english:'en', ja:'ja', jp:'ja', 日语:'ja', japanese:'ja',
  ko:'ko', 韩语:'ko', korean:'ko' }));
const OUT_ALIASES = new Map(Object.entries({ audio:'audio', wav:'audio', 音频:'audio', 语音:'audio',
  text:'text', txt:'text', 文本:'text', 文字:'text' }));
const ALIASES = [...LANG_ALIASES.keys(), ...OUT_ALIASES.keys()].sort((a,b) => b.length-a.length);
const ID = /^[a-f0-9]{64}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');

export class VoiceError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
const bad = (message, code='invalid_request') => new VoiceError(400,code,message);
const unavailable = () => new VoiceError(502,'audio_file_unavailable','暂时无法读取私有音频素材。');
const boundedInt = (raw, fallback, maximum, name) => {
  const value = raw === undefined ? String(fallback) : String(raw);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)>maximum) throw new Error('Invalid '+name);
  return Number(value);
};
function inside(root, file) {
  const rel=path.relative(root,file);
  return rel !== '..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);
}
export function validateMediaPath(value, extension, {layout='genshin',speaker}={}) {
  if (typeof value!=='string' || /[\\:\0-\x1f\x7f]/.test(value)) throw new Error('Invalid audio path');
  const parts=value.split('/');
  const valid=layout==='genshin' ? parts.length>=2 && ['战斗','非战斗'].includes(parts[0])
    : layout==='character' ? parts.length===2
    : layout==='character_armor_category' ? parts.length===4 : false;
  if (!valid || parts.some(p=>!p||p==='.'||p==='..') || (speaker!==undefined && parts[0]!==speaker && layout!=='genshin') ||
      path.posix.extname(value)!==extension) throw new Error('Invalid audio path');
  return value;
}
export function readVoiceConfig(env=process.env) {
  if (!env.VOICE_LOCAL_DATA_ROOT && !env.VOICE_DATASET_ID) return null;
  const config={
    localRoot:env.VOICE_LOCAL_DATA_ROOT ? path.resolve(env.VOICE_LOCAL_DATA_ROOT):null,
    datasetId:env.VOICE_DATASET_ID||'', revision:env.VOICE_DATASET_REVISION||'',
    token:env.VOICE_HF_TOKEN||'', indexFilename:env.VOICE_INDEX_FILENAME||'api-index.jsonl',
    cacheRoot:path.resolve(env.VOICE_CACHE_DIR||path.join(os.tmpdir(),'orange-tanuki-voice')),
    maxIndexBytes:boundedInt(env.VOICE_MAX_INDEX_BYTES,256*1024*1024,256*1024*1024,'VOICE_MAX_INDEX_BYTES'),
    maxFileBytes:boundedInt(env.VOICE_MAX_FILE_BYTES,64*1024*1024,1024*1024*1024,'VOICE_MAX_FILE_BYTES'),
    cacheBytes:boundedInt(env.VOICE_CACHE_MAX_BYTES,512*1024*1024,20*1024*1024*1024,'VOICE_CACHE_MAX_BYTES'),
    timeoutMs:boundedInt(env.VOICE_DOWNLOAD_TIMEOUT_MS,120000,600000,'VOICE_DOWNLOAD_TIMEOUT_MS')
  };
  if (!/^[^/\\:\0]+\.jsonl$/.test(config.indexFilename) || config.cacheBytes<config.maxFileBytes) throw new Error('Invalid audio configuration');
  if (!config.localRoot && (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.datasetId) ||
     !/^[a-f0-9]{40}$/.test(config.revision) || !config.token)) throw new Error('Incomplete private audio configuration');
  return config;
}
export class VoiceIndex {
  constructor(bytes,{layout='genshin'}={}) {
    this.hash=sha256(bytes);this.byId=new Map();this.groups=new Map();
    const paths=new Set();
    const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    for (const line of decoded.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row=JSON.parse(line);
      if (row.record_type==='metadata') continue;
      if (row.record_type!=='audio' || !ID.test(row.source_id) || typeof row.speaker!=='string' ||
          !row.speaker.trim() || row.speaker!==row.speaker.trim() || !LANGUAGES.includes(row.language)) throw new Error('Invalid audio index');
      const audio=validateMediaPath(row.audio,'.wav',{layout,speaker:row.speaker});
      const text=validateMediaPath(row.text_file,'.txt',{layout,speaker:row.speaker});
      if (audio.slice(0,-4)+'.txt'!==text || this.byId.has(row.source_id) || paths.has(audio) || paths.has(text)) throw new Error('Invalid audio pairing');
      paths.add(audio);paths.add(text);
      const parts=audio.split('/');
      const clip={id:row.source_id,character:row.speaker,language:row.language,audio,textFile:text,
        ...(layout==='character_armor_category'?{armor:parts[1],category:parts[2]}:{})};
      this.byId.set(clip.id,Object.freeze(clip));
      const key=clip.character+'\0'+clip.language;
      if (!this.groups.has(key)) this.groups.set(key,[]);
      this.groups.get(key).push(clip.id);
    }
    if (!this.byId.size) throw new Error('Empty audio index');
    this.characters=[...new Set([...this.byId.values()].map(c=>c.character))].sort();
    this.names=new Set(this.characters);
    this.prefixes=[...this.characters].sort((a,b)=>b.length-a.length);
    for (const ids of this.groups.values()) ids.sort();
  }
  languages(character) {return LANGUAGES.filter(lang=>this.groups.has(character+'\0'+lang));}
  group(character,language) {
    if (!this.names.has(character)) throw bad('未知角色，请查询音频角色列表中的准确名称。','unknown_character');
    const ids=this.groups.get(character+'\0'+language);
    if (!ids) throw new VoiceError(404,'language_not_available','该角色没有'+(LANG_NAMES[language]||language)+'素材。');
    return ids;
  }
}
function cleanQuery(search,allowed) {
  const out=Object.create(null);
  for (const [key,value] of search) {
    if (!allowed.includes(key)||Object.hasOwn(out,key)||value.length>(key==='q'?512:256)) throw bad('查询参数未知、重复或过长。');
    out[key]=value;
  }
  return out;
}
function normalized(value,aliases,name) {
  const result=aliases.get(String(value).trim().toLowerCase());
  if (!result) throw bad('未知'+name+'限定词。');
  return result;
}
function selector(index,query) {
  let character=query.character?.trim();
  const langs=new Set(query.language===undefined?[]:[normalized(query.language,LANG_ALIASES,'语言')]);
  const outs=new Set(query.output===undefined?[]:[normalized(query.output,OUT_ALIASES,'输出')]);
  if (query.q!==undefined) {
    const value=query.q.trim(),found=index.prefixes.find(name=>value.startsWith(name));
    if (!found) throw bad('q 必须以准确角色名开头。','unknown_character');
    if (character!==undefined&&character!==found) throw bad('character 与 q 中的角色冲突。');
    character=found;
    let rest=value.slice(found.length).replace(/[\s,，;；/]+/gu,' ').trim().toLowerCase();
    while(rest) {
      const alias=ALIASES.find(name=>rest.startsWith(name));
      if (!alias) throw bad('未知限定词；仅支持语言与音频／文本。');
      if (LANG_ALIASES.has(alias)) langs.add(LANG_ALIASES.get(alias)); else outs.add(OUT_ALIASES.get(alias));
      rest=rest.slice(alias.length).trimStart();
    }
  }
  if (!character) throw bad('请指定 character 或 q。');
  if (langs.size>1 || outs.size>1) throw bad('语言或输出限定词冲突。');
  const language=[...langs][0]||'zh',output=[...outs][0]||'audio';
  index.group(character,language);
  return {character,language,output};
}
function choose(index,selected,query,revision) {
  const ids=index.group(selected.character,selected.language);
  if (query.clip_id!==undefined&&query.seed!==undefined) throw bad('clip_id 与 seed 不能同时指定。');
  if (query.clip_id!==undefined) {
    if (!ID.test(query.clip_id)) throw bad('clip_id 格式不正确。');
    const clip=index.byId.get(query.clip_id);
    if (!clip) throw new VoiceError(404,'clip_not_found','未找到该 clip_id。');
    if (clip.character!==selected.character||clip.language!==selected.language) throw bad('clip_id 不属于指定角色和语言。');
    return clip;
  }
  const position=query.seed===undefined?randomInt(ids.length):
    Number(BigInt('0x'+sha256([revision,selected.character,selected.language,query.seed].join('\0')))%BigInt(ids.length));
  return index.byId.get(ids[position]);
}
// Only the original huggingface.co origin may receive a bearer token; redirects never do.
export async function fetchHubFile(config,relative,maxBytes,fetchImpl=fetch) {
  const safe=relative.split('/').map(encodeURIComponent).join('/');
  let url=new URL('https://huggingface.co/datasets/'+config.datasetId+'/resolve/'+config.revision+'/'+safe);
  const signal=AbortSignal.timeout(config.timeoutMs);
  for (let n=0;n<=5;n++) {
    let response;
    try {
      response=await fetchImpl(url,{redirect:'manual',signal,headers:{
        'Accept-Encoding':'identity',...(url.origin==='https://huggingface.co'?{Authorization:'Bearer '+config.token}:{})
      }});
    } catch {throw unavailable();}
    if ([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get('location');await response.body?.cancel();
      if (!location||n===5) throw unavailable();
      const next=new URL(location,url);
      if (next.protocol!=='https:'||next.username||next.password||
        !(next.hostname==='huggingface.co'||next.hostname.endsWith('.huggingface.co')||next.hostname.endsWith('.hf.co'))) throw unavailable();
      url=next;continue;
    }
    if (response.status!==200||!response.body) {await response.body?.cancel();throw unavailable();}
    const length=response.headers.get('content-length');
    if (length!==null&&(!/^\d+$/.test(length)||BigInt(length)>BigInt(maxBytes))) {await response.body.cancel();throw unavailable();}
    let size=0;const parts=[];
    try {
      for await (const chunk of response.body) {
        size+=chunk.byteLength;
        if (size>maxBytes) throw unavailable();
        parts.push(Buffer.from(chunk));
      }
    } catch {throw unavailable();}
    if (length!==null&&size!==Number(length)) throw unavailable();
    if (!size&&!relative.endsWith('.txt')) throw unavailable();
    return Buffer.concat(parts,size);
  }
  throw unavailable();
}
class DiskCache {
  constructor(config,fetchImpl) {
    this.config=config;this.fetchImpl=fetchImpl;this.entries=new Map();this.inflight=new Map();this.total=0;
    this.root=path.join(config.cacheRoot,sha256(config.datasetId+'@'+config.revision).slice(0,16));
    this.hits=0;this.misses=0;
  }
  async initialize() {await mkdir(this.root,{recursive:true});this.root=await realpath(this.root);}
  async acquire(relative) {
    const name=sha256(this.config.datasetId+'@'+this.config.revision+'\0'+relative)+path.posix.extname(relative);
    if (this.entries.has(name)) {
      const e=this.entries.get(name);e.pins++;e.used=Date.now();this.hits++;
      return this.lease(e,'hit');
    }
    if (this.inflight.has(name)) {
      const e=await this.inflight.get(name);e.pins++;this.hits++;return this.lease(e,'shared');
    }
    this.misses++;
    const task=this.load(name,relative);
    this.inflight.set(name,task);
    try {
      const e=await task;e.pins++;return this.lease(e,'miss');
    } finally {this.inflight.delete(name);}
  }
  async load(name,relative) {
    const buffer=await fetchHubFile(this.config,relative,this.config.maxFileBytes,this.fetchImpl);
    const size=buffer.length;
    if (size>this.config.cacheBytes) throw unavailable();
    for (const [key,e] of [...this.entries].sort((a,b)=>a[1].used-b[1].used)) {
      if (this.total+size<=this.config.cacheBytes) break;
      if (e.pins) continue;
      this.entries.delete(key);this.total-=e.size;
      await rm(e.file,{force:true});
    }
    if (this.total+size>this.config.cacheBytes) throw new VoiceError(503,'audio_cache_busy','音频缓存繁忙。');
    const temporary=path.join(this.root,randomUUID()+'.part'),file=path.join(this.root,name);
    try {
      const handle=await open(temporary,'wx',0o600);
      try {await handle.writeFile(buffer);} finally {await handle.close();}
      await rename(temporary,file);
    } finally {await rm(temporary,{force:true}).catch(()=>{});}
    const e={file,size,pins:0,used:Date.now()};
    this.entries.set(name,e);this.total+=size;return e;
  }
  lease(e,cache) {
    let closed=false;
    return {filename:e.file,size:e.size,cache,release:()=>{if(!closed){closed=true;e.pins--;}}};
  }
  stats(){return {files:this.entries.size,bytes:this.total,max_bytes:this.config.cacheBytes,hits:this.hits,misses:this.misses,inflight:this.inflight.size};}
}
class LocalStore {
  constructor(root,maxFileBytes,layout){this.root=root;this.maxFileBytes=maxFileBytes;this.layout=layout;}
  async acquire(relative) {
    validateMediaPath(relative,path.posix.extname(relative),{layout:this.layout});
    const filename=await realpath(path.join(this.root,relative));
    if (!inside(this.root,filename)) throw bad('素材路径越界。');
    const info=await stat(filename);
    if (!info.isFile()||info.size>this.maxFileBytes||(!info.size&&relative.endsWith('.wav'))) throw unavailable();
    return {filename,size:info.size,cache:'local',release(){}};
  }
  stats(){return {files:0,bytes:0,max_bytes:0,hits:0,misses:0,inflight:0};}
}
function send(req,res,status,value,headers={}) {
  const body=Buffer.from(JSON.stringify(value));
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...headers});
  res.end(req.method==='HEAD'?undefined:body);
}
export function parseRange(value,size) {
  if (typeof value!=='string') return null;
  const m=/^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m||(!m[1]&&!m[2])||size<=0) return null;
  const total=BigInt(size);
  let start,end;
  if (!m[1]) {const suffix=BigInt(m[2]);if(!suffix)return null;start=suffix>=total?0n:total-suffix;end=total-1n;}
  else {start=BigInt(m[1]);end=m[2]?BigInt(m[2]):total-1n;if(start>=total||end<start)return null;if(end>=total)end=total-1n;}
  return {start:Number(start),end:Number(end)};
}
export class VoiceService {
  constructor(config,{fetchImpl=fetch}={}) {
    this.config=config;this.state=config?'initializing':'not_configured';
    this.ready=config?this.initialize(fetchImpl).catch(error=>{
      this.state='unavailable';this.failureCode=error instanceof VoiceError?error.code:'invalid_index_or_configuration';
    }):Promise.resolve();
  }
  async initialize(fetchImpl) {
    let bytes;
    if (this.config.localRoot) {
      const root=await realpath(this.config.localRoot),filename=await realpath(path.join(root,this.config.indexFilename));
      if (!inside(root,filename)||(await stat(filename)).size>this.config.maxIndexBytes) throw new Error('Invalid audio index');
      bytes=await readFile(filename);
      this.store=new LocalStore(root,this.config.maxFileBytes,this.config.layout);
    } else {
      bytes=await fetchHubFile(this.config,this.config.indexFilename,this.config.maxIndexBytes,fetchImpl);
      this.store=new DiskCache(this.config,fetchImpl);
      await this.store.initialize();
    }
    this.index=new VoiceIndex(bytes,{layout:this.config.layout});
    this.revision=this.config.localRoot?'local-'+this.index.hash:this.config.revision;
    this.state='ready';
  }
  async handle(req,res,pathname,search) {
    try {
      if(this.state!=='ready') return send(req,res,503,{error:{code:'audio_'+this.state,message:'音频接口尚未就绪。'}});
      const index=this.index;
      if(pathname===AUDIO_PREFIX+'/health') {
        cleanQuery(search,[]);
        return send(req,res,200,{status:'ready',mode:this.config.localRoot?'local':'private_dataset',
          clips:index.byId.size,characters:index.characters.length,revision:this.revision,cache:this.store.stats()});
      }
      if(pathname===AUDIO_PREFIX+'/characters') {
        cleanQuery(search,[]);
        return send(req,res,200,{default_language:'zh',default_output:'audio',
          characters:index.characters.map(name=>({name,languages:index.languages(name),
            counts:Object.fromEntries(index.languages(name).map(lang=>[lang,index.group(name,lang).length]))}))});
      }
      if(pathname===AUDIO_PREFIX+'/clips') {
        const q=cleanQuery(search,['character','language','page','limit']);
        const character=q.character?.trim()||'',language=normalized(q.language||'zh',LANG_ALIASES,'语言');
        const page=boundedInt(q.page,1,1000000,'page'),limit=boundedInt(q.limit,20,100,'limit');
        const ids=index.group(character,language);
        return send(req,res,200,{character,language,page,limit,total:ids.length,
          clips:ids.slice((page-1)*limit,page*limit).map(id=>{
            const clip=index.byId.get(id);
            return {id,character,language,title:path.posix.basename(clip.audio,'.wav'),
              ...(clip.armor?{armor:clip.armor,category:clip.category}:{})};
          })});
      }
      if(pathname!==AUDIO_PREFIX+'/voice') throw new VoiceError(404,'not_found','请求的资源不存在。');
      const q=cleanQuery(search,['character','q','language','output','clip_id','seed']);
      const s=selector(index,q),clip=choose(index,s,q,this.revision);
      const params=new URLSearchParams({...(this.config.game&&this.config.game!=='genshin'?{game:this.config.game}:{}),
        character:s.character,language:s.language,output:s.output,clip_id:clip.id});
      const headers={'X-Clip-ID':clip.id,'X-Voice-Language':s.language,'X-Voice-Output':s.output,
        'X-Voice-Character':encodeURIComponent(s.character),'Cache-Control':'private, no-store',
        'X-Content-Type-Options':'nosniff'};
      if (s.output==='audio'&&q.clip_id===undefined&&q.seed===undefined) {
        res.writeHead(307,{...headers,Location:AUDIO_PREFIX+'/voice?'+params.toString(),'Content-Length':'0'});return res.end();
      }
      const relative=s.output==='audio'?clip.audio:clip.textFile;
      const lease=await this.store.acquire(relative);
      try {
        const etag='"'+sha256(this.revision+'\0'+relative)+'"';
        const range=req.method==='GET'&&s.output==='audio'&&req.headers.range&&
           (!req.headers['if-range']||req.headers['if-range']===etag)?parseRange(req.headers.range,lease.size):undefined;
        if (range===null) {
          res.writeHead(416,{...headers,'Content-Range':'bytes */'+lease.size,'Content-Length':'0'});return res.end();
        }
        const size=range?range.end-range.start+1:lease.size;
        res.writeHead(range?206:200,{...headers,ETag:etag,'X-Voice-Cache':lease.cache,
          'Content-Type':s.output==='audio'?'audio/wav':'text/plain; charset=utf-8',
          'Content-Disposition':"inline; filename*=UTF-8''"+encodeURIComponent(path.posix.basename(relative)),
          'Content-Length':size,...(s.output==='audio'?{'Accept-Ranges':'bytes'}:{}),
          ...(range?{'Content-Range':'bytes '+range.start+'-'+range.end+'/'+lease.size}:{})});
        if(req.method==='HEAD'||!size)res.end();
        else await pipeline(createReadStream(lease.filename,range||{}),res);
      } finally {lease.release();}
    } catch(error) {
      if(res.headersSent||res.destroyed){res.destroy();return;}
      const safe=error instanceof VoiceError?error:unavailable();
      send(req,res,safe.status,{error:{code:safe.code,message:safe.message}});
    }
  }
}
const normalizeAlias=value=>value.trim().toLowerCase();
export function readVoiceDatasets(env=process.env,{readDefaultConfig=()=>readFileSync(new URL('./voice-datasets.json',import.meta.url),'utf8')}={}) {
  let raw;
  if(Object.hasOwn(env,'VOICE_DATASETS_JSON')) raw=env.VOICE_DATASETS_JSON;
  else {try {raw=readDefaultConfig();}catch(e){if(e?.code==='ENOENT') return [];throw e;}}
  if(typeof raw!=='string'||raw.length>65536) throw new Error('Invalid voice dataset configuration');
  if(!raw.trim())return [];
  const rows=JSON.parse(raw);
  if(!Array.isArray(rows)||rows.length>8) throw new Error('Invalid voice dataset configuration');
  const seen=new Set(['genshin','原神']);
  return rows.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||!/^[a-z][a-z0-9_-]{0,31}$/.test(row.id)||
       !['genshin','character','character_armor_category'].includes(row.layout)||
       typeof row.name!=='string'||!row.name.trim()||
       !Array.isArray(row.aliases)||row.aliases.length>8||
       row.aliases.some(a=>typeof a!=='string'||!a.trim()||a.length>64)) throw new Error('Invalid voice dataset configuration');
    const names=[row.id,...row.aliases].map(normalizeAlias);
    if(new Set(names).size!==names.length||names.some(a=>seen.has(a))) throw new Error('Duplicate voice game alias');
    for(const name of names)seen.add(name);
    const base=path.resolve(env.VOICE_CACHE_DIR||path.join(os.tmpdir(),'orange-tanuki-voice'));
    const config=readVoiceConfig({...env,VOICE_LOCAL_DATA_ROOT:row.local_root||'',VOICE_DATASET_ID:row.dataset_id||'',
      VOICE_DATASET_REVISION:row.revision||'',VOICE_INDEX_FILENAME:row.index_filename||'api-index.jsonl',
      VOICE_CACHE_DIR:path.join(base,'games',row.id)});
    if(!config) throw new Error('Incomplete voice dataset configuration');
    return {id:row.id,name:row.name,aliases:row.aliases,
      config:{...config,layout:row.layout,game:row.id}};
  });
}
export class VoiceLibraryService {
  constructor(primary,datasets=[],{fetchImpl=fetch,configurationError=false}={}) {
    this.configurationError=configurationError;this.games=new Map();
    this.aliases=new Map([['genshin','genshin'],['原神','genshin']]);
    this.games.set('genshin',{id:'genshin',name:'原神',aliases:['原神'],service:primary});
    for(const entry of datasets) {
      const {config,...descriptor}=entry;
      this.games.set(entry.id,{...descriptor,service:new VoiceService(config,{fetchImpl})});
      for(const alias of [entry.id,...entry.aliases]) this.aliases.set(normalizeAlias(alias),entry.id);
    }
    this.ready=Promise.all([...this.games.values()].map(g=>g.service.ready));
    this.catalogCache=null;this.catalogSignature='';
  }
  catalog() {
    const signature=[...this.games.values()].map(g=>g.id+':'+g.service.state).join('|');
    if(this.catalogCache&&signature===this.catalogSignature)return this.catalogCache;
    const works=[],characters=[],assets=[];
    for(const game of this.games.values()) {
      if(game.service.state!=='ready')continue;
      const workId='voice_'+game.id;
      works.push({id:workId,name:game.name,description:'来自已配置音频仓库的只读索引',aliases:game.aliases});
      const index=game.service.index;
      for(const name of index.characters) characters.push({id:'voice_'+game.id+'_'+sha256(name).slice(0,16),work_id:workId,name});
      const characterId=new Map(characters.filter(c=>c.work_id===workId).map(c=>[c.name,c.id]));
      for(const clip of index.byId.values()) {
        const params=new URLSearchParams({game:game.id,character:clip.character,language:clip.language,output:'audio',clip_id:clip.id});
        assets.push({id:'voice_'+game.id+'_'+clip.id,type:'audio',title:path.posix.basename(clip.audio,'.wav'),
          work_id:workId,character_id:characterId.get(clip.character),work_name:game.name,
          character_name:clip.character,language:clip.language,
          play_url:AUDIO_PREFIX+'/voice?'+params.toString(),
          text_url:AUDIO_PREFIX+'/voice?'+new URLSearchParams({...Object.fromEntries(params),output:'text'}).toString()});
      }
    }
    this.catalogCache={works,characters,assets};
    this.catalogSignature=signature;
    return this.catalogCache;
  }
  async handle(req,res,pathname,search) {
    try {
      if(pathname===AUDIO_PREFIX+'/games') {
        cleanQuery(search,[]);
        return send(req,res,200,{default_game:'genshin',default_language:'zh',default_output:'audio',
          configuration_error:this.configurationError,
          games:[...this.games.values()].map(g=>({id:g.id,name:g.name,aliases:g.aliases,status:g.service.state,
            ...(g.service.state==='ready'?{clips:g.service.index.byId.size,characters:g.service.index.characters.length,
              languages:LANGUAGES.filter(lang=>[...g.service.index.byId.values()].some(c=>c.language===lang))}:{})}))});
      }
      const all=search.getAll('game');
      if(all.length>1||(all.length&&(!all[0].trim()||all[0].length>64)))throw bad('game 不能重复、为空或过长。');
      const id=all.length?this.aliases.get(normalizeAlias(all[0])):'genshin';
      if(!id)throw bad('未知作品，请查询 /api/v1/audio/games。','unknown_game');
      const query=new URLSearchParams(search);query.delete('game');
      res.setHeader('X-Voice-Game',id);
      return await this.games.get(id).service.handle(req,res,pathname,query);
    }catch(error){
      if(res.headersSent||res.destroyed){res.destroy();return;}
      const safe=error instanceof VoiceError?error:unavailable();
      send(req,res,safe.status,{error:{code:safe.code,message:safe.message}});
    }
  }
}
export function createVoiceServiceFromEnv(env=process.env,{fetchImpl=fetch,readDefaultConfig}={}) {
  let primary;
  try{primary=new VoiceService(readVoiceConfig(env),{fetchImpl});}
  catch{primary=new VoiceService(null);primary.state='unavailable';}
  try{return new VoiceLibraryService(primary,readVoiceDatasets(env,{readDefaultConfig}),{fetchImpl});}
  catch{return new VoiceLibraryService(primary,[],{fetchImpl,configurationError:true});}
}
