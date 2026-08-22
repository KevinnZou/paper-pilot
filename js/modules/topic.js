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

function normalizeTitleCandidates(list = []) {
  return Array.isArray(list)
    ? list.map((item, idx) => ({
        id: item.id || `title-${idx + 1}`,
        title: item.title || item.name || '',
        feasibility: item.feasibility || item.note || '',
        innovation: item.innovation || item.highlight || '',
      })).filter(item => item.title)
    : [];
}

function normalizeQuestionCandidates(list = []) {
  return Array.isArray(list)
    ? list.map((item, idx) => ({
        id: item.id || `rq-${idx + 1}`,
        question: item.question || item.title || '',
        object: item.object || '',
        variable: item.variable || '',
        answerability: item.answerability || '',
        dataNeed: item.dataNeed || '',
        method: item.method || '',
      })).filter(item => item.question)
    : [];
}

function normalizeResearchDesign(design = {}, project = getProject()) {
  return {
    currentStep: Number(design.currentStep) || 1,
    initialIdea: design.initialIdea || '',
    title: design.title || project.title || '',
    keywords: design.keywords || '',
    constraints: design.constraints || '',
    population: design.population || '',
    titleCandidates: normalizeTitleCandidates(design.titleCandidates),
    selectedTitleId: design.selectedTitleId || '',
    researchQuestions: Array.isArray(design.researchQuestions) ? design.researchQuestions : [],
    questionCandidates: normalizeQuestionCandidates(design.questionCandidates),
    selectedQuestionId: design.selectedQuestionId || '',
    researchGap: design.researchGap || '',
    gapSources: Array.isArray(design.gapSources) ? design.gapSources : [],
    objectives: Array.isArray(design.objectives) ? design.objectives : [],
    objectiveOptions: Array.isArray(design.objectiveOptions) ? design.objectiveOptions : [],
    variables: Array.isArray(design.variables) ? design.variables : [],
    hypotheses: Array.isArray(design.hypotheses) ? design.hypotheses : [],
    methods: Array.isArray(design.methods) ? design.methods : [],
    methodOptions: Array.isArray(design.methodOptions) ? design.methodOptions : [],
    selectedMethod: design.selectedMethod || '',
    dataSources: Array.isArray(design.dataSources) ? design.dataSources : [],
    dataOptions: Array.isArray(design.dataOptions) ? design.dataOptions : [],
    selectedDataSource: design.selectedDataSource || '',
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

function planReady(design) {
  return !!(design.researchQuestions.length && design.methods.length && design.dataSources.length);
}

function maxAvailableStep(design, project) {
  if ((project.outline || []).length) return 3;
  if (planReady(design)) return 3;
  if ((design.title || project.title || '').trim()) return 2;
  return 1;
}

function currentStep(design, project) {
  const max = maxAvailableStep(design, project);
  return Math.min(Math.max(design.currentStep || 1, 1), max);
}

function selectedQuestion(design) {
  return design.questionCandidates.find(item => item.id === design.selectedQuestionId)
    || design.researchQuestions[0]
    || null;
}

function selectedMethod(design) {
  return design.selectedMethod || design.methods[0] || '';
}

function selectedDataSource(design) {
  return design.selectedDataSource || design.dataSources[0] || '';
}

function renderTitleCards(design) {
  if (!design.titleCandidates.length) {
    return '<div class="topic-empty">生成后会在这里出现 4-5 个候选题目，每个都能直接设为主线。</div>';
  }
  return `<div class="topic-choice-list">${design.titleCandidates.map((item, idx) => `
    <article class="topic-choice-card ${design.selectedTitleId === item.id ? 'selected' : ''}">
      <div class="topic-choice-head">
        <span class="chip ref-no">${idx + 1}</span>
        ${design.selectedTitleId === item.id ? '<span class="chip done">当前主线</span>' : ''}
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      ${item.feasibility ? `<p><b>可行性</b>${escapeHtml(item.feasibility)}</p>` : ''}
      ${item.innovation ? `<p><b>创新点</b>${escapeHtml(item.innovation)}</p>` : ''}
      <div class="result-actions">
        <button class="btn" data-select-title="${escapeHtml(item.id)}">选这个题目</button>
      </div>
    </article>`).join('')}</div>`;
}

function renderQuestionCards(design) {
  if (!design.questionCandidates.length) {
    return '<div class="topic-empty">先生成方案建议，这里会给出 3 个左右可选的研究问题。</div>';
  }
  return `<div class="topic-choice-list compact">${design.questionCandidates.map((item, idx) => `
    <article class="topic-choice-card compact ${design.selectedQuestionId === item.id ? 'selected' : ''}">
      <div class="topic-choice-head">
        <span class="chip ref-no">${idx + 1}</span>
        ${design.selectedQuestionId === item.id ? '<span class="chip done">已选</span>' : ''}
      </div>
      <h3>${escapeHtml(item.question)}</h3>
      ${item.object ? `<p><b>对象</b>${escapeHtml(item.object)}</p>` : ''}
      ${item.variable ? `<p><b>变量</b>${escapeHtml(item.variable)}</p>` : ''}
      ${item.method ? `<p><b>方法</b>${escapeHtml(item.method)}</p>` : ''}
      ${item.dataNeed ? `<p><b>数据</b>${escapeHtml(item.dataNeed)}</p>` : ''}
      <div class="result-actions">
        <button class="btn btn-ghost" data-select-question="${escapeHtml(item.id)}">${design.selectedQuestionId === item.id ? '已选中' : '选择这个问题'}</button>
      </div>
    </article>`).join('')}</div>`;
}

function renderOptionPills(options, selected, attr, emptyText) {
  if (!options.length) return `<div class="topic-empty">${emptyText}</div>`;
  return `<div class="topic-pill-group">${options.map(item => `
    <button class="topic-pill ${selected === item ? 'selected' : ''}" data-${attr}="${escapeHtml(item)}" type="button">${escapeHtml(item)}</button>
  `).join('')}</div>`;
}

function feedbackBlock(id, placeholder, buttonLabel) {
  return `
    <div class="topic-feedback-block">
      <label class="field-label">如果这一批都不满意</label>
      <textarea id="${id}" class="topic-feedback-box" placeholder="${escapeHtml(placeholder)}"></textarea>
      <div class="result-actions">
        <button class="btn btn-ghost" id="${id}-submit">${escapeHtml(buttonLabel)}</button>
      </div>
    </div>`;
}

function renderFeasibility(design) {
  if (!design.feasibility.score && !design.feasibility.risks.length && !design.feasibility.suggestions.length) {
    return '<div class="topic-empty">生成方案建议后，这里会同步给出一轮可行性判断。</div>';
  }
  return `
    <div class="topic-score">可行性评分：<b>${escapeHtml(String(design.feasibility.score || '待评估'))}</b></div>
    <div class="topic-mini-block">
      <h4>主要风险</h4>
      <ul>${design.feasibility.risks.map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>暂无明显风险</li>'}</ul>
    </div>
    <div class="topic-mini-block">
      <h4>调整建议</h4>
      <ul>${design.feasibility.suggestions.map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>暂无</li>'}</ul>
    </div>`;
}

function renderPlanSummary(design) {
  const question = selectedQuestion(design);
  const method = selectedMethod(design);
  const data = selectedDataSource(design);
  return `
    <div class="topic-summary-grid">
      <div class="topic-summary-item">
        <span>论文题目</span>
        <b>${escapeHtml(design.title || '未选择')}</b>
      </div>
      <div class="topic-summary-item">
        <span>研究问题</span>
        <b>${escapeHtml(question?.question || '未选择')}</b>
      </div>
      <div class="topic-summary-item">
        <span>研究方法</span>
        <b>${escapeHtml(method || '未选择')}</b>
      </div>
      <div class="topic-summary-item">
        <span>数据来源</span>
        <b>${escapeHtml(data || '未选择')}</b>
      </div>
    </div>
    ${design.objectives.length ? `<div class="topic-mini-block"><h4>研究目标</h4><ul>${design.objectives.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
    ${design.researchGap ? `<div class="topic-mini-block"><h4>研究空白</h4><p>${escapeHtml(design.researchGap)}</p></div>` : ''}
    ${design.hypotheses.length ? `<div class="topic-mini-block"><h4>待验证判断</h4><ul>${design.hypotheses.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}`;
}

function renderOutlinePreview(text) {
  if (!String(text || '').trim()) {
    return '<div class="topic-empty">生成后会在这里出现五章大纲，确认无误后直接采用。</div>';
  }
  const blocks = [];
  let current = null;
  String(text || '').split('\n').forEach(line => {
    const t = line.trim();
    if (!t) return;
    if (/^第.+章/.test(t)) {
      if (current) blocks.push(current);
      current = { title: t, items: [] };
    } else if (current) {
      current.items.push(t);
    }
  });
  if (current) blocks.push(current);
  if (!blocks.length) return `<div class="topic-outline-raw">${escapeHtml(text)}</div>`;
  return `<div class="topic-outline-list">${blocks.map(block => `
    <article class="topic-outline-card">
      <h3>${escapeHtml(block.title)}</h3>
      <ul>${block.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    </article>`).join('')}</div>`;
}

function renderStepNav(step, maxStep, project, design) {
  const labels = ['定题', '定方案', '出大纲'];
  return `<div class="topic-stage-nav">
    ${labels.map((label, idx) => {
      const n = idx + 1;
      const enabled = n <= maxStep;
      const status = step === n ? 'current' : (n < step || (n === 1 && (design.title || project.title)) || (n === 2 && planReady(design)) || (n === 3 && (project.outline || []).length)) ? 'done' : '';
      return `<button class="topic-stage-tab ${status}" data-go-step="${n}" ${enabled ? '' : 'disabled'} type="button">
        <span class="topic-stage-index">${n}</span>
        <span>${label}</span>
      </button>`;
    }).join('')}
  </div>`;
}

function render(el) {
  const project = getProject();
  const design = normalizeResearchDesign(project.researchDesign, project);
  const step = currentStep(design, project);
  const maxStep = maxAvailableStep(design, project);

  let body = '';
  if (step === 1) {
    body = `
      <section class="card topic-wizard-card">
        <div class="topic-wizard-head">
          <div>
            <div class="topic-step-label">Step 1</div>
            <h2><span class="mark"></span>先从想法里挑出题目</h2>
            <p class="desc">这里只保留最少输入。你描述研究想法和限制条件，AI 直接给出题目候选，你只需要做选择。</p>
          </div>
          <div class="topic-head-side">
            <span class="chip doing">当前阶段</span>
          </div>
        </div>
        <div class="topic-wizard-grid">
          <div class="topic-primary-panel">
            <label class="field-label">研究想法</label>
            <textarea id="rd-idea" class="topic-idea-box" placeholder="例如：通过 AI 助力装修行业标准化、规范化、数字化">${escapeHtml(design.initialIdea)}</textarea>
            <div class="form-row">
              <div>
                <label class="field-label">关键词</label>
                <input type="text" id="rd-keywords" placeholder="例如：装修标准化，AI 赋能装修，采购优化" value="${escapeHtml(design.keywords)}">
              </div>
              <div>
                <label class="field-label">约束条件</label>
                <input type="text" id="rd-constraints" placeholder="例如：两个月完成，硕士论文，可获取企业案例" value="${escapeHtml(design.constraints)}">
              </div>
            </div>
            <div class="form-row">
              <div>
                <label class="field-label">学位类型</label>
                <select id="rd-degree">
                  ${['本科论文', '硕士论文', '博士论文', '课程论文'].map(d => `<option${d === (project.degreeType || '硕士论文') ? ' selected' : ''}>${d}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="field-label">研究对象 / 样本（可选）</label>
                <input type="text" id="rd-population" placeholder="例如：中小型装修企业 / 采购流程案例" value="${escapeHtml(design.population)}">
              </div>
            </div>
            <div class="result-actions" style="margin-top:16px">
              <button class="btn btn-ai-solid" id="rd-title-gen">生成题目候选</button>
              <button class="btn btn-ghost" id="rd-save-idea">保存当前输入</button>
            </div>
          </div>
        </div>
        <section class="topic-candidate-section">
          <div class="topic-candidate-head">
            <h3>题目候选</h3>
            <p class="desc">每个候选都可以直接设为主线，不需要额外复制粘贴。</p>
          </div>
          <div id="rd-title-out">${renderTitleCards(design)}</div>
          ${feedbackBlock('rd-title-feedback', '例如：题目太泛、想更偏实证、希望突出采购优化或规范化成效', '根据这些意见再生成一批')}
        </section>
        ${integrityNote()}
      </section>`;
  } else if (step === 2) {
    body = `
      <section class="card topic-wizard-card">
        <div class="topic-wizard-head">
          <div>
            <div class="topic-step-label">Step 2</div>
            <h2><span class="mark"></span>从方案候选里做选择</h2>
            <p class="desc">这一页不再要求你大段填写。AI 会基于题目给出研究问题、方法和数据来源建议，你只需要选一个最合适的组合。</p>
          </div>
          <div class="topic-head-side">
            <span class="chip doing">当前阶段</span>
          </div>
        </div>
        <div class="topic-current-line">
          <span class="chip done">当前题目</span>
          <strong>${escapeHtml(design.title || project.title)}</strong>
        </div>
        <div class="result-actions" style="margin:0 0 16px">
          <button class="btn btn-ai-solid" id="rd-plan-gen">生成研究方案建议</button>
          <button class="btn" id="rd-plan-save">确认这些选择，进入下一步</button>
        </div>
        <section class="topic-candidate-section">
          <div class="topic-candidate-head">
            <h3>研究问题候选</h3>
            <p class="desc">先在问题候选里选一个最顺手的切入点，再决定方法和数据来源。</p>
          </div>
          <div id="rd-question-out">${renderQuestionCards(design)}</div>
          ${feedbackBlock('rd-plan-feedback', '例如：问题太宏观，想更偏管理效能；方法不要实验法，想偏案例或访谈', '结合这些意见重生成方案')}
        </section>
        <div class="topic-step2-grid">
          <div class="topic-secondary-panel full">
            <h3>方法建议</h3>
            ${renderOptionPills(design.methodOptions, selectedMethod(design), 'select-method', '生成后在这里选择一种更适合的研究方法。')}
            <h3 style="margin-top:18px">数据来源建议</h3>
            ${renderOptionPills(design.dataOptions, selectedDataSource(design), 'select-data', '生成后在这里选择一种最可行的数据来源。')}
            ${design.objectiveOptions.length ? `<div class="topic-mini-block"><h4>AI 推荐的研究目标</h4><ul>${design.objectiveOptions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
          </div>
        </div>
        <div class="topic-feasibility-panel">
          <h3>可行性检查</h3>
          ${renderFeasibility(design)}
        </div>
      </section>`;
  } else {
    body = `
      <section class="card topic-wizard-card">
        <div class="topic-wizard-head">
          <div>
            <div class="topic-step-label">Step 3</div>
            <h2><span class="mark"></span>确认方案，生成并采用大纲</h2>
            <p class="desc">题目、研究问题、方法和数据来源都已经选定，这里只做最后确认，然后生成五章大纲，准备进入正式写作。</p>
          </div>
          <div class="topic-head-side">
            <span class="chip ${project.outline.length ? 'done' : 'doing'}">${project.outline.length ? '大纲已采用' : '当前阶段'}</span>
          </div>
        </div>
        <div class="topic-wizard-grid">
          <div class="topic-primary-panel">
            <h3>方案摘要</h3>
            ${renderPlanSummary(design)}
            <div class="result-actions" style="margin-top:18px">
              <button class="btn btn-ai-solid" id="outline-gen">生成论文大纲</button>
              <button class="btn btn-ghost btn-sm" id="outline-copy" ${project.outline.length ? '' : 'disabled'}>复制结果</button>
              <button class="btn" id="outline-adopt" ${project.outline.length ? '' : 'disabled'}>${project.outline.length ? '重新采用大纲' : '采用此大纲'}</button>
            </div>
            <div id="outline-out">${renderOutlinePreview('')}</div>
          </div>
          <aside class="topic-secondary-panel">
            <h3>快速文献扫描</h3>
            <p class="desc">这一步才需要回到真实文献核对研究空白和章节结构，不再从一开始就打扰主流程。</p>
            <div id="topic-lit"></div>
          </aside>
        </div>
        ${integrityNote()}
      </section>`;
  }

  el.innerHTML = `
    <div class="card topic-shell-card">
      <div class="topic-shell-head">
        <div>
          <h2><span class="mark"></span>研究设计向导</h2>
          <p class="desc">按真实论文推进顺序完成：先定题，再定方案，最后出大纲。</p>
        </div>
        <div class="topic-shell-status">当前第 ${step} 步 / 共 3 步</div>
      </div>
      ${renderStepNav(step, maxStep, project, design)}
    </div>
    ${body}`;

  const titleOut = el.querySelector('#rd-title-out');
  const outlineOut = el.querySelector('#outline-out');

  el.querySelectorAll('[data-go-step]').forEach(btn =>
    btn.addEventListener('click', () => {
      const next = Number(btn.dataset.goStep);
      saveDesignPatch({ currentStep: next });
      render(el);
    }));

    if (step === 1) {
    el.querySelector('#rd-save-idea').addEventListener('click', () => {
      saveDesignPatch({
        initialIdea: el.querySelector('#rd-idea').value.trim(),
        keywords: el.querySelector('#rd-keywords').value.trim(),
        constraints: el.querySelector('#rd-constraints').value.trim(),
        population: el.querySelector('#rd-population').value.trim(),
      });
      updateBasics({ degreeType: el.querySelector('#rd-degree').value });
      toast('研究想法已保存', 'ok');
    });

    async function generateTitles(feedback = '') {
      const idea = el.querySelector('#rd-idea').value.trim();
      const keywords = el.querySelector('#rd-keywords').value.trim();
      const constraints = el.querySelector('#rd-constraints').value.trim();
      const degreeType = el.querySelector('#rd-degree').value;
      const population = el.querySelector('#rd-population').value.trim();
      if (!idea && !keywords) {
        toast('请先填写研究想法或关键词', 'err');
        return;
      }
      const btn = el.querySelector('#rd-title-gen');
      setLoading(btn, true, '生成中…');
      titleOut.innerHTML = '<div class="topic-empty">AI 正在生成题目候选…</div>';
      try {
        const reply = await chat([
          { role: 'system', content: `${SYSTEM} 只输出严格 JSON 数组。` },
          { role: 'user', content: `请围绕下面的研究设想生成 4 个中文论文题目候选。每项字段：title, feasibility, innovation。\n研究想法：${idea || '未提供'}\n关键词：${keywords || '未提供'}\n约束：${constraints || '无'}\n学位类型：${degreeType}\n研究对象：${population || '未提供'}\n${feedback ? `用户对上一批候选的反馈：${feedback}\n请根据反馈明显调整方向，不要只是换几个近义词。` : ''}` },
        ], { temperature: 0.6, signal: topicSignal() });
        const parsed = normalizeTitleCandidates(parseJson(reply));
        if (!parsed.length) throw new Error('AI 未返回有效题目候选');
        saveDesignPatch({
          currentStep: 1,
          initialIdea: idea,
          keywords,
          constraints,
          population,
          titleCandidates: parsed,
        });
        updateBasics({ degreeType });
        render(el);
      } catch (e) {
        if (isAbort(e)) return;
        titleOut.innerHTML = `<div class="topic-empty">❌ ${escapeHtml(e.message)}</div>`;
        toast(e.message, 'err', 3600);
      } finally {
        setLoading(btn, false);
      }
    }

    el.querySelector('#rd-title-gen').addEventListener('click', () => generateTitles());
    el.querySelector('#rd-title-feedback-submit')?.addEventListener('click', () => {
      const feedback = el.querySelector('#rd-title-feedback')?.value.trim();
      if (!feedback) {
        toast('先写一下你不满意的点，我再按这个方向重生', 'err');
        return;
      }
      generateTitles(feedback);
    });

    el.querySelectorAll('[data-select-title]').forEach(btn =>
      btn.addEventListener('click', () => {
        const nextDesign = normalizeResearchDesign(getProject().researchDesign, getProject());
        const selected = nextDesign.titleCandidates.find(item => item.id === btn.dataset.selectTitle);
        if (!selected) return;
        saveDesignPatch({
          title: selected.title,
          selectedTitleId: selected.id,
          currentStep: 2,
        });
        updateBasics({
          title: selected.title,
          degreeType: el.querySelector('#rd-degree').value,
        });
        toast('论文题目已确定，继续下一步', 'ok');
        render(el);
      }));
  }

  if (step === 2) {
    async function generatePlan(feedback = '') {
      const current = normalizeResearchDesign(getProject().researchDesign, getProject());
      const btn = el.querySelector('#rd-plan-gen');
      setLoading(btn, true, '生成中…');
      el.querySelector('#rd-question-out').innerHTML = '<div class="topic-empty">AI 正在生成研究问题与方案建议…</div>';
      try {
        const reply = await chat([
          { role: 'system', content: `${SYSTEM} 只输出严格 JSON 对象。` },
          { role: 'user', content: `请基于下面的论文题目生成一个“低输入”的研究方案建议包。输出 JSON 对象，字段包括：
questions: [{id, question, object, variable, dataNeed, method}]
methods: [3个方法选项]
dataSources: [3个数据来源选项]
objectives: [3个研究目标]
researchGap: 1段研究空白
hypotheses: [2-3条待验证判断]
feasibility: {score, risks[], suggestions[]}

论文题目：${current.title || getProject().title}
研究想法：${current.initialIdea || '未提供'}
关键词：${current.keywords || '未提供'}
约束：${current.constraints || '无'}
研究对象：${current.population || '未提供'}
学位类型：${getProject().degreeType || '硕士论文'}
${feedback ? `用户对上一批方案的反馈：${feedback}\n请根据反馈调整研究问题、方法和数据来源，不要重复上一批同样的思路。` : ''}` },
        ], { temperature: 0.35, signal: topicSignal() });
        const parsed = parseJson(reply);
        const questions = normalizeQuestionCandidates(parsed.questions || []);
        const methodOptions = Array.isArray(parsed.methods) ? parsed.methods.filter(Boolean) : [];
        const dataOptions = Array.isArray(parsed.dataSources) ? parsed.dataSources.filter(Boolean) : [];
        if (!questions.length) throw new Error('AI 未返回有效研究问题');
        saveDesignPatch({
          questionCandidates: questions,
          selectedQuestionId: questions[0]?.id || '',
          methodOptions,
          selectedMethod: methodOptions[0] || '',
          dataOptions,
          selectedDataSource: dataOptions[0] || '',
          objectiveOptions: Array.isArray(parsed.objectives) ? parsed.objectives.filter(Boolean) : [],
          researchGap: parsed.researchGap || current.researchGap,
          hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses.filter(Boolean) : current.hypotheses,
          feasibility: {
            score: parsed.feasibility?.score || '',
            risks: Array.isArray(parsed.feasibility?.risks) ? parsed.feasibility.risks : [],
            suggestions: Array.isArray(parsed.feasibility?.suggestions) ? parsed.feasibility.suggestions : [],
          },
          currentStep: 2,
        });
        toast('研究方案候选已生成，选一个最合适的组合即可', 'ok');
        render(el);
      } catch (e) {
        if (isAbort(e)) return;
        toast(e.message, 'err', 3600);
      } finally {
        setLoading(btn, false);
      }
    }

    el.querySelector('#rd-plan-gen').addEventListener('click', () => generatePlan());
    el.querySelector('#rd-plan-feedback-submit')?.addEventListener('click', () => {
      const feedback = el.querySelector('#rd-plan-feedback')?.value.trim();
      if (!feedback) {
        toast('先告诉我哪里不满意，比如太泛、太虚、方法不合适', 'err');
        return;
      }
      generatePlan(feedback);
    });

    el.querySelectorAll('[data-select-question]').forEach(btn =>
      btn.addEventListener('click', () => {
        saveDesignPatch({ selectedQuestionId: btn.dataset.selectQuestion, currentStep: 2 });
        render(el);
      }));
    el.querySelectorAll('[data-select-method]').forEach(btn =>
      btn.addEventListener('click', () => {
        saveDesignPatch({ selectedMethod: btn.dataset.selectMethod, currentStep: 2 });
        render(el);
      }));
    el.querySelectorAll('[data-select-data]').forEach(btn =>
      btn.addEventListener('click', () => {
        saveDesignPatch({ selectedDataSource: btn.dataset.selectData, currentStep: 2 });
        render(el);
      }));

    el.querySelector('#rd-plan-save').addEventListener('click', () => {
      const current = normalizeResearchDesign(getProject().researchDesign, getProject());
      const question = selectedQuestion(current);
      const method = selectedMethod(current);
      const data = selectedDataSource(current);
      if (!question || !method || !data) {
        toast('请先各选一个研究问题、方法和数据来源', 'err');
        return;
      }
      saveDesignPatch({
        researchQuestions: [question],
        methods: [method],
        dataSources: [data],
        objectives: current.objectiveOptions.length ? current.objectiveOptions : current.objectives,
        currentStep: 3,
      });
      toast('研究方案已确定，继续生成大纲', 'ok');
      render(el);
    });
  }

  if (step === 3) {
    if (outlineOut) {
      const existingOutlineText = (getProject().outline || []).length
        ? getProject().outline.map(item => `${item.chapter}${(item.sections || []).length ? `\n${item.sections.map(sec => `  ${sec}`).join('\n')}` : ''}`).join('\n')
        : '';
      outlineOut.innerHTML = renderOutlinePreview(existingOutlineText);
      const copyBtn = el.querySelector('#outline-copy');
      const adoptBtn = el.querySelector('#outline-adopt');
      if (copyBtn) copyBtn.disabled = !existingOutlineText;
      if (adoptBtn) adoptBtn.disabled = !existingOutlineText;
    }

    el.querySelector('#outline-gen').addEventListener('click', async () => {
      const current = normalizeResearchDesign(getProject().researchDesign, getProject());
      const btn = el.querySelector('#outline-gen');
      setLoading(btn, true, '生成中…');
      outlineOut.innerHTML = '<div class="topic-empty">AI 正在生成论文大纲…</div>';
      try {
        const reply = await chat([
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `请为下面的论文研究方案生成规范的中文论文大纲。要求：输出五章结构，每章附 2-4 个二级标题，并让章节安排与研究问题、方法和数据来源一致。\n论文题目：${current.title || getProject().title}\n研究问题：${selectedQuestion(current)?.question || '未提供'}\n研究目标：${current.objectives.join('；') || '未提供'}\n研究空白：${current.researchGap || '未提供'}\n研究对象：${current.population || '未提供'}\n方法：${selectedMethod(current) || '未提供'}\n数据来源：${selectedDataSource(current) || '未提供'}\n待验证判断：${current.hypotheses.join('；') || '未提供'}\n\n输出格式示例：\n第1章 绪论\n  1.1 研究背景\n  1.2 研究意义` },
        ], { temperature: 0.4, signal: topicSignal() });
        outlineOut.innerHTML = renderOutlinePreview(reply);
        outlineOut.dataset.outlineText = reply;
        el.querySelector('#outline-copy').disabled = false;
        el.querySelector('#outline-adopt').disabled = false;
      } catch (e) {
        if (isAbort(e)) return;
        outlineOut.innerHTML = `<div class="topic-empty">❌ ${escapeHtml(e.message)}</div>`;
        toast(e.message, 'err', 3600);
      } finally {
        setLoading(btn, false);
      }
    });

    el.querySelector('#outline-copy').addEventListener('click', () => {
      const text = outlineOut?.dataset.outlineText || outlineOut?.textContent || '';
      if (!text.trim()) {
        toast('请先生成大纲', 'err');
        return;
      }
      copyText(text.trim());
    });

    el.querySelector('#outline-adopt').addEventListener('click', () => {
      const text = outlineOut?.dataset.outlineText || outlineOut?.textContent || '';
      if (!text.trim()) {
        toast('请先生成大纲', 'err');
        return;
      }
      const chapters = adoptOutline(text.trim());
      if (!chapters.length) {
        toast('大纲解析失败：未识别到「第X章」格式，请重新生成一次', 'err', 4000);
        return;
      }
      const current = normalizeResearchDesign(getProject().researchDesign, getProject());
      saveDesignPatch({
        researchQuestions: selectedQuestion(current) ? [selectedQuestion(current)] : current.researchQuestions,
        methods: selectedMethod(current) ? [selectedMethod(current)] : current.methods,
        dataSources: selectedDataSource(current) ? [selectedDataSource(current)] : current.dataSources,
        confirmedAt: current.confirmedAt || new Date().toISOString(),
        currentStep: 3,
      });
      updateBasics({ title: current.title || getProject().title, degreeType: getProject().degreeType });
      toast(`已采用大纲（${chapters.length} 章），可以开始正式写作`, 'ok');
      render(el);
    });

    renderLitSearch(el.querySelector('#topic-lit'), {
      defaultQuery: design.title || project.title,
      batchFrom: { title: design.title || project.title, chapters: project.outline.map(c => c.chapter) },
    });
  }
}

export default {
  id: 'topic',
  icon: '🧭',
  title: '研究设计',
  subtitle: '把论文想法变成可执行的研究方案',
  projectScoped: true,
  render,
};
