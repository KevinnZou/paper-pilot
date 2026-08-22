// 文献与格式：文献库 CRUD + GB/T 7714 规则引擎 + AI 解析（PRD §3.2、§4.4 链路②）
import { toast, copyText, escapeHtml, setLoading } from '../ui.js';
import { get, set } from '../storage.js';
import { chat } from '../api.js';
import { renderLitSearch } from '../litsearch.js';
import { getProject } from '../project.js';
import { ensureCitationIds, normalizeCitationEntry, formatCitationEntry } from '../citation-utils.js';
import { docFromJSON, collectCitationUsage, buildCitationNumberMap } from '../document-model.js';

// ---------- GB/T 7714 格式化：规则引擎抽至 gbt7714.js（供文献查找等模块复用） ----------
// 注意：`export ... from` 不建立本地绑定，必须先 import 再 re-export（历史 bug 修复）
import { formatCitation } from '../gbt7714.js';
export { formatCitation };

const PARSE_SYSTEM = '你是参考文献解析助手。把用户粘贴的引用信息解析为 GB/T 7714 条目。只输出严格 JSON 数组，每项形如 {"authors":"张三, 李四","title":"题名","source":"期刊名/学校/出版社","year":"2024","volume":"34","issue":"3","pages":"45-52","doi":"","url":"","institution":"","publisher":"","place":"","type":"J"}，type 取值 J(期刊)/D(学位论文)/M(专著)/C(会议)/R(报告)/S(标准)/P(专利)/N(报纸)/EB/OL(电子资源)，不确定的字段用空字符串。不要输出 JSON 以外的任何内容。';

// 中断恢复：导航离开时取消进行中的 AI 解析（与写作/文献模块一致；幂等——任一模块先初始化即生效）
if (!window.__tmAbort) {
  window.__tmAbort = new AbortController();
  document.addEventListener('tm:navigate', () => {
    window.__tmAbort.abort();
    window.__tmAbort = new AbortController();
  });
}
const abortSignal = () => window.__tmAbort.signal;

/** 汇总所有草稿正文中被引用的编号集合（GB/T 7714 自查：参考文献应为正文实际引用项） */
function collectCitedNums() {
  const project = getProject();
  if (project.documentV2) {
    const citations = get('citations', []);
    const { list, changed } = ensureCitationIds(citations);
    if (changed) set('citations', list);
    const usage = collectCitationUsage(docFromJSON({ ...project, citations: list }));
    const order = buildCitationNumberMap(docFromJSON({ ...project, citations: list }));
    return new Set([...usage.keys()].map(id => order.get(id)).filter(Boolean));
  }
  const nums = new Set();
  Object.values(get('drafts', {})).forEach(d => {
    const text = (d && typeof d === 'object' ? d.content : d) || '';
    (text.match(/\[(\d+)\]/g) || []).forEach(m => nums.add(Number(m.slice(1, -1))));
  });
  return nums;
}

function citationContext(list = sortedList()) {
  const project = getProject();
  const byId = new Map();
  const citedIds = new Set();
  let usage = new Map();
  let order = new Map();
  if (project.documentV2) {
    const doc = docFromJSON({ ...project, citations: list });
    usage = collectCitationUsage(doc);
    order = buildCitationNumberMap(doc);
    usage.forEach((_, id) => citedIds.add(id));
  }
  list.forEach(item => byId.set(item.id, item));
  return { usage, order, citedIds, byId };
}

function docRegions(doc) {
  const regions = [];
  let current = null;
  doc.forEach((node, offset) => {
    const from = offset + 1;
    const to = offset + node.nodeSize - 1;
    if (node.type.name === 'heading') {
      if (current) current.to = from - 1;
      const label = node.attrs.role === 'section'
        ? node.textContent.trim()
        : ({
            title: '论文标题',
            abstract: '摘要',
            keywords: '关键词',
            references: '参考文献',
            ack: '致谢',
          }[node.attrs.role] || node.textContent.trim());
      current = { label, from, to };
      regions.push(current);
      return;
    }
    if (!current) {
      current = { label: '未命名部分', from, to };
      regions.push(current);
      return;
    }
    current.to = to;
  });
  return regions;
}

function citationUsageMessage(list, item) {
  let refs = 0;
  const locations = [];
  const project = getProject();
  if (project.documentV2 && item.id) {
    const doc = docFromJSON({ ...project, citations: list });
    const usage = collectCitationUsage(doc).get(item.id);
    refs = usage?.count || 0;
    if (usage?.positions?.length) {
      const regions = docRegions(doc);
      const seen = new Set();
      usage.positions.forEach(pos => {
        const region = regions.find(entry => pos >= entry.from && pos <= entry.to);
        const label = region?.label || '未命名部分';
        if (!seen.has(label)) {
          seen.add(label);
          locations.push(label);
        }
      });
    }
  } else {
    const pattern = new RegExp(`\\[${item.litNo}\\]`, 'g');
    Object.entries(get('drafts', {})).forEach(([chapter, draft]) => {
      const text = draft?.content || '';
      const matches = text.match(pattern);
      if (matches?.length) {
        refs += matches.length;
        locations.push(chapter);
      }
    });
  }
  return { refs, locations };
}

function citedStatsHtml(citedNums, list) {
  if (!list.length) return '';
  const project = getProject();
  const cited = project.documentV2
    ? citationContext(list).citedIds.size
    : list.filter(c => citedNums.has(c.litNo)).length;
  const uncited = list.length - cited;
  return uncited > 0
    ? `<p class="cite-stats warn">已引用 <b>${cited}</b> / ${list.length} 条 · 未引用 <b>${uncited}</b> 条（GB/T 7714 参考文献应为正文实际引用项，建议补引或删除）</p>`
    : `<p class="cite-stats ok">已引用 <b>${cited}</b> / ${list.length} 条，全部已被正文引用 ✓</p>`;
}

/** 文献搜索匹配：标题 / 作者 / 出处 / 完整格式任一包含关键词（不区分大小写） */
function matchKeyword(c, kw) {
  if (!kw) return true;
  const hay = [c.title, c.formatted, c.source, (c.authors || []).map(a => a.name || '').join(' ')].join(' ').toLowerCase();
  return hay.includes(kw);
}

function renderList(list, citedNums, keyword = '', ctx = citationContext(list)) {
  if (!list.length) return '<div style="color:var(--ink-soft)">暂无文献，去上方「智能推荐与检索」收集吧</div>';
  const kw = keyword.trim().toLowerCase();
  const filtered = kw ? list.filter(c => matchKeyword(c, kw)) : list;
  if (!filtered.length) return `<div style="color:var(--ink-soft)">没有匹配「${escapeHtml(keyword.trim())}」的文献，试试标题 / 作者 / 出处关键词</div>`;
  return filtered.map(c => {
    const currentNo = ctx.order.get(c.id);
    const cited = !!currentNo || (c.litNo != null && citedNums.has(c.litNo));
    const badge = currentNo ? `[${currentNo}]` : c.litNo != null ? `L${c.litNo}` : '未编';
    return `
    <div class="item">
      <div class="item-main">
        <div class="item-title">${badge ? `<span class="chip ref-no">${badge}</span> ` : ''}${escapeHtml(c.title || '（无题名）')} <span class="chip">${escapeHtml(c.type || '?')}</span> ${
      cited
        ? '<span class="chip done" title="正文中已引用该文献">已引用</span>'
        : '<span class="chip uncited" title="正文中未引用该文献">未引用</span>'}</div>
        <div class="item-meta gb">${escapeHtml(c.formatted || '')}</div>
        <div class="item-meta">${escapeHtml([c.doi ? `DOI ${c.doi}` : '', c.url || ''].filter(Boolean).join(' · '))}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-ghost btn-sm" data-cit-copy="${escapeHtml(c.formatted || '')}" title="复制 GB/T 7714 格式">📋</button>
        <button class="btn btn-danger btn-sm" data-cit-del="${escapeHtml(c.id)}" title="删除该文献">🗑</button>
      </div>
    </div>`;
  }).join('');
}

/** 为缺编号的旧条目补上稳定引用编号（正文引用 [n] 依赖此编号）
 *  按 max+1 递增分配——用数组下标 i+1 会与已有编号冲突（出现两个同编号条目） */
function ensureNumbers(list) {
  const withIds = ensureCitationIds(list);
  list = withIds.list;
  let changed = false;
  let next = list.reduce((m, c) => Math.max(m, c.litNo || 0), 0) + 1;
  list.forEach(c => {
    if (c.litNo == null) { c.litNo = next++; changed = true; }
  });
  if (changed || withIds.changed) set('citations', list);
}

function nextLitNo(list) {
  return list.reduce((m, c) => Math.max(m, c.litNo || 0), 0) + 1;
}

function sortedList() {
  const list = ensureCitationIds(get('citations', [])).list.map(item =>
    normalizeCitationEntry(item, getProject().referenceStandard));
  return list.sort((a, b) => (a.litNo || 0) - (b.litNo || 0));
}

/** 局部刷新文献库列表（不整页重渲染，保留上方表单与结果） */
function refreshLibrary(el) {
  const list = sortedList();
  const citedNums = collectCitedNums();
  const ctx = citationContext(list);
  const box = el.querySelector('#cit-list');
  const kw = el.querySelector('#cit-search')?.value || '';
  if (box) box.innerHTML = renderList(list, citedNums, kw, ctx);
  const scount = el.querySelector('#cit-search-count');
  if (scount) {
    const matched = kw.trim() ? list.filter(c => matchKeyword(c, kw.trim().toLowerCase())).length : list.length;
    scount.textContent = kw.trim() ? `匹配 ${matched} / ${list.length} 条` : '';
    scount.className = 'cit-search-count' + (kw.trim() && !matched ? ' warn' : '');
  }
  const countChip = el.querySelector('.card h2 .chip.ref-no');
  if (countChip) countChip.textContent = `${list.length} 条`;
  const allBtn = el.querySelector('#cit-copy-all');
  if (allBtn) allBtn.disabled = !list.length;
  const stats = el.querySelector('#cit-cite-stats');
  if (stats) stats.innerHTML = citedStatsHtml(citedNums, list);
  bindListActions(el);
}

function bindListActions(el) {
  el.querySelectorAll('[data-cit-copy]').forEach(b =>
    b.addEventListener('click', () => copyText(b.dataset.citCopy)));
  el.querySelectorAll('[data-cit-del]').forEach(b =>
    b.addEventListener('click', () => {
      // 用稳定编号 litNo 定位（数组顺序会因 unshift 变化，索引定位会删错）
      const list = get('citations', []);
      const idx = list.findIndex(x => x.id === b.dataset.citDel);
      const item = idx >= 0 ? list[idx] : null;
      if (!item) return;
      const { refs, locations } = citationUsageMessage(list, item);
      const currentNo = citationContext(list).order.get(item.id) || item.litNo || '?';
      const locationLine = locations.length
        ? `\n引用位置：${locations.slice(0, 4).join('、')}${locations.length > 4 ? ` 等 ${locations.length} 处` : ''}`
        : '';
      const msg = refs
        ? `「${(item.title || '').slice(0, 24)}」在正文中被引用 ${refs} 次，删除后这些 [${currentNo}] 引用将失效且无法恢复。${locationLine}\n确定删除吗？`
        : `确定删除「${(item.title || '').slice(0, 24)}」吗？删除后无法恢复。`;
      if (!confirm(msg)) return;
      list.splice(idx, 1);
      set('citations', list);
      toast('已删除', 'ok');
      refreshLibrary(el);
    }));
}

function render(el) {
  const list0 = get('citations', []);
  ensureNumbers(list0);
  const list = sortedList();
  const citedNums = collectCitedNums();
  const prj = getProject();

  el.innerHTML = `
    <div class="card">
      <h2><span class="mark"></span>智能推荐与检索</h2>
      <p class="desc">一键基于「论文题目 + 大纲」批量推荐（中英文文献、AI 检索策略 + 推荐理由）；也可手动输入检索词；点「原文」核对、按「推荐理由」勾选入库</p>
      <div id="cit-lit"></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2><span class="mark"></span>AI 智能解析</h2>
        <p class="desc">粘贴从知网、Google Scholar 等处复制的杂乱引用信息（可一次多条），AI 解析为结构化条目并生成标准格式</p>
        <label class="field-label">粘贴引用信息</label>
        <textarea id="cit-parse" placeholder="例如：&#10;张伟, 李娜. 大语言模型在教育领域的应用研究[J]. 现代教育技术, 2024, 34(3): 45-52."></textarea>
        <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ai-solid" id="cit-parse-btn">解析并保存到文献库</button>
          <button class="btn btn-ghost" id="cit-parse-demo">填入示例试试</button>
        </div>
        <div class="result-box" id="cit-parse-out"><span class="placeholder">解析结果将显示在这里</span></div>
      </div>

      <div class="card">
        <h2><span class="mark"></span>手动录入</h2>
        <p class="desc">按字段录入，规则引擎实时生成 GB/T 7714 格式。已切到更细的数据结构：卷、期、页、DOI、URL 分开保存。</p>
        <div class="form-row">
          <div>
            <label class="field-label">文献类型</label>
            <select id="cit-type">
              <option value="J">期刊 [J]</option><option value="D">学位论文 [D]</option>
              <option value="M">专著 [M]</option><option value="C">会议论文 [C]</option>
              <option value="R">报告 [R]</option><option value="S">标准 [S]</option>
              <option value="P">专利 [P]</option><option value="N">报纸 [N]</option>
              <option value="EB/OL">电子资源 [EB/OL]</option>
            </select>
          </div>
          <div>
            <label class="field-label">年份</label>
            <input type="number" id="cit-year" placeholder="2024">
          </div>
        </div>
        <label class="field-label">作者（逗号分隔，超过 3 人自动"等"）</label>
        <input type="text" id="cit-author" placeholder="张伟, 李娜">
        <label class="field-label">题名</label>
        <input type="text" id="cit-title" placeholder="文章或书名">
        <label class="field-label">出处（期刊名 / 学校 / 出版社）</label>
        <input type="text" id="cit-source" placeholder="现代教育技术">
        <div class="form-row">
          <div>
            <label class="field-label">卷 / 期 / 页码</label>
            <div class="form-row">
              <div><input type="text" id="cit-volume" placeholder="卷 34"></div>
              <div><input type="text" id="cit-issue" placeholder="期 3"></div>
            </div>
            <input type="text" id="cit-pages" placeholder="页码 45-52" style="margin-top:8px">
          </div>
          <div>
            <label class="field-label">DOI / URL</label>
            <input type="text" id="cit-doi" placeholder="10.xxxx/xxxx">
            <input type="text" id="cit-url" placeholder="https://..." style="margin-top:8px">
          </div>
        </div>
        <div style="margin-top:16px">
          <button class="btn" id="cit-add">生成并保存</button>
        </div>
        <div class="result-box" id="cit-preview"><span class="placeholder">格式预览将显示在这里</span></div>
      </div>
    </div>

    <div class="card">
      <h2><span class="mark"></span>我的文献库　<span class="chip ref-no mono">${list.length} 条</span></h2>
      <p class="desc">文献保存在浏览器本地；在「写作工作台」中可直接「插入引用」（GB/T 7714 格式）</p>
      <div id="cit-cite-stats">${citedStatsHtml(citedNums, list)}</div>
      <div class="result-actions" style="margin:0 0 10px">
        <button class="btn btn-ghost btn-sm" id="cit-copy-all" ${list.length ? '' : 'disabled'}>复制全部（编号）</button>
      </div>
      <div class="cit-search-row">
        <input type="search" id="cit-search" placeholder="搜索标题 / 作者 / 出处…" aria-label="搜索文献库">
        <button class="btn btn-ghost btn-sm" id="cit-search-clear" title="清空搜索" ${list.length ? '' : 'disabled'}>✕</button>
        <span class="cit-search-count" id="cit-search-count" aria-live="polite"></span>
      </div>
      <div class="item-list" id="cit-list">${renderList(list, citedNums)}</div>
    </div>`;

  // 在线查找文献（真实数据库 → 人工勾选 → 入库，链路⑦；支持批量推荐）
  renderLitSearch(el.querySelector('#cit-lit'), {
    batchFrom: { title: prj.title, chapters: prj.outline.map(c => c.chapter) },
    onDone: () => refreshLibrary(el), // 只刷新文献库，保留检索结果与「已入库」引导
  });

  // 文献库实时搜索：输入即过滤，搜索词在局部刷新中保留（不整页重渲染）
  const searchEl = el.querySelector('#cit-search');
  searchEl.addEventListener('input', () => refreshLibrary(el));
  el.querySelector('#cit-search-clear').addEventListener('click', () => {
    searchEl.value = '';
    refreshLibrary(el);
    searchEl.focus();
  });

  // 手动录入：规则引擎实时生成格式（desc 承诺的「实时」，输入即预览）
  const previewEl = el.querySelector('#cit-preview');
  let previewTimer = null;
  function updatePreview() {
    const entry = {
      type: el.querySelector('#cit-type').value,
      year: el.querySelector('#cit-year').value.trim(),
      authors: el.querySelector('#cit-author').value.trim(),
      title: el.querySelector('#cit-title').value.trim(),
      source: el.querySelector('#cit-source').value.trim(),
      volume: el.querySelector('#cit-volume').value.trim(),
      issue: el.querySelector('#cit-issue').value.trim(),
      pages: el.querySelector('#cit-pages').value.trim(),
      doi: el.querySelector('#cit-doi').value.trim(),
      url: el.querySelector('#cit-url').value.trim(),
    };
    if (!entry.title) {
      previewEl.innerHTML = '<span class="placeholder">填写题名后实时预览 GB/T 7714 格式</span>';
      previewEl.classList.remove('filled');
      return;
    }
    previewEl.innerHTML =
      `<span class="sample-tag">GB/T 7714 格式（规则引擎实时生成）</span>\n${escapeHtml(formatCitation(entry, prj.referenceStandard))}`;
    previewEl.classList.add('filled');
  }
  ['#cit-type', '#cit-year', '#cit-author', '#cit-title', '#cit-source', '#cit-volume', '#cit-issue', '#cit-pages', '#cit-doi', '#cit-url'].forEach(s => {
    el.querySelector(s).addEventListener('input', () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(updatePreview, 300);
    });
  });

  // 保存入库（预览已在输入时实时生成，保存后清空字段、预览保留便于连续录入）
  el.querySelector('#cit-add').addEventListener('click', () => {
    const entry = {
      type: el.querySelector('#cit-type').value,
      year: el.querySelector('#cit-year').value.trim(),
      authors: el.querySelector('#cit-author').value.trim(),
      title: el.querySelector('#cit-title').value.trim(),
      source: el.querySelector('#cit-source').value.trim(),
      volume: el.querySelector('#cit-volume').value.trim(),
      issue: el.querySelector('#cit-issue').value.trim(),
      pages: el.querySelector('#cit-pages').value.trim(),
      doi: el.querySelector('#cit-doi').value.trim(),
      url: el.querySelector('#cit-url').value.trim(),
    };
    if (!entry.title) { toast('请至少填写题名', 'err'); return; }
    Object.assign(entry, formatCitationEntry({ ...entry, id: entry.id || crypto.randomUUID?.() }, prj.referenceStandard));
    updatePreview(); // 同步刷新预览（防抖未触发时立即点保存也能看到最新格式）
    const list = get('citations', []);
    if (!entry.id) entry.id = crypto.randomUUID?.() || `cit-${Date.now()}`;
    entry.litNo = nextLitNo(list);
    list.unshift(entry);
    set('citations', list);
    toast(`已保存到文献库（编号 [${entry.litNo}]）`, 'ok');
    refreshLibrary(el); // 预览保留在页面上，不整页重渲染
    // 连续录入：清空输入字段，预览保留
    ['#cit-title', '#cit-author', '#cit-year', '#cit-source', '#cit-volume', '#cit-issue', '#cit-pages', '#cit-doi', '#cit-url'].forEach(s => {
      const inp = el.querySelector(s);
      if (inp) inp.value = '';
    });
    clearTimeout(previewTimer); // 取消待触发的防抖更新（否则会以空表单覆盖刚生成的预览）
  });

  // 填入示例：一键体验 AI 解析（无需手打）
  el.querySelector('#cit-parse-demo').addEventListener('click', () => {
    const inp = el.querySelector('#cit-parse');
    inp.value = '张伟, 李娜. 大语言模型在教育领域的应用研究[J]. 现代教育技术, 2024, 34(3): 45-52.\n刘洋. 基于深度学习的医学图像分割方法研究[D]. 北京: 清华大学, 2023.';
    inp.focus();
    toast('示例已填入——点「解析并保存」试试', 'ok');
  });

  // AI 解析：AI 结构化 → 规则引擎格式化 → 批量入库
  el.querySelector('#cit-parse-btn').addEventListener('click', async () => {
    const raw = el.querySelector('#cit-parse').value.trim();
    if (!raw) { toast('请先粘贴引用信息', 'err'); return; }
    const btn = el.querySelector('#cit-parse-btn');
    const out = el.querySelector('#cit-parse-out');
    setLoading(btn, true, '解析中…');
    out.classList.remove('filled');
    out.innerHTML = '<span class="placeholder">AI 正在解析引用信息…</span>';
    try {
      const reply = await chat([
        { role: 'system', content: PARSE_SYSTEM },
        { role: 'user', content: raw },
      ], { temperature: 0, signal: abortSignal() });
      let entries;
      try {
        // 容错解析（对齐 litsearch.parseJson）：代码围栏 → 直接解析 → 失败则提取数组子串 + 去尾随逗号 + 解包装对象
        const body = reply.replace(/```json|```/g, '').trim();
        try {
          entries = JSON.parse(body);
        } catch {
          const b = body.indexOf('[');
          const e = body.lastIndexOf(']');
          const jsonText = (b >= 0 && e > b ? body.slice(b, e + 1) : body)
            .replace(/,(\s*[}\]])/g, '$1');
          entries = JSON.parse(jsonText);
        }
        if (!Array.isArray(entries)) {
          for (const k of ['items', 'data', 'list', 'results', 'citations']) {
            if (Array.isArray(entries[k])) { entries = entries[k]; break; }
          }
        }
        if (!Array.isArray(entries)) throw new Error('not array');
      } catch {
        out.innerHTML = `<span class="placeholder">AI 返回格式异常，原始内容如下：</span>\n${escapeHtml(reply)}`;
        toast('解析失败：AI 返回格式异常', 'err');
        return;
      }
      const list = get('citations', []);
      const objs = entries.filter(e => e && typeof e === 'object'); // 防御 AI 返回非对象元素
      if (!objs.length) {
        out.innerHTML = `<span class="placeholder">AI 未解析出文献条目，请检查粘贴内容或稍后重试</span>`;
        toast('未解析到文献条目', 'err');
        return;
      }
      objs.forEach(e => {
        e.id = e.id || crypto.randomUUID?.() || `cit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        Object.assign(e, normalizeCitationEntry(e, prj.referenceStandard));
        e.litNo = nextLitNo(list);
        list.unshift(e);
      });
      set('citations', list);
      out.innerHTML =
        `<span class="sample-tag">已解析 ${objs.length} 条并保存到文献库</span>\n` +
        escapeHtml(objs.map((e, i) => `[${i + 1}] ${e.formatted}`).join('\n'));
      out.classList.add('filled');
      toast(`成功解析并保存 ${objs.length} 条文献`, 'ok');
      refreshLibrary(el); // 解析结果保留在页面上，不整页重渲染
    } catch (e) {
      if (e?.code === 'aborted') return; // 主动取消（切页），不打扰
      out.innerHTML = `<span class="placeholder">❌ ${escapeHtml(e.message)}</span>`;
      toast(e.message, 'err', 3600);
    } finally {
      setLoading(btn, false);
    }
  });

  // 复制全部（按稳定编号排序）
  el.querySelector('#cit-copy-all').addEventListener('click', () => {
    copyText(sortedList().map(c => `[${c.litNo}] ${c.formatted || c.title}`).join('\n'));
  });

  bindListActions(el);
}

export default {
  id: 'citation',
  icon: '📚',
  title: '文献与格式',
  subtitle: 'GB/T 7714 引用格式，一键生成',
  projectScoped: true,
  render,
};
