// 在线文献查找 v2.7：AI 检索策略 + 真实学术数据库 + AI 推荐理由标注
// 流程：论文题目+大纲 → AI 生成英文学术检索词 → CrossRef/OpenAlex 检索（自动切换）
//       → 合并去重 → AI 为每条候选标注"可印证/支撑论文的哪个点" → 人工勾选审核入库
import { formatCitation } from './gbt7714.js';
import { toast, escapeHtml, setLoading } from './ui.js';
import { get, set } from './storage.js';
import { chat, shouldUseLiveAI } from './api.js';
import { ensureCitationIds, normalizeCitationEntry } from './citation-utils.js';

// 中断恢复：导航离开时取消进行中的检索与 AI 标注（避免结果写进已卸载的页面、浪费 token）
// tm:navigate 由 document.dispatchEvent 触发且不冒泡，监听必须挂在 document；模块只加载一次，每次导航后换新 controller
if (!window.__tmLitAbort) {
  window.__tmLitAbort = new AbortController();
  document.addEventListener('tm:navigate', () => {
    window.__tmLitAbort.abort();
    window.__tmLitAbort = new AbortController();
  });
}
const litSignal = () => window.__tmLitAbort.signal;

/** 区分主动取消（切页）与其他失败：fetch 抛 AbortError，chat 抛 code:'aborted' */
function isAbort(e) {
  return e?.name === 'AbortError' || e?.code === 'aborted';
}

function fetchFail(name) {
  return new Error(`无法连接 ${name}：请检查网络；若持续失败，试试强制刷新页面（Cmd+Shift+R）`);
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function issueLabel(volume, issue, pages) {
  return [volume || '', issue ? `(${issue})` : '', pages || ''].filter(Boolean).join(' ');
}

function mockLiterature(query) {
  return [
    {
      doi: '10.1000/mock-lit-1',
      title: `${query}：组织管理与流程优化研究`,
      author: '张伟, 李娜',
      authors: '张伟, 李娜',
      source: '管理学研究',
      year: '2024',
      volume: '12',
      issue: '3',
      pages: '45-58',
      type: 'J',
      abstract: '本文围绕数字化转型、流程标准化与组织协同展开，适合作为研究背景与理论铺垫。',
      provider: '模拟结果',
      url: '',
    },
    {
      doi: '10.1000/mock-lit-2',
      title: `${query}：案例研究方法在企业数字化研究中的应用`,
      author: '刘洋',
      authors: '刘洋',
      source: '研究方法论评论',
      year: '2023',
      volume: '9',
      issue: '2',
      pages: '12-26',
      type: 'J',
      abstract: '聚焦案例研究法和访谈法的结合方式，可支撑方法设计部分。',
      provider: '模拟结果',
      url: '',
    },
    {
      doi: '10.1000/mock-lit-3',
      title: `${query}：人工智能赋能行业规范化的路径分析`,
      author: '王敏, 陈晨',
      authors: '王敏, 陈晨',
      source: '产业经济观察',
      year: '2025',
      volume: '18',
      issue: '1',
      pages: '66-79',
      type: 'J',
      abstract: '讨论 AI 介入行业规范化与效率提升的关键路径，适合作为案例分析和讨论参考。',
      provider: '模拟结果',
      url: '',
    },
  ];
}

/** 解析模型返回的 JSON：容忍代码围栏、前后说明文字、数组被包装在对象中的情况 */
function parseJson(reply) {
  const s = reply.replace(/```json|```/g, '').trim();
  let data;
  try {
    data = JSON.parse(s);
  } catch {
    const m = s.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (!m) throw new Error('AI 未返回有效 JSON');
    data = JSON.parse(m[0]);
  }
  if (!Array.isArray(data)) {
    for (const k of ['queries', 'items', 'chapters', 'results', 'data', 'list']) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return data;
}

async function searchCrossRef(query, rows, signal, offset = 0) {
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query', query);
  url.searchParams.set('rows', String(rows));
  if (offset) url.searchParams.set('offset', String(offset));
  url.searchParams.set('select', 'DOI,title,author,issued,container-title,volume,issue,page,abstract');
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw fetchFail('CrossRef');
  }
  if (!res.ok) throw new Error(`CrossRef 检索失败（HTTP ${res.status}），请稍后再试`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('CrossRef 返回了无法解析的数据，请稍后再试');
  }
  return (data.message?.items || []).map(item => {
    const authors = (item.author || [])
      .map(a => [a.family, a.given].filter(Boolean).join(' ').trim())
      .filter(Boolean);
    const year = item.issued?.['date-parts']?.[0]?.[0];
    return {
      doi: item.DOI || '',
      title: (item.title || [''])[0],
      author: authors.join(', '),
      authors: authors.join(', '),
      source: (item['container-title'] || [''])[0],
      year: year ? String(year) : '',
      volume: item.volume || '',
      issue: item.issue || '',
      pages: item.page || '',
      type: 'J',
      abstract: stripTags(item.abstract || ''),
      provider: 'CrossRef',
      url: item.URL || '',
    };
  }).filter(r => r.title);
}

async function searchOpenAlex(query, rows, signal, offset = 0) {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', query);
  url.searchParams.set('per-page', String(rows));
  if (offset) url.searchParams.set('offset', String(offset));
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw fetchFail('OpenAlex');
  }
  if (!res.ok) throw new Error(`OpenAlex 检索失败（HTTP ${res.status}），请稍后再试`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('OpenAlex 返回了无法解析的数据，请稍后再试');
  }
  return (data.results || []).map(w => {
    const authors = (w.authorships || []).slice(0, 4)
      .map(a => a.author?.display_name)
      .filter(Boolean);
    const b = w.biblio || {};
    const pages = [b.first_page, b.last_page].filter(Boolean).join('-');
    return {
      doi: (w.doi || '').replace('https://doi.org/', ''),
      title: w.display_name || '',
      author: authors.join(', '),
      authors: authors.join(', '),
      source: w.primary_location?.source?.display_name || '',
      year: w.publication_year ? String(w.publication_year) : '',
      volume: b.volume || '',
      issue: b.issue || '',
      pages,
      type: 'J',
      abstract: '',
      provider: 'OpenAlex',
      url: w.primary_location?.landing_page_url || w.primary_location?.pdf_url || '',
    };
  }).filter(r => r.title);
}

/** OpenAlex 中文文献检索（language:zh，覆盖部分中文学术期刊；知网等中文库无开放 API，可用「AI 解析」粘贴补充） */
async function searchOpenAlexZh(query, rows, signal) {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', query);
  url.searchParams.set('filter', 'language:zh');
  url.searchParams.set('per-page', String(rows));
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw fetchFail('OpenAlex');
  }
  if (!res.ok) throw new Error(`OpenAlex 中文检索失败（HTTP ${res.status}）`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('OpenAlex 返回了无法解析的数据，请稍后再试');
  }
  return (data.results || []).map(w => {
    const authors = (w.authorships || []).slice(0, 4)
      .map(a => a.author?.display_name)
      .filter(Boolean);
    const b = w.biblio || {};
    const pages = [b.first_page, b.last_page].filter(Boolean).join('-');
    return {
      doi: (w.doi || '').replace('https://doi.org/', ''),
      title: w.display_name || '',
      author: authors.join(', '),
      authors: authors.join(', '),
      source: w.primary_location?.source?.display_name || '',
      year: w.publication_year ? String(w.publication_year) : '',
      volume: b.volume || '',
      issue: b.issue || '',
      pages,
      type: 'J',
      abstract: '',
      provider: 'OpenAlex',
      lang: 'zh',
      url: w.primary_location?.landing_page_url || w.primary_location?.pdf_url || '',
    };
  }).filter(r => r.title);
}

/** 检索词含中文时检索中文文献通道，失败静默返回空（主动取消透传） */
async function searchZhIfCjk(query, rows, signal) {
  if (!shouldUseLiveAI()) return [];
  if (!/[一-鿿]/.test(query)) return [];
  try {
    return await searchOpenAlexZh(query, rows, signal);
  } catch (e) {
    if (isAbort(e)) throw e;
    return [];
  }
}

/** 双数据源自动切换：CrossRef 失败时降级到 OpenAlex */
export async function searchLiterature(query, rows = 10, signal, offset = 0) {
  if (!shouldUseLiveAI()) {
    return mockLiterature(query).slice(offset, offset + rows);
  }
  let lastErr;
  for (const [name, fn] of [['CrossRef', searchCrossRef], ['OpenAlex', searchOpenAlex]]) {
    try {
      return await fn(query, rows, signal, offset);
    } catch (e) {
      if (isAbort(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('检索失败，请稍后再试');
}

/** AI 检索策略：把论文题目+各章转化为英文学术检索词（中文语境匹配英文数据库的关键） */
export async function buildQueries({ title, chapters = [] }, signal) {
  if (!shouldUseLiveAI()) {
    return [
      { chapter: '论文题目', queries: ['AI-enabled governance', 'process standardization'] },
      ...(chapters.slice(0, 2).map(chapter => ({ chapter, queries: ['case study methodology'] }))),
    ];
  }
  const reply = await chat([
    { role: 'system', content: '你是学术文献检索专家。把论文题目与各章主题转化为适合在 CrossRef/OpenAlex 等英文学术数据库检索的关键词短语（2-5 个英文单词，学术术语，不要整句）。只输出严格 JSON。' },
    { role: 'user', content: `论文题目：《${title}》\n章节列表：\n${chapters.map((c, i) => `${i + 1}. ${c}`).join('\n') || '（无章节大纲）'}\n\n输出 JSON 数组：[{"chapter":"章节名","queries":["英文关键词短语1","英文关键词短语2"]}]，题目与每章各生成 1-2 个查询，总共不超过 8 个查询。` },
  ], { temperature: 0.3, signal });
  const arr = parseJson(reply);
  if (!Array.isArray(arr)) throw new Error('AI 检索策略返回格式异常，已自动退回原始关键词');
  return arr.filter(g => g.chapter && Array.isArray(g.queries)).map(g => ({
    chapter: g.chapter,
    queries: g.queries.filter(q => typeof q === 'string' && q.trim()).slice(0, 2),
  })).filter(g => g.queries.length);
}

/** AI 推荐理由：为每条候选标注"可印证/支撑论文的哪个点"并匹配最适配章节 */
export async function annotateCandidates(items, { title, chapters = [] }, signal) {
  if (!shouldUseLiveAI()) {
    return items.map((r, i) => ({
      ...r,
      reason: i === 0
        ? '可用于铺垫研究背景与行业现状'
        : i === 1
          ? '可支撑研究方法与案例设计'
          : '可用于案例分析或讨论部分',
      chapter: chapters[i] || chapters[0] || '第1章 绪论',
    }));
  }
  const listText = items.map((r, i) =>
    `${i}. 标题：${r.title}\n   出处：${[r.source, r.year].filter(Boolean).join(', ')}\n   摘要：${(r.abstract || '无').slice(0, 150)}`).join('\n');
  const reply = await chat([
    { role: 'system', content: '你是论文文献匹配专家。为每篇候选文献写一条"推荐理由"：它在用户的论文里可以印证、支撑或借鉴什么（如：支撑方法设计、作为对比 baseline、提供综述素材、概念/理论定义来源、实验数据参考），并指出最适合关联的章节。只输出严格 JSON。' },
    { role: 'user', content: `用户论文：《${title}》\n章节：${chapters.join('；') || '（无大纲，请根据题目判断）'}\n\n候选文献（共 ${items.length} 条）：\n${listText}\n\n输出 JSON 数组：[{"i":0,"reason":"一句话推荐理由（30字内，说清可印证/支撑哪个点）","chapter":"最适合的章节名"}]，覆盖每一条候选。` },
  ], { temperature: 0.4, signal });
  const arr = parseJson(reply);
  const map = new Map(arr.map(a => [Number(a.i), a]));
  return items.map((r, i) => ({
    ...r,
    reason: map.get(i)?.reason || '',
    chapter: map.get(i)?.chapter || r.group || '',
  }));
}

function itemKey(r) {
  return ((r.doi || r.title || '').toLowerCase()).trim();
}

/** 合并去重：按 DOI/题名 */
function dedupe(groups) {
  const seen = new Set();
  const merged = [];
  groups.forEach(g => g.forEach(r => {
    const key = itemKey(r);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(r);
  }));
  return merged;
}

/** 在容器内渲染「查找文献」组件 */
export function renderLitSearch(container, { defaultQuery = '', batchFrom = null, compact = false, onDone } = {}) {
  const sourceNote = shouldUseLiveAI()
    ? '数据来源：CrossRef / OpenAlex；先看推荐理由和题名，再按需打开原文核对。'
    : '当前为演示模式，使用内置模拟文献结果，不会请求外部数据库。';
  container.innerHTML = `
    <div class="lit-search-shell">
      <div class="lit-search-bar">
        <input type="text" id="lit-q" class="lit-query-input" placeholder="输入检索词（论文题目、关键词、章节主题…）" value="${escapeHtml(defaultQuery)}">
        <button class="btn" id="lit-search">查找</button>
      </div>
      ${batchFrom && (batchFrom.title || batchFrom.chapters?.length) ? `
        <div class="lit-batch-callout">
          <div>
            <div class="lit-batch-title">快速生成一批候选</div>
            <p class="hint">系统会根据当前题目和大纲自动生成检索词，再补上推荐理由，方便你直接筛选。</p>
          </div>
          <button class="btn btn-ai-solid" id="lit-batch">一键批量推荐</button>
        </div>` : ''}
      <p class="hint lit-search-note">${sourceNote}</p>
      <div id="lit-results"></div>
    </div>
  `;

  const q = container.querySelector('#lit-q');
  const btn = container.querySelector('#lit-search');
  const results = container.querySelector('#lit-results');
  const batchBtn = container.querySelector('#lit-batch');

  let currentItems = [];
  let moreState = null; // { query, rows, offset }——单次检索的分页游标；批量推荐/紧凑模式不启用

  /** 已选计数刷新（加载更多追加条目后同样生效） */
  function reloadCount() {
    const el = results.querySelector('#lit-count');
    if (!el) return;
    const n = results.querySelectorAll('input[type=checkbox]:checked').length;
    el.textContent = `已选 ${n} 条`;
  }

  /** 单条/多条文献候选 HTML（纯函数：加载更多追加时只渲染新条目，保留已勾选状态）
   *  startIndex：追加批次的全局下标起点（避免 id 冲突与默认勾选重复） */
  function litItemsHtml(items, libKeys, startIndex = 0, autoCheck = true) {
    let lastGroup = null;
    return items.map((r, idxInBatch) => {
      const i = startIndex + idxInBatch;
      const key = itemKey(r);
      const inLib = key && libKeys.has(key);
      const langTag = r.lang === 'zh' ? '中文文献' : '英文文献';
      const topic = r.chapter || r.group || '';
      const groupKey = topic ? `${langTag}｜${topic}` : '';
      let groupHeader = '';
      if (groupKey && groupKey !== lastGroup) {
        lastGroup = groupKey;
        groupHeader = `<div class="lit-group">${escapeHtml(groupKey)}</div>`;
      }
      const link = r.doi
        ? `https://doi.org/${encodeURIComponent(r.doi)}`
        : `https://scholar.google.com/scholar?q=${encodeURIComponent(r.title)}`;
      const abs = r.abstract
        ? escapeHtml(r.abstract.length > 300 ? r.abstract.slice(0, 300) + '…' : r.abstract)
        : '（该数据库未提供摘要，可点「🔗 原文」核对）';
      return `${groupHeader}
        <div class="item lit-item">
          <label class="lit-cb" for="lit-cb-${i}" title="${inLib ? '已入库' : '点击勾选'}">
            <input type="checkbox" id="lit-cb-${i}" ${inLib ? 'disabled' : (autoCheck && i < 3 ? 'checked' : '')}>
            <span class="lit-main">
              <span class="lit-title">${escapeHtml(r.title)}${inLib ? ' <span class="seal lit-in-library">已入库</span>' : ''}</span>
              ${r.reason ? `<span class="lit-reason"><span class="rsn-label">推荐理由</span>${escapeHtml(r.reason)}</span>` : ''}
              <span class="lit-meta"><span class="authors">${escapeHtml([r.author || r.authors, r.source].filter(Boolean).join(' · '))}</span> · <span class="mono">${escapeHtml([r.year, issueLabel(r.volume, r.issue, r.pages)].filter(Boolean).join(' '))}</span> · <span class="chip">${escapeHtml(r.provider || '')}</span>${r.lang === 'zh' ? ' <span class="chip">中文</span>' : ''}</span>
            </span>
          </label>
          <div class="lit-actions">
            <a class="btn btn-ghost btn-sm" href="${link}" target="_blank" rel="noopener" title="打开原文页面核对">打开原文</a>
            <button class="btn btn-ghost btn-sm" data-lit-detail="${i}">详情</button>
          </div>
        </div>
        <div class="lit-detail" id="lit-detail-${i}" hidden>
          <div class="gb">${escapeHtml(formatCitation(r))}</div>
          ${r.doi ? `<div class="mono">DOI: ${escapeHtml(r.doi)}</div>` : ''}
          ${r.url ? `<div class="mono lit-detail-url">URL: ${escapeHtml(r.url)}</div>` : ''}
          <div class="lit-abstract">摘要：${abs}</div>
          <div class="lit-detail-link"><a href="${link}" target="_blank" rel="noopener">打开原文页面</a></div>
        </div>`;
    }).join('');
  }

  /** 加载更多：同一检索词取下一页（offset 递增），追加去重，保留已勾选 */
  async function loadMore() {
    if (!moreState) return;
    const moreBtn = results.querySelector('#lit-more');
    if (moreBtn) setLoading(moreBtn, true, '加载中…');
    try {
      const more = await searchLiterature(moreState.query, moreState.rows, litSignal(), moreState.offset);
      const libKeys = new Set(get('citations', []).map(c => itemKey(c)).filter(Boolean));
      const seen = new Set(currentItems.map(itemKey));
      const fresh = more.filter(r => { const k = itemKey(r); return k && !seen.has(k); });
      currentItems.push(...fresh);
      const listEl = results.querySelector('.item-list');
      // 追加批次：全局下标续接（id 不冲突）、不自动勾选（首屏的「推荐前 3」只生效一次）
      if (listEl) listEl.insertAdjacentHTML('beforeend', litItemsHtml(fresh, libKeys, currentItems.length - fresh.length, false));
      moreState.offset += moreState.rows;
      const totalEl = results.querySelector('#lit-total');
      if (totalEl) totalEl.textContent = `共 ${currentItems.length} 条 · 已按适配章节分组去重`;
      reloadCount();
      if (!fresh.length) {
        if (moreBtn) moreBtn.remove();
        toast('没有更多相关文献了', 'ok', 1500);
        return;
      }
      toast(`已追加 ${fresh.length} 条`, 'ok', 1500);
    } catch (e) {
      if (isAbort(e)) return;
      toast(e.message, 'err', 3600);
    } finally {
      const b = results.querySelector('#lit-more');
      if (b) setLoading(b, false);
    }
  }

  function renderResults(items) {
    currentItems = items;
    if (!items.length) {
      results.innerHTML = '<div class="empty-inline">未找到相关文献，换一个关键词，或者用题目里的更具体表述再试一次。</div>';
      return;
    }
    const libKeys = new Set(
      get('citations', []).map(c => itemKey(c)).filter(Boolean)
    );

    const itemsHtml = litItemsHtml(items, libKeys);

    results.innerHTML = `
      <div class="lit-results-head">
        <div class="lit-results-stats">
          <span class="hint mono lit-stat" id="lit-count">已选 0 条</span>
          <span class="hint mono lit-stat" id="lit-total">共 ${items.length} 条 · 已按适配章节分组去重</span>
        </div>
        <div class="result-actions lit-result-actions">
          <button class="btn btn-ghost btn-sm" id="lit-sel-all">全选</button>
          <button class="btn btn-ghost btn-sm" id="lit-sel-none">清空</button>
        </div>
      </div>
      <div class="item-list lit-result-list">${itemsHtml}</div>
      <div class="lit-footer-actions">
        <button class="btn" id="lit-add">将已选文献加入文献库</button>
      </div>
      ${moreState ? '<div class="lit-more-row"><button class="btn btn-ghost btn-sm" id="lit-more">加载更多</button></div>' : ''}`;

    reloadCount();
    results.querySelector('#lit-sel-all').addEventListener('click', () => {
      results.querySelectorAll('input:not(:disabled)').forEach(cb => { cb.checked = true; });
      reloadCount();
    });
    results.querySelector('#lit-sel-none').addEventListener('click', () => {
      results.querySelectorAll('input').forEach(cb => { cb.checked = false; });
      reloadCount();
    });
    results.querySelector('#lit-more')?.addEventListener('click', loadMore);
    // 事件委托：勾选计数 + 详情展开（加载更多追加的条目无需单独绑定）
    results.addEventListener('change', e => {
      if (e.target.matches('input[type=checkbox]')) reloadCount();
    });
    results.addEventListener('click', e => {
      const det = e.target.closest('[data-lit-detail]');
      if (!det) return;
      const d = results.querySelector(`#lit-detail-${det.dataset.litDetail}`);
      const show = d.hidden;
      d.hidden = !show;
      det.textContent = show ? '收起' : '详情';
    });
    results.querySelector('#lit-add').addEventListener('click', () => {
      const selected = currentItems.filter((_, i) => {
        const cb = results.querySelector(`#lit-cb-${i}`);
        return cb && cb.checked && !cb.disabled;
      });
      if (!selected.length) { toast('请先勾选要加入的文献', 'err'); return; }
      const libKeysNow = new Set(
        get('citations', []).map(c => itemKey(c)).filter(Boolean)
      );
      const list = get('citations', []);
      const normalized = ensureCitationIds(list);
      if (normalized.changed) {
        list.splice(0, list.length, ...normalized.list);
      }
      let next = list.reduce((m, c) => Math.max(m, c.litNo || 0), 0);
      const seen = new Set();
      let added = 0;
      let skipped = 0;
      selected.forEach(r => {
        const key = itemKey(r);
        if (seen.has(key) || libKeysNow.has(key)) { skipped++; return; }
        seen.add(key);
        const entry = normalizeCitationEntry({
          ...r,
          id: r.id || crypto.randomUUID?.() || `cit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        entry.litNo = ++next;
        list.unshift(entry);
        added++;
      });
      set('citations', list);
      toast(`新增 ${added} 条${skipped ? `，跳过 ${skipped} 条重复` : ''}`, 'ok');
      // 刷新结果列表：已入库条目置灰并打「已入库」印章，保持状态一致
      renderResults(items);
      // 入库后引导下一步：去工作台插入引用
      const guide = document.createElement('div');
      guide.className = 'lit-guide-row';
      const seal = document.createElement('span');
      seal.className = 'seal';
      seal.textContent = `已入库 ${added} 条`;
      const goBtn = document.createElement('button');
      goBtn.className = 'btn btn-ghost btn-sm';
      goBtn.textContent = '去写作工作台插入引用';
      goBtn.addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'writing' })));
      guide.append(seal, goBtn);
      const addBtn = results.querySelector('#lit-add');
      if (addBtn) addBtn.after(guide);
      if (onDone) onDone(added);
    });
  }

  // 单次检索：检索后同样做 AI 推荐理由标注（有论文语境时）
  async function run() {
    const query = q.value.trim();
    if (!query) { toast('请输入检索词', 'err'); return; }
    setLoading(btn, true, '检索中…');
    results.innerHTML = '<p class="desc">正在检索文献候选…</p>';
    try {
      let items = await searchLiterature(query, compact ? 8 : 10, litSignal());
      const zhItems = await searchZhIfCjk(query, compact ? 5 : 6, litSignal());
      items = [...zhItems, ...items]; // 中文文献排前
      if (items.length && batchFrom?.title) {
        results.innerHTML = '<p class="desc">正在补充每条候选的推荐理由…</p>';
        items = await annotateCandidates(items, batchFrom, litSignal())
          .catch(e => { if (isAbort(e)) throw e; return items; });
      }
      // 单次检索启用分页游标（加载更多追加同一检索词下一页；批量推荐/紧凑模式不分页）
      moreState = compact ? null : { query, rows: compact ? 8 : 10, offset: compact ? 8 : 10 };
      renderResults(items);
    } catch (e) {
      if (isAbort(e)) return; // 主动取消（切页），不打扰
      results.innerHTML = `<p class="desc">检索失败：${escapeHtml(e.message)}</p>`;
      toast(e.message, 'err', 3600);
    } finally {
      setLoading(btn, false);
    }
  }

  // 批量推荐：AI 检索策略 → 检索 → 合并去重 → AI 推荐理由
  async function runBatch() {
    moreState = null; // 批量推荐不分页
    const ctx = batchFrom;
    const rawQueries = [ctx.title, ...(ctx.chapters || [])].filter(Boolean);
    if (!rawQueries.length) { toast('请先设置论文题目或采用大纲', 'err'); return; }

    setLoading(batchBtn, true, 'AI 生成检索策略中…');
    results.innerHTML = '<p class="desc">正在根据题目和大纲生成检索策略…</p>';
    let plan;
    try {
      plan = await buildQueries(ctx, litSignal());
    } catch (e) {
      if (isAbort(e)) { setLoading(batchBtn, false); return; }
      plan = rawQueries.map(q => ({ chapter: q, queries: [q] }));
      // 透传 R13 可读错误文案（网络/bad_response/格式异常），不误导归因（Key 问题由 chat 错误本身说明）
      toast(`AI 检索策略生成失败（${e.message}）`, 'err', 4000);
    }
    const pairs = plan.flatMap(g => g.queries.map(query => ({ query, group: g.chapter }))).slice(0, 8);

    setLoading(batchBtn, true, '检索真实文献中…');
    results.innerHTML = `<p class="desc">正在按 ${pairs.length} 组检索词收集文献候选…</p>`;
    let items;
    try {
      const groups = await Promise.all(pairs.map(p =>
        searchLiterature(p.query, 3, litSignal())
          .then(list => list.map(r => ({ ...r, group: p.group })))
          .catch(e => { if (isAbort(e)) throw e; return []; })));
      // 中文文献通道：直接用中文题目/章节名检索（OpenAlex language:zh）
      const zhPairs = [ctx.title, ...(ctx.chapters || [])]
        .filter(q => /[一-鿿]/.test(q))
        .slice(0, 6);
      const zhGroups = shouldUseLiveAI()
        ? await Promise.all(zhPairs.map(q =>
            searchOpenAlexZh(q, 3, litSignal())
              .then(list => list.map(r => ({ ...r, group: q, lang: 'zh' })))
              .catch(e => { if (isAbort(e)) throw e; return []; })))
        : [];
      items = dedupe([...zhGroups, ...groups]);
    } catch (e) {
      if (isAbort(e)) { setLoading(batchBtn, false); return; }
      results.innerHTML = `<p class="desc">检索失败：${escapeHtml(e.message)}</p>`;
      toast(e.message, 'err', 3600);
      setLoading(batchBtn, false);
      return;
    }

    if (items.length && ctx.title) {
      setLoading(batchBtn, true, 'AI 标注推荐理由中…');
      results.innerHTML = '<p class="desc">正在为候选补充推荐理由，方便你直接筛选…</p>';
      // 注意：此 await 在 runBatch 的 try/catch 之外，abort 必须就地接住——
      // rethrow 会变成 unhandled rejection 且 setLoading(false) 不执行（按钮卡加载态）
      try {
        items = await annotateCandidates(items.slice(0, 20), ctx, litSignal());
      } catch (e) {
        if (isAbort(e)) { setLoading(batchBtn, false); return; }
        // 标注失败：退回无推荐理由的结果（不影响已检索到的文献）
      }
    }

    renderResults(items);
    setLoading(batchBtn, false);
  }

  btn.addEventListener('click', run);
  q.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  if (batchBtn) batchBtn.addEventListener('click', runBatch);
}
