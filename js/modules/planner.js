// 计划与进度：按截止日期真实倒排的甘特图 + 打卡关联章节（PRD §4.4 链路①③）
import { toast, escapeHtml, calGridHtml } from '../ui.js';
import { getProject, updateBasics, saveProject, setChapterProgress, calcStreak, isoLocal } from '../project.js';
import { get, set } from '../storage.js';

const TEMPLATES = [
  {
    name: '本科毕业论文（12周）',
    stages: [['选题与开题', 2], ['文献调研', 2], ['研究/实验设计', 2], ['数据收集与实验', 2], ['初稿撰写', 2], ['修改与定稿', 1], ['答辩准备', 1]],
  },
  {
    name: '硕士毕业论文（24周）',
    stages: [['选题与开题报告', 4], ['文献综述', 4], ['研究方案设计', 3], ['实验/调研实施', 5], ['论文撰写', 5], ['修改定稿', 2], ['预答辩与答辩', 1]],
  },
  {
    name: '博士毕业论文（36周）',
    stages: [['选题与开题报告', 6], ['文献综述', 5], ['研究方案设计', 4], ['实验/调研实施', 10], ['论文撰写', 7], ['修改定稿', 3], ['预答辩与答辩', 1]],
  },
  {
    name: '课程论文（8周）',
    stages: [['选题与开题', 1], ['文献调研', 1], ['论文撰写', 3], ['修改定稿', 2], ['提交准备', 1]],
  },
];

const DAY = 86400000;

function fmtDate(ms) {
  const t = new Date(ms);
  return `${t.getMonth() + 1}/${t.getDate()}`;
}

/** 从截止日期倒排各阶段起止时间 */
function backschedule(stages, dueDate) {
  const due = new Date(dueDate).getTime();
  let end = due;
  return stages.map(([name, weeks], i) => {
    const start = end - weeks * 7 * DAY;
    const item = { id: `s${i + 1}`, name, weeks, start, end };
    end = start;
    return item;
  });
}

function renderGantt(stages, totalDays, chapterProgress = {}) {
  const now = Date.now();
  const today = new Date();
  const todayLabel = `${today.getMonth() + 1}月${today.getDate()}日`;
  const rows = stages.map(s => {
    const pct = Math.max(6, Math.round(((s.end - s.start) / totalDays) * 100));
    const isNow = s.start <= now && now <= s.end;
    const done = s.end < now;
    const title = `${s.name}：${fmtDate(s.start)} – ${fmtDate(s.end)}（${s.weeks} 周）${isNow ? ' · 当前阶段' : done ? ' · 已完成' : ''}`;
    const tasks = s.tasks && s.tasks.length
      ? `<div class="gantt-tasks">${s.tasks.map(t => {
          const st = chapterProgress[t];
          const chipCls = st === '已完成' ? 'done' : st === '进行中' ? 'doing' : '';
          return `<span class="chip ${chipCls}">${st === '已完成' ? '✓ ' : ''}${escapeHtml(t)}${st ? ` · ${st}` : ''}</span>`;
        }).join('')}</div>`
      : '';
    return `<div class="gantt-block">
      <div class="gantt-row">
        <span class="gantt-label">${escapeHtml(s.name)}${isNow ? ' <span class="chip doing">进行中</span>' : done ? ' <span class="chip done">✓ 已完成</span>' : ''}</span>
        <div class="gantt-track" title="${title}"><div class="gantt-bar ${isNow ? 'now' : done ? 'done' : ''}" style="width:${pct}%"></div></div>
        <span class="gantt-week">${fmtDate(s.start)} – ${fmtDate(s.end)}</span>
      </div>
      ${tasks}
    </div>`;
  }).join('');
  const info = `<div class="gantt-info">今天：<b>${todayLabel}</b> · 朱砂描边＝当前阶段 · 松烟绿＝已完成阶段</div>`;
  return `<div class="result-box filled">${info}<div class="gantt-placeholder">${rows}</div></div>`;
}

function render(el) {
  const p = getProject();
  const rawCheckins = get('checkins', []);
  const checkins = rawCheckins.map(c => (typeof c === 'string' ? { date: c, chapter: '', note: '' } : c));
  const today = isoLocal(Date.now());
  const checkedToday = checkins.some(c => c.date === today);
  const daysLeft = p.dueDate ? Math.ceil((new Date(p.dueDate).getTime() - Date.now()) / DAY) : null;
  const streak = calcStreak(checkins.map(c => c.date));
  const chapters = p.outline || [];
  const stages = p.stages || [];
  const totalDays = stages.length ? (stages[0].end - stages[stages.length - 1].start) : 1;

  // 打卡日历热力图（共用组件）
  const calHtml = calGridHtml(checkins.map(c => c.date));

  el.innerHTML = `
    <div class="card">
      <h2><span class="mark"></span>写作计划</h2>
      <p class="desc">选择计划模板并设定论文截止日期，系统按截止日期倒排每个阶段的时间轴${chapters.length ? '；已采用的大纲章节会自动挂到撰写阶段' : ''}</p>
      <div class="form-row">
        <div>
          <label class="field-label">计划模板</label>
          <select id="plan-tpl">${TEMPLATES.map((t, i) => `<option value="${i}">${t.name}</option>`).join('')}</select>
        </div>
        <div>
          <label class="field-label">论文截止日期</label>
          <input type="date" id="plan-due" value="${p.dueDate || ''}">
        </div>
      </div>
      <div style="margin-top:16px">
        <button class="btn" id="plan-gen">生成写作计划</button>
      </div>
      <div id="plan-out">
        ${stages.length
          ? renderGantt(stages, totalDays, p.chapterProgress)
          : '<div class="result-box"><span class="placeholder">设定截止日期并点击生成，计划甘特图将显示在这里</span></div>'}
      </div>
    </div>

    <div class="card">
      <h2><span class="mark"></span>每日打卡</h2>
      <p class="desc">累计 <b>${checkins.length}</b> 天 · 连续 <b>${streak}</b> 天 🔥${daysLeft !== null ? (daysLeft >= 0 ? ` · 距截止还有 <b>${daysLeft}</b> 天` : ` · 已过截止 <b>${-daysLeft}</b> 天`) : ''}</p>
      ${calHtml}
      ${chapters.length ? `
        <label class="field-label">今天写了哪一章？（进度会同步到论文主页）</label>
        <select id="ck-chapter">
          <option value="">（未写章节，仅打卡）</option>
          ${chapters.map(c => `<option value="${escapeHtml(c.chapter)}"${c.chapter === p.currentChapter ? ' selected' : ''}>${escapeHtml(c.chapter)}</option>`).join('')}
        </select>` : `
        <p class="desc">提示：先在「选题与大纲」采用大纲，打卡时就能记录每章进度</p>`}
      <label class="field-label">今日小结（可选）</label>
      <input type="text" id="ck-note" placeholder="例如：完成文献综述第一小节，约800字">
      <div style="margin-top:14px">
        <button class="btn" id="checkin-btn" ${checkedToday ? 'disabled title="今天已经打过卡，明天再来"' : ''}>${checkedToday ? '今日已打卡' : '今日已写作，打卡'}</button>
        ${checkedToday ? '<span class="seal" style="margin-left:10px">已打卡</span>' : ''}
      </div>
      ${checkins.length ? `
        <h3>打卡记录（最近 7 次）</h3>
        <div class="item-list">
          ${checkins.slice(0, 7).map(c => `
            <div class="item">
              <div class="item-main">
                <div class="item-title mono">${escapeHtml(c.date)}${c.chapter ? ` · ${escapeHtml(c.chapter)}` : ''}</div>
                ${c.note ? `<div class="item-meta">${escapeHtml(c.note)}</div>` : ''}
              </div>
              ${c.chapter ? '<span class="chip doing">进行中</span>' : '<span class="seal" style="font-size:11px">已打卡</span>'}
            </div>`).join('')}
        </div>` : ''}
    </div>`;

  // 生成计划：倒排日期 + 大纲章节挂到撰写阶段（链路①）
  el.querySelector('#plan-gen').addEventListener('click', () => {
    const dueVal = el.querySelector('#plan-due').value;
    if (!dueVal) { toast('请先选择论文截止日期', 'err'); return; }
    const tpl = TEMPLATES[el.querySelector('#plan-tpl').value];
    const stages = backschedule(tpl.stages, dueVal);
    stages.forEach(s => {
      if (/撰写/.test(s.name) && chapters.length) s.tasks = chapters.map(c => c.chapter);
    });
    updateBasics({ dueDate: dueVal });
    saveProject({ stages });
    toast(`写作计划已生成：${stages.length} 个阶段，按截止日期倒排`, 'ok');
    render(el);
  });

  // 打卡：写入记录 + 更新章节进度（链路③）
  el.querySelector('#checkin-btn').addEventListener('click', () => {
    const chapter = el.querySelector('#ck-chapter')?.value || '';
    const note = el.querySelector('#ck-note').value.trim();
    const list = get('checkins', []);
    list.unshift({ date: isoLocal(Date.now()), chapter, note });
    set('checkins', list);
    if (chapter) setChapterProgress(chapter, '进行中');
    toast(chapter ? `打卡成功，${chapter} 已标记为「进行中」` : '打卡成功，继续保持！', 'ok');
    render(el);
  });
}

export default {
  id: 'planner',
  icon: '📅',
  title: '计划与进度',
  subtitle: '甘特图、倒计时、打卡，对抗拖延',
  projectScoped: true,
  render,
};
