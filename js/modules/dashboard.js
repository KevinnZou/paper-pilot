// 论文主页 v4：五步写作之旅 + 进度聚合 + 关键数字（纸墨朱砂视觉体系）
import { get } from '../storage.js';
import { getProject, calcStreak, setCurrentChapter } from '../project.js';
import { escapeHtml, toast, calGridHtml } from '../ui.js';
import { loadDemoData, hasExistingData } from '../demo-data.js';
import { ICONS } from '../icons.js';

const CARDS = [
  { id: 'topic', title: '选题与大纲', desc: '选题建议 → 设为题目 → 生成并采用大纲' },
  { id: 'writing', title: '写作工作台', desc: '一份完整论文文档：目录定位、AI 动作、规范引用' },
  { id: 'citation', title: '文献中心', desc: '智能推荐中英文文献，核对理由后勾选入库' },
  { id: 'planner', title: '计划与进度', desc: '截止日期倒排甘特图、每日打卡、进度监督' },
];

const PROGRESS_WEIGHT = { '已完成': 1, '进行中': 0.5, '未开始': 0 };

function shortName(s, n = 12) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function wordCount(s) {
  return String(s || '').replace(/\s/g, '').length;
}

export default {
  id: 'dashboard',
  icon: '🏠',
  title: '论文主页',
  subtitle: '你的论文，一条主线看到底',

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
      { label: '确定论文题目', done: !!p.title, extra: p.title ? shortName(p.title, 8) : '', nav: 'topic' },
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

    // 主行动按钮 = 下一步
    let heroAction = '';
    if (!cfg?.apiKey) heroAction = '<button class="btn btn-lg" data-nav="settings">第一步：填入 API Key</button>';
    else if (!p.title) heroAction = '<button class="btn btn-lg" data-nav="topic">去确定选题</button>';
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
          : '五个步骤，从选题到定稿。先完成下方流程条的第一步。'}</p>
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

    const journeyHtml = `
      <div class="card journey-card">
        <h2><span class="mark"></span>写作之旅　<span class="chip ${doneSteps === steps.length ? 'done' : 'doing'}">${doneSteps}/${steps.length}</span></h2>
        <p class="desc">按顺序完成以下步骤，每步完成后自动打勾；点击任意一步可直接前往</p>
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
      ? `${heroHtml}${entranceHtml}${progressHtml}${journeyHtml}`
      : `${heroHtml}${journeyHtml}${entranceHtml}${progressHtml}`;

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
