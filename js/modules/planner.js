import { toast, escapeHtml, calGridHtml } from '../ui.js';
import { getProject, updateBasics, saveProject, setChapterProgress, calcStreak, isoLocal, getPlan, savePlan, getEvidence } from '../project.js';
import { meaningfulTitle } from '../title-utils.js';

let weekExpanded = false;
const WEEK_PREVIEW = 3;

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

function dateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function plusDays(n) {
  return dateKey(Date.now() + n * DAY);
}

function makeTaskId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

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
    const tasks = s.tasks?.length
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

function chapterTasks(project) {
  const chapters = project.outline || [];
  const progress = project.chapterProgress || {};
  const ordered = chapters
    .map((item, index) => ({ ...item, index, status: progress[item.chapter] || '未开始' }))
    .filter(item => item.status !== '已完成')
    .slice(0, 4);
  return ordered.map((item, idx) => ({
    id: `auto-chapter-${item.sectionId || item.chapter}`,
    title: item.status === '进行中' ? `继续推进 ${item.chapter}` : `启动 ${item.chapter}`,
    dueDate: plusDays(idx === 0 ? 0 : Math.min(idx + 1, 5)),
    source: 'auto',
    nav: 'writing',
    chapter: item.chapter,
    sectionId: item.sectionId || item.chapter,
    note: item.status === '进行中' ? '补正文并回看引用支撑' : '先写出可工作的初稿',
  }));
}

function derivedTasks(project) {
  const design = project.researchDesign || {};
  const tasks = [];
  if (!project.dueDate) {
    tasks.push({ id: 'auto-due', title: '设定论文截止日期', dueDate: plusDays(0), source: 'auto', nav: 'planner', note: '没有截止日期，系统无法准确倒排' });
  }
  if (!meaningfulTitle(project.researchDesign?.title, project.title)) {
    tasks.push({ id: 'auto-title', title: '确定论文题目', dueDate: plusDays(0), source: 'auto', nav: 'topic', note: '先把研究想法落成明确题目' });
  }
  if (!(design.researchQuestions || []).length) {
    tasks.push({ id: 'auto-rq', title: '补齐研究问题', dueDate: plusDays(0), source: 'auto', nav: 'topic', note: '至少生成 3-5 个候选问题' });
  }
  if (!(design.methods || []).length) {
    tasks.push({ id: 'auto-method', title: '明确研究方法', dueDate: plusDays(1), source: 'auto', nav: 'topic', note: '方法决定后续写作结构' });
  }
  if (!(design.dataSources || []).length) {
    tasks.push({ id: 'auto-data', title: '补充数据来源', dueDate: plusDays(1), source: 'auto', nav: 'topic', note: '至少确认数据或材料从哪里来' });
  }
  if (!design.feasibility?.score && !(design.feasibility?.risks || []).length) {
    tasks.push({ id: 'auto-feasibility', title: '做一轮可行性检查', dueDate: plusDays(2), source: 'auto', nav: 'topic', note: '确认时间、样本和方法都可落地' });
  }
  if (!(project.outline || []).length) {
    tasks.push({ id: 'auto-outline', title: '生成并采用论文大纲', dueDate: plusDays(2), source: 'auto', nav: 'topic', note: '大纲会驱动写作与文献推荐' });
  }
  tasks.push(...chapterTasks(project));
  if ((project.citations || []).length && !getEvidence().length) {
    tasks.push({ id: 'auto-evidence', title: '从文献中整理 2 张证据卡', dueDate: plusDays(3), source: 'auto', nav: 'citation', note: '让右栏证据能支撑写作' });
  }
  return tasks;
}

function allTasks(project, plan) {
  return [...derivedTasks(project), ...(plan.tasks || [])].sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
}

function isDone(task, plan) {
  return (plan.doneTaskIds || []).includes(task.id);
}

function taskChip(task) {
  if (task.source === 'manual') return 'done';
  return task.dueDate < isoLocal(Date.now()) ? 'uncited' : task.dueDate === isoLocal(Date.now()) ? 'doing' : '';
}

function taskActionLabel(task, done) {
  if (done) return '查看';
  if (task.nav === 'topic') return '去研究设计';
  if (task.nav === 'writing') return task.chapter ? '去写这一章' : '去写作台';
  if (task.nav === 'citation') return '去整理文献';
  if (task.nav === 'planner') return '去排计划';
  return '继续';
}

function renderTaskList(tasks, plan, emptyText) {
  if (!tasks.length) return `<div class="planner-empty">${emptyText}</div>`;
  return `<div class="planner-task-list">${tasks.map(task => {
    const done = isDone(task, plan);
    return `
    <div class="task-item">
      <button class="task-check ${done ? 'done' : ''}" type="button" data-task-done="${escapeHtml(task.id)}" role="checkbox" aria-checked="${done}" title="${done ? '撤销完成' : '标记完成'}" aria-label="${done ? '撤销完成' : '标记完成'}">${done ? '✓' : ''}</button>
      <div class="task-body">
        <div class="task-title">${escapeHtml(task.title)} ${done ? '<span class="chip done">已完成</span>' : ''}</div>
        <div class="task-meta">${task.dueDate ? `<span class="task-date">${escapeHtml(task.dueDate)}</span>` : ''}${task.note ? `<span>${escapeHtml(task.note)}</span>` : ''}</div>
      </div>
      <button class="btn ${done ? 'btn-ghost' : 'btn'} btn-sm" data-task-go="${escapeHtml(task.id)}">${taskActionLabel(task, done)}</button>
    </div>`;}).join('')}</div>`;
}

function currentStageText(stages) {
  const now = Date.now();
  const stage = stages.find(item => item.start <= now && now <= item.end);
  return stage ? `${stage.name}（${fmtDate(stage.start)} - ${fmtDate(stage.end)}）` : '尚未生成计划';
}

function render(el) {
  const project = getProject();
  const plan = getPlan();
  const rawCheckins = project.checkins || [];
  const checkins = rawCheckins.map(c => (typeof c === 'string' ? { date: c, chapter: '', note: '' } : c));
  const today = isoLocal(Date.now());
  const checkedToday = checkins.some(c => c.date === today);
  const daysLeft = project.dueDate ? Math.ceil((new Date(project.dueDate).getTime() - Date.now()) / DAY) : null;
  const streak = calcStreak(checkins.map(c => c.date));
  const chapters = project.outline || [];
  const stages = project.stages || [];
  const totalDays = stages.length ? (stages[0].end - stages[stages.length - 1].start) : 1;
  const tasks = allTasks(project, plan);
  const todayTasks = tasks.filter(task => task.dueDate <= today && !isDone(task, plan));
  const weekEnd = plusDays(6);
  const weekTasks = tasks.filter(task => task.dueDate > today && task.dueDate <= weekEnd && !isDone(task, plan));
  const overdueTasks = tasks.filter(task => task.dueDate < today && !isDone(task, plan));
  const weekPreview = weekExpanded ? weekTasks : weekTasks.slice(0, WEEK_PREVIEW);

  const calHtml = calGridHtml(checkins.map(c => c.date));

  const doneChapters = chapters.filter(c => (project.chapterProgress?.[c.chapter] || '未开始') === '已完成').length;
  const currentStage = currentStageText(stages);
  const latestCheckins = checkins.slice(0, 6);
  el.innerHTML = `
    <div class="planner-shell">
      <section class="card planner-hero">
        <div class="planner-hero-head">
          <div>
            <h2><span class="mark"></span>今日节奏</h2>
            <p class="desc">把今天要做什么、是否打卡、阶段是否合理放在同一条工作线上。</p>
          </div>
          <button class="btn btn-sm" id="checkin-btn" ${checkedToday ? 'disabled title="今天已经打过卡，明天再来"' : ''}>${checkedToday ? '今日已打卡 ✓' : '今日打卡'}</button>
        </div>
        <div class="planner-hero-metrics">
          <div class="planner-metric">
            <span>截止</span>
            <b class="${daysLeft != null && daysLeft < 0 ? 'danger' : ''}">${daysLeft != null ? (daysLeft >= 0 ? `${daysLeft} 天` : `已过 ${-daysLeft} 天`) : '未设定'}</b>
          </div>
          <div class="planner-metric">
            <span>当前阶段</span>
            <b>${escapeHtml(currentStage)}</b>
          </div>
          <div class="planner-metric">
            <span>章节完成</span>
            <b>${doneChapters}/${chapters.length || 0} 章</b>
          </div>
          <div class="planner-metric">
            <span>连续打卡</span>
            <b>${streak} 天</b>
          </div>
        </div>
        <div class="planner-checkin-strip">
          <div class="planner-checkin-copy">
            <strong>今日打卡</strong>
            <span>${checkedToday ? '今天已经记过一次了，下面可以继续看本周任务。' : '顺手记录今天推进到哪一章，后面回看节奏会很清楚。'}</span>
          </div>
          <div class="checkin-row ${chapters.length ? '' : 'no-chapters'}">
            ${chapters.length ? `<select id="ck-chapter"><option value="">（未写章节，仅打卡）</option>${chapters.map(c => `<option value="${escapeHtml(c.chapter)}"${c.chapter === project.currentChapter ? ' selected' : ''}>${escapeHtml(c.chapter)}</option>`).join('')}</select>` : ''}
            <input type="text" id="ck-note" placeholder="今日小结（可选）">
            ${checkedToday ? '<span class="seal planner-strip-seal">已打卡</span>' : ''}
          </div>
        </div>
      </section>

      <section class="planner-workspace">
        <div class="card planner-card planner-agenda-card">
          <div class="planner-panel-head">
            <div>
              <h2><span class="mark"></span>本周行动</h2>
              <p class="desc">${overdueTasks.length ? `先处理逾期任务：当前还有 <b>${overdueTasks.length}</b> 个任务已经过期。` : '只保留当前最该推进的事项，完成后再看后续安排。'}</p>
            </div>
            <div class="planner-counts">
              <span class="chip ${overdueTasks.length ? 'doing' : ''}">${todayTasks.length} 今日</span>
              <span class="chip">${weekTasks.length} 后续</span>
            </div>
          </div>
          ${renderTaskList(todayTasks, plan, '今天没有硬性待办，可以从本周任务里挑一项推进。')}
          ${overdueTasks.length ? '<div class="planner-actions-row"><button class="btn btn-ghost" id="plan-reschedule">重新调整后续任务</button></div>' : ''}
          <details class="planner-inline-capture">
            <summary>新增临时任务</summary>
            <div class="planner-inline-form">
              <div>
                <label class="field-label">任务内容</label>
                <input type="text" id="plan-task-title" placeholder="例如：补第三章 3 篇近三年中文文献">
              </div>
              <div>
                <label class="field-label">截止日期</label>
                <input type="date" id="plan-task-due" value="${plusDays(2)}">
              </div>
              <div>
                <label class="field-label">关联章节</label>
                <select id="plan-task-section"><option value="">暂不关联</option>${chapters.map(item => `<option value="${escapeHtml(item.chapter)}">${escapeHtml(item.chapter)}</option>`).join('')}</select>
              </div>
              <div class="planner-inline-wide">
                <label class="field-label">备注（可选）</label>
                <input type="text" id="plan-task-note" placeholder="例如：优先补方法比较和近三年研究现状">
              </div>
              <button class="btn" id="plan-task-add">加入任务列表</button>
            </div>
          </details>
          <div class="planner-subsection">
            <div class="planner-panel-head">
              <div>
                <h3>后续任务</h3>
                <p class="desc">明天起 7 天内需要看见的任务，默认只露出最靠前的几项。</p>
              </div>
            </div>
            ${renderTaskList(weekPreview, plan, '本周自动任务还不多，可以补充一个手动任务。')}
            ${!weekExpanded && weekTasks.length > WEEK_PREVIEW ? `<div class="planner-actions-row"><button class="btn btn-ghost btn-sm" id="plan-week-more">查看全部（${weekTasks.length} 条）</button></div>` : ''}
          </div>
        </div>

        <aside class="card planner-card planner-history-card">
          <div class="planner-panel-head">
            <div>
              <h2><span class="mark"></span>节奏记录</h2>
              <p class="desc">近 70 天打卡和最近小结放在这里，主要用于回看节奏。</p>
            </div>
          </div>
          <div class="planner-cal">${calHtml}</div>
          <div class="item-list planner-checkin-list">
            ${latestCheckins.length ? latestCheckins.map(c => `<div class="item"><div class="item-main"><div class="item-title mono">${escapeHtml(c.date)}${c.chapter ? ` · ${escapeHtml(c.chapter)}` : ''}</div>${c.note ? `<div class="item-meta">${escapeHtml(c.note)}</div>` : ''}</div>${c.chapter ? '<span class="chip doing">进行中</span>' : '<span class="seal planner-seal-lite">已打卡</span>'}</div>`).join('') : '<p class="desc">还没有打卡记录。</p>'}
          </div>
        </aside>
      </section>

      <section class="card planner-card planner-timeline-card">
        <div class="planner-panel-head">
          <div>
            <h2><span class="mark"></span>计划与时间轴</h2>
            <p class="desc">定模板和截止日期后生成倒排阶段；这里看整体节奏，不和今日行动混在一起。</p>
          </div>
        </div>
        <div class="planner-timeline-controls">
          <div class="form-row">
            <div><label class="field-label">计划模板</label><select id="plan-tpl">${TEMPLATES.map((t, i) => `<option value="${i}"${t.name === plan.lastTemplate ? ' selected' : ''}>${t.name}</option>`).join('')}</select></div>
            <div><label class="field-label">论文截止日期</label><input type="date" id="plan-due" value="${project.dueDate || ''}"></div>
          </div>
          <div class="planner-actions-row"><button class="btn" id="plan-gen">生成 / 更新计划</button></div>
        </div>
        <div id="plan-out" class="planner-timeline-shell">${stages.length ? renderGantt(stages, totalDays, project.chapterProgress) : '<div class="planner-empty">设定截止日期后，这里会显示倒排计划。</div>'}</div>
      </section>
    </div>
  `;
  el.querySelector('#plan-week-more')?.addEventListener('click', () => { weekExpanded = true; render(el); });
  el.querySelector('#plan-gen').addEventListener('click', () => {
    const dueVal = el.querySelector('#plan-due').value;
    if (!dueVal) {
      toast('请先选择论文截止日期', 'err');
      return;
    }
    const tpl = TEMPLATES[Number(el.querySelector('#plan-tpl').value)];
    const nextStages = backschedule(tpl.stages, dueVal);
    nextStages.forEach(stage => {
      if (/撰写/.test(stage.name) && chapters.length) stage.tasks = chapters.map(c => c.chapter);
    });
    updateBasics({ dueDate: dueVal });
    saveProject({ stages: nextStages });
    savePlan({ ...plan, lastTemplate: tpl.name });
    toast(`计划已更新：${tpl.name}`, 'ok');
    render(el);
  });

  el.querySelector('#plan-task-add').addEventListener('click', () => {
    const title = el.querySelector('#plan-task-title').value.trim();
    if (!title) {
      toast('请先填写任务内容', 'err');
      return;
    }
    const dueDate = el.querySelector('#plan-task-due').value || plusDays(2);
    const chapter = el.querySelector('#plan-task-section').value;
    const note = el.querySelector('#plan-task-note').value.trim();
    const nextPlan = {
      ...plan,
      tasks: [{
        id: makeTaskId('manual'),
        title,
        dueDate,
        chapter,
        note,
        source: 'manual',
        nav: chapter ? 'writing' : 'planner',
      }, ...(plan.tasks || [])],
    };
    savePlan(nextPlan);
    toast('任务已加入本周列表', 'ok');
    render(el);
  });

  el.querySelectorAll('[data-task-go]').forEach(btn =>
    btn.addEventListener('click', () => {
      const task = tasks.find(item => item.id === btn.dataset.taskGo);
      if (!task) return;
      if (task.chapter) {
        setChapterProgress(task.chapter, '进行中');
        saveProject({ currentChapter: task.chapter });
      }
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: task.nav || 'planner' }));
    }));

  el.querySelectorAll('[data-task-done]').forEach(btn =>
    btn.addEventListener('click', () => {
      const id = btn.dataset.taskDone;
      const done = new Set(plan.doneTaskIds || []);
      const task = tasks.find(item => item.id === id);
      if (done.has(id)) done.delete(id);
      else done.add(id);
      savePlan({ ...plan, doneTaskIds: [...done] });
      if (task?.chapter && done.has(id)) setChapterProgress(task.chapter, '已完成');
      toast(done.has(id) ? '任务已标记完成' : '已撤销完成状态', 'ok');
      render(el);
    }));

  el.querySelector('#plan-reschedule')?.addEventListener('click', () => {
    if (!overdueTasks.length) return;
    if (!confirm(`当前有 ${overdueTasks.length} 个逾期任务，是否把未完成的手动任务顺延到未来 7 天内？`)) return;
    let shift = 1;
    const rescheduled = (plan.tasks || []).map(task => {
      if ((plan.doneTaskIds || []).includes(task.id)) return task;
      if (!task.dueDate || task.dueDate >= today) return task;
      const next = { ...task, dueDate: plusDays(Math.min(shift, 7)) };
      shift += 1;
      return next;
    });
    savePlan({
      ...plan,
      tasks: rescheduled,
      lastRescheduledAt: new Date().toISOString(),
    });
    toast('后续任务已顺延，请按新的节奏推进', 'ok');
    render(el);
  });

  el.querySelector('#checkin-btn').addEventListener('click', () => {
    const chapter = el.querySelector('#ck-chapter')?.value || '';
    const note = el.querySelector('#ck-note').value.trim();
    const list = [...(project.checkins || [])];
    list.unshift({ date: isoLocal(Date.now()), chapter, note });
    saveProject({ checkins: list });
    if (chapter) setChapterProgress(chapter, '进行中');
    toast(chapter ? `打卡成功，${chapter} 已标记为「进行中」` : '打卡成功，继续保持！', 'ok');
    render(el);
  });
}

export default {
  id: 'planner',
  icon: '',
  title: '计划与进度',
  subtitle: '今日任务、本周任务与时间轴',
  projectScoped: true,
  render,
};
