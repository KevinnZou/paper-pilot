// 选题与大纲：AI 选题建议（可一键设为论文题目）+ 大纲生成 +「采用此大纲」（PRD v2.2：选题采用流程）
import { toast, copyText, integrityNote, escapeHtml, setLoading } from '../ui.js';
import { chat } from '../api.js';
import { getProject, adoptOutline, updateBasics } from '../project.js';
import { renderLitSearch } from '../litsearch.js';

const SYSTEM = '你是一位资深论文导师，熟悉中国高校各学科论文选题与写作规范。回答直接给出内容，不要客套话和多余解释。';

// 中断恢复：与 writing/litsearch/citation/settings 同构——导航离开即取消选题/大纲的 AI 请求（结果不再写进已卸载页面）
if (!window.__tmTopicAbort) {
  window.__tmTopicAbort = new AbortController();
  document.addEventListener('tm:navigate', () => {
    window.__tmTopicAbort.abort();
    window.__tmTopicAbort = new AbortController();
  });
}
const topicSignal = () => window.__tmTopicAbort.signal;
function isAbort(e) {
  return e?.name === 'AbortError' || e?.code === 'aborted';
}

/** 把 AI 返回的选题解析为 {title, detail[]} 列表（支持 1. / 1、 两种编号）；清洗 AI 常见的 markdown 加粗（**标题**） */
function parseSuggestions(text) {
  const items = [];
  let current = null;
  text.split('\n').forEach(line => {
    const m = /^\s*(\d+)[.、．]\s*(.+)$/.exec(line.trim());
    if (m) {
      if (current) items.push(current);
      current = { title: m[2].replace(/\*\*|__|`/g, '').trim(), detail: [] };
    } else if (current) {
      current.detail.push(line);
    }
  });
  if (current) items.push(current);
  return items;
}

function copyResult(out) {
  if (out.querySelector('.placeholder') || !out.textContent.trim()) { toast('请先生成内容再复制', 'err'); return; }
  copyText(out.textContent.trim());
}

function render(el) {
  const p = getProject();

  el.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <h2><span class="mark"></span>选题建议</h2>
        <p class="desc">输入你的专业方向或感兴趣的关键词，AI 生成 5 个候选选题；满意的可直接「设为论文题目」接入主线${p.title ? `（当前论文：<b>${escapeHtml(p.title)}</b>）` : ''}</p>
        <label class="field-label">专业 / 研究方向</label>
        <input type="text" id="topic-field" placeholder="例如：计算机视觉、组织行为学、供应链管理">
        <label class="field-label">感兴趣的关键词（可选）</label>
        <input type="text" id="topic-kw" placeholder="例如：小样本学习；用逗号分隔">
        <label class="field-label">附加要求（可选）</label>
        <input type="text" id="topic-req" placeholder="例如：偏应用型、需要公开数据集、2万字">
        <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ai-solid" id="topic-gen">生成选题建议</button>
          <button class="btn btn-ghost" id="topic-demo">填入示例试试</button>
        </div>
        <div class="result-box" id="topic-out"><span class="placeholder">生成结果将显示在这里</span></div>
        <div class="result-actions">
          <button class="btn btn-ghost btn-sm" id="topic-copy" disabled title="先生成选题建议再复制">复制结果</button>
        </div>
        ${integrityNote()}
      </div>

      <div class="card">
        <h2><span class="mark"></span>大纲生成</h2>
        <p class="desc">输入论文题目，AI 生成研究框架与章节大纲；点击「采用此大纲」将章节接入论文主线（自动关联工作台、计划与论文主页）</p>
        <label class="field-label">论文题目 / 主题</label>
        <input type="text" id="outline-title" placeholder="例如：基于大语言模型的智能客服满意度研究" value="${p.title}">
        <div class="form-row">
          <div>
            <label class="field-label">学位类型</label>
            <select id="outline-degree">
              ${['本科论文', '硕士论文', '博士论文', '课程论文'].map(d => `<option${d === p.degreeType ? ' selected' : ''}>${d}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field-label">预计字数（可选）</label>
            <input type="number" id="outline-words" placeholder="例如 20000">
          </div>
        </div>
        <div style="margin-top:16px">
          <button class="btn btn-ai-solid" id="outline-gen">生成研究框架</button>
        </div>
        <div class="result-box" id="outline-out"><span class="placeholder">生成结果将显示在这里</span></div>
        <div class="result-actions">
          <button class="btn" id="outline-adopt" disabled title="先生成大纲再采用">采用此大纲</button>
          <button class="btn btn-ghost btn-sm" id="outline-copy" disabled title="先生成大纲再复制">复制</button>
        </div>
        ${integrityNote()}
      </div>
    </div>

    <div class="card">
      <h2><span class="mark"></span>查找相关文献（选题后推荐）</h2>
      <p class="desc">确定选题后，可一键基于「论文题目 + 大纲」批量推荐整篇论文的文献候选清单（按章节分组、自动去重）；点「原文」核对全文、点「详情」看摘要，勾选后入库——真实元数据，杜绝 AI 幻觉引用</p>
      <div id="topic-lit"></div>
    </div>`;

  // 填入示例：一键体验选题建议（无需手打）
  el.querySelector('#topic-demo').addEventListener('click', () => {
    el.querySelector('#topic-field').value = '计算机视觉';
    el.querySelector('#topic-kw').value = '小样本学习；医学图像分割';
    el.querySelector('#topic-req').value = '偏应用型、需要公开数据集';
    toast('示例已填入——点「生成选题建议」试试', 'ok');
  });

  // 选题建议（AI）→ 解析为卡片，每条可设为论文题目
  el.querySelector('#topic-gen').addEventListener('click', async () => {
    const field = el.querySelector('#topic-field').value.trim();
    const kw = el.querySelector('#topic-kw').value.trim();
    const req = el.querySelector('#topic-req').value.trim();
    if (!field && !kw) { toast('请先填写专业方向或关键词', 'err'); return; }
    const btn = el.querySelector('#topic-gen');
    const out = el.querySelector('#topic-out');
    setLoading(btn, true, '生成中…');
    out.classList.remove('filled');
    out.innerHTML = '<span class="placeholder">AI 正在生成选题建议…</span>';
    try {
      const reply = await chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `请帮我生成 5 个论文选题建议。\n专业/研究方向：${field || '未提供'}\n感兴趣的关键词：${kw || '未提供'}\n附加要求：${req || '无'}\n\n每个选题输出格式：\nN. 题目\n· 可行性：…（从数据、方法、资源角度说明）\n· 创新点：…` },
      ], { temperature: 0.8, signal: topicSignal() });
      const items = parseSuggestions(reply);
      if (items.length >= 2) {
        out.innerHTML = `<div class="suggestion-list">${items.map((it, i) => `
          <div class="suggestion-item">
            <div class="sug-title"><span class="chip ref-no">${i + 1}</span> ${escapeHtml(it.title)}</div>
            ${it.detail.filter(d => d.trim()).length ? `<div class="sug-detail">${escapeHtml(it.detail.join('\n'))}</div>` : ''}
            <div style="margin-top:8px">
              <button class="btn btn-sm" data-adopt-title="${escapeHtml(it.title)}">设为论文题目</button>
            </div>
          </div>`).join('')}</div>`;
        out.classList.add('filled');
        el.querySelector('#topic-copy').disabled = false;
        out.querySelectorAll('[data-adopt-title]').forEach(b =>
          b.addEventListener('click', () => {
            updateBasics({ title: b.dataset.adoptTitle });
            // 衔接：同步填入右侧「大纲生成」的题目输入，用户无需重输
            const outlineTitle = el.querySelector('#outline-title');
            if (outlineTitle) outlineTitle.value = b.dataset.adoptTitle;
            toast('已设为论文题目，已同步到「大纲生成」——去生成大纲吧', 'ok');
            b.replaceWith(Object.assign(document.createElement('span'), {
              className: 'seal', textContent: '已设为主线',
            }));
          }));
      } else {
        out.textContent = reply;
        out.classList.add('filled');
        el.querySelector('#topic-copy').disabled = false;
      }
    } catch (e) {
      if (isAbort(e)) return; // 导航取消：静默放弃，不打扰
      out.innerHTML = `<span class="placeholder">❌ ${escapeHtml(e.message)}</span>`;
      toast(e.message, 'err', 3600);
    } finally {
      setLoading(btn, false);
    }
  });

  // 大纲生成（AI）
  el.querySelector('#outline-gen').addEventListener('click', async () => {
    const title = el.querySelector('#outline-title').value.trim();
    if (!title) { toast('请先输入论文题目', 'err'); return; }
    const degree = el.querySelector('#outline-degree').value;
    const words = el.querySelector('#outline-words').value.trim();
    const btn = el.querySelector('#outline-gen');
    const out = el.querySelector('#outline-out');
    setLoading(btn, true, '生成中…');
    out.classList.remove('filled');
    out.innerHTML = '<span class="placeholder">AI 正在生成研究框架…</span>';
    try {
      const reply = await chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `请为论文「${title}」生成规范的章节大纲（学位类型：${degree}${words ? `，预计 ${words} 字` : ''}）。\n要求：第一章到第五章，每章含 2-4 个二级标题（如 1.1），每章附一句要点说明。格式：\n第X章 标题\n   X.X 小节标题` },
      ], { temperature: 0.5, signal: topicSignal() });
      out.textContent = reply;
      out.classList.add('filled');
      el.querySelector('#outline-copy').disabled = false;
      // 重新生成后恢复「采用此大纲」入口（此前采用过的按钮已变印章，需重建才能再次采用）
      restoreAdoptButton(out);
    } catch (e) {
      if (isAbort(e)) return; // 导航取消：静默放弃，不打扰
      out.innerHTML = `<span class="placeholder">❌ ${escapeHtml(e.message)}</span>`;
      toast(e.message, 'err', 3600);
    } finally {
      setLoading(btn, false);
    }
  });

  // 采用此大纲：章节接入论文主线 + 论文题目入库（链路①）
  function adoptOutlineAction(out) {
    if (out.querySelector('.placeholder') || !out.textContent.trim()) { toast('请先生成大纲再采用', 'err'); return; }
    const chapters = adoptOutline(out.textContent.trim());
    if (!chapters.length) {
      toast('大纲解析失败：未识别到「第X章」格式，请重新生成一次', 'err', 4000);
      return;
    }
    const title = el.querySelector('#outline-title').value.trim();
    if (title) updateBasics({ title, degreeType: el.querySelector('#outline-degree').value });
    toast(`已采用大纲（${chapters.length} 章），去「写作工作台」开始按章写作吧`, 'ok');
    el.querySelector('#outline-adopt').replaceWith(Object.assign(document.createElement('span'), {
      className: 'seal', textContent: `已采用 · ${chapters.length} 章`,
    }));
    // 衔接：下一步引导（不整页重渲染，原地追加）
    const actions = out.closest('.card').querySelector('.result-actions');
    if (actions) {
      const goBtn = document.createElement('button');
      goBtn.className = 'btn';
      goBtn.dataset.tm = 'outline-go';
      goBtn.textContent = '去写作工作台写第一章 →';
      goBtn.addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'writing' })));
      actions.appendChild(goBtn);
    }
  }

  // 大纲生成后恢复操作入口：首次生成时启用置灰的按钮；采用过的按钮已被印章替换，需清理印章与引导后重建
  function restoreAdoptButton(out) {
    const actions = out.closest('.card').querySelector('.result-actions');
    if (!actions) return;
    const existing = actions.querySelector('#outline-adopt');
    if (existing) { existing.disabled = false; return; }
    actions.querySelectorAll('.seal, [data-tm="outline-go"]').forEach(x => x.remove());
    const adoptBtn = document.createElement('button');
    adoptBtn.className = 'btn';
    adoptBtn.id = 'outline-adopt';
    adoptBtn.textContent = '采用此大纲';
    adoptBtn.addEventListener('click', () => adoptOutlineAction(out));
    actions.querySelector('#outline-copy').before(adoptBtn);
  }

  el.querySelector('#outline-adopt').addEventListener('click', () =>
    adoptOutlineAction(el.querySelector('#outline-out')));

  el.querySelector('#topic-copy').addEventListener('click', () => copyResult(el.querySelector('#topic-out')));
  el.querySelector('#outline-copy').addEventListener('click', () => copyResult(el.querySelector('#outline-out')));

  // 选题后推荐文献（链路⑦）：单次检索 + 基于题目/大纲的批量推荐
  renderLitSearch(el.querySelector('#topic-lit'), {
    defaultQuery: p.title,
    batchFrom: { title: p.title, chapters: p.outline.map(c => c.chapter) },
  });
}

export default {
  id: 'topic',
  icon: '🧭',
  title: '选题与大纲',
  subtitle: '从方向到框架，理清论文第一步',
  projectScoped: true,
  render,
};
