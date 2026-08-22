// 写作工作台 v2.9：一份完整论文文档（题目/摘要/关键词/各章/参考文献/致谢）
// 左栏目录点击定位到对应位置（不重建编辑器）；正文引用只插入序号 [n]，
// 完整条目在「复制全文 / 排版预览」中按文献库编号自动生成文末参考文献列表
import { toast, copyText, integrityNote, escapeHtml, setLoading } from '../ui.js';
import { chat } from '../api.js';
import { get, set } from '../storage.js';
import { getProject, setCurrentChapter, setChapterProgress, saveProject, addMaterial, removeMaterial } from '../project.js';
import { snapshotChapter, snapshotDoc, getChapterVersions, getDocVersions, getVersion, versionsSize, versionCount, orphanChapters } from '../versions.js';

const SYSTEM = '你是一位资深论文写作导师，帮助中国高校学生完成论文写作。遵守学术诚信：不代替用户完成整篇论文（整篇代写）；基于用户提供的大纲、要点撰写章节初稿草稿属于允许的辅助，但需提醒用户亲自审阅、补充个人观点与数据。改写需保留原意并提醒用户自行核实。回答直接给出结果，不要客套话和多余解释。';

const DRAFT_KEY = 'drafts';
const SECTION_TITLES = ['摘要', '关键词', '参考文献', '致谢'];

// 学位常见字数要求（仅提示参考，不校验；本科 1.5-3 万 / 硕士 3-5 万 / 博士 8-15 万 / 课程论文 5 千-1 万）
const TARGET_RANGE = {
  '本科论文': [15000, 30000],
  '硕士论文': [30000, 50000],
  '博士论文': [80000, 150000],
  '课程论文': [5000, 10000],
};

/** 各章草稿字数合计（与目录 chip 同口径：真实已写内容，不含模板） */
function totalWords(chapters, drafts) {
  return chapters.reduce((sum, c) => sum + wordCount(drafts[c.chapter]?.content), 0);
}

/** 学位目标字数提示（仅提示参考）：未达下限朱砂「距下限还差 X 字」，已达松烟绿「已达下限 ✓」 */
function updateTarget(el, chapters, drafts, degreeType) {
  const tgt = el.querySelector('#wb-target');
  if (!tgt) return;
  const range = TARGET_RANGE[degreeType];
  const total = totalWords(chapters, drafts);
  if (!range || !chapters.length) { tgt.textContent = ''; return; }
  const fmt = n => n.toLocaleString('zh-CN');
  const target = `${fmt(range[0] / 10000)}-${fmt(range[1] / 10000)} 万字`;
  if (total < range[0]) {
    tgt.textContent = `${degreeType}常见 ${target} · 已写 ${fmt(total)} 字，距下限还差 ${fmt(range[0] - total)} 字`;
    tgt.className = 'wb-target warn';
  } else {
    tgt.textContent = `${degreeType}常见 ${target} · 已写 ${fmt(total)} 字，已达下限 ✓`;
    tgt.className = 'wb-target ok';
  }
}

// 中断恢复：页面/模块切换时取消进行中的 AI 请求（防止结果写错位置或静默丢失）
// 注意：tm:navigate 由 document.dispatchEvent 触发且不冒泡，监听必须挂在 document 上
// 模块只加载一次，每次导航后换新 controller，否则后续请求会被立即取消
if (!window.__tmWritingAbort) {
  window.__tmWritingAbort = new AbortController();
  document.addEventListener('tm:navigate', () => {
    window.__tmWritingAbort.abort();
    window.__tmWritingAbort = new AbortController();
  });
}
const writingSignal = () => window.__tmWritingAbort.signal;

// AI 动作上下文：论文题目 + 当前章节——续写/扩写/润色需要主题背景才能写对方向（无题目时退化为通用表述）
const ctxLine = ({ title, chapter }) =>
  `论文《${title || '（未定题）'}》${chapter ? `「${chapter}」章节` : ''}`;

const AI_ACTIONS = [
  {
    id: 'polish', label: '润色', primary: true,
    title: '润色所选文字；未选中时润色当前章节',
    prompt: (t, ctx) => `请将${ctxLine(ctx)}中的以下段落改写为规范的学术表达：保留原意与关键信息，修正口语化、冗余和不严谨的表述。只输出改写后的文字。\n\n${t}`,
    temperature: 0.3, needSelection: false,
  },
  {
    id: 'expand', label: '扩写', primary: false,
    title: '扩写所选文字（需先在编辑器中选中）',
    prompt: (t, ctx) => `请将${ctxLine(ctx)}中的以下文字扩展为论证充分、逻辑严密的学术段落（扩写到原篇幅的 2-3 倍，与论文主题保持一致）。只输出扩展后的文字。\n\n${t}`,
    temperature: 0.6, needSelection: true,
  },
  {
    id: 'paraphrase', label: '降重', primary: false,
    title: '降重改写所选文字；未选中时改写当前章节',
    prompt: (t, ctx) => `请在保留原意的前提下，将${ctxLine(ctx)}中的以下文字重新组织语言表达（合规改写：用于优化表达与理解，请勿用于规避学术诚信检测）。只输出改写后的文字。\n\n${t}`,
    temperature: 0.7, needSelection: false,
  },
  {
    id: 'continue', label: '续写', primary: false,
    title: '基于光标上文续写 300-500 字',
    prompt: (t, ctx) => `以下是${ctxLine(ctx)}草稿的结尾部分，请保持风格、主题与内容连贯，续写 300-500 字。只输出续写的文字。\n\n……${t}`,
    temperature: 0.8, needSelection: false,
  },
];

function wordCount(s) {
  return String(s || '').replace(/\s/g, '').length;
}

// ---------- 版本管理：自动快照判定 ----------

/** 自动快照判定（防抖落盘后调用）：距上档 ≥10 分钟且有变化，或变化 ≥500 字立即留档 */
function maybeSnapshot(chapter, content) {
  if (!chapter) return;
  const list = getChapterVersions(chapter);
  const latest = list[0];
  if (latest && latest.text === content) return;
  if (latest && Date.now() - latest.at < 10 * 60 * 1000) {
    if (Math.abs(wordCount(content) - wordCount(latest.text)) < 500) return;
  }
  snapshotChapter(chapter, content, 'auto', '');
}

/** 版本时间展示：MM/DD HH:mm */
function fmtVersionTime(at) {
  const d = new Date(at);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 版本历史抽屉样式（一次性注入）
(function injectVersionStyles() {
  if (document.getElementById('tm-vd-style')) return;
  const st = document.createElement('style');
  st.id = 'tm-vd-style';
  st.textContent = `
    .vd-mask { position: fixed; inset: 0; background: rgba(24,34,44,.42); z-index: 9998; }
    .vd-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 430px; max-width: 92vw; background: #fff;
      z-index: 9999; display: flex; flex-direction: column; box-shadow: -8px 0 28px rgba(24,34,44,.18);
      font-size: 13px; color: #1F2937; }
    .vd-head { padding: 14px 16px; background: #26303B; color: #fff; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
    .vd-close { background: none; border: none; color: #9AA8B5; font-size: 16px; cursor: pointer; }
    .vd-tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 14px; border-bottom: 1px solid #E8ECEF; }
    .vd-tab { border: 1px solid #D9DEE3; background: #fff; border-radius: 14px; padding: 2px 11px; font-size: 12px; cursor: pointer; color: #3E4C5A; }
    .vd-tab.on { background: #E8F3F7; border-color: #0E6E8C; color: #0E6E8C; font-weight: 600; }
    .vd-list { flex: 1; overflow-y: auto; padding: 8px 0; }
    .vd-card { margin: 6px 12px; border: 1px solid #E8ECEF; border-radius: 8px; padding: 9px 12px; }
    .vd-card .row1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .vd-time { font-weight: 700; }
    .vd-badge { font-size: 11px; border-radius: 3px; padding: 0 6px; }
    .vd-badge.auto { background: #E9F1EB; color: #477A56; border: 1px solid #C5D9CB; }
    .vd-badge.manual { background: #E8F3F7; color: #0E6E8C; border: 1px solid #BBD8E4; }
    .vd-badge.milestone { background: #FBF4E6; color: #B7791F; border: 1px solid #E8D5A8; }
    .vd-words { color: #6B7A8A; font-size: 12px; margin-left: auto; }
    .vd-label { color: #6B7A8A; font-size: 12px; }
    .vd-ops { display: flex; gap: 6px; margin-top: 8px; }
    .vd-ops button { border: 1px solid #D9DEE3; background: #fff; border-radius: 4px; padding: 2px 10px; font-size: 12px; cursor: pointer; color: #1F2937; }
    .vd-ops button.primary { border-color: #0E6E8C; color: #0E6E8C; }
    .vd-preview { margin-top: 8px; max-height: 220px; overflow-y: auto; background: #FAFBFD; border: 1px solid #E8ECEF; border-radius: 5px; padding: 8px 10px; font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; color: #3E4C5A; }
    .vd-empty { padding: 28px 20px; text-align: center; color: #9AA3AB; }
    .vd-foot { border-top: 1px solid #E8ECEF; padding: 9px 14px; color: #6B7A8A; font-size: 12px; display: flex; justify-content: space-between; align-items: center; }
    .vd-foot.warn { color: #C03B2D; font-weight: 600; }`;
  document.head.appendChild(st);
})();

/** 以「用户编辑」方式替换区间文本：进入浏览器原生撤销栈，Ctrl+Z 可撤销 AI 改动 */
function applyEdit(ta, text, start, end) {
  ta.focus();
  ta.setSelectionRange(start, end);
  document.execCommand('insertText', false, text);
  const pos = start + text.length;
  ta.selectionStart = ta.selectionEnd = pos;
  ta.dispatchEvent(new Event('input'));
}

// ---------- 完整论文文档：构建 / 解析 / 定位 ----------

function isChapterLine(t) {
  return /^(第[一二三四五六七八九十百\d]+章[　\s]*.*)$/.test(t);
}

/** 「第X章」→ 两位等宽编号（01、02…），用于目录的数字章标 */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function chapterNo(name) {
  const m = /第([一二三四五六七八九十\d]+)章/.exec(name || '');
  if (!m) return '';
  const s = m[1];
  if (/^\d+$/.test(s)) return String(Number(s)).padStart(2, '0');
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    return String((a ? CN_NUM[a] : 1) * 10 + (b ? CN_NUM[b] || 0 : 0)).padStart(2, '0');
  }
  return String(CN_NUM[s] || '').padStart(2, '0');
}

/** 把结构化数据拼成完整论文文档（参考文献为自动生成区占位） */
export function buildDocument(p, drafts) {
  const lines = [];
  if (p.title) { lines.push(p.title); lines.push(''); }
  lines.push('摘要'); lines.push(p.abstract || '（在此撰写摘要，或将右栏生成的摘要粘贴过来）');
  lines.push(''); lines.push('关键词'); lines.push(p.keywords || '（3-5 个关键词，用分号分隔）');
  (p.outline || []).forEach(c => {
    lines.push(''); lines.push(c.chapter); lines.push(drafts[c.chapter]?.content || '');
  });
  lines.push(''); lines.push('参考文献');
  lines.push('（自动生成：正文引用的 [n] 将在「复制全文 / 排版预览」中按文献库列出）');
  lines.push(''); lines.push('致谢'); lines.push(p.acknowledgments || '');
  return lines.join('\n');
}

/** 解析文档文本回结构化数据 */
export function parseDocument(text) {
  const sections = { title: '', abstract: '', keywords: '', chapters: [], acknowledgments: '' };
  let cur = { name: '__head__', lines: [] };
  const flush = () => {
    const content = cur.lines.join('\n').trim();
    if (cur.name === '__head__') sections.title = content.split('\n')[0] || '';
    else if (cur.name === '摘要') sections.abstract = content;
    else if (cur.name === '关键词') sections.keywords = content;
    else if (cur.name === '致谢') sections.acknowledgments = content;
    else if (cur.name === '参考文献') { /* 自动生成区，忽略手动内容 */ }
    else if (cur.name) sections.chapters.push({ name: cur.name, content });
  };
  text.split('\n').forEach(line => {
    const t = line.trim();
    if (isChapterLine(t) || SECTION_TITLES.includes(t)) { flush(); cur = { name: t, lines: [] }; }
    else cur.lines.push(line);
  });
  flush();
  return sections;
}

/** 章节正文替换范围：标题行之后的区间（AI 输出不含章节标题，替换必须保留标题行，否则 parseDocument 丢章） */
function chapterBodyRange(text, range) {
  const nl = text.indexOf('\n', range.start);
  return { start: nl >= 0 ? nl + 1 : range.start, end: range.end };
}

/** 查找某个区块（章节/摘要等）标题行在全文中的字符范围 */
function findChapterRange(text, chapter) {
  const lines = text.split('\n');
  let pos = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const isBlockStart = isChapterLine(t) || SECTION_TITLES.includes(t);
    if (isBlockStart) {
      if (start >= 0) return { start, end: pos };
      if (t === chapter) start = pos;
    }
    pos += lines[i].length + 1;
  }
  return { start, end: start >= 0 ? text.length : -1 };
}

/** 保存：解析文档 → 同步草稿/章节结构/摘要关键词致谢 */
function persistDocument(text, p) {
  const s = parseDocument(text);
  const drafts = get(DRAFT_KEY, {});
  s.chapters.forEach(c => { drafts[c.name] = { content: c.content, updatedAt: Date.now() }; });
  set(DRAFT_KEY, drafts);
  const oldNames = (p.outline || []).map(c => c.chapter);
  const newNames = s.chapters.map(c => c.name);
  const same = oldNames.length === newNames.length && oldNames.every((n, i) => n === newNames[i]);
  const lost = oldNames.filter(n => !newNames.includes(n));
  // 防误操作（结构保护）：
  // 1) 解析不到任何章节（如全选删除后空白文档）→ 不覆盖大纲与进度
  // 2) 章节部分丢失（标题行被误改/误删，如「第一章 绪论」前误打字吞并标题行）→ 保留原大纲结构
  //    ——标题行是结构锚点（R10 教训），丢失章节的草稿内容仍在 drafts 中不会丢
  if (!same && newNames.length > 0 && lost.length === 0) {
    const progress = {};
    newNames.forEach(n => { progress[n] = p.chapterProgress[n] || '未开始'; });
    saveProject({ outline: newNames.map(n => ({ chapter: n })), chapterProgress: progress });
  } else if (!same && lost.length > 0) {
    toast(`检测到章节「${lost.slice(0, 2).join('」「')}${lost.length > 2 ? `」等 ${lost.length} 章` : '」'}疑似丢失，已保留原大纲结构`, 'err', 4200);
  }
  saveProject({
    title: s.title || p.title,
    abstract: s.abstract,
    keywords: s.keywords,
    acknowledgments: s.acknowledgments,
  });
}

/** 收集正文中引用的序号并按文献库生成参考文献列表
 *  返回 { refs, missing }：missing 为正文引用了但文献库不存在的编号（此前静默丢弃，用户无感知） */
function buildRefList(text, citations) {
  const nums = new Set();
  (text.match(/\[(\d+)\]/g) || []).forEach(m => nums.add(Number(m.slice(1, -1))));
  const found = new Set(citations.map(c => c.litNo));
  const missing = [...nums].filter(n => !found.has(n)).sort((a, b) => a - b);
  const refs = [...nums].sort((a, b) => a - b)
    .map(n => {
      const c = citations.find(x => x.litNo === n);
      return c ? `[${n}] ${c.formatted || c.title}` : null;
    })
    .filter(Boolean)
    .join('\n');
  return { refs, missing };
}

/** 复制全文：题目+摘要+关键词+各章+参考文献（自动）+致谢 */
function fullText(text, citations) {
  const s = parseDocument(text);
  const lines = [];
  if (s.title) { lines.push(s.title, ''); }
  lines.push('摘要', s.abstract || '', '', '关键词', s.keywords || '');
  s.chapters.forEach(c => { lines.push('', c.name, c.content); });
  const { refs } = buildRefList(text, citations);
  lines.push('', '参考文献', refs || '（暂无引用）', '', '致谢', s.acknowledgments || '');
  return lines.join('\n');
}

/** 排版预览：生成打印级 HTML 并在新窗口打开（可另存为 PDF） */
function openPrintPreview(text, citations, p) {
  const s = parseDocument(text);
  const paras = c => (c || '').split('\n\n').filter(x => x.trim())
    .map(x => `<p>${escapeHtml(x)}</p>`).join('') || '<p class="hint">（暂无内容）</p>';
  const { refs, missing } = buildRefList(text, citations);
  const refsHtml = refs
    ? refs.split('\n').map(r => `<p class="ref">${escapeHtml(r)}</p>`).join('')
    : '<p class="hint">（暂无引用）</p>';
  // 缺号提示条：屏幕可见自查、打印时隐藏（不污染 PDF 成品）
  const missingNote = missing.length
    ? `<p class="missing-note">⚠ 正文引用了 [${missing.join('][')}]，但文献库中未找到对应条目，未列入参考文献——请到「文献与格式」补齐或修正正文引用</p>`
    : '';
  const degreeLine = p.degreeType ? `<p class="degree">（${escapeHtml(p.degreeType)}）</p>` : '';
  const body = `
    <h1 class="title">${escapeHtml(s.title || p.title || '（未命名论文）')}</h1>
    ${degreeLine}
    <h2 class="sec">摘要</h2>${paras(s.abstract)}
    <h2 class="sec">关键词</h2><p>${escapeHtml(s.keywords || '（未写关键词）')}</p>
    ${s.chapters.map(c => `<h2 class="sec">${escapeHtml(c.name)}</h2>${paras(c.content)}`).join('')}
    <h2 class="sec">参考文献</h2>${refsHtml}${missingNote}
    <h2 class="sec">致谢</h2>${paras(s.acknowledgments)}`;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(s.title || '论文')} · 排版预览</title>
  <style>
    body { max-width: 760px; margin: 44px auto; padding: 0 26px 60px; font-family: "Songti SC", STSong, SimSun, serif; line-height: 1.95; color: #26303B; background: #F6F5F1; }
    .title { text-align: center; font-size: 22px; font-weight: 700; margin: 0 0 4px; }
    .degree { text-align: center; color: #64707D; font-size: 13px; margin: 0 0 34px; font-family: -apple-system, "PingFang SC", sans-serif; }
    .sec { font-size: 17px; margin: 30px 0 12px; font-weight: 700; border-bottom: 1px solid #E4E1D8; padding-bottom: 6px; }
    .sec::before { content: ''; display: inline-block; width: 8px; height: 8px; background: #C03B2D; margin-right: 9px; }
    p { text-indent: 2em; margin: 6px 0; font-size: 15px; }
    p.ref { text-indent: -2em; padding-left: 2em; font-size: 12.5px; line-height: 1.8; color: #4A5560; }
    .hint { color: #9AA3AB; text-indent: 0; }
    .missing-note { color: #C03B2D; font-size: 12.5px; text-indent: 0; background: #FBF1EF; border: 1px solid #E8C8C2; padding: 8px 12px; border-radius: 4px; margin-top: 10px; }
    .print-foot { margin-top: 40px; border-top: 1px solid #E4E1D8; padding-top: 10px; font-size: 11px; color: #9AA3AB; text-align: center; font-family: -apple-system, "PingFang SC", sans-serif; text-indent: 0; }
    .print-tip { position: fixed; top: 14px; right: 16px; background: #2F4F66; color: #fff; padding: 8px 14px; border-radius: 5px; font-size: 13px; font-family: -apple-system, "PingFang SC", sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.18); }
    @media print { body { margin: 0; background: #fff; } .print-tip { display: none; } .missing-note { display: none; } }
  </style></head><body><div class="print-tip">Ctrl/Cmd+P 打印或另存为 PDF</div>${body}<p class="print-foot">PaperPilot · 论文写作助手 · AI 辅助生成的草稿请逐段人工审核</p></body></html>`;
  const win = window.open('', '_blank');
  if (!win) { toast('浏览器拦截了新窗口，请允许弹窗后重试', 'err'); return; }
  win.document.write(html);
  win.document.close();
}

/** 页眉行：正在写的章节 + 状态印章 */
function currentHeaderHtml(name, st) {
  return `<span class="cur-title">正在写：<b>${escapeHtml(name)}</b></span>${
    st === '已完成' ? '<span class="seal" style="margin-left:8px">已完成</span>' : ''
  }<span class="cur-note">文档含题目 / 摘要 / 关键词 / 各章 / 参考文献 / 致谢</span>`;
}

// ---------- 渲染 ----------

function render(el) {
  const p = getProject();
  const chapters = p.outline || [];
  const drafts = get(DRAFT_KEY, {});
  const current = (p.currentChapter && chapters.some(c => c.chapter === p.currentChapter))
    ? p.currentChapter
    : (chapters.length ? chapters[0].chapter : '');
  const doc = buildDocument(p, drafts);

  el.innerHTML = `
    <div class="card" style="padding:0;overflow:hidden">
      <div class="workbench">
        <aside class="wb-left">
          <h3><span class="mark"></span>论文目录</h3>
          <p class="desc" style="margin-bottom:10px">${chapters.length ? '点击章节定位到文档对应位置，文档是一份连续完整的论文' : '还没有大纲'}</p>
          ${chapters.length ? `
            <div class="chapter-list">
              ${chapters.map(c => {
                const st = p.chapterProgress[c.chapter] || '未开始';
                const dotCls = st === '已完成' ? 'st-done' : st === '进行中' ? 'st-doing' : 'st-none';
                const wc = wordCount(drafts[c.chapter]?.content);
                return `<button class="chapter-item ${c.chapter === current ? 'active' : ''}" data-ch="${escapeHtml(c.chapter)}">
                  <span class="ch-no">${chapterNo(c.chapter)}</span>
                  <span class="dot ${dotCls}" title="${st}"></span>
                  <span class="name" title="${escapeHtml(c.chapter)}">${escapeHtml(c.chapter)}</span>
                  ${wc ? `<span class="chip">${wc}字</span>` : ''}
                </button>`;
              }).join('')}
            </div>` : `
            <p class="desc">先在「选题与大纲」生成并采用大纲，这里就能按章节写作</p>
            <button class="btn btn-ghost btn-sm" data-nav="topic">去生成大纲 →</button>`}
        </aside>

        <section class="wb-center">
          <div class="wb-current">${current
            ? `<span id="wb-cur-wrap">${currentHeaderHtml(current, p.chapterProgress[current] || '未开始')}</span><button class="btn btn-ghost btn-sm" id="wb-done-inline" ${(p.chapterProgress[current] || '') === '已完成' ? 'style="display:none"' : ''}>标记本章完成</button>`
            : '<span class="cur-title">在左侧目录选择章节</span>'}</div>
          <div class="wb-toolbar">
            <button class="btn btn-ai-solid btn-sm" id="wb-draft-toggle" title="基于大纲与要点生成本章初稿">生成初稿</button>
            ${AI_ACTIONS.map(a => `<button class="btn btn-ai btn-sm" data-ai="${a.id}" title="${a.title}">${a.label}</button>`).join('')}
            <span class="wb-sep"></span>
            <button class="btn btn-ghost btn-sm" id="wb-undo" title="撤销上一步（触屏设备无需快捷键；键盘可用 Ctrl+Z）">↶ 撤销</button>
            <button class="btn btn-ghost btn-sm" id="wb-redo" title="重做（触屏设备无需快捷键；键盘可用 Ctrl+Y）">↷ 重做</button>
            <span class="wb-sep"></span>
            <button class="btn btn-ghost btn-sm" id="wb-version" title="查看各章节历史版本：可预览、恢复到任意一档（跨会话持久）">⏱ 历史版本</button>
            <button class="btn btn-ghost btn-sm" id="wb-version-save" title="把当前章节存为一个版本（可写备注，重要节点主动留档）">＋ 存为版本</button>
            <span class="wb-sep"></span>
            <button class="btn btn-ghost btn-sm" id="wb-copy-all" title="复制全文（含自动生成的参考文献列表）">复制全文</button>
            <button class="btn btn-ghost btn-sm" id="wb-download" title="下载全文为 Markdown 文件（含自动生成的参考文献列表）">下载全文</button>
            <button class="btn btn-ghost btn-sm" id="wb-preview" title="生成排版后的论文页面，可打印/另存 PDF">排版预览</button>
          </div>
          <div class="sel-bar" id="wb-sel-bar" style="display:none">
            <span class="sel-count" id="wb-sel-count">已选中 0 字</span>
            <span class="sel-label">对所选文字：</span>
            <button class="btn btn-ai btn-sm" data-ai="polish">润色</button>
            <button class="btn btn-ai btn-sm" data-ai="expand">扩写</button>
            <button class="btn btn-ai btn-sm" data-ai="paraphrase">降重</button>
          </div>
          <div class="card draft-form" id="draft-form" style="display:none;margin-bottom:12px;padding:16px 18px">
            <h2 style="font-size:14px;display:flex;align-items:center;gap:10px">生成当前章初稿 <span class="seal seal-red">AI 草稿</span></h2>
            <p class="desc" style="margin-bottom:8px">AI 将基于你的论文题目、本章大纲与要点撰写草稿，写入本章位置后请逐段审阅修改</p>
            <label class="field-label">本章要点 / 研究内容（可选，越具体越好）</label>
            <textarea id="draft-points" rows="3" placeholder="例如：先介绍注意力机制的原理，再结合医疗影像小样本分割说明其应用价值与不足"></textarea>
            <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
              <select id="draft-len" style="width:auto">
                <option value="800">约 800 字</option>
                <option value="1500" selected>约 1500 字</option>
                <option value="2500">约 2500 字</option>
              </select>
              <button class="btn btn-ai-solid btn-sm" id="draft-go">生成并写入本章</button>
              <button class="btn btn-ghost btn-sm" id="draft-cancel">取消</button>
            </div>
            ${integrityNote()}
          </div>
          <textarea id="wb-editor" class="paper-sheet" spellcheck="false" placeholder="完整论文文档将在这里展开：题目、摘要、关键词、各章、参考文献、致谢。左侧目录可定位到任意位置。"></textarea>
          <div class="wb-meta">
            <span id="wb-count">全文字数 ${wordCount(doc)}</span>
            <span id="wb-target" class="wb-target"></span>
            <span id="wb-saved">草稿将自动保存在本地</span>
            <span class="hint-plain">选中文字后使用上方 AI 动作 · <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> 撤销</span>
          </div>
          ${integrityNote()}
        </section>

        <aside class="wb-right"></aside>
      </div>
    </div>`;

  const ta = el.querySelector('#wb-editor');
  ta.value = doc;

  renderRight(el);

  // —— 目录：点击定位（不重建编辑器，光标不丢） ——
  el.querySelectorAll('[data-ch]').forEach(b =>
    b.addEventListener('click', () => {
      const prevCur = getProject().currentChapter || current;
      persistDocument(ta.value, getProject());
      // 切换章节：离开前若距上档 ≥1 分钟且有变化，补一个里程碑档（防长写作无档）
      const prevContent = get(DRAFT_KEY, {})[prevCur]?.content || '';
      const prevList = getChapterVersions(prevCur);
      if (prevCur !== b.dataset.ch && prevContent
        && prevList[0] && prevList[0].text !== prevContent
        && Date.now() - prevList[0].at >= 60 * 1000) {
        snapshotChapter(prevCur, prevContent, 'milestone', '');
      }
      setCurrentChapter(b.dataset.ch);
      el.querySelectorAll('.chapter-item').forEach(x =>
        x.classList.toggle('active', x.dataset.ch === b.dataset.ch));
      const st = getProject().chapterProgress[b.dataset.ch] || '未开始';
      el.querySelector('#wb-cur-wrap').innerHTML = currentHeaderHtml(b.dataset.ch, st);
      const doneInline = el.querySelector('#wb-done-inline');
      if (doneInline) doneInline.style.display = st === '已完成' ? 'none' : '';
      const r = findChapterRange(ta.value, b.dataset.ch);
      if (r.start >= 0) {
        ta.focus();
        ta.setSelectionRange(r.start, r.start);
      }
      b.classList.add('flash');
      setTimeout(() => b.classList.remove('flash'), 1000);
    }));

  const doneBtn = el.querySelector('#wb-done-inline');
  if (doneBtn) {
    doneBtn.addEventListener('click', () => {
      const cur = getProject().currentChapter || current;
      persistDocument(ta.value, getProject());
      // 里程碑快照：本章留档 + 整文档留档（章节完成 = 全文自然检查点）
      const contentDone = get(DRAFT_KEY, {})[cur]?.content || '';
      if (contentDone) {
        snapshotChapter(cur, contentDone, 'milestone', '本章完成');
        snapshotDoc(ta.value, `「${cur}」完成`);
      }
      setChapterProgress(cur, '已完成');
      toast(`「${cur}」已标记完成，去写下一章吧`, 'ok');
      render(el);
    });
  }

  el.querySelectorAll('[data-nav]').forEach(b =>
    b.addEventListener('click', () =>
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: b.dataset.nav }))));

  // —— 编辑器：字数 + 防抖自动保存（保存时同步章节结构/摘要等） ——
  const updateMeta = () => {
    el.querySelector('#wb-count').textContent = `全文字数 ${wordCount(ta.value)}`;
    const prj = getProject();
    updateTarget(el, prj.outline || [], get(DRAFT_KEY, {}), prj.degreeType);
  };
  updateMeta(); // 初始渲染即填充目标字数提示（模板内 #wb-target 初始为空）
  let timer = null;
  ta.addEventListener('input', () => {
    updateMeta();
    const cur = getProject().currentChapter || current;
    const prog = getProject().chapterProgress;
    if (cur && prog[cur] === '未开始') setChapterProgress(cur, '进行中');
    clearTimeout(timer);
    timer = setTimeout(() => {
      persistDocument(ta.value, getProject());
      const prjSnap = getProject();
      maybeSnapshot(prjSnap.currentChapter || current, get(DRAFT_KEY, {})[prjSnap.currentChapter || current]?.content || '');
      const saved = el.querySelector('#wb-saved'); // 模块可能已被卸载，需判空
      if (saved) saved.textContent = `已保存 ${new Date().toLocaleTimeString('zh-CN')}`;
      const prj = getProject();
      updateTarget(el, prj.outline || [], get(DRAFT_KEY, {}), prj.degreeType); // 落盘后按最新草稿刷新目标
      const right = document.querySelector('.wb-right');
      if (right) renderCits(right); // 右栏引用「已引用×N」计数随正文刷新
    }, 400);
  });

  // —— 选区快捷操作条：选中文字后浮现（Notion AI 式） ——
  const selBar = el.querySelector('#wb-sel-bar');
  const selCount = el.querySelector('#wb-sel-count');
  const updateSelBar = () => {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (end > start) {
      selCount.textContent = `已选中 ${wordCount(ta.value.slice(start, end))} 字`;
      selBar.style.display = '';
    } else {
      selBar.style.display = 'none';
    }
  };
  ['select', 'mouseup', 'keyup', 'focus'].forEach(ev => ta.addEventListener(ev, updateSelBar));

  // —— Ctrl/Cmd+S：立即保存并刷新状态指示 ——
  ta.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      persistDocument(ta.value, getProject());
      const prjC = getProject();
      const curC = prjC.currentChapter || current;
      const contentC = get(DRAFT_KEY, {})[curC]?.content || '';
      if (contentC) snapshotChapter(curC, contentC, 'milestone', ''); // Ctrl+S 即用户主动留档时刻
      const saved = el.querySelector('#wb-saved');
      if (saved) saved.textContent = `已保存 ${new Date().toLocaleTimeString('zh-CN')}（Ctrl+S）`;
      toast('已保存', 'ok', 1200);
    }
  });

  // —— AI 动作：作用于选中文字 ——
  function runAction(key, btn) {
    const act = AI_ACTIONS.find(a => a.id === key);
    const selStart = ta.selectionStart;
    const selEnd = ta.selectionEnd;
    const selText = ta.value.slice(selStart, selEnd);
    let target;
    let rangeStart;
    let rangeEnd;
    let scopeMsg = '所选文字';
    let wholeChapter = false; // 整章替换：需保证章尾换行，防止与下一区块标题粘连（粘连会让 parseDocument 丢章）
    if (key === 'continue') {
      if (!ta.value.trim()) { toast('先写一些内容再续写', 'err'); return; }
      target = ta.value.slice(Math.max(0, selEnd - 500), selEnd);
      rangeStart = selEnd;
      rangeEnd = selEnd;
      scopeMsg = '光标处';
    } else if (selText) {
      target = selText;
      rangeStart = selStart;
      rangeEnd = selEnd;
    } else if (act.needSelection) {
      toast('请先在编辑器中选中要扩写的文字', 'err');
      return;
    } else if (!ta.value.trim()) {
      toast('编辑器还没有内容', 'err');
      return;
    } else {
      // 防误操作：未选中时不改写全文，只作用于当前章节（与目录高亮一致）
      const cur = getProject().currentChapter || current;
      const r = cur ? findChapterRange(ta.value, cur) : { start: -1, end: -1 };
      if (r.start >= 0) {
        const body = chapterBodyRange(ta.value, r); // 替换区间：标题行之后（AI 输出不含标题行）
        const chapterText = ta.value.slice(body.start, body.end).trim();
        if (!chapterText) { toast(`「${cur}」还没有内容，先写一些或选中文字再操作`, 'err'); return; }
        target = ta.value.slice(r.start, body.end).trim(); // 上下文含标题行，帮助 AI 理解章节
        rangeStart = body.start;
        rangeEnd = body.end;
        scopeMsg = `「${cur}」整章`;
        wholeChapter = true;
      } else {
        target = ta.value;
        rangeStart = 0;
        rangeEnd = ta.value.length;
        scopeMsg = '全文';
      }
    }
    setLoading(btn, true, '生成中…');
    chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: act.prompt(target, { title: getProject().title, chapter: current }) },
    ], { temperature: act.temperature, signal: writingSignal() })
      .then(reply => {
        if (!ta.isConnected) { toast('AI 已完成，但页面已离开，未写入编辑器。返回后重新操作即可', 'err', 3600); return; }
        if (!reply.trim()) { toast('AI 返回内容为空，请重试', 'err'); return; }
        // 整章替换补章尾换行：findChapterRange 的 end 是下一区块标题行起点，替换文本必须保留分隔
        applyEdit(ta, wholeChapter ? reply.trimEnd() + '\n' : reply, rangeStart, rangeEnd);
        toast(`已应用到${scopeMsg}（可用 Ctrl+Z 撤销）`, 'ok');
      })
      .catch(e => {
        if (e?.code === 'aborted') return; // 主动取消（切页），不打扰
        toast(e.message, 'err', 3600);
      })
      .finally(() => setLoading(btn, false));
  }
  el.querySelectorAll('[data-ai]').forEach(b =>
    b.addEventListener('click', () => runAction(b.dataset.ai, b)));

  // —— 生成初稿：写入当前章节范围 ——
  const draftForm = el.querySelector('#draft-form');
  el.querySelector('#wb-draft-toggle').addEventListener('click', () => {
    draftForm.style.display = draftForm.style.display === 'none' ? 'block' : 'none';
    if (draftForm.style.display !== 'none') {
      const pts = el.querySelector('#draft-points');
      if (pts) setTimeout(() => pts.focus(), 50); // 打开即聚焦，直接输入要点
    }
  });
  el.querySelector('#draft-cancel').addEventListener('click', () => {
    draftForm.style.display = 'none';
  });
  el.querySelector('#draft-go').addEventListener('click', async () => {
    const cur = getProject().currentChapter || current;
    if (!cur) { toast('请先在左侧目录选择章节', 'err'); return; }
    const range = findChapterRange(ta.value, cur);
    if (range.start < 0) { toast('未在文档中找到该章节', 'err'); return; }
    const body = chapterBodyRange(ta.value, range); // 替换区间：标题行之后（初稿输出不含章节标题）
    const chapterText = ta.value.slice(body.start, body.end).trim();
    if (chapterText && !confirm(`本章已有内容（约 ${wordCount(chapterText)} 字），生成初稿将替换本章内容。继续吗？`)) return;
    const points = el.querySelector('#draft-points').value.trim();
    const len = el.querySelector('#draft-len').value;
    const btn = el.querySelector('#draft-go');
    setLoading(btn, true, '生成中…');
    try {
      const reply = await chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `请为论文《${p.title || '（暂未定题）'}》的「${cur}」撰写初稿草稿（${p.degreeType || '学位类型未设定'}，${len}字左右）。\n本章要点/研究内容：${points || '根据章节标题自行合理展开，注意与论文主题一致'}\n要求：学术语言规范、逻辑连贯、适当分段；只输出正文草稿，不要小标题与解释。` },
      ], { temperature: 0.7, signal: writingSignal() });
      if (!ta.isConnected) { toast('AI 已完成，但页面已离开，未写入编辑器。返回后重新生成即可', 'err', 3600); return; }
      if (!reply.trim()) { toast('AI 返回内容为空，请重试', 'err'); return; }
      // 整章替换补章尾换行（同上：防下一区块标题粘连）
      applyEdit(ta, reply.trimEnd() + '\n', body.start, body.end);
      draftForm.style.display = 'none';
      toast('初稿已写入本章——请逐段审阅修改（可用 Ctrl+Z 撤销）', 'ok');
    } catch (e) {
      if (e?.code === 'aborted') return; // 主动取消（切页），不打扰
      toast(e.message, 'err', 3600);
    } finally {
      setLoading(btn, false);
    }
  });

  // —— 复制全文 / 排版预览 ——
  // 触屏撤销/重做：execCommand('undo'/'redo') 进入与 Ctrl+Z/Y 相同的原生撤销栈（R30 验证路径）
  el.querySelector('#wb-undo').addEventListener('click', () => {
    const ed = document.getElementById('wb-editor');
    if (!ed) return;
    ed.focus();
    document.execCommand('undo');
    ed.dispatchEvent(new Event('input'));
    toast('已撤销上一步', 'ok', 1500);
  });
  el.querySelector('#wb-redo').addEventListener('click', () => {
    const ed = document.getElementById('wb-editor');
    if (!ed) return;
    ed.focus();
    document.execCommand('redo');
    ed.dispatchEvent(new Event('input'));
    toast('已重做', 'ok', 1500);
  });

  // —— 版本管理：存为版本 / 历史抽屉（恢复前自动存档，恢复走原生撤销栈可反悔） ——
  const doRestoreChapter = (chapter, id) => {
    const v = getVersion(chapter, id);
    if (!v) { toast('该版本已被容量淘汰，无法恢复', 'err'); return false; }
    const range = findChapterRange(ta.value, chapter);
    if (range.start < 0) { toast('文档中未找到该章节', 'err'); return false; }
    const body = chapterBodyRange(ta.value, range);
    const curContent = ta.value.slice(body.start, body.end);
    if (curContent === v.text) { toast('该版本与当前内容一致，无需恢复', 'err'); return false; }
    if (!confirm(`将用 ${fmtVersionTime(v.at)} 的版本覆盖本章当前内容。\n当前内容会先自动存档，恢复后仍可 Ctrl+Z 退回。继续吗？`)) return false;
    snapshotChapter(chapter, curContent, 'manual', '恢复前自动存档');
    applyEdit(ta, v.text.trimEnd() + '\n', body.start, body.end); // 补章尾换行：防与下一区块标题粘连丢章
    toast(`已恢复 ${fmtVersionTime(v.at)} 的版本（Ctrl+Z 可退回）`, 'ok');
    return true;
  };
  const doRestoreDoc = id => {
    const v = getDocVersions().find(x => x.id === id);
    if (!v) { toast('该版本已被容量淘汰，无法恢复', 'err'); return false; }
    if (ta.value === v.text) { toast('该版本与当前内容一致，无需恢复', 'err'); return false; }
    if (!confirm(`将用 ${fmtVersionTime(v.at)} 的整文档版本覆盖当前全文。\n当前内容会先存档（各章 + 全文里程碑），恢复后仍可 Ctrl+Z 退回。继续吗？`)) return false;
    const prjD = getProject();
    const draftsD = get(DRAFT_KEY, {});
    (prjD.outline || []).forEach(c => {
      const c2 = draftsD[c.chapter]?.content;
      if (c2) snapshotChapter(c.chapter, c2, 'manual', '恢复前自动存档');
    });
    snapshotDoc(ta.value, '恢复前自动存档');
    applyEdit(ta, v.text, 0, ta.value.length);
    toast(`已恢复 ${fmtVersionTime(v.at)} 的整文档版本（Ctrl+Z 可退回）`, 'ok');
    return true;
  };
  const doRestoreOrphan = (chapter, id) => {
    const v = getVersion(chapter, id);
    if (!v) { toast('该版本已被容量淘汰', 'err'); return false; }
    addMaterial({ type: '📄 版本存档', title: `${chapter}（${fmtVersionTime(v.at)}）`, content: v.text });
    toast('已转存到素材库（右栏可插入）', 'ok');
    return true;
  };
  const V_BADGE = { auto: ['自动', 'auto'], manual: ['手动', 'manual'], milestone: ['里程碑', 'milestone'] };
  const cardHtml = (type, name, v, openPre) => {
    const [badgeTxt, badgeCls] = V_BADGE[v.src] || [v.src, 'auto'];
    const opLabel = type === 'orphan' ? '转存素材库' : '恢复';
    return `<div class="vd-card">
      <div class="row1">
        <span class="vd-time">${fmtVersionTime(v.at)}</span>
        <span class="vd-badge ${badgeCls}">${badgeTxt}</span>
        ${v.label ? `<span class="vd-label">${escapeHtml(v.label)}</span>` : ''}
        <span class="vd-words">${wordCount(v.text).toLocaleString('zh-CN')} 字</span>
      </div>
      <div class="vd-ops">
        <button type="button" data-act="preview" data-id="${v.id}">${openPre ? '收起' : '预览'}</button>
        <button type="button" class="primary" data-act="restore" data-id="${v.id}" data-type="${type}" data-name="${escapeHtml(name)}">${opLabel}</button>
      </div>
      ${openPre ? `<div class="vd-preview">${escapeHtml(v.text || '（空）')}</div>` : ''}
    </div>`;
  };
  el.querySelector('#wb-version').addEventListener('click', () => {
    if (document.querySelector('.vd-mask')) return; // 已打开
    const outline = (getProject().outline || []).map(c => c.chapter);
    const orphans = orphanChapters(outline);
    const tabs = [
      ...outline.filter(n => getChapterVersions(n).length).map(n => ({ type: 'chapter', name: n, label: n })),
      ...(getDocVersions().length ? [{ type: 'doc', name: '', label: '全文里程碑' }] : []),
      ...(orphans.length ? [{ type: 'orphan', name: '', label: `其他存档 ${orphans.length}` }] : []),
    ];
    const state = { tab: tabs[0] || null, openPre: null };
    const mask = document.createElement('div');
    mask.className = 'vd-mask';
    const panel = document.createElement('div');
    panel.className = 'vd-panel';
    mask.appendChild(panel);
    document.body.appendChild(mask);
    const paint = () => {
      if (!tabs.length) {
        panel.innerHTML = `<div class="vd-head"><span>版本历史</span><button type="button" class="vd-close" data-act="close">✕</button></div>
          <div class="vd-list"><div class="vd-empty">还没有版本记录<br>写作时自动留档，也可点工具栏「＋ 存为版本」手动保存</div></div>
          <div class="vd-foot"><span>版本占用 0 KB / 上限 1.2 MB</span></div>`;
        return;
      }
      const t = state.tab;
      // 孤儿章节跨章聚合：list 元素为 { chapter, v }，卡片需带上来源章节名（转存素材库按章标注）
      const list = t.type === 'doc' ? getDocVersions()
        : t.type === 'orphan' ? orphans.flatMap(n => getChapterVersions(n).map(v => ({ chapter: n, v })))
        : getChapterVersions(t.name);
      const size = versionsSize();
      const kb = Math.round(size / 1024);
      const warn = size > 900 * 1024;
      panel.innerHTML = `<div class="vd-head"><span>版本历史</span><button type="button" class="vd-close" data-act="close">✕</button></div>
        <div class="vd-tabs">${tabs.map(x => `<button type="button" class="vd-tab ${x === t ? 'on' : ''}" data-tab="${x.type}::${escapeHtml(x.name)}">${escapeHtml(x.label)}</button>`).join('')}</div>
        <div class="vd-list">${list.length
          ? (t.type === 'orphan'
              ? list.map(x => cardHtml('orphan', x.chapter, x.v, state.openPre === x.v.id)).join('')
              : list.map(v => cardHtml(t.type, t.name, v, state.openPre === v.id)).join(''))
          : '<div class="vd-empty">该分组暂无版本</div>'}</div>
        <div class="vd-foot ${warn ? 'warn' : ''}"><span>版本占用 ${kb} KB / 上限 1.2 MB${warn ? ' · 建议到「设置」导出备份' : ''}</span><span>${versionCount()} 份</span></div>`;
    };
    panel.addEventListener('click', e => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) {
        const [type, name] = tabBtn.dataset.tab.split('::');
        state.tab = tabs.find(x => x.type === type && x.name === name) || state.tab;
        state.openPre = null;
        paint();
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'close') { mask.remove(); return; }
      const id = btn.dataset.id;
      if (btn.dataset.act === 'preview') { state.openPre = state.openPre === id ? null : id; paint(); return; }
      const ok = btn.dataset.type === 'doc'
        ? doRestoreDoc(id)
        : btn.dataset.type === 'orphan'
          ? doRestoreOrphan(btn.dataset.name, id)
          : doRestoreChapter(btn.dataset.name, id);
      if (ok) mask.remove();
      else paint(); // 失败保持抽屉并刷新（版本可能已被容量淘汰）
    });
    paint();
  });
  el.querySelector('#wb-version-save').addEventListener('click', () => {
    const prjS = getProject();
    const curS = prjS.currentChapter || current;
    const contentS = get(DRAFT_KEY, {})[curS]?.content || '';
    if (!curS || !contentS) { toast('先在左栏选择有内容的章节再存档', 'err'); return; }
    const label = prompt('给这个版本写个备注（可留空）', '');
    if (label === null) return;
    const v = snapshotChapter(curS, contentS, 'manual', label.trim() || '手动留档');
    if (v) toast(`已存为版本（${fmtVersionTime(v.at)}）`, 'ok');
    else toast('该章节内容与最新版本一致，无需重复存档', 'err');
  });
  el.querySelector('#wb-copy-all').addEventListener('click', () => {
    persistDocument(ta.value, getProject());
    const { missing } = buildRefList(ta.value, get('citations', []));
    copyText(fullText(ta.value, get('citations', [])));
    if (missing.length) toast(`正文引用了 [${missing.join('][')}]，文献库未找到，未列入参考文献`, 'err', 4200);
  });
  el.querySelector('#wb-download').addEventListener('click', () => {
    persistDocument(ta.value, getProject());
    const { missing } = buildRefList(ta.value, get('citations', []));
    const prj = getProject();
    const fname = (prj.title || '论文全文').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.md';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([fullText(ta.value, get('citations', []))], { type: 'text/markdown;charset=utf-8' }));
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`已下载「${fname}」（${wordCount(ta.value).toLocaleString('zh-CN')} 字）`, 'ok');
    if (missing.length) toast(`正文引用了 [${missing.join('][')}]，文献库未找到，未列入参考文献`, 'err', 4200);
  });
  el.querySelector('#wb-preview').addEventListener('click', () => {
    persistDocument(ta.value, getProject());
    const { missing } = buildRefList(ta.value, get('citations', []));
    openPrintPreview(ta.value, get('citations', []), getProject());
    if (missing.length) toast(`正文引用了 [${missing.join('][')}]，文献库未找到，请到「文献与格式」补齐`, 'err', 4200);
  });

  // 中断恢复：关页/刷新前兜底保存（防 400ms 防抖窗口内内容丢失）
  if (!window.__tmUnloadSave) {
    window.__tmUnloadSave = true;
    window.addEventListener('beforeunload', () => {
      const editor = document.getElementById('wb-editor');
      if (editor) persistDocument(editor.value, getProject());
    });
  }
}

// ---------- 右栏：引用插入（序号）/ 摘要 / 素材 ----------

function renderRight(el) {
  const right = el.querySelector('.wb-right');
  right.innerHTML = `
    <h3><span class="mark"></span>插入引用（序号）</h3>
    <div id="wb-cits"></div>
    <p class="hint">正文中只插入引用序号 [n]；完整条目由系统在「复制全文 / 排版预览」的文末参考文献中按序号自动列出</p>
    <p style="margin-top:16px">
      <button class="btn btn-ghost btn-sm" data-nav="citation" style="width:100%">找文献 → 文献中心</button>
    </p>
    <h3 style="margin-top:24px"><span class="mark"></span>生成摘要</h3>
    <p class="desc">基于已写内容生成（适合初稿成型后使用）</p>
    <div style="display:flex;gap:6px">
      <button class="btn btn-ai btn-sm" id="wb-abstract" style="flex:1">本章摘要</button>
      <button class="btn btn-ai btn-sm" id="wb-abstract-all" style="flex:1">全文摘要</button>
    </div>
    <div class="result-box" id="wb-abstract-out" style="margin-top:8px"><span class="placeholder">结果将显示在这里</span></div>
    <div class="result-actions">
      <button class="btn btn-sm" id="wb-abstract-save" disabled title="先生成摘要">保存为素材</button>
      <button class="btn btn-ghost btn-sm" id="wb-abstract-copy" disabled title="先生成摘要">复制</button>
    </div>
    <h3 style="margin-top:24px"><span class="mark"></span>素材库</h3>
    <div id="wb-mats"></div>`;

  renderCits(right);
  renderMats(right);

  // 摘要生成：本章 / 全文两个口径（状态机：生成中禁用防连点；未生成时保存/复制置灰）
  const out = right.querySelector('#wb-abstract-out');
  const saveBtn = right.querySelector('#wb-abstract-save');
  const copyBtn = right.querySelector('#wb-abstract-copy');
  async function genAbstract(btn, source, label) {
    if (wordCount(source) < 100) { toast(`${label}内容还太少（至少约 100 字），先写写吧`, 'err'); return; }
    const both = [right.querySelector('#wb-abstract'), right.querySelector('#wb-abstract-all')];
    both.forEach(b => { b.dataset.orig = b.textContent; b.disabled = true; });
    out.innerHTML = '<span class="placeholder">AI 正在生成摘要…</span>';
    try {
      const reply = await chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `以下是论文${label === '本章' ? '章节' : '全文'}草稿（节选前 ${label === '本章' ? 2000 : 4000} 字），请基于其内容生成符合学术规范的中文摘要（250-400字），并给出3-5个关键词（格式：「关键词：xx；xx；xx」）。\n\n${source.slice(0, label === '本章' ? 2000 : 4000)}` },
      ], { temperature: 0.5, signal: writingSignal() });
      if (!out.isConnected) return; // 页面已离开，结果无处展示
      out.textContent = reply;
      out.classList.add('filled');
      saveBtn.disabled = false;
      copyBtn.disabled = false;
    } catch (e) {
      if (e?.code === 'aborted') return;
      out.innerHTML = `<span class="placeholder">❌ ${escapeHtml(e.message)}</span>`;
      toast(e.message, 'err', 3600);
    } finally {
      both.forEach(b => {
        if (!b.isConnected) return;
        b.disabled = false;
        b.textContent = b.dataset.orig || b.textContent;
      });
    }
  }
  right.querySelector('#wb-abstract').addEventListener('click', () => {
    const ta = document.getElementById('wb-editor');
    const cur = getProject().currentChapter || '';
    const r = cur ? findChapterRange(ta.value, cur) : { start: -1, end: -1 };
    const chapterText = r.start >= 0 ? ta.value.slice(r.start, r.end).trim() : '';
    genAbstract(right.querySelector('#wb-abstract'), chapterText, '本章');
  });
  right.querySelector('#wb-abstract-all').addEventListener('click', () => {
    const ta = document.getElementById('wb-editor');
    const full = parseDocument(ta.value).chapters.map(c => c.content).join('\n');
    genAbstract(right.querySelector('#wb-abstract-all'), full, '全文');
  });

  right.querySelector('#wb-abstract-save').addEventListener('click', () => {
    const out = right.querySelector('#wb-abstract-out');
    if (out.querySelector('.placeholder') || !out.textContent.trim()) { toast('请先生成摘要', 'err'); return; }
    addMaterial({ type: '📄 摘要', title: getProject().currentChapter || '全文', content: out.textContent.trim() });
    toast('摘要已保存到素材库', 'ok');
    renderMats(right);
  });

  right.querySelector('#wb-abstract-copy').addEventListener('click', () => {
    const out = right.querySelector('#wb-abstract-out');
    if (out.querySelector('.placeholder') || !out.textContent.trim()) { toast('请先生成摘要', 'err'); return; }
    copyText(out.textContent.trim());
  });
}

function renderCits(right) {
  const all = get('citations', []).filter(c => c.litNo != null).sort((a, b) => a.litNo - b.litNo);
  const box = right.querySelector('#wb-cits');
  if (!all.length) {
    box.innerHTML = '<p class="desc">文献库为空——先去「文献中心」收集文献，再回到这里按序号插入</p>';
    return;
  }
  // 衔接可见：标注每条文献在正文中的引用次数
  const ta = document.getElementById('wb-editor');
  const text = ta ? ta.value : '';
  const countOf = n => ((text.match(new RegExp(`\\[${n}\\]`, 'g')) || []).length);
  // 未引用文献排前（用户大概率引用尚未引用的文献，避免重复）；编号顺序保持稳定
  const list = [...all].sort((a, b) => (countOf(a.litNo) > 0) - (countOf(b.litNo) > 0) || a.litNo - b.litNo);
  const used = all.filter(c => countOf(c.litNo) > 0);
  box.innerHTML = `
    <div style="display:flex;gap:6px">
      <select id="w-cit-sel" style="flex:1">
        ${list.map(c => {
          const n = countOf(c.litNo);
          return `<option value="${c.litNo}">[${c.litNo}] ${escapeHtml((c.formatted || c.title || '').slice(0, 26))}${n ? ` · 已引用×${n}` : ' · 未引用'}</option>`;
        }).join('')}
      </select>
      <input type="number" id="w-cit-no" min="1" placeholder="编号直达" style="width:74px" title="知道编号时直接输入，如 12">
    </div>
    <p class="hint" style="margin:6px 0 8px">${
      used.length
        ? `正文已引用：${used.map(c => `<span class="chip ref-no">[${c.litNo}] ×${countOf(c.litNo)}</span>`).join(' ')}`
        : '正文还没有插入引用——把光标放在要引用的句子后，点下方按钮'}</p>
    <button class="btn btn-sm" id="w-cit-insert" style="width:100%">在光标处插入 [序号]</button>`;
  const insert = () => {
    const sel = box.querySelector('#w-cit-sel');
    const noInput = box.querySelector('#w-cit-no');
    const direct = noInput.value.trim();
    const allNos = new Set(all.map(c => c.litNo));
    let litNo;
    if (direct && !allNos.has(Number(direct))) {
      toast(`文献库中没有编号 [${direct}]`, 'err');
      return;
    }
    litNo = direct ? Number(direct) : Number(sel.value);
    noInput.value = '';
    const snippet = `[${litNo}]`;
    const ed = document.getElementById('wb-editor');
    const pos = ed.selectionStart;
    applyEdit(ed, snippet, pos, pos);
    toast(`已在光标处插入引用序号 [${litNo}]（Ctrl+Z 可撤销）`, 'ok');
  };
  box.querySelector('#w-cit-insert').addEventListener('click', insert);
  box.querySelector('#w-cit-no').addEventListener('keydown', e => { if (e.key === 'Enter') insert(); });
}

function renderMats(right) {
  const p = getProject();
  const box = right.querySelector('#wb-mats');
  const items = p.materials.slice(0, 10);
  box.innerHTML = items.length
    ? `<div class="item-list">${items.map((m, i) => `
        <div class="item">
          <div class="item-main">
            <div class="item-title">${escapeHtml(m.title)} <span class="chip">${escapeHtml(m.type)}</span></div>
            <div class="item-meta mono">${escapeHtml(m.createdAt)}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn btn-ghost btn-sm" data-mat-ins="${i}" title="在编辑器光标处插入素材内容（可撤销）">插入</button>
            <button class="btn btn-ghost btn-sm" data-mat-copy="${i}" title="复制素材内容">📋</button>
            <button class="btn btn-danger btn-sm" data-mat-del="${escapeHtml(m.id)}" title="删除素材">🗑</button>
          </div>
        </div>`).join('')}</div>
      ${p.materials.length > 10 ? `<p class="desc">素材共 ${p.materials.length} 条，显示最近 10 条</p>` : ''}`
    : '<p class="desc">暂无素材：摘要生成后可保存到这里复用</p>';
  // 插入到光标处：与引用插入同款 applyEdit（进原生撤销栈，可撤销）
  box.querySelectorAll('[data-mat-ins]').forEach(b =>
    b.addEventListener('click', () => {
      const content = items[Number(b.dataset.matIns)].content;
      const ta = document.getElementById('wb-editor');
      if (!ta) return;
      const pos = ta.selectionStart;
      ta.focus();
      applyEdit(ta, content, pos, pos);
      toast(`已插入素材「${items[Number(b.dataset.matIns)].title.slice(0, 12)}」（Ctrl+Z 可撤销）`, 'ok');
    }));
  // 复制走闭包读取原文：素材内容含换行，放 dataset 属性会被 HTML 解析规范化为空格
  box.querySelectorAll('[data-mat-copy]').forEach(b =>
    b.addEventListener('click', () => copyText(items[Number(b.dataset.matCopy)].content)));
  box.querySelectorAll('[data-mat-del]').forEach(b =>
    b.addEventListener('click', () => {
      removeMaterial(b.dataset.matDel);
      toast('素材已删除', 'ok');
      renderMats(right);
    }));
}

export default {
  id: 'writing',
  icon: '✍️',
  title: '写作工作台',
  subtitle: '一份完整论文文档：目录定位、序号引用、文末文献自动生成',
  projectScoped: true,
  render,
};
