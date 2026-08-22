import { toast, copyText, integrityNote, escapeHtml, setLoading } from '../ui.js';
import { chat } from '../api.js';
import { getProject, adoptOutline, updateBasics, saveProject } from '../project.js';
import { renderLitSearch } from '../litsearch.js';

const SYSTEM = '你是一位资深论文研究设计导师，熟悉中国高校论文选题、研究问题设计、方法论、开题与写作规范。回答直接给出内容，不要客套话和多余解释。';

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

function parseJson(reply) {
  const body = String(reply || '').replace(/```json|```/g, '').trim();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    const match = body.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (!match) throw new Error('AI 未返回有效 JSON');
    data = JSON.parse(match[0].replace(/,(\s*[}\]])/g, '$1'));
  }
  return data;
}

function linesToArray(text) {
  return String(text || '')
    .split(/\n|；|;/)
    .map(s => s.replace(/^\s*[-*•\d.、]+\s*/, '').trim())
    .filter(Boolean);
}

function parseSuggestionCards(text) {
  const items = [];
  let current = null;
  String(text || '').split('\n').forEach(line => {
    const m = /^\s*(\d+)[.、．]\s*(.+)$/.exec(line.trim());
    if (m) {
      if (current) items.push(current);
      current = { title: m[2].replace(/\*\*|__|`/g, '').trim(), detail: [] };
    } else if (current) {
      current.detail.push(line.trim());
    }
  });
  if (current) items.push(current);
  return items;
}

function copyResult(out) {
  if (out.querySelector('.placeholder') || !out.textContent.trim()) {
    toast('请先生成内容再复制', 'err');
    return;
  }
  copyText(out.textContent.trim());
}

function normalizeResearchDesign(design = {}, project = getProject()) {
  return {
    initialIdea: design.initialIdea || '',
    title: design.title || project.title || '',
    researchQuestions: Array.isArray(design.researchQuestions) ? design.researchQuestions : [],
    researchGap: design.researchGap || '',
    gapSources: Array.isArray(design.gapSources) ? design.gapSources : [],
    objectives: Array.isArray(design.objectives) ? design.objectives : [],
    population: design.population || '',
    variables: Array.isArray(design.variables) ? design.variables : [],
    hypotheses: Array.isArray(design.hypotheses) ? design.hypotheses : [],
    methods: Array.isArray(design.methods) ? design.methods : [],
    dataSources: Array.isArray(design.dataSources) ? design.dataSources : [],
    feasibility: {
      score: design.feasibility?.score || '',
      risks: Array.isArray(design.feasibility?.risks) ? design.feasibility.risks : [],
      suggestions: Array.isArray(design.feasibility?.suggestions) ? design.feasibility.suggestions : [],
    },
    confirmedAt: design.confirmedAt || '',
  };
}

function saveDesignPatch(patch) {
  const project = getProject();
  const current = normalizeResearchDesign(project.researchDesign, project);
  const next = {
    ...current,
    ...patch,
    feasibility: {
      ...current.feasibility,
      ...(patch.feasibility || {}),
    },
  };
  const title = patch.title ?? current.title ?? project.title;
  saveProject({ researchDesign: next, ...(title ? { title } : {}) });
  return next;
}

function designContext(el) {
  const project = getProject();
  const current = normalizeResearchDesign(project.researchDesign, project);
  return {
    idea: el.querySelector('#rd-idea').value.trim(),
    title: el.querySelector('#rd-title').value.trim() || current.title || project.title,
    degreeType: el.querySelector('#rd-degree').value,
    keywords: el.querySelector('#rd-keywords').value.trim(),
    constraints: el.querySelector('#rd-constraints').value.trim(),
    current,
  };
}

function renderQuestions(list) {
  if (!list.length) return '<span class="placeholder">研究问题候选将显示在这里</span>';
  return `<div class="suggestion-list">${list.map((item, idx) => `
    <div class="suggestion-item">
      <div class="sug-title"><span class="chip ref-no">${idx + 1}</span> ${escapeHtml(item.question || item.title || '未命名问题')}</div>
      ${item.object ? `<div class="sug-detail">研究对象：${escapeHtml(item.object)}</div>` : ''}
      ${item.variable ? `<div class="sug-detail">核心变量：${escapeHtml(item.variable)}</div>` : ''}
      ${item.answerability ? `<div class="sug-detail">可回答性：${escapeHtml(item.answerability)}</div>` : ''}
      ${item.dataNeed ? `<div class="sug-detail">数据要求：${escapeHtml(item.dataNeed)}</div>` : ''}
      ${item.method ? `<div class="sug-detail">适用方法：${escapeHtml(item.method)}</div>` : ''}
    </div>`).join('')}</div>`;
}

function renderFeasibility(feasibility) {
  if (!feasibility?.score && !feasibility?.risks?.length && !feasibility?.suggestions?.length) {
    return '<span class="placeholder">可行性检查结果将显示在这里</span>';
  }
  return `
    <div class="sample-tag">综合评分：${escapeHtml(String(feasibility.score || '待评估'))}</div>
    <div style="margin-top:8px"><b>主要风险</b></div>
    <ul>${(feasibility.risks || []).map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>暂无</li>'}</ul>
    <div style="margin-top:8px"><b>调整建议</b></div>
    <ul>${(feasibility.suggestions || []).map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>暂无</li>'}</ul>`;
}

function renderSnapshot(design) {
  const sections = [
    ['研究想法', design.initialIdea],
    ['研究空白', design.researchGap],
    ['研究对象', design.population],
    ['研究目标', design.objectives.join('；')],
    ['变量', design.variables.join('；')],
    ['假设', design.hypotheses.join('；')],
    ['方法', design.methods.join('；')],
    ['数据来源', design.dataSources.join('；')],
  ].filter(([, value]) => String(value || '').trim());
  if (!sections.length) return '<span class="placeholder">保存研究设计后，这里会形成你的方案快照</span>';
  return sections.map(([label, value]) => `
    <div class="item">
      <div class="item-main">
        <div class="item-title">${escapeHtml(label)}</div>
        <div class="item-meta">${escapeHtml(value)}</div>
      </div>
    </div>`).join('');
}

function attachTitleAdopt(el, out, onAdopt) {
  out.querySelectorAll('[data-adopt-title]').forEach(btn =>
    btn.addEventListener('click', () => {
      const title = btn.dataset.adoptTitle;
      el.querySelector('#rd-title').value = title;
      updateBasics({ title, degreeType: el.querySelector('#rd-degree').value });
      saveDesignPatch({ title });
      toast('已设为论文题目，并同步到研究设计主线', 'ok');
      onAdopt?.(title);
      btn.replaceWith(Object.assign(document.createElement('span'), {
        className: 'seal',
        textContent: '已设为主线',
      }));
    }));
}

function render(el) {
  const project = getProject();
  const design = normalizeResearchDesign(project.researchDesign, project);

  el.innerHTML = `
    <div class="workspace-columns">
      <div class="workspace-column">
        <div class="card workspace-card">
          <h2><span class="mark"></span>研究想法与题目</h2>
          <p class="desc">先把模糊想法落成题目候选，再把满意的题目设为项目主线。</p>
          <label class="field-label">研究想法</label>
          <textarea id="rd-idea" placeholder="你想研究什么问题？为什么值得做？">${escapeHtml(design.initialIdea)}</textarea>
          <label class="field-label">关键词</label>
          <input type="text" id="rd-keywords" placeholder="例如：小样本学习；医学图像；注意力机制" value="${escapeHtml((design.variables || []).join('；'))}">
          <label class="field-label">约束条件</label>
          <input type="text" id="rd-constraints" placeholder="例如：公开数据集、两个月完成、硕士论文" value="${escapeHtml(design.objectives?.[0] || '')}">
          <div class="result-actions" style="margin-top:16px">
            <button class="btn btn-ai-solid" id="rd-title-gen">生成题目候选</button>
            <button class="btn btn-ghost" id="rd-save-idea">保存研究想法</button>
          </div>
          <div class="result-box" id="rd-title-out"><span class="placeholder">题目候选将显示在这里</span></div>
          <div class="result-actions">
            <button class="btn btn-ghost btn-sm" id="rd-title-copy" disabled>复制结果</button>
          </div>
          ${integrityNote()}
        </div>

        <div class="card workspace-card">
          <h2><span class="mark"></span>研究问题</h2>
          <p class="desc">生成 3-5 个候选研究问题，并说明研究对象、核心变量、可回答性、数据要求和适用方法。</p>
          <div class="result-actions">
            <button class="btn btn-ai-solid" id="rd-question-gen">生成研究问题</button>
            <button class="btn btn-ghost btn-sm" id="rd-question-use" ${design.researchQuestions.length ? '' : 'disabled'}>采用到研究设计</button>
          </div>
          <div class="result-box" id="rd-question-out">${renderQuestions(design.researchQuestions)}</div>
        </div>

        <div class="card workspace-card">
          <h2><span class="mark"></span>研究空白与方案确认</h2>
          <p class="desc">这里先形成你的研究空白与方案摘要。文献来源需要结合下方“快速文献扫描”核对，避免空白判断失真。</p>
          <label class="field-label">研究空白</label>
          <textarea id="rd-gap" placeholder="概括现有研究的不足、分歧或未覆盖之处">${escapeHtml(design.researchGap)}</textarea>
          <label class="field-label">空白依据文献（每行一条）</label>
          <textarea id="rd-gap-sources" placeholder="例如：&#10;Smith 2024：仅关注自然图像，未覆盖医学场景&#10;张三 2025：样本规模较小">${escapeHtml(design.gapSources.join('\n'))}</textarea>
          <label class="field-label">研究假设 / 待验证判断（每行一条）</label>
          <textarea id="rd-hypotheses" placeholder="例如：&#10;加入空间注意力后可提升边界识别效果">${escapeHtml(design.hypotheses.join('\n'))}</textarea>
          <div class="result-actions" style="margin-top:16px">
            <button class="btn" id="rd-save-gap">保存方案摘要</button>
            <button class="btn btn-ghost" id="rd-confirm">确认研究方案</button>
          </div>
          <div class="result-box" id="rd-snapshot">${renderSnapshot(design)}</div>
        </div>
      </div>

      <div class="workspace-column">
        <div class="card workspace-card">
          <h2><span class="mark"></span>研究主线</h2>
          <p class="desc">把项目主线补齐为可执行的研究方案，后续大纲、文献推荐和写作都会用到这里的内容。</p>
          <label class="field-label">论文题目</label>
          <input type="text" id="rd-title" placeholder="例如：基于注意力机制的医学图像小样本分割研究" value="${escapeHtml(design.title || project.title)}">
          <div class="form-row">
            <div>
              <label class="field-label">学位类型</label>
              <select id="rd-degree">
                ${['本科论文', '硕士论文', '博士论文', '课程论文'].map(d => `<option${d === (project.degreeType || '硕士论文') ? ' selected' : ''}>${d}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="field-label">研究对象 / 样本</label>
              <input type="text" id="rd-population" placeholder="例如：公开肺部 CT 数据集 / 某行业员工样本" value="${escapeHtml(design.population)}">
            </div>
          </div>
          <label class="field-label">研究目标（每行一条）</label>
          <textarea id="rd-objectives" placeholder="例如：&#10;梳理相关研究现状&#10;构建方法框架&#10;验证方法有效性">${escapeHtml(design.objectives.join('\n'))}</textarea>
          <label class="field-label">变量 / 核心概念（每行一条）</label>
          <textarea id="rd-variables" placeholder="例如：&#10;支持集规模&#10;分割精度&#10;空间注意力模块">${escapeHtml(design.variables.join('\n'))}</textarea>
          <label class="field-label">研究方法（每行一条）</label>
          <textarea id="rd-methods" placeholder="例如：&#10;文献分析法&#10;实验对比法&#10;问卷调查法">${escapeHtml(design.methods.join('\n'))}</textarea>
          <label class="field-label">数据来源（每行一条）</label>
          <textarea id="rd-data-sources" placeholder="例如：&#10;公开数据集&#10;企业年报&#10;访谈记录">${escapeHtml(design.dataSources.join('\n'))}</textarea>
          <div class="result-actions" style="margin-top:16px">
            <button class="btn" id="rd-save-design">保存研究设计</button>
            <button class="btn btn-ghost" id="rd-sync-title">同步为项目题目</button>
          </div>
        </div>

        <div class="card workspace-card">
          <h2><span class="mark"></span>可行性检查</h2>
          <p class="desc">从数据可得性、样本获取、方法难度、时间、资源、题目范围、创新度和学位匹配度做一轮检查。</p>
          <div class="result-actions">
            <button class="btn btn-ai-solid" id="rd-feasibility-gen">进行可行性检查</button>
            <button class="btn btn-ghost btn-sm" id="rd-feasibility-use" ${(design.feasibility.score || design.feasibility.risks.length) ? '' : 'disabled'}>保存检查结果</button>
          </div>
          <div class="result-box" id="rd-feasibility-out">${renderFeasibility(design.feasibility)}</div>
        </div>

        <div class="card workspace-card">
          <h2><span class="mark"></span>论文大纲</h2>
          <p class="desc">大纲会优先参考研究问题、研究空白、方法和数据来源，生成后可直接采用到论文主线。</p>
          <div class="result-actions" style="margin-top:4px">
            <button class="btn btn-ai-solid" id="outline-gen">生成论文大纲</button>
            <button class="btn btn-ghost btn-sm" id="outline-copy" disabled>复制</button>
          </div>
          <div class="result-box" id="outline-out"><span class="placeholder">生成结果将显示在这里</span></div>
          <div class="result-actions">
            <button class="btn" id="outline-adopt" disabled>采用此大纲</button>
          </div>
          ${integrityNote()}
        </div>
      </div>
    </div>

    <div class="card">
      <h2><span class="mark"></span>快速文献扫描</h2>
      <p class="desc">基于当前论文题目与已采用大纲做中英文文献扫描。研究空白与方法选择都建议回到真实文献核对后再定稿。</p>
      <div id="topic-lit"></div>
    </div>`;

  let pendingQuestions = design.researchQuestions;
  let pendingFeasibility = design.feasibility;

  function collectDesignFromInputs() {
    return {
      initialIdea: el.querySelector('#rd-idea').value.trim(),
      title: el.querySelector('#rd-title').value.trim(),
      population: el.querySelector('#rd-population').value.trim(),
      objectives: linesToArray(el.querySelector('#rd-objectives').value),
      variables: linesToArray(el.querySelector('#rd-variables').value),
      methods: linesToArray(el.querySelector('#rd-methods').value),
      dataSources: linesToArray(el.querySelector('#rd-data-sources').value),
      researchGap: el.querySelector('#rd-gap').value.trim(),
      gapSources: linesToArray(el.querySelector('#rd-gap-sources').value),
      hypotheses: linesToArray(el.querySelector('#rd-hypotheses').value),
    };
  }

  function persistDesign(extra = {}) {
    const base = collectDesignFromInputs();
    const next = saveDesignPatch({
      ...base,
      ...extra,
      title: base.title || extra.title || project.title,
      researchQuestions: extra.researchQuestions || pendingQuestions || design.researchQuestions,
      feasibility: extra.feasibility || pendingFeasibility || design.feasibility,
    });
    updateBasics({
      title: next.title || project.title,
      degreeType: el.querySelector('#rd-degree').value,
    });
    el.querySelector('#rd-snapshot').innerHTML = renderSnapshot(next);
    return next;
  }

  el.querySelector('#rd-save-idea').addEventListener('click', () => {
    const next = persistDesign();
    toast(next.initialIdea ? '研究想法已保存' : '已保存当前研究设计', 'ok');
  });

  el.querySelector('#rd-save-design').addEventListener('click', () => {
    persistDesign();
    toast('研究设计已保存', 'ok');
  });

  el.querySelector('#rd-save-gap').addEventListener('click', () => {
    persistDesign();
    toast('方案摘要已保存', 'ok');
  });

  el.querySelector('#rd-sync-title').addEventListener('click', () => {
    const title = el.querySelector('#rd-title').value.trim();
    if (!title) {
      toast('请先填写论文题目', 'err');
      return;
    }
    updateBasics({ title, degreeType: el.querySelector('#rd-degree').value });
    saveDesignPatch({ title });
    toast('已同步为项目题目', 'ok');
  });

  el.querySelector('#rd-confirm').addEventListener('click', () => {
    const next = persistDesign({ confirmedAt: new Date().toISOString() });
    toast(next.confirmedAt ? '研究方案已确认' : '已保存', 'ok');
  });

  el.querySelector('#rd-title-gen').addEventListener('click', async () => {
    const ctx = designContext(el);
    if (!ctx.idea && !ctx.keywords) {
      toast('请先填写研究想法或关键词', 'err');
      return;
    }
    const btn = el.querySelector('#rd-title-gen');
    const out = el.querySelector('#rd-title-out');
    setLoading(btn, true, '生成中…');
    out.classList.remove('filled');
    out.innerHTML = '<span class="placeholder">AI 正在生成题目候选…</span>';
    try {
      const reply = await chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `请围绕下面的研究设想生成 5 个中文论文题目候选，并分别简述其可行性与创新角度。\n研究想法：${ctx.idea || '未提供'}\n关键词：${ctx.keywords || '未提供'}\n约束：${ctx.constraints || '无'}\n学位类型：${ctx.degreeType}\n\n输出格式：\n1. 题目\n- 可行性：...\n- 创新点：...` },
      ], { temperature: 0.7, signal: topicSignal() });
      const items = parseSuggestionCards(reply);
      if (items.length >= 2) {
        out.innerHTML = `<div class="suggestion-list">${items.map((it, i) => `
          <div class="suggestion-item">
            <div class="sug-title"><span class="chip ref-no">${i + 1}</span> ${escapeHtml(it.title)}</div>
            ${it.detail.filter(Boolean).length ? `<div class="sug-detail">${escapeHtml(it.detail.join('\n'))}</div>` : ''}
            <div style="margin-top:8px"><button class="btn btn-sm" data-adopt-title="${escapeHtml(it.title)}">设为论文题目</button></div>
          </div>`).join('')}</div>`;
        out.classList.add('filled');
        el.querySelector('#rd-title-copy').disabled = false;
        attachTitleAdopt(el, out, title => {
          el.querySelector('#rd-title').value = title;
        });
      } else {
        out.textContent = reply;
        out.classList.add('filled');
        el.querySelector('#rd-title-copy').disabled = false;
      }
    } catch (e) {
      if (isAbort(e)) return;
      out.innerHTML = `<span class="placeholder">❌ ${escapeHtml(e.message)}</span>`;
      toast(e.message, 'err', 3600);
    } finally {
      setLoading(btn, false);
    }
  });

  el.querySelector('#rd-question-gen').addEventListener('click', async () => {
    const ctx = designContext(el);
    if (!ctx.title && !ctx.idea) {
      toast('请先填写研究想法或论文题目', 'err');
      return;
    }
    const btn = el.querySelector('#rd-question-gen');
    const out = el.querySelector('#rd-question-out');
    setLoading(btn, true, '生成中…');
    out.classList.remove('filled');
    out.innerHTML = '<span class="placeholder">AI 正在生成研究问题…</span>';
    try {
      const reply = await chat([
        { role: 'system', content: `${SYSTEM} 只输出严格 JSON 数组。` },
        { role: 'user', content: `请基于以下论文设计，生成 3-5 个候选研究问题。每项字段：question, object, variable, answerability, dataNeed, method。\n论文题目：${ctx.title || '未定题'}\n研究想法：${ctx.idea || '未提供'}\n关键词：${ctx.keywords || '未提供'}\n研究对象：${el.querySelector('#rd-population').value.trim() || '未提供'}\n方法偏好：${el.querySelector('#rd-methods').value.trim() || '未提供'}\n约束：${ctx.constraints || '无'}` },
      ], { temperature: 0.4, signal: topicSignal() });
      const parsed = parseJson(reply);
      if (!Array.isArray(parsed) || !parsed.length) throw new Error('AI 未返回有效研究问题');
      pendingQuestions = parsed;
      out.innerHTML = renderQuestions(parsed);
      out.classList.add('filled');
      el.querySelector('#rd-question-use').disabled = false;
    } catch (e) {
      if (isAbort(e)) return;
      out.innerHTML = `<span class="placeholder">❌ ${escapeHtml(e.message)}</span>`;
      toast(e.message, 'err', 3600);
    } finally {
      setLoading(btn, false);
    }
  });

  el.querySelector('#rd-question-use').addEventListener('click', () => {
    if (!pendingQuestions?.length) {
      toast('请先生成研究问题', 'err');
      return;
    }
    persistDesign({ researchQuestions: pendingQuestions });
    toast(`已采用 ${pendingQuestions.length} 个研究问题候选`, 'ok');
  });

  el.querySelector('#rd-feasibility-gen').addEventListener('click', async () => {
    const ctx = designContext(el);
    if (!ctx.title && !ctx.idea) {
      toast('请先填写研究想法或论文题目', 'err');
      return;
    }
    const btn = el.querySelector('#rd-feasibility-gen');
    const out = el.querySelector('#rd-feasibility-out');
    setLoading(btn, true, '分析中…');
    out.classList.remove('filled');
    out.innerHTML = '<span class="placeholder">AI 正在检查研究可行性…</span>';
    try {
      const reply = await chat([
        { role: 'system', content: `${SYSTEM} 只输出严格 JSON 对象。` },
        { role: 'user', content: `请对下面的论文研究方案做可行性检查，维度至少覆盖：数据可得性、样本获取、方法难度、时间、资源、题目范围、创新度、与学位层次匹配度。输出字段：score, risks[], suggestions[]。\n论文题目：${ctx.title || '未定题'}\n研究想法：${ctx.idea || '未提供'}\n研究对象：${el.querySelector('#rd-population').value.trim() || '未提供'}\n研究目标：${el.querySelector('#rd-objectives').value.trim() || '未提供'}\n方法：${el.querySelector('#rd-methods').value.trim() || '未提供'}\n数据来源：${el.querySelector('#rd-data-sources').value.trim() || '未提供'}\n学位类型：${ctx.degreeType}\n约束：${ctx.constraints || '无'}` },
      ], { temperature: 0.3, signal: topicSignal() });
      const parsed = parseJson(reply);
      if (!parsed || typeof parsed !== 'object') throw new Error('AI 未返回有效可行性结果');
      pendingFeasibility = {
        score: parsed.score || '',
        risks: Array.isArray(parsed.risks) ? parsed.risks : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
      out.innerHTML = renderFeasibility(pendingFeasibility);
      out.classList.add('filled');
      el.querySelector('#rd-feasibility-use').disabled = false;
    } catch (e) {
      if (isAbort(e)) return;
      out.innerHTML = `<span class="placeholder">❌ ${escapeHtml(e.message)}</span>`;
      toast(e.message, 'err', 3600);
    } finally {
      setLoading(btn, false);
    }
  });

  el.querySelector('#rd-feasibility-use').addEventListener('click', () => {
    persistDesign({ feasibility: pendingFeasibility });
    toast('可行性检查结果已保存', 'ok');
  });

  function adoptOutlineAction(out) {
    if (out.querySelector('.placeholder') || !out.textContent.trim()) {
      toast('请先生成大纲再采用', 'err');
      return;
    }
    const chapters = adoptOutline(out.textContent.trim());
    if (!chapters.length) {
      toast('大纲解析失败：未识别到「第X章」格式，请重新生成一次', 'err', 4000);
      return;
    }
    const title = el.querySelector('#rd-title').value.trim();
    if (title) updateBasics({ title, degreeType: el.querySelector('#rd-degree').value });
    persistDesign({ confirmedAt: design.confirmedAt || new Date().toISOString() });
    toast(`已采用大纲（${chapters.length} 章），去写作工作台继续推进`, 'ok');
    el.querySelector('#outline-adopt').disabled = true;
    el.querySelector('#outline-adopt').textContent = `已采用 · ${chapters.length} 章`;
  }

  el.querySelector('#outline-gen').addEventListener('click', async () => {
    const base = persistDesign();
    const title = base.title || project.title;
    if (!title) {
      toast('请先确定论文题目', 'err');
      return;
    }
    const btn = el.querySelector('#outline-gen');
    const out = el.querySelector('#outline-out');
    setLoading(btn, true, '生成中…');
    out.classList.remove('filled');
    out.innerHTML = '<span class="placeholder">AI 正在生成论文大纲…</span>';
    try {
      const reply = await chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `请为下面的论文研究方案生成规范的中文论文大纲。要求：输出五章结构，每章附 2-4 个二级标题，并让章节安排与研究问题、研究空白、方法和数据来源一致。\n论文题目：${title}\n学位类型：${el.querySelector('#rd-degree').value}\n研究想法：${base.initialIdea || '未提供'}\n研究问题：${(pendingQuestions || base.researchQuestions).map(item => item.question || item).join('；') || '未提供'}\n研究空白：${base.researchGap || '未提供'}\n研究目标：${base.objectives.join('；') || '未提供'}\n研究对象：${base.population || '未提供'}\n方法：${base.methods.join('；') || '未提供'}\n数据来源：${base.dataSources.join('；') || '未提供'}\n\n输出格式示例：\n第1章 绪论\n  1.1 研究背景\n  1.2 研究意义` },
      ], { temperature: 0.4, signal: topicSignal() });
      out.textContent = reply;
      out.classList.add('filled');
      el.querySelector('#outline-copy').disabled = false;
      el.querySelector('#outline-adopt').disabled = false;
      persistDesign();
    } catch (e) {
      if (isAbort(e)) return;
      out.innerHTML = `<span class="placeholder">❌ ${escapeHtml(e.message)}</span>`;
      toast(e.message, 'err', 3600);
    } finally {
      setLoading(btn, false);
    }
  });

  el.querySelector('#outline-adopt').addEventListener('click', () => adoptOutlineAction(el.querySelector('#outline-out')));
  el.querySelector('#outline-copy').addEventListener('click', () => copyResult(el.querySelector('#outline-out')));
  el.querySelector('#rd-title-copy').addEventListener('click', () => copyResult(el.querySelector('#rd-title-out')));

  renderLitSearch(el.querySelector('#topic-lit'), {
    defaultQuery: project.title || design.title,
    batchFrom: { title: project.title || design.title, chapters: project.outline.map(c => c.chapter) },
  });
}

export default {
  id: 'topic',
  icon: '🧭',
  title: '研究设计',
  subtitle: '把论文想法变成可执行的研究方案',
  projectScoped: true,
  render,
};
