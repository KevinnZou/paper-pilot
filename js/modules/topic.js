import { toast, copyText, integrityNote, escapeHtml, setLoading } from '../ui.js';
import { chat, shouldUseLiveAI } from '../api.js';
import { getProject, adoptOutline, parseOutline, updateBasics, saveProject } from '../project.js';
import { ICONS } from '../icons.js';
import { meaningfulTitle, isPlaceholderTitle } from '../title-utils.js';

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

const TEXT_KEYS = [
  'label', 'name', 'title', 'value', 'text', 'content', 'summary',
  'focus', 'objective', 'strategy', 'suggestion', 'scope', 'answer',
  'question', 'method', 'dataSource', 'data', 'description',
];

function textFromUnknown(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join('；');
  if (value && typeof value === 'object') {
    for (const key of TEXT_KEYS) {
      const text = textFromUnknown(value[key]);
      if (text) return text;
    }
    for (const item of Object.values(value)) {
      const text = textFromUnknown(item);
      if (text) return text;
    }
  }
  return '';
}

function objectFromWrappedAI(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  for (const key of ['data', 'result', 'results', 'payload', 'researchDesign', 'plan']) {
    if (data[key] && typeof data[key] === 'object') return data[key];
  }
  return data;
}

function arrayFromAI(data, keys = []) {
  if (Array.isArray(data)) return data;
  const source = objectFromWrappedAI(data);
  if (!source || typeof source !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key];
  }
  return [];
}

function planFromAI(data) {
  const source = objectFromWrappedAI(data);
  if (Array.isArray(source)) return { questions: source };
  return (source && typeof source === 'object') ? source : {};
}

function stableId(value, fallback) {
  const text = textFromUnknown(value);
  return text || fallback;
}

function fallbackScopeOptions(current, questions = []) {
  const title = resolvedResearchTitle(current, getProject()) || current.title || '当前题目';
  const firstQuestion = questions[0]?.question || selectedQuestion(current)?.question || title;
  if (/采购|供应链/.test(`${title} ${firstQuestion}`)) {
    return ['只聚焦采购规范化环节', '只比较 2-3 家装修企业的采购流程', '只讨论 AI 对采购执行效率和合规性的影响'];
  }
  if (/流程|标准|规范/.test(`${title} ${firstQuestion}`)) {
    return ['只聚焦标准化流程执行效果', '只分析施工交付前后的流程变化', '只选 2-3 个高频业务流程做案例'];
  }
  return ['只聚焦一个核心业务场景', '只比较 2-3 个可获得资料的案例', '只讨论最容易被数据支撑的影响路径'];
}

function outlineTextFromAI(reply) {
  const raw = String(reply || '').trim();
  if (!raw) return '';
  try {
    const parsed = parseJson(raw);
    const source = objectFromWrappedAI(parsed);
    const direct = textFromUnknown(source?.outlineText || source?.outline || source?.content);
    if (direct) return direct;
    const chapters = arrayFromAI(source, ['chapters', 'outline', 'items']);
    if (chapters.length) {
      return chapters.map((chapter, idx) => {
        const title = textFromUnknown(chapter?.chapter || chapter?.title || chapter?.name || chapter);
        const heading = /^第.+章/.test(title) ? title : `第${idx + 1}章 ${title || '章节'}`;
        const sections = normalizeOptionStrings(chapter?.sections || chapter?.subsections || chapter?.items || []);
        return `${heading}${sections.length ? `\n${sections.map(section => `  ${section}`).join('\n')}` : ''}`;
      }).join('\n');
    }
  } catch {
    // 纯文本大纲是最常见返回，JSON 解析失败时直接按原文处理。
  }
  return raw;
}

function normalizeOptionStrings(list = []) {
  return Array.isArray(list)
    ? list.map(item => {
        return textFromUnknown(item);
      }).filter(Boolean)
    : [];
}

function normalizeTitleCandidates(list = []) {
  const items = arrayFromAI(list, ['titles', 'titleCandidates', 'candidates', 'options', 'items']);
  const seen = new Set();
  return items.length
    ? items.map((item, idx) => {
        const title = textFromUnknown(item?.title || item?.name || item);
        const rawId = stableId(item?.id, `title-${idx + 1}`);
        const id = seen.has(rawId) ? `title-${idx + 1}` : rawId;
        seen.add(id);
        return {
          id,
          title,
          feasibility: textFromUnknown(item?.feasibility || item?.note || item?.reason || item?.rationale),
          innovation: textFromUnknown(item?.innovation || item?.highlight || item?.novelty),
        };
      }).filter(item => item.title)
    : [];
}

function normalizeQuestionCandidates(list = []) {
  const items = arrayFromAI(list, ['questions', 'researchQuestions', 'questionCandidates', 'candidates', 'options', 'items']);
  const seen = new Set();
  return items.length
    ? items.map((item, idx) => {
        const question = textFromUnknown(item?.question || item?.title || item);
        const rawId = stableId(item?.id, `rq-${idx + 1}`);
        const id = seen.has(rawId) ? `rq-${idx + 1}` : rawId;
        seen.add(id);
        return {
          id,
          question,
          object: textFromUnknown(item?.object || item?.population),
          variable: textFromUnknown(item?.variable || item?.variables),
          answerability: textFromUnknown(item?.answerability || item?.feasibility),
          dataNeed: textFromUnknown(item?.dataNeed || item?.data || item?.dataSource),
          method: textFromUnknown(item?.method),
        };
      }).filter(item => item.question)
    : [];
}

function resolvedResearchTitle(design = {}, project = getProject()) {
  return meaningfulTitle(design.title, project.title);
}

function normalizeResearchDesign(design = {}, project = getProject()) {
  const designTitle = isPlaceholderTitle(design.title) ? '' : design.title;
  const projectTitle = isPlaceholderTitle(project.title) ? '' : project.title;
  return {
    currentStep: Number(design.currentStep) || 1,
    stepTouched: !!design.stepTouched,
    initialIdea: design.initialIdea || '',
    title: designTitle || projectTitle || '',
    keywords: design.keywords || '',
    constraints: design.constraints || '',
    population: design.population || '',
    titleCandidates: normalizeTitleCandidates(design.titleCandidates),
    selectedTitleId: textFromUnknown(design.selectedTitleId),
    planStatus: design.planStatus || 'idle',
    planError: design.planError || '',
    planCursor: Number.isFinite(Number(design.planCursor)) ? Number(design.planCursor) : 0,
    outlineStatus: design.outlineStatus || 'idle',
    outlineError: design.outlineError || '',
    researchQuestions: normalizeQuestionCandidates(design.researchQuestions),
    questionCandidates: normalizeQuestionCandidates(design.questionCandidates),
    selectedQuestionId: textFromUnknown(design.selectedQuestionId),
    researchGap: textFromUnknown(design.researchGap),
    gapSources: normalizeOptionStrings(design.gapSources),
    objectives: normalizeOptionStrings(design.objectives),
    objectiveOptions: normalizeOptionStrings(design.objectiveOptions),
    selectedObjectiveFocus: textFromUnknown(design.selectedObjectiveFocus),
    customPromptValues: (design.customPromptValues && typeof design.customPromptValues === 'object') ? design.customPromptValues : {},
    variables: normalizeOptionStrings(design.variables),
    hypotheses: normalizeOptionStrings(design.hypotheses),
    methods: normalizeOptionStrings(design.methods),
    methodOptions: normalizeOptionStrings(design.methodOptions),
    selectedMethod: textFromUnknown(design.selectedMethod),
    dataSources: normalizeOptionStrings(design.dataSources),
    dataOptions: normalizeOptionStrings(design.dataOptions),
    selectedDataSource: textFromUnknown(design.selectedDataSource),
    feasibility: {
      score: textFromUnknown(design.feasibility?.score),
      risks: normalizeOptionStrings(design.feasibility?.risks),
      suggestions: normalizeOptionStrings(design.feasibility?.suggestions),
    },
    selectedRiskStrategy: textFromUnknown(design.selectedRiskStrategy),
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
  const title = patch.title ?? current.title ?? (isPlaceholderTitle(project.title) ? '' : project.title);
  saveProject({ researchDesign: next, ...(title && !isPlaceholderTitle(title) ? { title } : {}) });
  return next;
}

function customPromptValue(design, key) {
  return textFromUnknown(design.customPromptValues && typeof design.customPromptValues === 'object' && design.customPromptValues[key]);
}

function planReady(design) {
  return !!(design.researchQuestions.length && design.methods.length && design.dataSources.length);
}

function maxAvailableStep(design, project) {
  if ((project.outline || []).length) return 3;
  if (planReady(design)) return 3;
  if (resolvedResearchTitle(design, project)) return 2;
  return 1;
}

function currentStep(design, project) {
  const max = maxAvailableStep(design, project);
  // 首次进入向导（用户未手动切过步）时，若项目已推进到更高阶段，默认落在已达成阶段，
  // 避免"已有题目/大纲却看起来要从零再来"；用户手动切步后（stepTouched）尊重其选择。
  if (!design.stepTouched && max > 1) return max;
  return Math.min(Math.max(design.currentStep || 1, 1), max);
}

function selectedQuestion(design) {
  const selectedId = textFromUnknown(design.selectedQuestionId);
  return design.questionCandidates.find(item => textFromUnknown(item.id) === selectedId)
    || design.researchQuestions[0]
    || (customPromptValue(design, 'question') ? { id: 'rq-custom', question: customPromptValue(design, 'question'), object: '自定义主问题', variable: '', dataNeed: '', method: '' } : null)
    || null;
}

function selectedMethod(design) {
  return design.selectedMethod || customPromptValue(design, 'method') || design.methods[0] || '';
}

function selectedDataSource(design) {
  return design.selectedDataSource || customPromptValue(design, 'data') || design.dataSources[0] || '';
}

function selectedObjectiveFocus(design) {
  return design.selectedObjectiveFocus || customPromptValue(design, 'objective') || design.objectiveOptions[0] || '';
}

function selectedRiskStrategy(design) {
  return design.selectedRiskStrategy || customPromptValue(design, 'strategy') || design.feasibility.suggestions[0] || '';
}

function renderTitleCards(design) {
  if (!design.titleCandidates.length) {
    return '<div class="topic-empty">生成后会在这里出现 4-5 个候选题目，每个都能直接设为主线。</div>';
  }
  return `<div class="topic-choice-list">${design.titleCandidates.map((item, idx) => `
    <article class="topic-choice-card ${textFromUnknown(design.selectedTitleId) === textFromUnknown(item.id) ? 'selected' : ''}">
      <div class="topic-choice-head">
        <span class="chip ref-no">${idx + 1}</span>
        ${textFromUnknown(design.selectedTitleId) === textFromUnknown(item.id) ? '<span class="chip done">当前主线</span>' : ''}
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      ${item.feasibility ? `<p><b>可行性</b>${escapeHtml(item.feasibility)}</p>` : ''}
      ${item.innovation ? `<p><b>创新点</b>${escapeHtml(item.innovation)}</p>` : ''}
      <div class="result-actions">
        <button class="btn" data-select-title="${escapeHtml(item.id)}">选这个题目</button>
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

function renderPlanSummary(design) {
  const question = selectedQuestion(design);
  const method = selectedMethod(design);
  const data = selectedDataSource(design);
  const planIncomplete = !(question?.question || method || data);
  return `
    ${planIncomplete ? `<div class="topic-summary-notice">研究方案（研究问题/方法/数据来源）尚未单独设定。若已选定大纲可直接采用，或回到「定方案」步完善。 <button class="btn btn-ghost btn-sm" type="button" data-go-step="2">去定方案</button></div>` : ``}
    <div class="topic-summary-grid">
      <div class="topic-summary-item">
        <span>论文题目</span>
        <b>${escapeHtml(design.title || '未设定')}</b>
      </div>
      <div class="topic-summary-item">
        <span>研究问题</span>
        <b>${escapeHtml(question?.question || '未单独设定')}</b>
      </div>
      <div class="topic-summary-item">
        <span>研究方法</span>
        <b>${escapeHtml(method || '未单独设定')}</b>
      </div>
      <div class="topic-summary-item">
        <span>数据来源</span>
        <b>${escapeHtml(data || '未单独设定')}</b>
      </div>
    </div>
    ${design.objectives.length ? `<div class="topic-mini-block"><h4>研究目标</h4><ul>${design.objectives.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
    ${design.researchGap ? `<div class="topic-mini-block"><h4>研究空白</h4><p>${escapeHtml(design.researchGap)}</p></div>` : ''}
    ${design.hypotheses.length ? `<div class="topic-mini-block"><h4>待验证判断</h4><ul>${design.hypotheses.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}`;
}

function planPrompts(design) {
  return [
    {
      key: 'question',
      title: '你这篇论文最想回答哪个主问题？',
      desc: '先定主问题，后面的方法、数据和大纲都会围绕它展开。',
      answered: !!selectedQuestion(design)?.question,
      summary: selectedQuestion(design)?.question || '',
      customPlaceholder: '例如：AI 如何提升装修企业标准化流程的执行效率？',
    },
    {
      key: 'method',
      title: '你打算怎么研究这个问题？',
      desc: '优先选你最容易真的做出来的方法。',
      answered: !!selectedMethod(design),
      summary: selectedMethod(design),
      customPlaceholder: '例如：文本分析法 / 扎根理论 / 问卷调查',
    },
    {
      key: 'data',
      title: '你最有把握拿到哪类数据？',
      desc: '数据可获得性比“看起来高级”更重要。',
      answered: !!selectedDataSource(design),
      summary: selectedDataSource(design),
      customPlaceholder: '例如：行业报告、企业内部数据、访谈纪要',
    },
    ...(design.feasibility.suggestions.length ? [{
      key: 'strategy',
      title: '你希望论文范围主要收在哪一处？',
      desc: '明确写作边界，大纲会按这个范围展开。',
      answered: !!selectedRiskStrategy(design),
      summary: selectedRiskStrategy(design),
      customPlaceholder: '例如：只聚焦采购环节 / 只分析两家案例企业',
    }] : []),
  ];
}

function currentPlanPrompt(design) {
  const prompts = planPrompts(design);
  const fallback = prompts.findIndex(item => !item.answered);
  const preferred = Number.isFinite(Number(design.planCursor)) ? Number(design.planCursor) : (fallback === -1 ? prompts.length - 1 : fallback);
  const index = Math.max(0, Math.min(preferred, Math.max(prompts.length - 1, 0)));
  return { prompts, index, current: prompts[index] || null };
}

function renderPromptProgress(design) {
  const { prompts, index } = currentPlanPrompt(design);
  return `<div class="topic-prompt-progress">
    ${prompts.map((item, idx) => {
      const classes = ['topic-prompt-chip', item.answered ? 'done' : '', idx === index ? 'current' : ''].filter(Boolean).join(' ');
      return `
      <button class="${classes}" data-go-plan-prompt="${idx}" type="button" title="${escapeHtml(item.summary || item.title)}">
        <span class="topic-prompt-no">${idx + 1}</span>
        <span>${escapeHtml(item.key === 'question' ? '主问题' : item.key === 'method' ? '方法' : item.key === 'data' ? '数据' : item.key === 'objective' ? '侧重点' : '范围')}</span>
      </button>`;
    }).join('')}
  </div>`;
}

function renderQuestionOptions(design) {
  return `<div class="topic-option-list">${design.questionCandidates.map((item, idx) => `
    <button class="topic-option-card ${textFromUnknown(design.selectedQuestionId) === textFromUnknown(item.id) ? 'selected' : ''}" data-select-question="${escapeHtml(item.id)}" type="button">
      <div class="topic-option-line">
        <span class="topic-option-no">${idx + 1}</span>
        <strong>${escapeHtml(item.question)}</strong>
        ${textFromUnknown(design.selectedQuestionId) === textFromUnknown(item.id) ? '<span class="chip done">已选</span>' : ''}
      </div>
    </button>`).join('')}</div>`;
}

function renderTextOptions(options, selected, attr) {
  return `<div class="topic-option-list compact">${options.map(item => `
    <button class="topic-option-card compact ${selected === item ? 'selected' : ''}" data-${attr}="${escapeHtml(item)}" type="button">
      <strong>${escapeHtml(item)}</strong>
    </button>`).join('')}</div>`;
}

function renderPlanQuestionnaire(design) {
  const { current, prompts, index } = currentPlanPrompt(design);
  if (!current) return '';
  const isLast = index === prompts.length - 1;
  const canConfirm = prompts.every(item => item.answered);
  let optionsHtml = '';
  if (current.key === 'question') optionsHtml = renderQuestionOptions(design);
  else if (current.key === 'method') optionsHtml = renderTextOptions(design.methodOptions, selectedMethod(design), 'select-method');
  else if (current.key === 'data') optionsHtml = renderTextOptions(design.dataOptions, selectedDataSource(design), 'select-data');
  else if (current.key === 'objective') optionsHtml = renderTextOptions(design.objectiveOptions, selectedObjectiveFocus(design), 'select-objective');
  else if (current.key === 'strategy') optionsHtml = renderTextOptions(design.feasibility.suggestions, selectedRiskStrategy(design), 'select-strategy');
  const customValue = customPromptValue(design, current.key);
  const customSelected = customValue && customValue === current.summary;
  return `
    ${renderPromptProgress(design)}
    <section class="topic-prompt-card">
      <div class="topic-prompt-head">
        <span class="topic-prompt-kicker">当前问题</span>
        <h3>${escapeHtml(current.title)}</h3>
        <p class="desc">${escapeHtml(current.desc)}</p>
      </div>
      ${optionsHtml}
      <div class="topic-custom-answer">
        <label class="field-label" for="rd-custom-${escapeHtml(current.key)}">或者直接写你自己的答案 ${customSelected ? '<span class="chip done">已使用</span>' : ''}</label>
        <div class="topic-custom-row">
          <input id="rd-custom-${escapeHtml(current.key)}" type="text" value="${escapeHtml(customValue)}" placeholder="${escapeHtml(current.customPlaceholder || '输入你的自定义答案')}">
          <button class="btn btn-ghost btn-sm" data-custom-submit="${escapeHtml(current.key)}">使用这个答案</button>
        </div>
      </div>
      <div class="topic-prompt-actions">
        ${index > 0 ? '<button class="btn btn-ghost btn-sm" id="rd-plan-prev" type="button">上一题</button>' : '<span></span>'}
        ${isLast ? `<button class="btn btn-sm" id="rd-plan-finish" type="button" ${canConfirm ? '' : 'disabled'}>确认进入大纲</button>` : ''}
      </div>
      <div class="topic-inline-error" id="rd-plan-finish-error" hidden></div>
    </section>`;
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

function outlineChapterCount(text) {
  // 与"采用"时用的 parseOutline 同源，保证弹窗显示"已识别 N 章"与实际写入一致
  return parseOutline(text).length;
}

function renderStepNav(step, maxStep, project, design) {
  const labels = ['确定题目', '确定方案', '生成大纲'];
  return `<div class="topic-stage-nav">
    ${labels.map((label, idx) => {
      const n = idx + 1;
      const enabled = n <= maxStep;
      const status = step === n ? 'current' : (n < step || (n === 1 && resolvedResearchTitle(design, project)) || (n === 2 && planReady(design)) || (n === 3 && (project.outline || []).length)) ? 'done' : '';
      return `<button class="topic-stage-tab ${status}" data-go-step="${n}" ${enabled ? '' : 'disabled'} type="button">
        <span class="topic-stage-index">${n}</span>
        <span>${label}</span>
      </button>`;
    }).join('')}
  </div>`;
}

function mockTitles({ idea, keywords, constraints }) {
  const hint = `${idea} ${keywords} ${constraints}`;
  if (/装修|标准|规范|采购|数字化/.test(hint)) {
    return [
      {
        id: 'title-1',
        title: '装修行业数字化转型中的 AI 赋能路径与规范化效应研究',
        feasibility: '可结合企业访谈、流程制度和采购资料展开，数据抓取难度适中。',
        innovation: '把 AI 从工具层提升到行业规范化与管理流程重构层面讨论。',
      },
      {
        id: 'title-2',
        title: 'AI 驱动下装修企业标准化管理机制优化研究',
        feasibility: '题目边界清晰，适合采用案例研究与访谈结合的方式推进。',
        innovation: '聚焦标准化管理机制，而不是泛泛讨论数字化转型。',
      },
      {
        id: 'title-3',
        title: '基于 AI 赋能的装修企业采购规范化路径研究',
        feasibility: '采购流程通常更容易找到可观察样本，适合硕士论文体量。',
        innovation: '把采购规范化作为切入口，更容易落到可验证的流程层面。',
      },
      {
        id: 'title-4',
        title: 'AI 介入装修行业流程标准化的作用机制与实践路径研究',
        feasibility: '适合多案例比较，兼顾理论分析与实践建议。',
        innovation: '同时讨论作用机制与实践路径，利于后续生成完整五章结构。',
      },
    ];
  }
  return [
    {
      id: 'title-1',
      title: '基于人工智能赋能的行业数字化转型路径研究',
      feasibility: '适合案例研究或访谈法，资料获取难度中等。',
      innovation: '从赋能路径切入，便于后续拆成机制、条件与建议三个层面。',
    },
    {
      id: 'title-2',
      title: '人工智能技术在组织管理优化中的应用机制研究',
      feasibility: '题目较稳，适合管理类论文常用结构。',
      innovation: '把技术应用和组织管理机制直接联结，便于后续展开研究问题。',
    },
    {
      id: 'title-3',
      title: 'AI 驱动下企业流程重构与绩效提升研究',
      feasibility: '适合围绕具体流程场景展开，不必追求大样本。',
      innovation: '将流程重构与绩效提升放在同一主线中，更贴近实务。',
    },
    {
      id: 'title-4',
      title: '人工智能赋能业务规范化管理的实现路径研究',
      feasibility: '可围绕制度文本、流程资料和访谈构建论证。',
      innovation: '更强调规范化管理这一管理学视角，而非纯技术视角。',
    },
  ];
}

function mockOutline(current) {
  const title = current.title || '论文题目';
  const method = selectedMethod(current) || '案例研究法';
  const data = selectedDataSource(current) || '企业访谈资料';
  return `第1章 绪论
  1.1 研究背景
  1.2 研究意义
  1.3 研究思路与结构安排
第2章 理论基础与文献综述
  2.1 核心概念界定
  2.2 理论基础
  2.3 国内外研究现状
第3章 研究设计
  3.1 研究问题与分析框架
  3.2 研究方法：${method}
  3.3 数据来源：${data}
第4章 ${title}的实证/案例分析
  4.1 现状与问题识别
  4.2 关键影响机制分析
  4.3 优化路径与实施条件
第5章 结论与建议
  5.1 研究结论
  5.2 管理建议
  5.3 不足与展望`;
}

function render(el) {
  const project = getProject();
  const design = normalizeResearchDesign(project.researchDesign, project);
  const activeTitle = resolvedResearchTitle(design, project);
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
            <p class="desc">描述研究想法与限制条件，AI 会给出题目候选，你只需挑选最合适的。</p>
          </div>
          <div class="topic-head-side">
            <span class="chip doing">当前阶段</span>
          </div>
        </div>
        <div class="topic-wizard-grid">
          <div class="topic-primary-panel">
            ${activeTitle ? `<div class="topic-already">你已定题：<b>${escapeHtml(activeTitle)}</b>。可在此基础上细化研究想法，或直接进入下一步。</div>` : ''}
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
            <div class="result-actions topic-form-actions">
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
    const hasPlanSuggestions = design.planStatus === 'ready' && design.questionCandidates.length;
    body = `
      <section class="card topic-wizard-card">
        <div class="topic-wizard-head">
          <div>
            <div class="topic-step-label">Step 2</div>
            <h2><span class="mark"></span>从方案候选里做选择</h2>
            <p class="desc">确认 AI 基于题目给出的研究问题、方法与数据来源组合。</p>
          </div>
          <div class="topic-head-side">
            ${hasPlanSuggestions ? '<button class="btn btn-ghost btn-sm" id="rd-plan-regen" type="button">重新生成方案</button>' : ''}
            <span class="chip doing">当前阶段</span>
          </div>
        </div>
        <div class="topic-current-line">
          <span class="chip done">当前题目</span>
          <strong>${escapeHtml(activeTitle)}</strong>
        </div>
        ${design.planStatus === 'loading' ? '<div class="topic-empty">正在根据已选题目生成研究方案建议…</div>' : ''}
        ${design.planStatus === 'error' ? `<div class="topic-empty">研究方案生成失败：${escapeHtml(design.planError || '请稍后重试')}<div class="result-actions topic-retry-actions"><button class="btn btn-ai-solid" id="rd-plan-retry">重新生成研究方案</button></div></div>` : ''}
        ${hasPlanSuggestions ? `
        <section class="topic-candidate-section">
          <div class="topic-candidate-head">
            <h3>像答问卷一样把方案定下来</h3>
            <p class="desc">一次一个问题，点选答案即可进入下一问。</p>
          </div>
          ${renderPlanQuestionnaire(design)}
        </section>
        ` : (design.planStatus === 'idle' ? '<div class="topic-empty">正在准备研究方案问卷…</div>' : '')}
      </section>`;
  } else {
    const adopted = !!project.outline.length;
    const adoptedText = (project.outline || []).map(item => `${item.chapter}${(item.sections || []).length ? `\n${item.sections.map(s => `  ${s}`).join('\n')}` : ''}`).join('\n');
    body = adopted ? `
      <section class="card topic-wizard-card">
        <div class="topic-wizard-head">
          <div>
            <div class="topic-step-label">Step 3</div>
            <h2><span class="mark"></span>已采用论文大纲</h2>
            <p class="desc">大纲已采用到写作工作台。调整章节结构请直接在「写作工作台」进行（可新增、改名、调序、删除章节）。</p>
          </div>
          <div class="topic-head-side"><span class="chip done">大纲已采用</span></div>
        </div>
        <div class="result-actions topic-adopted-actions">
          <button class="btn" id="adopted-go-writing">去写作工作台</button>
        </div>
        <details class="topic-outline-preview" open>
          <summary>当前大纲</summary>
          <div id="outline-out">${renderOutlinePreview(adoptedText)}</div>
        </details>
      </section>` : `
      <section class="card topic-wizard-card">
        <div class="topic-wizard-head">
          <div>
            <div class="topic-step-label">Step 3</div>
            <h2><span class="mark"></span>生成并采用论文大纲</h2>
            <p class="desc">下面已按研究方案自动生成一版大纲。你可以直接修改章节，确认后一次性采用到写作工作台。</p>
          </div>
          <div class="topic-head-side">
            <span class="chip ${project.outline.length ? 'done' : 'doing'}">${project.outline.length ? '大纲已采用' : '当前阶段'}</span>
          </div>
        </div>
        <section class="topic-candidate-section">
          <div class="topic-candidate-head topic-candidate-head-actions">
            <div>
              <h3>生成并微调大纲</h3>
              <p class="desc">已自动生成一版，直接改文字即可；不满意可「重新生成」。</p>
            </div>
            <div class="topic-outline-actions">
              <button class="btn btn-ghost btn-sm" id="outline-gen">重新生成</button>
              <button class="btn btn-ghost btn-sm" id="outline-copy">复制文本</button>
              <button class="btn btn-sm" id="outline-adopt">采用大纲</button>
            </div>
          </div>
          ${design.outlineStatus === 'loading' ? '<div class="topic-empty topic-state-note">正在根据已选方案生成论文大纲，请稍等…</div>' : ''}
          ${design.outlineStatus === 'error' ? `<div class="topic-empty topic-state-note">大纲生成失败：${escapeHtml(design.outlineError || '请稍后重试')}<div class="result-actions topic-retry-actions"><button class="btn btn-ai-solid btn-sm" id="outline-gen-retry">重新生成大纲</button></div></div>` : ''}
          <details class="topic-outline-preview">
            <summary>预览大纲结构</summary>
            <div id="outline-out">${renderOutlinePreview('')}</div>
          </details>
          <div class="topic-outline-editor">
            <label class="field-label" for="outline-editor">编辑大纲（可直接改章节名、增删二级标题）</label>
            <textarea id="outline-editor" class="topic-outline-textarea" placeholder="正在生成大纲…"></textarea>
          </div>
        </section>
        ${integrityNote()}
      </section>
      <div class="modal-backdrop" id="outline-confirm" hidden>
        <div class="modal-panel oc-modal">
          <div class="oc-modal-head">
            <div>
              <h2>确认方案与大纲</h2>
              <p class="desc">确认后将一次性应用到写作工作台。</p>
            </div>
            <button class="btn btn-ghost btn-sm icon-only" id="oc-close" type="button" aria-label="关闭">${ICONS.close}</button>
          </div>
          <div id="oc-conflict"></div>
          <div class="oc-modal-label">研究方案</div>
          <div id="oc-plan" class="oc-plan"></div>
          <div class="oc-modal-label">论文大纲</div>
          <div id="oc-outline" class="oc-outline"></div>
          <div class="result-actions">
            <button class="btn" id="oc-confirm">确认并进入写作台</button>
            <button class="btn btn-ghost" id="oc-cancel">取消</button>
          </div>
        </div>
      </div>`;
  }

  el.innerHTML = `
    <div class="card topic-shell-card">
      <div class="topic-shell-head">
        <div>
          <h2><span class="mark"></span>研究设计向导</h2>
          <p class="desc">按论文推进顺序完成：先定题，再定方案，最后出大纲。</p>
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
      saveDesignPatch({ currentStep: next, stepTouched: true });
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
        let parsed;
        if (shouldUseLiveAI()) {
          const reply = await chat([
            { role: 'system', content: `${SYSTEM} 只输出严格 JSON 数组。` },
            { role: 'user', content: `请围绕下面的研究设想生成 4 个中文论文题目候选。每项字段：title, feasibility, innovation。\n研究想法：${idea || '未提供'}\n关键词：${keywords || '未提供'}\n约束：${constraints || '无'}\n学位类型：${degreeType}\n研究对象：${population || '未提供'}\n${feedback ? `用户对上一批候选的反馈：${feedback}\n请根据反馈明显调整方向，不要只是换几个近义词。` : ''}` },
          ], { temperature: 0.6, signal: topicSignal(), timeoutMs: 60000 });
          parsed = normalizeTitleCandidates(parseJson(reply));
        } else {
          parsed = mockTitles({ idea, keywords, constraints });
        }
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
        titleOut.innerHTML = `<div class="topic-empty">题目候选生成失败：${escapeHtml(e.message)}</div>`;
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
          planStatus: 'idle',
          planError: '',
          planCursor: 0,
          researchQuestions: [],
          questionCandidates: [],
          selectedQuestionId: '',
          researchGap: '',
          objectives: [],
          objectiveOptions: [],
          selectedObjectiveFocus: '',
          hypotheses: [],
          methods: [],
          methodOptions: [],
          selectedMethod: '',
          dataSources: [],
          dataOptions: [],
          selectedDataSource: '',
          feasibility: { score: '', risks: [], suggestions: [] },
          selectedRiskStrategy: '',
          customPromptValues: {},
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
      const btn = el.querySelector('#rd-plan-gen') || el.querySelector('#rd-plan-retry');
      if (btn) setLoading(btn, true, '生成中…');
      saveDesignPatch({ planStatus: 'loading', planError: '', currentStep: 2 });
      render(el);
      try {
        let parsed;
        if (shouldUseLiveAI()) {
          const reply = await chat([
          { role: 'system', content: `${SYSTEM} 只输出严格 JSON 对象。` },
          { role: 'user', content: `请基于下面的论文题目生成一个“低输入”的研究方案建议包。必须紧扣论文题目，不要给泛泛的管理建议。输出 JSON 对象，字段包括：
questions: [{id, question, object, variable, dataNeed, method}]
methods: [3个方法选项]
dataSources: [3个数据来源选项]
objectives: [3个研究目标]
researchGap: 1段研究空白
hypotheses: [2-3条待验证判断]
feasibility: {score, risks[], suggestions[]}

其中 feasibility.suggestions 必须是 3 个“范围边界选项”，例如“只聚焦采购规范化环节”“只比较 2-3 家中小型装修企业”“只讨论标准化流程执行效果”。不要输出对象嵌套对象；每个选项尽量是一句可点击的短文本。

论文题目：${resolvedResearchTitle(current, getProject()) || '未提供'}
研究想法：${current.initialIdea || '未提供'}
关键词：${current.keywords || '未提供'}
约束：${current.constraints || '无'}
研究对象：${current.population || '未提供'}
学位类型：${getProject().degreeType || '硕士论文'}
${feedback ? `用户对上一批方案的反馈：${feedback}\n请根据反馈调整研究问题、方法和数据来源，不要重复上一批同样的思路。` : ''}` },
          ], { temperature: 0.35, signal: topicSignal(), timeoutMs: 60000 });
          parsed = parseJson(reply);
        } else {
          parsed = mockPlan(current, feedback);
        }
        const plan = planFromAI(parsed);
        const questions = normalizeQuestionCandidates(plan.questions || plan.researchQuestions || plan.questionCandidates || []);
        const methodOptions = normalizeOptionStrings(plan.methods || plan.methodOptions || []);
        const dataOptions = normalizeOptionStrings(plan.dataSources || plan.dataOptions || []);
        const feasibility = plan.feasibility && typeof plan.feasibility === 'object' ? plan.feasibility : {};
        const scopeOptions = normalizeOptionStrings(feasibility.suggestions || plan.scopeOptions || plan.boundaries);
        if (!questions.length) throw new Error('AI 未返回有效研究问题');
        saveDesignPatch({
          planStatus: 'ready',
          planError: '',
          questionCandidates: questions,
          planCursor: 0,
          selectedQuestionId: '',
          methodOptions,
          selectedMethod: '',
          dataOptions,
          selectedDataSource: '',
          objectiveOptions: normalizeOptionStrings(plan.objectives || plan.objectiveOptions),
          selectedObjectiveFocus: '',
          researchGap: textFromUnknown(plan.researchGap) || current.researchGap,
          hypotheses: normalizeOptionStrings(plan.hypotheses).length ? normalizeOptionStrings(plan.hypotheses) : current.hypotheses,
          feasibility: {
            score: textFromUnknown(feasibility.score),
            risks: normalizeOptionStrings(feasibility.risks),
            suggestions: scopeOptions.length ? scopeOptions : fallbackScopeOptions(current, questions),
          },
          selectedRiskStrategy: '',
          customPromptValues: {},
          currentStep: 2,
        });
        toast('研究方案候选已生成，继续按问卷往下选即可', 'ok');
        render(el);
      } catch (e) {
        if (isAbort(e)) return;
        saveDesignPatch({ planStatus: 'error', planError: e.message, currentStep: 2 });
        toast(e.message, 'err', 3600);
        render(el);
      } finally {
        if (btn) setLoading(btn, false);
      }
    }

    function maybeAdvancePlanFlow(nextDesign) {
      const current = normalizeResearchDesign(nextDesign, getProject());
      const { prompts, index } = currentPlanPrompt(current);
      if (index < prompts.length - 1) {
        saveDesignPatch({ planCursor: index + 1, currentStep: 2 });
      }
      render(el);
    }

    function showPlanFinishError(message) {
      const box = el.querySelector('#rd-plan-finish-error');
      if (box) {
        box.hidden = false;
        box.textContent = message;
      }
      toast(message, 'err', 3600);
    }

    function finishPlanFlow(btn) {
      try {
        if (btn) setLoading(btn, true, '进入中…');
        const current = normalizeResearchDesign(getProject().researchDesign, getProject());
        const { prompts } = currentPlanPrompt(current);
        const done = prompts.every(item => item.answered);
        if (!done) {
          showPlanFinishError('还有问题没选完，先把这一轮答完');
          if (btn) setLoading(btn, false);
          return;
        }
        const question = selectedQuestion(current);
        const method = selectedMethod(current);
        const data = selectedDataSource(current);
        const objective = selectedObjectiveFocus(current);
        if (!question?.question || !method || !data) {
          showPlanFinishError('研究问题、方法和数据来源还没有完整保存，请回到前面的题目重新点选一次。');
          if (btn) setLoading(btn, false);
          return;
        }
        saveDesignPatch({
          researchQuestions: [question],
          methods: [method],
          dataSources: [data],
          objectives: objective ? [objective] : (current.objectiveOptions.length ? current.objectiveOptions : current.objectives),
          currentStep: 3,
          stepTouched: false,
          outlineStatus: 'idle',
          outlineError: '',
        });
        toast('研究方案已确定，正在进入大纲页', 'ok');
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'topic' }));
      } catch (e) {
        showPlanFinishError(`进入大纲失败：${e.message || '未知错误'}`);
        if (btn) setLoading(btn, false);
      }
    }

    function applyCustomPromptValue(key) {
      const input = el.querySelector(`#rd-custom-${key}`);
      const value = input?.value.trim();
      if (!value) {
        toast('先写一个自定义答案', 'err');
        return;
      }
      const current = normalizeResearchDesign(getProject().researchDesign, getProject());
      const nextCustom = {
        ...(current.customPromptValues || {}),
        [key]: value,
      };
      let patch = { customPromptValues: nextCustom, currentStep: 2 };
      if (key === 'question') {
        const customId = 'rq-custom';
        const existing = current.questionCandidates.filter(item => item.id !== customId);
        patch.questionCandidates = [{ id: customId, question: value, object: '自定义主问题', variable: '', dataNeed: '', method: '' }, ...existing];
        patch.selectedQuestionId = customId;
      } else if (key === 'method') {
        patch.selectedMethod = value;
      } else if (key === 'data') {
        patch.selectedDataSource = value;
      } else if (key === 'objective') {
        patch.selectedObjectiveFocus = value;
      } else if (key === 'strategy') {
        patch.selectedRiskStrategy = value;
      }
      maybeAdvancePlanFlow(saveDesignPatch(patch));
    }

    function mockPlan(current, feedback = '') {
      const baseTitle = resolvedResearchTitle(current, getProject()) || '论文题目';
      const practical = /采购|标准|规范|管理|数字化|企业|流程/.test(`${baseTitle} ${feedback}`);
      return {
        questions: practical ? [
          { id: 'rq-1', question: 'AI 介入后，装修企业标准化流程的执行效率是否会显著提升？', object: '中小型装修企业流程', variable: '标准执行效率', dataNeed: '流程前后对比与访谈', method: '案例研究法' },
          { id: 'rq-2', question: '装修行业数字化转型中，AI 对采购规范化的关键影响路径是什么？', object: '采购与供应链环节', variable: '采购规范化程度', dataNeed: '企业访谈与制度文本', method: '访谈研究法' },
          { id: 'rq-3', question: 'AI 赋能标准化管理后，企业内部协同成本会如何变化？', object: '企业协同流程', variable: '协同成本', dataNeed: '管理者访谈与流程记录', method: '多案例比较法' },
        ] : [
          { id: 'rq-1', question: '该研究主题下的核心作用机制是什么？', object: '目标场景', variable: '关键影响因素', dataNeed: '案例材料与二手资料', method: '案例研究法' },
          { id: 'rq-2', question: '不同实施条件下，结果差异会体现在哪些方面？', object: '实施主体', variable: '实施条件差异', dataNeed: '访谈与文档分析', method: '比较研究法' },
          { id: 'rq-3', question: '相关策略落地的主要阻碍与优化路径分别是什么？', object: '实际落地过程', variable: '阻碍因素', dataNeed: '专家访谈与过程资料', method: '访谈研究法' },
        ],
        methods: practical
          ? ['案例研究法', '访谈研究法', '多案例比较法']
          : ['案例研究法', '访谈研究法', '文献分析法'],
        dataSources: practical
          ? ['企业访谈记录', '内部流程制度文本', '采购与执行台账']
          : ['公开案例材料', '半结构化访谈', '行业二手资料'],
        objectives: practical
          ? ['梳理 AI 赋能装修行业标准化的主要路径', '识别采购与流程规范化中的关键作用点', '提出可落地的管理优化建议']
          : ['界定研究对象与核心问题', '总结主要影响机制', '形成可执行的优化路径'],
        researchGap: practical
          ? '现有研究更多讨论 AI 工具本身或单点应用，对装修行业如何通过 AI 推动标准化与规范化管理、并形成可复制流程的研究仍然不足。'
          : '现有研究对该主题的实际落地路径与场景差异讨论还不够具体，缺少可直接支撑论文结构的方案化表达。',
        hypotheses: practical
          ? ['AI 赋能会提升标准流程执行一致性', '采购规范化是数字化转型中最先显效的环节']
          : ['实施条件差异会显著影响最终效果', '组织协同机制是结果差异的重要解释变量'],
        feasibility: {
          score: practical ? '8.6 / 10' : '8.1 / 10',
          risks: practical
            ? ['企业一手资料获取需要提前沟通', '案例过少会削弱结论说服力']
            : ['样本边界可能不够清晰', '问题范围若继续扩大，后续写作会发散'],
          suggestions: practical
            ? ['只聚焦装修企业标准化流程执行效果', '只比较 2-3 家中小型装修企业案例', '只讨论采购规范化这一条主线']
            : ['只聚焦一个核心业务场景', '只比较 2-3 个可获得资料的案例', '只讨论最容易被数据支撑的影响路径'],
        },
      };
    }

    el.querySelector('#rd-plan-gen')?.addEventListener('click', () => generatePlan());
    el.querySelector('#rd-plan-retry')?.addEventListener('click', () => generatePlan());
    el.querySelector('#rd-plan-regen')?.addEventListener('click', () => generatePlan());
    if (design.planStatus === 'idle') {
      generatePlan();
      return;
    }

    el.querySelectorAll('[data-go-plan-prompt]').forEach(btn =>
      btn.addEventListener('click', () => {
        saveDesignPatch({ planCursor: Number(btn.dataset.goPlanPrompt), currentStep: 2 });
        render(el);
      }));
    el.querySelectorAll('[data-select-question]').forEach(btn =>
      btn.addEventListener('click', () => {
        maybeAdvancePlanFlow(saveDesignPatch({ selectedQuestionId: btn.dataset.selectQuestion, currentStep: 2 }));
      }));
    el.querySelectorAll('[data-select-method]').forEach(btn =>
      btn.addEventListener('click', () => {
        maybeAdvancePlanFlow(saveDesignPatch({ selectedMethod: btn.dataset.selectMethod, currentStep: 2 }));
      }));
    el.querySelectorAll('[data-select-data]').forEach(btn =>
      btn.addEventListener('click', () => {
        maybeAdvancePlanFlow(saveDesignPatch({ selectedDataSource: btn.dataset.selectData, currentStep: 2 }));
      }));
    el.querySelectorAll('[data-select-objective]').forEach(btn =>
      btn.addEventListener('click', () => {
        maybeAdvancePlanFlow(saveDesignPatch({ selectedObjectiveFocus: btn.dataset.selectObjective, currentStep: 2 }));
      }));
    el.querySelectorAll('[data-select-strategy]').forEach(btn =>
      btn.addEventListener('click', () => {
        maybeAdvancePlanFlow(saveDesignPatch({ selectedRiskStrategy: btn.dataset.selectStrategy, currentStep: 2 }));
      }));
    el.querySelector('#rd-plan-prev')?.addEventListener('click', () => {
      const current = normalizeResearchDesign(getProject().researchDesign, getProject());
      saveDesignPatch({ planCursor: Math.max((current.planCursor || 0) - 1, 0), currentStep: 2 });
      render(el);
    });
    el.querySelector('#rd-plan-finish')?.addEventListener('click', e => finishPlanFlow(e.currentTarget));
    el.querySelectorAll('[data-custom-submit]').forEach(btn =>
      btn.addEventListener('click', () => applyCustomPromptValue(btn.dataset.customSubmit)));
  }

  if (step === 3) {
    el.querySelector('#adopted-go-writing')?.addEventListener('click', () =>
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'writing' })));
    const outlineEditor = el.querySelector('#outline-editor');

    function syncOutlineUI(text) {
      const value = String(text || '').trim();
      if (outlineOut) {
        outlineOut.innerHTML = renderOutlinePreview(value);
        outlineOut.dataset.outlineText = value;
      }
      if (outlineEditor && outlineEditor.value !== value) {
        outlineEditor.value = value;
      }
      const copyBtn = el.querySelector('#outline-copy');
      const adoptBtn = el.querySelector('#outline-adopt');
      if (copyBtn) copyBtn.disabled = !value;
      if (adoptBtn) adoptBtn.disabled = !value;
    }

    if (outlineOut) {
      const existingOutlineText = (getProject().outline || []).length
        ? getProject().outline.map(item => `${item.chapter}${(item.sections || []).length ? `\n${item.sections.map(sec => `  ${sec}`).join('\n')}` : ''}`).join('\n')
        : '';
      syncOutlineUI(existingOutlineText);
    }

    async function generateOutline(feedback = '') {
      const current = normalizeResearchDesign(getProject().researchDesign, getProject());
      const btn = el.querySelector('#outline-gen');
      setLoading(btn, true, '生成中…');
      saveDesignPatch({ outlineStatus: 'loading', outlineError: '', currentStep: 3 });
      outlineOut.innerHTML = '<div class="topic-empty">AI 正在生成论文大纲…</div>';
      if (outlineEditor) {
        outlineEditor.disabled = true;
        outlineEditor.placeholder = 'AI 正在生成论文大纲…';
      }
      try {
        const reply = shouldUseLiveAI()
          ? await chat([
              { role: 'system', content: SYSTEM },
              { role: 'user', content: `请为下面的论文研究方案生成规范的中文论文大纲。要求：只输出纯文本大纲，不要 JSON，不要 Markdown 代码块；输出五章结构，每章附 2-4 个二级标题，并让章节安排与研究问题、方法、数据来源和范围边界一致。\n论文题目：${resolvedResearchTitle(current, getProject()) || '未提供'}\n研究问题：${selectedQuestion(current)?.question || '未提供'}\n研究目标：${current.objectives.join('；') || '未提供'}\n研究空白：${current.researchGap || '未提供'}\n研究对象：${current.population || '未提供'}\n方法：${selectedMethod(current) || '未提供'}\n数据来源：${selectedDataSource(current) || '未提供'}\n范围边界：${selectedRiskStrategy(current) || '未提供'}\n待验证判断：${current.hypotheses.join('；') || '未提供'}\n${feedback ? `\n用户对上一版大纲的修改意见：${feedback}\n请根据这个意见重组章节，不要只改个别字。` : ''}\n\n输出格式示例：\n第1章 绪论\n  1.1 研究背景\n  1.2 研究意义` },
            ], { temperature: 0.4, signal: topicSignal(), timeoutMs: 60000 })
          : mockOutline(current);
        const outlineText = outlineTextFromAI(reply);
        if (!outlineText.trim()) throw new Error('模型返回了空大纲，请重试');
        syncOutlineUI(outlineText);
        saveDesignPatch({ outlineStatus: 'ready', outlineError: '', currentStep: 3 });
      } catch (e) {
        if (isAbort(e)) return;
        outlineOut.innerHTML = `<div class="topic-empty">论文大纲生成失败：${escapeHtml(e.message)}</div>`;
        saveDesignPatch({ outlineStatus: 'error', outlineError: e.message, currentStep: 3 });
        toast(e.message, 'err', 3600);
      } finally {
        if (outlineEditor) {
          outlineEditor.disabled = false;
          outlineEditor.placeholder = '可直接粘贴或编辑大纲，例如：第1章 绪论';
        }
        setLoading(btn, false);
      }
    }

    el.querySelector('#outline-gen')?.addEventListener('click', () => generateOutline());
    el.querySelector('#outline-gen-retry')?.addEventListener('click', () => generateOutline());
    if (!(getProject().outline || []).length && !String(outlineEditor?.value || '').trim()) {
      generateOutline();
    }

    outlineEditor?.addEventListener('input', () => {
      const value = outlineEditor.value;
      if (outlineOut) {
        outlineOut.innerHTML = renderOutlinePreview(value);
        outlineOut.dataset.outlineText = value.trim();
      }
      const copyBtn = el.querySelector('#outline-copy');
      const adoptBtn = el.querySelector('#outline-adopt');
      if (copyBtn) copyBtn.disabled = !value.trim();
      if (adoptBtn) adoptBtn.disabled = !value.trim();
    });

    el.querySelector('#outline-copy')?.addEventListener('click', () => {
      const text = outlineEditor?.value || outlineOut?.dataset.outlineText || outlineOut?.textContent || '';
      if (!text.trim()) {
        toast('请先生成大纲', 'err');
        return;
      }
      copyText(text.trim());
    });

    const ocModal = el.querySelector('#outline-confirm');
    const ocPlan = el.querySelector('#oc-plan');
    const ocOutline = el.querySelector('#oc-outline');
    const ocConflict = el.querySelector('#oc-conflict');

    function applyOutline(text) {
      const chapters = adoptOutline(text.trim());
      if (!chapters.length) {
        toast('大纲解析失败：未识别到「第X章」格式，请重新生成一次', 'err', 4000);
        return false;
      }
      const current = normalizeResearchDesign(getProject().researchDesign, getProject());
      saveDesignPatch({
        researchQuestions: selectedQuestion(current) ? [selectedQuestion(current)] : current.researchQuestions,
        methods: selectedMethod(current) ? [selectedMethod(current)] : current.methods,
        dataSources: selectedDataSource(current) ? [selectedDataSource(current)] : current.dataSources,
        confirmedAt: current.confirmedAt || new Date().toISOString(),
        currentStep: 3,
      });
      updateBasics({ title: resolvedResearchTitle(current, getProject()), degreeType: getProject().degreeType });
      toast(`已采用大纲（${chapters.length} 章），正在进入论文写作`, 'ok');
      document.dispatchEvent(new Event('tm:projects-changed')); // 研究设计完成 -> 从导航隐藏
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'writing' }));
      return true;
    }

    function openOutlineConfirm(text) {
      const current = normalizeResearchDesign(getProject().researchDesign, getProject());
      const chapterCount = outlineChapterCount(text);
      if (ocPlan) {
        ocPlan.innerHTML = `
          <div class="oc-plan-grid">
            <div class="oc-plan-item"><span>论文题目</span><b>${escapeHtml(resolvedResearchTitle(current, getProject()) || '未设定')}</b></div>
            <div class="oc-plan-item"><span>研究问题</span><b>${escapeHtml(selectedQuestion(current)?.question || '未单独设定')}</b></div>
            <div class="oc-plan-item"><span>研究方法</span><b>${escapeHtml(selectedMethod(current) || '未单独设定')}</b></div>
            <div class="oc-plan-item"><span>数据来源</span><b>${escapeHtml(selectedDataSource(current) || '未单独设定')}</b></div>
          </div>`;
      }
      if (ocOutline) ocOutline.textContent = text.trim();
      if (ocConflict) {
        const p = getProject();
        const hasData = (p.outline || []).length || Object.keys(p.drafts || {}).length || p.documentV2;
        ocConflict.innerHTML = `
          ${chapterCount ? `<div class="oc-ready-note">已识别 ${chapterCount} 个章节，确认后会写入论文写作台。</div>` : '<div class="oc-conflict-warning">暂未识别到章节。请把大纲改成「第1章 绪论」或「1. 绪论」这类格式后再确认。</div>'}
          ${hasData ? '<div class="oc-conflict-warning">当前工作台已有内容（已用大纲 / 草稿 / 正文）。采用新大纲会替换章节结构；已匹配章节的草稿会尽量保留，其余内容可能被覆盖。</div>' : ''}`;
      }
      const confirmBtn = el.querySelector('#oc-confirm');
      if (confirmBtn) confirmBtn.disabled = !chapterCount;
      if (ocModal) {
        ocModal.hidden = false;
        document.body.style.overflow = 'hidden';
      }
    }

    function closeOutlineConfirm() {
      if (!ocModal) return;
      ocModal.hidden = true;
      document.body.style.overflow = '';
    }

    el.querySelector('#outline-adopt')?.addEventListener('click', () => {
      const text = outlineEditor?.value || outlineOut?.dataset.outlineText || outlineOut?.textContent || '';
      if (!text.trim()) {
        toast('请先生成大纲', 'err');
        return;
      }
      openOutlineConfirm(text);
    });
    el.querySelector('#oc-confirm')?.addEventListener('click', () => {
      const ok = applyOutline(outlineEditor?.value || outlineOut?.dataset.outlineText || '');
      if (ok) closeOutlineConfirm();
      else if (ocConflict) {
        ocConflict.innerHTML = '<div class="oc-conflict-warning">大纲还没有成功写入。请检查是否包含「第1章」这类章节标题，再重新确认。</div>';
      }
    });
    el.querySelector('#oc-cancel')?.addEventListener('click', closeOutlineConfirm);
    el.querySelector('#oc-close')?.addEventListener('click', closeOutlineConfirm);
    ocModal?.addEventListener('click', e => { if (e.target === ocModal) closeOutlineConfirm(); });
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape' && ocModal && !ocModal.hidden) closeOutlineConfirm();
    });
  }
}

export default {
  id: 'topic',
  icon: '',
  title: '研究设计',
  subtitle: '把论文想法变成可执行的研究方案',
  projectScoped: true,
  render,
};
