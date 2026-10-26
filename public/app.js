'use strict';

(() => {
  const main = document.getElementById('main');
  const state = { info: null, stats: null, sequence: 0, summarySequence: 0, toastTimer: null, workNames: new Map(), characterNames: new Map() };
  const pageNames = { overview: '总览', assets: '素材浏览', catalog: '作品与角色', models: '模型版本', upload: '上传入库', api: 'API 接入' };
  const types = [['', '全部素材', 'grid'], ['audio', '音频', 'audio'], ['image', '图片', 'image'], ['model', '音色模型', 'model']];
  const endpoints = [
    ['/api/v1/info', '站点信息', '名称、简介、存储状态与资源总量。'],
    ['/api/v1/stats', '资源统计', '按素材类型与语言查看汇总。'],
    ['/api/v1/assets', '素材列表', '支持关键词与分类筛选；图片可区分角色关联和独立图片。'],
    ['/api/v1/works', '作品目录', '查看已入库的作品，支持关键词搜索。'],
    ['/api/v1/characters', '角色目录', '按作品或关键词查找角色。'],
    ['/api/v1/models', '音色模型', '查看模型索引与关联信息。'],
    ['/api/v1/audio/games', '音频作品', '列出可用游戏、角色数量和音频索引状态。'],
    ['/api/v1/audio/characters', '音频角色', '传 game 参数查询已加载角色和音频数量。'],
    ['/healthz', '服务状态', '检查当前同源服务是否可用。']
  ];

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
  const active = sequence => sequence === state.sequence;
  const loading = (message = '正在读取资料库…') => `<div class="loading-state" role="status"><span class="spinner" aria-hidden="true"></span>${esc(message)}</div>`;
  const heading = (title, description, eyebrow, actions = '') => `<div class="page-heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
  const arrowLink = (href, text, primary = false) => `<a class="button${primary ? ' primary' : ''}" href="${esc(href)}">${esc(text)}${icon('arrow')}</a>`;
  function empty(title, description, kind = 'folder', action = '', compact = false) {
    return `<div class="empty-state${compact ? ' compact' : ''}"><div class="empty-illustration" aria-hidden="true"><span class="empty-paper back"></span><span class="empty-paper front">${icon(kind)}</span><span class="empty-dot"></span><span class="empty-dot second"></span></div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;
  }
  function errorPanel(error, retry = 'page') {
    return `<div class="error-state" role="alert">${icon('info')}<h3>暂时无法读取数据</h3><p>${esc(error.message || '请检查服务连接后重试。')}</p><button class="button" type="button" data-retry="${retry}">${icon('refresh')}重新加载</button></div>`;
  }
  function toast(message) {
    const el = document.getElementById('toast');
    clearTimeout(state.toastTimer); el.textContent = message; el.hidden = false;
    state.toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }
  function route() {
    const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
    return { page: pageNames[path] ? path : 'overview', params: new URLSearchParams(query) };
  }
  function routeURL(page, params = {}) {
    const query = page === 'assets' ? normalizeAssetParams(params) : new URLSearchParams(params);
    [...query.keys()].forEach(key => { if (!query.get(key)) query.delete(key); });
    return `#/${page}${query.size ? `?${query}` : ''}`;
  }
  function navigate(page, params = {}) {
    const hash = routeURL(page, params);
    if (location.hash === hash) render(); else location.hash = hash;
  }
  function normalizeAssetParams(params) {
    const query = new URLSearchParams(params);
    if (query.get('type') && query.get('type') !== 'audio') query.delete('view');
    else if (query.has('view') && !['works', 'characters', 'clips'].includes(query.get('view'))) query.delete('view');
    if (query.get('type') !== 'image') query.delete('image_scope');
    else {
      query.delete('language'); query.delete('emotion');
      if (!query.get('image_scope')) query.delete('image_scope');
      if (query.get('image_scope') === 'standalone') { query.delete('work'); query.delete('character'); }
    }
    return query;
  }
  async function request(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(path, { headers: { Accept: 'application/json' }, signal: controller.signal, cache: 'no-store' });
      let json;
      try { json = await response.json(); } catch { throw new Error(`接口返回了无法读取的内容（HTTP ${response.status}）。`); }
      if (!response.ok) throw new Error(json.error?.message || `请求失败（HTTP ${response.status}）。`);
      return json;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请确认服务仍在运行后重试。');
      if (error instanceof TypeError) throw new Error('无法连接服务，请检查服务状态后重试。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function listResult(result) {
    if (!Array.isArray(result.data) || !result.meta || !Number.isFinite(result.meta.total)) throw new Error('接口列表格式不正确，暂时无法显示。');
    return result;
  }
  async function refreshSummary() {
    const sequence = ++state.summarySequence;
    try {
      const [info, stats] = await Promise.all([request('/api/v1/info'), request('/api/v1/stats')]);
      if (!info.data || !stats.data?.totals || !Number.isFinite(stats.data.totals.assets)) throw new Error('统计接口格式不正确。');
      if (sequence !== state.summarySequence) return state.stats;
      state.info = info.data; state.stats = stats.data;
      document.getElementById('nav-assets-count').textContent = number(stats.data.totals.assets);
      document.getElementById('service-label').textContent = '接口已连接';
      document.getElementById('service-dot').className = 'status-dot online';
      document.querySelectorAll('[data-type-count]').forEach(el => { el.textContent = number(typeCount(el.dataset.typeCount)); });
      document.querySelectorAll('[data-total]').forEach(el => { el.textContent = number(state.stats.totals[el.dataset.total]); });
      return stats.data;
    } catch (error) {
      if (sequence !== state.summarySequence) return state.stats;
      state.info = null; state.stats = null;
      document.getElementById('nav-assets-count').textContent = '—';
      document.getElementById('service-label').textContent = '接口未连接';
      document.getElementById('service-dot').className = 'status-dot error';
      throw error;
    }
  }
  const typeCount = type => state.stats ? (type ? state.stats.by_type?.[type] ?? 0 : state.stats.totals.assets) : undefined;
  const joined = values => Array.isArray(values) && values.length ? values.join('、') : '—';
  const workName = id => state.workNames.get(id) || id || '—';
  const characterName = id => state.characterNames.get(id) || id || '—';
  function rememberNames(kind, rows) {
    const map = kind === 'works' ? state.workNames : state.characterNames;
    rows.forEach(row => { if (row.id && row.name) map.set(row.id, row.name); });
  }
  function fileDescriptions(files) {
    if (!Array.isArray(files) || !files.length) return '—';
    return files.map(file => `${file.storage_key}${typeof file.size_bytes === 'number' ? ` (${number(file.size_bytes)} B)` : ''}`).join('；');
  }
  function voiceURL(value, output) {
    if (typeof value !== 'string' || !value.startsWith('/api/v1/audio/voice?')) return null;
    try {
      const url = new URL(value, location.origin);
      const allowed = ['game', 'character', 'language', 'output', 'clip_id'];
      if (url.origin !== location.origin || url.pathname !== '/api/v1/audio/voice' || url.hash ||
          url.searchParams.get('output') !== output || [...url.searchParams.keys()].some(key =>
            !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) return null;
      return url;
    } catch { return null; }
  }
  function audioPlayer(row) {
    if (row.type !== 'audio') return '';
    const play = voiceURL(row.play_url, 'audio');
    if (!play) return '<p class="voice-note">此条目尚未配置试听文件。</p>';
    const download = new URL(play); download.searchParams.set('download', '1');
    const filename = String(row.title || row.id || 'audio').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') + '.wav';
    const text = voiceURL(row.text_url, 'text');
    return `<div class="voice-preview"><audio controls preload="none" aria-label="试听：${esc(row.title || '音频')}" src="${esc(play.pathname + play.search)}">浏览器不支持音频播放。</audio><div class="voice-actions"><a class="button small voice-download" href="${esc(download.pathname + download.search)}" download="${esc(filename)}">下载音频</a>${text ? `<details class="voice-transcript" data-text-url="${esc(text.pathname + text.search)}"><summary class="button small">查看台词</summary><div class="voice-transcript-body" aria-live="polite">展开后读取配对文本。</div></details>` : ''}</div></div>`;
  }

  async function showTranscript(details) {
    if (!details.open || details.dataset.loaded || details.dataset.loading) return;
    const url = voiceURL(details.dataset.textUrl, 'text');
    if (!url) return;
    const body = details.querySelector('.voice-transcript-body');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    details.dataset.loading = 'true'; body.textContent = '正在读取台词…';
    try {
      const response = await fetch(url.pathname + url.search, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'text/plain' } });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/plain')) throw new Error('暂时无法读取台词，请收起后重试。');
      if (Number(response.headers.get('content-length')) > 1024 * 1024) throw new Error('文本过长，暂不在页面展开。');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 1024 * 1024) throw new Error('文本过长，暂不在页面展开。');
      body.textContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes) || '这份配对文本为空。';
      details.dataset.loaded = 'true';
    } catch (error) {
      body.textContent = error.name === 'AbortError' ? '读取超时，请收起后重试。' : '暂时无法读取台词，请收起后重试。';
    } finally { clearTimeout(timer); delete details.dataset.loading; }
  }

  function statsCards() {
    const values = [
      ['全部素材', state.stats?.totals.assets, 'library', '本地与远程索引素材'],
      ['音频素材', typeCount('audio'), 'audio', '声音、对白与片段'],
      ['图片素材', typeCount('image'), 'image', '图像与视觉参考'],
      ['音色模型', state.stats?.totals.models, 'model', '模型索引与版本']
    ];
    return values.map(([label, value, symbol, note]) => `<article class="card stat-card"><div class="stat-label">${label}<span class="stat-icon">${icon(symbol)}</span></div>${value === undefined ? '<div class="skeleton" aria-label="正在加载统计"></div>' : `<div class="stat-number">${number(value)}</div>`}<div class="stat-note">${note}</div></article>`).join('');
  }
  function catalogRows() {
    return [['audio', '音频', '可检索的声音收藏', 'audio'], ['image', '图片', '灵感与视觉素材', 'image'], ['model', '音色模型', '独立管理模型版本', 'model']].map(([type, name, description, symbol]) => `<a class="category-row" href="${routeURL('assets', { type })}"><span class="category-icon">${icon(symbol)}</span><span class="category-name">${name}<small>${description}</small></span><span class="category-count">${number(typeCount(type))}</span>${icon('chevron')}</a>`).join('');
  }
  function pagination(meta) {
    if (meta.total_pages <= 1) return '';
    return `<div class="pagination"><button class="button small" data-page="${meta.page - 1}" ${meta.page <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${number(meta.page)} / ${number(meta.total_pages)} 页</span><button class="button small" data-page="${meta.page + 1}" ${meta.page >= meta.total_pages ? 'disabled' : ''}>下一页</button></div>`;
  }
  function assetAssociation(row) {
    if (row.type === 'image' && row.image_scope === 'standalone') return '<span class="chip">独立图片</span>';
    const association = `${esc(row.work_name || workName(row.work_id))} / ${esc(row.character_name || characterName(row.character_id))}`;
    if (row.type === 'image') return row.image_scope === 'character' ? `<span class="chip">角色关联</span><br>${association}` : '图片归属未设置';
    return association;
  }
  function assetTable(result, filtered = false, recent = false, imageOnly = false) {
    if (!result.data.length) return empty(filtered ? '没有找到匹配的素材' : '这里，等待你的第一份收藏', filtered ? '试试其他关键词，或清除筛选条件。' : '资料库目前为空。配置已有音频数据集后即可按角色检索和试听，无需重复上传文件。', 'library', filtered ? '<button class="button small" data-clear-filters>清除筛选</button>' : (recent ? arrowLink('#/upload', '了解入库方式') : ''), !recent);
    return `<div class="table-wrap"><table><thead><tr><th>素材名称</th><th>类型</th><th>归属</th>${imageOnly ? '' : '<th>语言</th><th>情绪</th>'}</tr></thead><tbody>${result.data.map(row => `<tr><td><strong>${esc(row.title || row.id)}</strong>${audioPlayer(row)}</td><td>${esc(({ audio: '音频', image: '图片', model: '音色模型', video: '视频', text: '文本' })[row.type] || row.type || '—')}</td><td>${assetAssociation(row)}</td>${imageOnly ? '' : `<td>${row.type === 'image' ? '不适用' : esc(row.language || '—')}</td><td>${row.type === 'image' ? '不适用' : esc(joined(row.emotions))}</td>`}</tr>`).join('')}</tbody></table></div>${pagination(result.meta)}`;
  }

  async function renderOverview(sequence) {
    main.innerHTML = heading('总览', '收藏声音与影像，连接你的创作。', 'YOUR CREATIVE SPACE', `<a class="button" href="#/api">${icon('code')}API 接入</a>${arrowLink('#/assets', '浏览素材', true)}`) +
      `<section class="stats-grid" id="overview-stats" aria-label="资源统计">${statsCards()}</section><div class="overview-grid"><section class="card"><div class="card-header"><div class="section-heading">${icon('library')}<h2>最近入库</h2></div><a class="button text" href="#/assets">查看全部${icon('arrow')}</a></div><div id="recent-content">${loading()}</div></section><section class="card"><div class="card-header"><h2>资源分类</h2><span class="minor-label">按类型探索</span></div><div class="category-list" id="category-content">${catalogRows()}</div></section></div><section class="connection-strip"><span class="connection-symbol">${icon('code')}</span><div><h3>把收藏连接到你的创作流程</h3><p>通过只读 API 获取资源索引，按需试听远程仓库中的现有音频。</p></div><a class="button small" href="#/api">查看 API${icon('arrow')}</a></section>`;
    const results = await Promise.allSettled([refreshSummary(), request('/api/v1/assets?page_size=5').then(listResult)]);
    if (!active(sequence)) return;
    if (results[0].status === 'fulfilled') {
      document.getElementById('overview-stats').innerHTML = statsCards();
      document.getElementById('category-content').innerHTML = catalogRows();
    } else {
      document.getElementById('overview-stats').innerHTML = `<div class="card" style="grid-column:1/-1">${errorPanel(results[0].reason)}</div>`;
      document.getElementById('category-content').innerHTML = '<p class="api-footnote">连接恢复后显示真实分类统计。</p>';
    }
    document.getElementById('recent-content').innerHTML = results[1].status === 'fulfilled' ? assetTable(results[1].value, false, true) : errorPanel(results[1].reason);
  }
  function option(value, label, selected) { return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`; }
  async function fetchAllCharacters(workQuery) {
    const base = '/api/v1/characters?page_size=100' + workQuery;
    const first = listResult(await request(base));
    if (first.meta.total_pages <= 1) return first;
    const pages = Array.from({length: Math.min(first.meta.total_pages, 20) - 1}, (_, i) => i + 2);
    const rest = await Promise.all(pages.map(page => request(base + '&page=' + page).then(listResult)));
    return {...first, data: first.data.concat(...rest.map(r => r.data))};
  }
  function assetTypeTabs(selected) {
    return `<div class="type-tabs" aria-label="素材类型">${types.map(([type, name, symbol]) => `<button class="type-tab${selected === type ? ' active' : ''}" type="button" data-type="${type}" aria-pressed="${selected === type}">${icon(symbol)}${name}<span data-type-count="${type}">${number(typeCount(type))}</span></button>`).join('')}</div>`;
  }
  async function findDirectoryRecord(kind, id) {
    if (!id) return null;
    const result = listResult(await request(`/api/v1/${kind}?${new URLSearchParams({ q: id, page_size: '100' })}`));
    rememberNames(kind, result.data);
    return result.data.find(row => row.id === id) || null;
  }
  function audioBreadcrumbs(work, character, current) {
    const parts = [`<a href="${routeURL('assets', { type: 'audio' })}">全部作品</a>`];
    if (work) parts.push(`<a href="${routeURL('assets', { type: 'audio', work: work.id, view: 'characters' })}">${esc(work.name)}</a>`);
    if (character) parts.push(`<span aria-current="page">${esc(character.name)}</span>`);
    else if (current) parts.push(`<span aria-current="page">${esc(current)}</span>`);
    return `<nav class="audio-breadcrumbs" aria-label="音频目录">${parts.join(`<span class="audio-breadcrumb-separator" aria-hidden="true">/</span>`)}</nav>`;
  }
  function mediaCards(result, filtered) {
    if (!result.data.length) return empty(filtered ? '没有找到匹配的素材' : '暂时没有可浏览的音频', '可以调整关键词与语言，或返回角色目录重新选择。', 'audio', '', true);
    const languageNames = { zh: '中文', en: '英语', ja: '日语', ko: '韩语' };
    return `<div class="audio-clip-grid">${result.data.map(row => {
      const work = row.work_name || state.workNames.get(row.work_id);
      const character = row.character_name || state.characterNames.get(row.character_id);
      const relatedType = ['audio', 'image', 'model'].includes(row.type) ? row.type : '';
      const related = row.character_id ? routeURL('assets', { type: relatedType, work: row.work_id, character: row.character_id, ...(row.type === 'image' ? { image_scope: row.image_scope } : {}) }) : '';
      return `<article class="audio-clip-card"><div class="audio-clip-heading"><span class="audio-card-icon">${icon(row.type === 'audio' ? 'audio' : row.type === 'image' ? 'image' : 'library')}</span><h3>${esc(row.title || row.id)}</h3></div><div class="audio-clip-meta">${work ? `<a href="${routeURL('assets', { type: relatedType, work: row.work_id, ...(row.type === 'audio' ? { view: 'characters' } : {}) })}">${esc(work)}</a>` : ''}${character ? `<a href="${related}">${esc(character)}</a>` : ''}${row.type === 'image' && row.image_scope === 'standalone' ? '<span class="chip">独立图片</span>' : ''}<span class="chip">${esc(row.type === 'audio' ? languageNames[row.language] || row.language || '音频' : ({ image: '图片', model: '模型', text: '文本', video: '视频' })[row.type] || row.type)}</span></div>${audioPlayer(row)}</article>`;
    }).join('')}</div>${pagination(result.meta)}`;
  }
  async function renderAudioBrowser(sequence, params) {
    const selectedType = params.get('type') || '';
    const requestedView = params.get('view'), selectedWork = params.get('work'), selectedCharacter = params.get('character');
    const hasClipFilters = ['q', 'language', 'emotion', 'category'].some(key => params.get(key));
    const view = selectedCharacter ? 'clips' : ['works', 'characters', 'clips'].includes(requestedView) ? requestedView :
      hasClipFilters ? 'clips' : selectedWork ? 'characters' : 'works';
    const allTypesSearch = !selectedType && params.get('q') && !selectedCharacter && requestedView !== 'clips';
    main.innerHTML = heading('素材浏览', '先选择作品与角色，再试听或下载需要的音频。', 'EXPLORE YOUR LIBRARY') +
      `<section class="card filter-panel">${assetTypeTabs(selectedType)}</section><section class="card">${loading()}</section>`;
    const query = new URLSearchParams({ page_size: '24' });
    let endpoint;
    if (view === 'clips') {
      endpoint = 'assets';
      if (!allTypesSearch) query.set('type', 'audio');
      for (const key of ['q', 'work', 'character', 'language', 'emotion', 'category', 'page']) if (params.get(key)) query.set(key, params.get(key));
    } else {
      endpoint = view === 'works' ? 'works' : 'characters';
      for (const key of ['q', 'page']) if (params.get(key)) query.set(key, params.get(key));
      if (view === 'characters' && selectedWork) query.set('work', selectedWork);
    }
    const results = await Promise.allSettled([
      request(`/api/v1/${endpoint}?${query}`).then(listResult),
      findDirectoryRecord('works', selectedWork), findDirectoryRecord('characters', selectedCharacter)
    ]);
    if (!active(sequence)) return;
    let work = results[1].status === 'fulfilled' ? results[1].value : null;
    let character = results[2].status === 'fulfilled' ? results[2].value : null;
    const result = results[0].status === 'fulfilled' ? results[0].value : null;
    if (result) {
      if (view !== 'clips') rememberNames(endpoint, result.data);
      else for (const row of result.data) {
        if (row.work_id && row.work_name) state.workNames.set(row.work_id, row.work_name);
        if (row.character_id && row.character_name) state.characterNames.set(row.character_id, row.character_name);
      }
      if (view === 'clips') {
        const missing = new Map();
        for (const row of result.data) {
          if (row.work_id && !state.workNames.has(row.work_id)) missing.set('works:' + row.work_id, ['works', row.work_id]);
          if (row.character_id && !state.characterNames.has(row.character_id)) missing.set('characters:' + row.character_id, ['characters', row.character_id]);
        }
        await Promise.allSettled([...missing.values()].map(([kind, id]) => findDirectoryRecord(kind, id)));
        if (!active(sequence)) return;
      }
      const first = result.data.find(row => row.character_id === selectedCharacter);
      if (!character && selectedCharacter && first?.character_name) character = { id: selectedCharacter, name: first.character_name, work_id: first.work_id };
      if (!work && first?.work_name) work = { id: first.work_id, name: first.work_name };
    }
    if (!work && character?.work_id) {
      try { work = await findDirectoryRecord('works', character.work_id); } catch { /* Keep the usable clip results. */ }
      if (!active(sequence)) return;
    }
    if (!work && selectedWork) work = { id: selectedWork, name: state.workNames.get(selectedWork) || '当前作品' };
    if (!character && selectedCharacter) character = { id: selectedCharacter, name: state.characterNames.get(selectedCharacter) || '当前角色' };
    const title = view === 'works' ? '按作品浏览音频' : view === 'characters' ? `${work?.name || '全部作品'} · 角色目录` :
      character ? `${character.name}的音频` : allTypesSearch ? '素材搜索结果' : params.get('q') ? '音频搜索结果' : `${work?.name || '全部作品'}的音频`;
    const description = view === 'works' ? '从作品进入角色目录；图片与模型也可以切换分类查看。' : view === 'characters' ?
      '搜索角色名称，选择一个角色查看其音频。' : '每条音频都可以直接试听、下载，或展开查看配对台词。';
    const directoryContext = { directory_q: params.get('directory_q') || '', directory_page: params.get('directory_page') || '' };
    const roleParams = { type: 'audio', view: 'characters', ...(work ? { work: work.id } : {}), q: directoryContext.directory_q, page: directoryContext.directory_page };
    const back = view === 'works' ? '' : `<a class="button small" href="${routeURL('assets', view === 'characters' ? { type: 'audio' } : roleParams)}">${view === 'characters' ? '返回作品列表' : '返回角色列表'}</a>`;
    const allAudio = `<a class="button small" href="${routeURL('assets', { type: 'audio', view: 'clips', ...(work ? { work: work.id } : {}), ...directoryContext })}">${work ? '此作品全部音频' : '全部音频'}</a>`;
    let controls, content;
    if (view !== 'clips') {
      const label = view === 'works' ? '作品' : '角色';
      controls = `<div class="audio-directory-toolbar"><form id="audio-directory-search" class="inline-search" data-directory-view="${view}"><input name="q" aria-label="搜索${label}名称" value="${esc(params.get('q') || '')}" placeholder="搜索${label}名称…"><button type="submit" class="button">${icon('search')}搜索</button></form><div class="audio-directory-actions">${back}${allAudio}</div></div>`;
      content = !result ? errorPanel(results[0].reason) : `<div class="result-toolbar"><span>共 <strong>${number(result.meta.total)}</strong> 个${label}</span><span>每页 ${number(result.meta.page_size)} 个</span></div>` +
        (!result.data.length ? empty(params.get('q') ? `没有匹配的${label}` : `暂时没有${label}`, '请尝试其他关键词，或返回上一级目录。', view === 'works' ? 'folder' : 'person', '', true) :
          `<div class="audio-directory-grid">${result.data.map(row => {
            const target = view === 'works' ? { type: 'audio', work: row.id, view: 'characters' } : { type: 'audio', work: row.work_id, character: row.id, directory_q: params.get('q') || '', directory_page: params.get('page') || '' };
            return `<a class="audio-directory-card" href="${routeURL('assets', target)}"><span class="audio-directory-icon">${icon(view === 'works' ? 'folder' : 'person')}</span><h3>${esc(row.name || row.id)}</h3><p>${view === 'works' ? '选择角色，浏览音频' : esc(work?.name || state.workNames.get(row.work_id) || '角色音频')}</p><span class="audio-directory-open">${view === 'works' ? '查看角色' : '浏览音频'}${icon('arrow')}</span></a>`;
          }).join('')}</div>${pagination(result.meta)}`);
    } else {
      controls = `<div class="audio-directory-actions audio-list-navigation">${back}${character ? allAudio : ''}</div><form id="audio-filter"><div class="audio-filters"><div class="field"><label for="audio-q">关键词</label><input id="audio-q" name="q" value="${esc(params.get('q') || '')}" placeholder="${character ? '在当前角色中搜索音频名称…' : '搜索名称、角色、作品或标签…'}"></div><div class="field"><label for="audio-language">语言</label><select id="audio-language" name="language">${[['', '全部语言'], ['zh', '中文'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语']].map(([value, label]) => option(value, label, params.get('language') || '')).join('')}</select></div><button class="button primary" type="submit">${icon('search')}搜索${allTypesSearch ? '素材' : '音频'}</button><button class="button text" type="button" data-reset-audio>重置筛选</button></div><details class="audio-more-filters"><summary>更多筛选</summary><div class="audio-extra-filters"><div class="field"><label for="audio-emotion">情绪标签</label><input id="audio-emotion" name="emotion" value="${esc(params.get('emotion') || '')}" placeholder="输入情绪标签"></div><div class="field"><label for="audio-category">分类标签</label><input id="audio-category" name="category" value="${esc(params.get('category') || '')}" placeholder="输入分类标签"></div></div></details></form>`;
      content = !result ? errorPanel(results[0].reason) : `<div class="result-toolbar"><span>共 <strong>${number(result.meta.total)}</strong> 份${allTypesSearch ? '素材' : '音频'}</span><span>${character ? '当前角色' : work ? '当前作品 · 多个角色' : '跨作品与角色'}</span></div>${mediaCards(result, hasClipFilters)}`;
    }
    main.innerHTML = heading(title, description, 'EXPLORE YOUR LIBRARY') + audioBreadcrumbs(work, character, view === 'works' ? '' : view === 'characters' ? '角色目录' : '音频列表') +
      `<section class="card filter-panel">${assetTypeTabs(selectedType)}${controls}</section><section class="card" id="asset-results">${content}</section>`;
  }
  async function renderAssets(sequence, params) {
    params = normalizeAssetParams(params);
    const canonical = routeURL('assets', params);
    if (location.hash !== canonical) history.replaceState(null, '', canonical);
    const selectedType = params.get('type') || '';
    if (!selectedType || selectedType === 'audio') return renderAudioBrowser(sequence, params);
    const imageOnly = selectedType === 'image';
    const standalone = imageOnly && params.get('image_scope') === 'standalone';
    main.innerHTML = heading('素材浏览', '按作品、角色与声音特征，找到你需要的那一份素材。', 'EXPLORE YOUR LIBRARY') +
      `<section class="card filter-panel"><div class="type-tabs" aria-label="素材类型">${types.map(([type, name, symbol]) => `<button class="type-tab${selectedType === type ? ' active' : ''}" type="button" data-type="${type}" aria-pressed="${selectedType === type}">${icon(symbol)}${name}<span data-type-count="${type}">${number(typeCount(type))}</span></button>`).join('')}</div><form id="asset-filter"><div class="filters"><div class="field"><label for="filter-q">关键词</label><input id="filter-q" name="q" value="${esc(params.get('q') || '')}" placeholder="名称、描述、标签…"></div>${imageOnly ? `<div class="field"><label for="filter-image-scope">图片归属</label><select id="filter-image-scope" name="image_scope">${[['', '全部图片'], ['character', '角色关联'], ['standalone', '独立图片']].map(([v, l]) => option(v, l, params.get('image_scope') || '')).join('')}</select></div>` : ''}<div class="field"><label for="filter-work">作品</label><select id="filter-work" name="work" ${standalone ? 'disabled' : ''}><option value="">全部作品</option></select></div><div class="field"><label for="filter-character">角色</label><select id="filter-character" name="character" ${standalone ? 'disabled' : ''}><option value="">全部角色</option></select></div><div class="field" ${imageOnly ? 'hidden' : ''}><label for="filter-language">语言</label><select id="filter-language" name="language" ${imageOnly ? 'disabled' : ''}>${[['', '全部语言'], ['zh', '中文'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语']].map(([v, l]) => option(v, l, params.get('language') || '')).join('')}</select></div><div class="field" ${imageOnly ? 'hidden' : ''}><label for="filter-emotion">情绪</label><input id="filter-emotion" name="emotion" ${imageOnly ? 'disabled' : ''} value="${esc(params.get('emotion') || '')}" placeholder="输入情绪标签"></div></div><div class="filter-bottom"><div class="field"><label for="filter-category">分类标签</label><input id="filter-category" name="category" value="${esc(params.get('category') || '')}" placeholder="输入分类标签"></div><button type="button" class="button text" data-clear-filters>清除筛选</button><button type="submit" class="button primary">${icon('search')}筛选素材</button></div></form></section><section class="card" id="asset-results">${loading()}</section>`;
    const keys = ['q', 'type', 'image_scope', 'work', 'character', 'language', 'emotion', 'category', 'page'];
    const query = new URLSearchParams(); keys.forEach(key => { if (params.get(key)) query.set(key, params.get(key)); });
    const filtered = [...query.keys()].some(key => key !== 'page');
    const workQuery = params.get('work') ? `&work=${encodeURIComponent(params.get('work'))}` : '';
    const results = await Promise.allSettled([request(`/api/v1/assets?${query}`).then(listResult), request('/api/v1/works?page_size=100').then(listResult), fetchAllCharacters(workQuery)]);
    if (!active(sequence)) return;
    if (results[1].status === 'fulfilled') rememberNames('works', results[1].value.data);
    if (results[2].status === 'fulfilled') rememberNames('characters', results[2].value.data);
    if (results[0].status === 'fulfilled') {
      const value = results[0].value;
      document.getElementById('asset-results').innerHTML = `<div class="result-toolbar"><span>共 <strong>${number(value.meta.total)}</strong> 份素材</span><span>${filtered ? '已应用筛选' : '全部资源'}</span></div>${assetTable(value, filtered, false, imageOnly)}`;
    } else document.getElementById('asset-results').innerHTML = errorPanel(results[0].reason);
    for (const [index, key, label] of [[1, 'work', '作品'], [2, 'character', '角色']]) {
      const select = document.getElementById(`filter-${key}`);
      if (standalone) {
        select.innerHTML = option('', `独立图片不需要${label}`, ''); select.value = ''; select.disabled = true;
        continue;
      }
      if (results[index].status === 'fulfilled') {
        const rows = results[index].value.data;
        select.innerHTML = option('', `全部${label}`, params.get(key) || '') + rows.map(row => option(String(row.id), row.name || row.title || row.id, params.get(key) || '')).join('');
        if (params.get(key) && !rows.some(row => String(row.id) === params.get(key))) select.insertAdjacentHTML('beforeend', option(params.get(key), `当前筛选：${params.get(key)}`, params.get(key)));
      } else {
        select.innerHTML = '<option value="">目录加载失败</option>'; select.disabled = true;
        select.title = '点击结果区域的重新加载，或刷新页面后重试。';
      }
    }
  }
  async function renderCatalog(sequence, params) {
    const kind = params.get('kind') === 'characters' ? 'characters' : 'works';
    const label = kind === 'works' ? '作品' : '角色';
    main.innerHTML = heading('作品与角色', '让每份素材都有清晰的归属。', 'ORGANIZE BY CONTEXT') +
      `<div class="catalog-tabs">${[['works', '作品目录'], ['characters', '角色目录']].map(([value, name]) => `<a class="catalog-tab${value === kind ? ' active' : ''}" href="${routeURL('catalog', { kind: value })}">${name}<span class="chip" data-total="${value}">${number(state.stats?.totals[value])}</span></a>`).join('')}</div><form id="catalog-search" class="inline-search"><input name="q" aria-label="搜索${label}" value="${esc(params.get('q') || '')}" placeholder="搜索${label}名称…"><button type="submit" class="button">${icon('search')}搜索</button></form><section class="card" id="catalog-results">${loading()}</section>`;
    try {
      const query = new URLSearchParams(); ['q', 'page'].forEach(key => { if (params.get(key)) query.set(key, params.get(key)); });
      const result = listResult(await request(`/api/v1/${kind}?${query}`)); if (!active(sequence)) return;
      rememberNames(kind, result.data);
      document.getElementById('catalog-results').innerHTML = `<div class="card-header"><h2>${label}目录</h2><span class="minor-label">${number(result.meta.total)} 个${label}</span></div>` + (!result.data.length ? empty(params.get('q') ? `没有匹配的${label}` : `还没有${label}记录`, params.get('q') ? '请尝试其他关键词。' : `${label}目录目前为空，入库后可在这里按归属浏览素材。`, kind === 'works' ? 'folder' : 'person') : `<div class="item-grid">${result.data.map(row => `<article class="data-item">${icon(kind === 'works' ? 'folder' : 'person')}<h3>${esc(row.name || row.title || row.id)}</h3><p>${esc(row.description || '')}</p><a class="button small" href="${routeURL('assets', { [kind === 'works' ? 'work' : 'character']: row.id })}">浏览相关素材</a></article>`).join('')}</div>${pagination(result.meta)}`);
    } catch (error) { if (active(sequence)) document.getElementById('catalog-results').innerHTML = errorPanel(error); }
  }
  async function renderModels(sequence, params) {
    const id = params.get('id');
    main.innerHTML = heading(id ? '模型版本详情' : '模型版本', '集中管理音色模型与版本信息，保留清晰的更新脉络。', 'VOICE MODEL REGISTRY', id ? arrowLink('#/models', '返回模型列表') : '') +
      `<form id="model-search" class="inline-search" ${id ? 'hidden' : ''}><input name="q" aria-label="搜索音色模型" placeholder="搜索模型名称…" value="${esc(params.get('q') || '')}"><button class="button" type="submit">${icon('search')}搜索</button></form><section class="card" id="model-results">${loading()}</section>`;
    try {
      const query = new URLSearchParams(); ['q', 'page'].forEach(key => { if (params.get(key)) query.set(key, params.get(key)); });
      const result = listResult(await request(id ? `/api/v1/models/${encodeURIComponent(id)}/versions?${query}` : `/api/v1/models?${query}`)); if (!active(sequence)) return;
      const columns = id ? ['版本', '框架', '文件 / 大小', '依赖', '说明'] : ['模型名称', '作品 / 角色', '语言', '分类', ''];
      const rows = result.data.map(row => id
        ? `<tr><td><strong>${esc(row.version)}</strong></td><td>${esc(row.framework)}</td><td>${esc(fileDescriptions(row.files))}</td><td>${esc(joined(row.dependencies))}</td><td>${esc(row.description || '—')}</td></tr>`
        : `<tr><td><strong>${esc(row.name || row.id)}</strong></td><td>${esc(workName(row.work_id))} / ${esc(characterName(row.character_id))}</td><td>${esc(row.language || '—')}</td><td>${esc(joined(row.categories))}</td><td><a class="button small" href="${routeURL('models', { id: row.id })}">查看版本</a></td></tr>`).join('');
      document.getElementById('model-results').innerHTML = `<div class="card-header"><h2>${id ? '版本记录' : '音色模型目录'}</h2><span class="minor-label">${number(result.meta.total)} ${id ? '个版本' : '个模型'}</span></div><div class="table-wrap"><table><thead><tr>${columns.map(name => `<th>${name}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="5" class="table-empty">${empty(params.get('q') ? '没有匹配的模型' : id ? '暂无版本记录' : '还没有音色模型', '模型与版本目录目前为空。存储接入后，可关联作品、角色和语言。', 'model')}</td></tr>`}</tbody></table></div>${pagination(result.meta)}`;
    } catch (error) { if (active(sequence)) document.getElementById('model-results').innerHTML = errorPanel(error); }
  }
  function renderUpload() {
    main.innerHTML = heading('上传入库', '把文件、归属与描述整理在同一个地方。', 'ADD TO YOUR COLLECTION') +
      `<div class="notice">${icon('lock')}<div><strong>存储尚未连接，上传暂未启用</strong><p>当前只提供资源浏览与只读 API。此表单用于展示入库结构，不会选择、发送或保存文件。</p></div></div><div class="two-columns"><form class="card" id="upload-form"><div class="card-header"><h2>素材信息</h2><span class="chip orange">待接入存储</span></div><div class="form-body"><div class="dropzone" id="upload-dropzone">${icon('upload')}<strong>文件上传区域</strong><p>文件类型与大小限制将在存储接入后配置</p><button type="button" class="button small" disabled style="margin-top:13px">选择文件 · 尚未启用</button></div><div class="form-grid"><div class="field full"><label for="upload-title">素材名称</label><input id="upload-title" placeholder="为素材填写一个清晰的名称"></div><div class="field"><label for="upload-type">素材类型</label><select id="upload-type"><option value="audio">音频</option><option value="image">图片</option><option value="model">音色模型</option></select></div><div class="field" id="upload-image-scope-field" hidden><label for="upload-image-scope">图片归属</label><select id="upload-image-scope" disabled><option value="character">角色关联</option><option value="standalone">独立图片</option></select><span id="upload-image-scope-note">角色关联图片需要选择有效作品与角色，当前目录为空。</span></div><div class="field" id="upload-language-field"><label for="upload-language">语言</label><select id="upload-language"><option>请选择语言</option><option>中文</option><option>英语</option><option>日语</option><option>韩语</option><option>不适用</option></select></div><div class="field" id="upload-work-field"><label for="upload-work">所属作品</label><select id="upload-work" disabled><option value="">暂无作品可选</option></select></div><div class="field" id="upload-character-field"><label for="upload-character">关联角色</label><select id="upload-character" disabled><option value="">暂无角色可选</option></select></div><div class="field" id="upload-emotion-field"><label for="upload-emotion">情绪标签</label><input id="upload-emotion" placeholder="填写已确认的情绪"></div><div class="field"><label for="upload-category">分类标签</label><input id="upload-category" placeholder="填写便于检索的分类"></div><div class="field full" id="upload-transcript-field"><label for="upload-transcript">对应文本（音频）</label><textarea id="upload-transcript" placeholder="保留完整原文，与对应音频绑定；不删字音、不省略句子。"></textarea><span>完整原文将与音频一一对应。当前仅为表单结构，不会提交或入库。</span></div><div class="field full"><label for="upload-description">素材描述</label><textarea id="upload-description" placeholder="记录来源、用途或其他说明…"></textarea></div></div></div><div class="form-bottom"><small>表单内容仅保留在当前页面，不会入库。</small><button type="submit" class="button primary" disabled>${icon('lock')}上传并入库</button></div></form><aside class="card" style="align-self:start"><div class="card-header"><h2>入库流程</h2><span class="minor-label">结构预览</span></div><ol class="explain-list"><li><span class="step-number">01</span><div><strong>连接文件存储</strong><p>配置素材存储位置与上传能力后，才能启用文件入库。</p></div></li><li><span class="step-number">02</span><div><strong>填写归属与标签</strong><p>角色素材填写作品与角色；独立图片填写分类与描述。</p></div></li><li><span class="step-number">03</span><div><strong>确认后进入资料库</strong><p>完成文件与信息核对后，再开放浏览及 API 访问。</p></div></li></ol></aside></div>`;
    updateUploadFields();
    document.getElementById('upload-type').addEventListener('change', updateUploadFields);
    document.getElementById('upload-image-scope').addEventListener('change', updateUploadFields);
    document.getElementById('upload-dropzone').addEventListener('dragover', event => event.preventDefault());
    document.getElementById('upload-dropzone').addEventListener('drop', event => { event.preventDefault(); toast('存储尚未连接，文件未上传。'); });
  }
  function updateUploadFields() {
    const imageOnly = document.getElementById('upload-type').value === 'image';
    const scope = document.getElementById('upload-image-scope');
    const standalone = imageOnly && scope.value === 'standalone';
    document.getElementById('upload-image-scope-field').hidden = !imageOnly;
    scope.disabled = !imageOnly;
    document.getElementById('upload-image-scope-note').textContent = standalone
      ? '独立图片不要求作品或角色，不会建立角色关联。'
      : '角色关联图片需要选择有效作品与角色，当前目录为空。';
    for (const name of ['work', 'character']) {
      document.getElementById(`upload-${name}-field`).hidden = standalone;
      const field = document.getElementById(`upload-${name}`);
      field.disabled = true; // No directory entries exist; never invent a selection.
      if (standalone) field.value = '';
    }
    for (const name of ['language', 'emotion', 'transcript']) {
      document.getElementById(`upload-${name}-field`).hidden = imageOnly;
      document.getElementById(`upload-${name}`).disabled = imageOnly;
    }
  }
  function apiURL() {
    const endpoint = document.getElementById('api-endpoint')?.value || '/api/v1/assets';
    if (!endpoints.some(([path]) => path === endpoint)) throw new Error('请选择已列出的只读接口。');
    const query = new URLSearchParams(document.getElementById('api-query')?.value.trim().replace(/^\?/, '') || '');
    return `${endpoint}${query.size ? `?${query}` : ''}`;
  }
  function updateAPIAddress() { document.getElementById('api-request-address').textContent = `GET ${location.origin}${apiURL()}`; }
  function renderAPI() {
    main.innerHTML = heading('API 接入', '使用统一的只读接口，把素材索引接入你的工具。', 'CONNECT YOUR WORKFLOW') +
      `<div class="api-base"><small>BASE URL</small><code>${esc(location.origin)}/api/v1</code><button class="button small" type="button" data-copy-base>${icon('copy')}复制地址</button></div><div class="two-columns"><section class="card"><div class="card-header"><h2>只读接口</h2><span class="chip">API v1</span></div><div class="endpoint-list">${endpoints.slice(0, 6).map(([path, name, description]) => `<div class="endpoint"><div class="endpoint-title"><span class="method">GET</span><code>${path}</code><span class="minor-label">${name}</span></div><p>${description}</p></div>`).join('')}<div class="endpoint"><div class="endpoint-title"><span class="method">GET</span><code>/api/v1/models/{id}/versions</code></div><p>读取指定模型的版本；不存在的模型返回 404。</p></div></div></section><section class="card api-console"><div class="card-header"><h2>在线试调</h2><span class="minor-label">真实同源请求</span></div><form class="console-form" id="api-form"><div class="field"><label for="api-endpoint">选择接口</label><select id="api-endpoint">${endpoints.map(([path, name]) => option(path, `${name} · ${path}`, '/api/v1/assets')).join('')}</select></div><div class="field"><label for="api-query">查询参数（可选）</label><input id="api-query" placeholder="type=audio&language=zh&page_size=24" autocomplete="off"></div><div class="console-buttons"><button class="button primary" type="submit" id="api-send">${icon('code')}发送 GET 请求</button><button class="button" type="button" data-copy-request aria-label="复制完整请求地址">${icon('copy')}</button></div></form><code class="request-address" id="api-request-address"></code><div class="response-header"><span>RESPONSE</span><span class="response-status" id="api-response-status">等待请求</span></div><pre class="response-body" id="api-response" aria-live="polite">选择接口并发送请求，在这里查看真实返回。\n当前资料库为空，列表接口将返回空数组。</pre></section></div><p class="api-footnote">列表支持 page / page_size 分页。图片使用 type=image；image_scope=character 为角色关联，image_scope=standalone 为独立图片，全部图片省略 image_scope。独立图片不传作品或角色。上传接口当前不可用。完整协议：<a href="/docs/openapi.json" target="_blank" rel="noopener">查看 OpenAPI 文档</a></p>`;
    updateAPIAddress();
    document.getElementById('api-endpoint').addEventListener('change', updateAPIAddress);
    document.getElementById('api-query').addEventListener('input', updateAPIAddress);
  }
  async function tryAPI() {
    const sequence = state.sequence;
    const button = document.getElementById('api-send'), output = document.getElementById('api-response'), status = document.getElementById('api-response-status');
    button.disabled = true; status.textContent = '请求中…'; status.classList.remove('bad'); output.textContent = '正在请求接口…';
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000), start = performance.now();
    try {
      const response = await fetch(apiURL(), { signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
      const text = await response.text(); if (!active(sequence)) return;
      let formatted = text; try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Display actual non-JSON body unchanged. */ }
      output.textContent = formatted;
      status.textContent = `${response.status} ${response.statusText} · ${Math.round(performance.now() - start)} ms`;
      status.classList.toggle('bad', !response.ok);
    } catch (error) {
      if (!active(sequence)) return;
      status.textContent = '请求失败'; status.classList.add('bad');
      output.textContent = error.name === 'AbortError' ? '请求超时。请检查服务状态后再次发送。' : '无法连接当前接口，请确认服务正在运行。';
    } finally { clearTimeout(timer); if (active(sequence)) button.disabled = false; }
  }
  async function copy(value) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const field = document.createElement('textarea'); field.value = value; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.appendChild(field); field.select();
        const success = document.execCommand('copy'); field.remove(); if (!success) throw new Error('copy_failed');
      }
      toast('地址已复制');
    } catch { toast('浏览器未允许复制，请从页面选中地址复制。'); }
  }
  function menu(open) {
    document.getElementById('sidebar').classList.toggle('open', open);
    document.getElementById('sidebar-backdrop').hidden = !open;
    const toggle = document.getElementById('menu-toggle'); toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
  }
  async function render() {
    const { page, params } = route(); const sequence = ++state.sequence;
    document.title = `${pageNames[page]} · 橙狸集 OrangeTanuki Hub`;
    document.getElementById('breadcrumb-current').textContent = pageNames[page];
    document.querySelectorAll('[data-nav]').forEach(link => { const selected = link.dataset.nav === page; link.classList.toggle('active', selected); if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
    document.getElementById('global-search-input').value = page === 'assets' ? params.get('q') || '' : '';
    menu(false);
    try {
      if (page === 'overview') await renderOverview(sequence);
      else if (page === 'assets') await renderAssets(sequence, params);
      else if (page === 'catalog') await renderCatalog(sequence, params);
      else if (page === 'models') await renderModels(sequence, params);
      else if (page === 'upload') renderUpload();
      else renderAPI();
    } catch (error) { if (active(sequence)) main.innerHTML = heading(pageNames[page], '请检查服务后重试。', 'ORANGETANUKI HUB') + `<section class="card">${errorPanel(error)}</section>`; }
  }

  document.getElementById('global-search').addEventListener('submit', event => { event.preventDefault(); navigate('assets', { q: document.getElementById('global-search-input').value.trim() }); });
  document.getElementById('menu-toggle').addEventListener('click', () => menu(!document.getElementById('sidebar').classList.contains('open')));
  document.getElementById('sidebar-backdrop').addEventListener('click', () => menu(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') menu(false);
    if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { event.preventDefault(); document.getElementById('global-search-input').focus(); }
  });
  main.addEventListener('submit', event => {
    event.preventDefault(); const { page, params } = route();
    if (event.target.id === 'audio-directory-search') {
      const next = new URLSearchParams(params), view = event.target.dataset.directoryView;
      for (const key of ['page', 'character', 'language', 'emotion', 'category']) next.delete(key);
      if (view === 'works') next.delete('work');
      next.set('view', view); next.set('q', new FormData(event.target).get('q').trim());
      navigate('assets', next);
    } else if (event.target.id === 'audio-filter') {
      const next = new URLSearchParams(new FormData(event.target));
      for (const key of ['type', 'work', 'character', 'directory_q', 'directory_page']) if (params.get(key)) next.set(key, params.get(key));
      if (params.get('view') === 'clips' || params.get('character') || params.get('type') === 'audio' || !next.get('q')) next.set('view', 'clips');
      navigate('assets', next);
    } else if (event.target.id === 'asset-filter') {
      const next = new URLSearchParams(new FormData(event.target)); if (params.get('type')) next.set('type', params.get('type')); navigate('assets', next);
    } else if (event.target.id === 'catalog-search' || event.target.id === 'model-search') {
      params.delete('page'); params.set('q', new FormData(event.target).get('q').trim()); navigate(page, params);
    } else if (event.target.id === 'api-form') tryAPI();
    else if (event.target.id === 'upload-form') toast('存储尚未连接，未发送任何文件。');
  });
  main.addEventListener('change', event => {
    if (event.target.id !== 'filter-image-scope') return;
    const next = new URLSearchParams(new FormData(document.getElementById('asset-filter')));
    next.set('type', 'image'); next.delete('page');
    navigate('assets', next);
  });
  main.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target || target.disabled) return;
    const { page, params } = route();
    if (target.hasAttribute('data-retry')) render();
    else if (target.hasAttribute('data-clear-filters')) navigate('assets');
    else if (target.hasAttribute('data-reset-audio')) {
      for (const key of ['q', 'language', 'emotion', 'category', 'page']) params.delete(key);
      params.set('view', 'clips'); navigate('assets', params);
    }
    else if (target.hasAttribute('data-type')) { params.set('type', target.dataset.type); params.delete('page'); params.delete('view'); if (target.dataset.type !== 'image') params.delete('image_scope'); navigate('assets', params); }
    else if (target.hasAttribute('data-page')) { params.set('page', target.dataset.page); navigate(page, params); }
    else if (target.hasAttribute('data-copy-base')) copy(`${location.origin}/api/v1`);
    else if (target.hasAttribute('data-copy-request')) copy(`${location.origin}${apiURL()}`);
  });
  main.addEventListener('toggle', event => {
    if (event.target.matches?.('.voice-transcript')) showTranscript(event.target);
  }, true);
  main.addEventListener('play', event => {
    if (event.target.tagName === 'AUDIO') main.querySelectorAll('audio').forEach(audio => { if (audio !== event.target) audio.pause(); });
  }, true);
  window.addEventListener('hashchange', render);
  if (route().page !== 'overview') refreshSummary().catch(() => {});
  render();
})();
