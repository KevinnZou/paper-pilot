// 论文主页 v4：五步写作之旅 + 进度聚合 + 关键数字（纸墨朱砂视觉体系）
import { get } from '../storage.js';
import { getProject, calcStreak, setCurrentChapter } from '../project.js';
import { escapeHtml, toast, calGridHtml } from '../ui.js';
import { loadDemoData, hasExistingData } from '../demo-data.js';
import { ICONS } from '../icons.js';

const CARDS = [
  { id: 'topic', title: '研究设计', desc: '研究想法 → 研究问题 → 可行性检查 → 论文大纲' },
  { id: 'writing', title: '写作工作台', desc: '一份完整论文文档：目录定位、AI 动作、规范引用' },
  { id: 'citation', title: '文献与证据', desc: '智能推荐中英文文献，核对理由后勾选入库' },
  { id: 'planner', title: '计划与进度', desc: '今日任务、本周任务、时间轴与写作记录' },
  { id: 'checkExport', title: '检查与导出', desc: '结构、引用、格式检查，以及 DOCX / PDF / Markdown 导出' },
];

const PROGRESS_WEIGHT = { '已完成': 1, '进行中': 0.5, '未开始': 0 };

function shortName(s, n = 12) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function wordCount(s) {
  return String(s || '').replace(/\s/g, '').length;
}

function nextActionCard({ cfg, project, researchReadyCount, chapters, nextChapter, drafts, daysLeft }) {
  const totalWords = Object.values(drafts).reduce((sum, d) => sum + wordCount(d?.content), 0);
  const chapterWords = nextChapter ? wordCount(drafts[nextChapter]?.content || '') : 0;
  const chapterStatus = nextChapter ? (project.chapterProgress[nextChapter] || '未开始') : '';
  if (!cfg?.apiKey) {
    return {
      title: '今天先打通 AI 能力',
      goal: '完成 API 配置，解锁研究设计、文献检索和写作辅助。',
      bullets: ['填写 API Key', '测试连接', '返回项目主页继续主线'],
      eta: '5 分钟',
      nav: 'settings',
      cta: '去配置',
    };
  }
  if (!project.title) {
    return {
      title: '今天先定下论文题目',
      goal: '把研究想法落成明确题目，后续研究问题和大纲才能稳定生成。',
      bullets: ['写下研究想法', '生成题目候选', '选一个题目设为主线'],
      eta: '20 分钟',
      nav: 'topic',
      cta: '去研究设计',
    };
  }
  if (researchReadyCount < 4) {
    return {
      title: '今天补齐研究设计',
      goal: '至少把研究问题、方法、数据来源和可行性检查补全，让后续写作有抓手。',
      bullets: ['生成 3-5 个研究问题', '确认方法与数据来源', '做一轮可行性检查'],
      eta: '35 分钟',
      nav: 'topic',
      cta: '继续研究设计',
    };
  }
  if (!chapters.length) {
    return {
      title: '今天产出论文大纲',
      goal: '用研究设计生成五章结构，并采用到项目主线。',
      bullets: ['检查研究空白是否清楚', '生成论文大纲', '采用到写作工作台'],
      eta: '25 分钟',
      nav: 'topic',
      cta: '去生成大纲',
    };
  }
  if (!project.dueDate) {
    return {
      title: '今天设定截止日期',
      goal: '把整篇论文挂到时间轴上，后续任务和风险判断才会准确。',
      bullets: ['确认提交日期', '生成倒排计划', '看系统给出的写作节奏'],
      eta: '10 分钟',
      nav: 'planner',
      cta: '去设截止日期',
    };
  }
  if (nextChapter) {
    const wordGoal = chapterWords >= 800 ? 1200 : 800;
    const diff = Math.max(wordGoal - chapterWords, 0);
    return {
      title: `今天建议完成 ${nextChapter}`,
      goal: chapterStatus === '未开始'
        ? '先把这一章写出能工作的初稿，再回头补证据和细化表达。'
        : '继续把当前章节推进到成型版本，减少中断成本。',
      bullets: [
        diff > 0 ? `补足约 ${diff} 字，达到 ${wordGoal} 字初稿` : `继续精修本章，已超过 ${wordGoal} 字基础线`,
        '检查本章至少有 2 处文献支撑',
        daysLeft != null && daysLeft <= 14 ? '同步留意截止风险，避免只写不排期' : '完成后更新章节状态',
      ],
      eta: chapterStatus === '未开始' ? '45 分钟' : '35 分钟',
      nav: 'writing',
      cta: `去写「${shortName(nextChapter, 8)}」`,
    };
  }
  return {
    title: '今天做一次总检查',
    goal: `当前已累计 ${totalWords} 字，适合回看结构、引用和计划是否一致。`,
    bullets: ['检查章节是否失衡', '回看文献引用是否充足', '安排下一轮修改重点'],
    eta: '30 分钟',
    nav: 'writing',
    cta: '回到全文',
  };
}

export default {
  id: 'dashboard',
  icon: '🏠',
  title: '论文主页',
  subtitle: '你的论文，一条主线看到底',
  projectScoped: true,

  render(el) {
    const p = getProject();
    const cfg = get('config', {});
    const drafts = get('drafts', {});
    const rawCheckins = get('checkins', []);
    const checkins = rawCheckins.map(c => (typeof c === 'string' ? c : c.date));
    const due = p.dueDate ? new Date(p.dueDate) : null;
    const daysLeft = due ? Math.ceil((due - Date.now()) / 86400000) : null;
    const streak = calcStreak(checkins);
    const chapters = p.outline || [];
    const doneCount = chapters.filter(c => p.chapterProgress[c.chapter] === '已完成').length;
    const researchDesign = p.researchDesign || {};
    const researchReadyCount = [
      !!(researchDesign.initialIdea || '').trim(),
      !!(p.title || researchDesign.title || '').trim(),
      !!(researchDesign.researchQuestions || []).length,
      !!(researchDesign.methods || []).length,
      !!(researchDesign.dataSources || []).length,
      !!(researchDesign.feasibility?.score || researchDesign.feasibility?.risks?.length),
    ].filter(Boolean).length;
    const overallPct = chapters.length
      ? Math.round(chapters.reduce((s, c) => s + (PROGRESS_WEIGHT[p.chapterProgress[c.chapter]] || 0), 0) / chapters.length * 100)
      : 0;
    const totalWords = Object.values(drafts).reduce((s, d) => s + wordCount(d?.content), 0);
    const lastRaw = rawCheckins[rawCheckins.length - 1];
    const lastText = lastRaw
      ? (typeof lastRaw === 'string' ? lastRaw : `${lastRaw.date}${lastRaw.chapter ? ` · ${lastRaw.chapter}` : ''}`)
      : '';

    // 五步写作之旅（onboarding 流程条）
    const steps = [
      { label: '填入 API Key', done: !!(cfg?.apiKey), extra: cfg?.apiKey ? '已配置' : '', nav: 'settings' },
      { label: '明确研究题目', done: !!p.title, extra: p.title ? shortName(p.title, 8) : '', nav: 'topic' },
      { label: '补齐研究设计', done: researchReadyCount >= 4, extra: `${researchReadyCount}/6`, nav: 'topic' },
      { label: '采用章节大纲', done: chapters.length > 0, extra: chapters.length ? `${chapters.length} 章` : '', nav: 'topic' },
      { label: '设定截止日期', done: !!p.dueDate, extra: p.dueDate ? p.dueDate.slice(5).replace('-', '/') : '', nav: 'planner' },
      { label: '开始按章写作', done: Object.values(drafts).some(d => (d?.content || '').trim()), nav: 'writing' },
    ];
    const doneSteps = steps.filter(s => s.done).length;
    const currentIdx = steps.findIndex(s => !s.done);

    // 下一步章节：当前章已完成则智能指向最近的进行中/未开始章
    const prog = p.chapterProgress;
    const nextChapter = (p.currentChapter && prog[p.currentChapter] !== '已完成')
      ? p.currentChapter
      : ((chapters.find(c => prog[c.chapter] === '进行中')
          || chapters.find(c => prog[c.chapter] === '未开始')
          || chapters[0]) || {}).chapter || '';
    const nextAction = nextActionCard({
      cfg,
      project: p,
      researchReadyCount,
      chapters,
      nextChapter,
      drafts,
      daysLeft,
    });

    // 主行动按钮 = 下一步
    let heroAction = '';
    if (!cfg?.apiKey) heroAction = '<button class="btn btn-lg" data-nav="settings">第一步：填入 API Key</button>';
    else if (!p.title) heroAction = '<button class="btn btn-lg" data-nav="topic">去确定研究题目</button>';
    else if (researchReadyCount < 4) heroAction = '<button class="btn btn-lg" data-nav="topic">补齐研究设计</button>';
    else if (!chapters.length) heroAction = '<button class="btn btn-lg" data-nav="topic">去生成并采用大纲</button>';
    else if (!p.dueDate) heroAction = '<button class="btn btn-lg" data-nav="planner">设定截止日期</button>';
    else heroAction = `<button class="btn btn-lg" id="hero-continue">${nextChapter ? `继续写「${shortName(nextChapter)}」` : '开始写作'}</button>`;

    // 四块版面：hero / 写作之旅 / 章节进度+打卡 / 功能入口
    const writingPhase = !!p.title && chapters.length > 0;

    const heroHtml = `
      <div class="card hero project-hero">
        <div class="hero-top">
          <h2><span class="mark"></span>${p.title ? escapeHtml(p.title) : '开始你的论文之旅'}</h2>
          <div class="meta">
            ${p.degreeType ? `<span class="chip">${escapeHtml(p.degreeType)}</span>` : ''}
            ${p.dueDate ? `<span class="chip">截止 ${escapeHtml(p.dueDate)}</span>` : ''}
            ${researchReadyCount ? `<span class="chip">研究设计 ${researchReadyCount}/6</span>` : ''}
            ${chapters.length ? `<span class="chip">${chapters.length} 章大纲</span>` : ''}
            ${doneCount ? `<span class="chip done">已完成 ${doneCount} 章</span>` : ''}
            ${p.materials.length ? `<span class="chip">素材 ${p.materials.length} 条</span>` : ''}
            ${doneSteps === steps.length ? '<span class="chip done">旅程五步全部完成</span>' : ''}
          </div>
        </div>
        <p class="hero-lead">${p.title
          ? `覆盖选题、写作、文献、进度的全流程助手${daysLeft !== null
              ? (daysLeft >= 0 ? `　·　距截止 <b>${daysLeft}</b> 天` : `　·　已过截止 <b>${-daysLeft}</b> 天`)
              : ''}`
          : '先把研究设计立住，再进入大纲、写作、文献和进度推进。'}</p>
        <div class="hero-action-row">
          ${heroAction}
          ${!p.title ? '<button class="btn btn-ghost" id="hero-demo">先载入演示数据看效果</button>' : ''}
          ${p.title ? '<button class="btn btn-ghost" data-nav="planner">查看写作计划</button>' : ''}
        </div>
        ${p.title ? `
          <div class="hero-stats">
            <div class="stat"><span class="stat-num ${daysLeft !== null && daysLeft <= 14 ? 'danger' : ''}" ${daysLeft !== null && daysLeft <= 14 ? 'title="已不足两周，注意写作节奏"' : ''}>${daysLeft !== null ? daysLeft : '—'}</span><span class="stat-label">距截止天数</span></div>
            <div class="stat"><span class="stat-num">${overallPct}%</span><span class="stat-label">章节进度</span></div>
            <div class="stat"><span class="stat-num">${totalWords || 0}</span><span class="stat-label">已写字数</span></div>
            <div class="stat"><span class="stat-num">${streak}</span><span class="stat-label">连续打卡</span></div>
          </div>` : ''}
      </div>`;

    const nextActionHtml = `
      <div class="card">
        <h2><span class="mark"></span>今天该做什么</h2>
        <div class="item" style="padding:0;border:none;background:transparent">
          <div class="item-main">
            <div class="item-title">${escapeHtml(nextAction.title)}</div>
            <div class="item-meta">${escapeHtml(nextAction.goal)}</div>
            <div class="item-meta" style="margin-top:8px">预计 ${escapeHtml(nextAction.eta)}</div>
            <ul style="margin:10px 0 0 18px;padding:0">
              ${nextAction.bullets.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </div>
        </div>
        <div class="hero-action-row" style="margin-top:14px">
          <button class="btn btn-lg" data-nav="${nextAction.nav}" ${nextAction.nav === 'writing' && nextChapter ? `data-write="${escapeHtml(nextChapter)}"` : ''}>${escapeHtml(nextAction.cta)}</button>
          ${p.dueDate ? '<button class="btn btn-ghost" data-nav="planner">查看本周任务</button>' : ''}
        </div>
      </div>`;

    const journeyHtml = `
      <div class="card journey-card">
        <h2><span class="mark"></span>写作之旅　<span class="chip ${doneSteps === steps.length ? 'done' : 'doing'}">${doneSteps}/${steps.length}</span></h2>
        <p class="desc">按顺序把研究设计、写作和计划串起来；点击任意一步可直接前往</p>
        <div class="journey">
          ${steps.map((s, i) => `
            <button class="journey-step ${s.done ? 'done' : i === currentIdx ? 'current' : ''}" data-nav="${s.nav}" title="${escapeHtml(s.label)}${s.done ? '（已完成）' : i === currentIdx ? '（当前步骤）' : ''}">
              <span class="js-check">${s.done ? '✓' : i + 1}</span>
              <span class="js-label">${s.label}${s.extra ? ` <span class="mono">${escapeHtml(s.extra)}</span>` : ''}</span>
              ${i === currentIdx && !s.done ? '<span class="js-tag">下一步</span>' : ''}
            </button>`).join('')}
        </div>
      </div>`;

    const progressHtml = `
      <div class="grid dash-cols">
        <div class="card">
          <h2><span class="mark"></span>章节进度</h2>
          <p class="desc">${chapters.length
            ? `总体进度 <b>${overallPct}%</b>（点击「去写」直达工作台对应章节）`
            : '采用大纲后，这里会显示每一章的写作进度'}</p>
          ${chapters.length ? `
            <div>
              ${chapters.map(c => {
                const st = p.chapterProgress[c.chapter] || '未开始';
                const chipCls = st === '已完成' ? 'done' : st === '进行中' ? 'doing' : '';
                const isNext = c.chapter === nextChapter;
                return `<div class="progress-row ${isNext ? 'is-next' : ''}">
                  <span class="progress-label" title="${escapeHtml(c.chapter)}">${escapeHtml(shortName(c.chapter, 10))}</span>
                  <div class="progress-track"><div class="progress-fill" style="width:${PROGRESS_WEIGHT[st] * 100}%"></div></div>
                  <span class="chip ${chipCls}">${st}</span>
                  ${drafts[c.chapter]?.content ? `<span class="chip">${wordCount(drafts[c.chapter].content)}字</span>` : ''}
                  <button class="btn ${isNext ? '' : 'btn-ghost'} btn-sm" data-write="${escapeHtml(c.chapter)}">${isNext ? '继续写' : '去写'}</button>
                </div>`;
              }).join('')}
            </div>` : `
            <div class="empty">
              <div class="empty-icon">📖</div>
              <p>还没有大纲——生成大纲并「采用」后，这里会显示每章进度</p>
              <button class="btn btn-ghost btn-sm" data-nav="topic">去生成大纲 →</button>
            </div>`}
        </div>

        <div class="card">
          <h2><span class="mark"></span>写作打卡</h2>
          <p class="desc">累计打卡 <b>${checkins.length}</b> 天${streak ? ` · 连续 <b>${streak}</b> 天` : ''}</p>
          ${calGridHtml(checkins)}
          ${lastText
            ? `<p class="desc">最近打卡：${escapeHtml(lastText)}</p>`
            : '<p class="desc">还没有打卡记录，开始第一次打卡吧</p>'}
          <button class="btn btn-ghost" data-nav="planner">去打卡</button>
        </div>
      </div>`;

    const entranceHtml = `
      <div class="dash-grid">
        ${CARDS.map(c => `
          <button class="dash-card" data-nav="${c.id}" title="${escapeHtml(c.desc)}">
            <span class="icon">${ICONS[c.id] || ''}</span>
            <span class="d-card-txt">
              <span class="d-title">${c.title}</span>
              <span class="d-desc">${escapeHtml(c.desc)}</span>
            </span>
          </button>`).join('')}
      </div>`;

    // 版面顺序按阶段：入门中（未定题/未用大纲）旅程在上引导上手；已进入写作后旅程沉底
    el.innerHTML = writingPhase
      ? `${heroHtml}${nextActionHtml}${entranceHtml}${progressHtml}${journeyHtml}`
      : `${heroHtml}${nextActionHtml}${journeyHtml}${entranceHtml}${progressHtml}`;

    // 章节直写
    el.querySelectorAll('[data-write]').forEach(b =>
      b.addEventListener('click', () => {
        setCurrentChapter(b.dataset.write);
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'writing' }));
      }));

    // 空态：一键载入演示数据（空态即邀请）
    const demoBtn = el.querySelector('#hero-demo');
    if (demoBtn) {
      demoBtn.addEventListener('click', () => {
        if (hasExistingData() && !confirm('载入演示数据将覆盖当前的论文、文献、打卡等本地数据。继续吗？')) return;
        loadDemoData();
        toast('演示数据已载入——这就是一份完整论文的样子', 'ok');
        // 走导航事件重渲染主页（避免模块内自引用）
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'dashboard' }));
      });
    }

    // 主行动按钮（继续写：当前章已完成时自动指向下一章）
    const heroBtn = el.querySelector('#hero-continue');
    if (heroBtn) {
      heroBtn.addEventListener('click', () => {
        if (!chapters.length) {
          document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'topic' }));
          return;
        }
        const target = nextChapter || chapters[0].chapter;
        setCurrentChapter(target);
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'writing' }));
      });
    }

    el.querySelectorAll('[data-nav]').forEach(b =>
      b.addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: b.dataset.nav }))));
  },
};
