import { toast, escapeHtml } from '../ui.js';
import {
  listProjects,
  createProject,
  setActiveProject,
  duplicateProject,
  deleteProject,
  projectStats,
  getAppState,
} from '../project.js';

function fmtDate(iso) {
  if (!iso) return '未编辑';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default {
  id: 'projects',
  icon: '📁',
  title: '项目中心',
  subtitle: '按论文项目组织研究、写作、文献和进度',

  render(el) {
    const projects = listProjects();
    const activeId = getAppState().activeProjectId;

    el.innerHTML = `
      <div class="card project-center-hero">
        <div class="hero-top">
          <div>
            <h2><span class="mark"></span>我的论文项目</h2>
            <p class="desc">V4 从这里开始：每篇论文都是一个独立项目，题目、草稿、文献、打卡、版本历史全部隔离保存。</p>
          </div>
          <button class="btn btn-lg" id="pc-new">创建论文项目</button>
        </div>
      </div>

      ${projects.length ? `
        <div class="project-grid">
          ${projects.map(project => {
            const stats = projectStats(project.id);
            return `
              <div class="card project-card ${project.id === activeId ? 'active' : ''}">
                <div class="project-card-head">
                  <div>
                    <h2>${escapeHtml(project.title || '未命名论文')}</h2>
                    <p class="desc">${escapeHtml(project.degreeType || '未设置类型')}${project.currentStage ? ` · ${escapeHtml(project.currentStage)}` : ''}</p>
                  </div>
                  ${project.id === activeId ? '<span class="seal">当前项目</span>' : ''}
                </div>
                <div class="project-meta">
                  <span class="chip">${stats.progressPct}% 进度</span>
                  <span class="chip">${stats.chapterCount} 章</span>
                  <span class="chip">${stats.totalWords} 字</span>
                  <span class="chip ${stats.daysLeft != null && stats.daysLeft <= 7 ? 'doing' : ''}">${stats.daysLeft == null ? '未设截止' : `距截止 ${stats.daysLeft} 天`}</span>
                </div>
                <div class="project-facts">
                  <div><span>最近编辑</span><b>${fmtDate(project.updatedAt)}</b></div>
                  <div><span>已完成章节</span><b>${stats.doneCount}/${stats.chapterCount || 0}</b></div>
                </div>
                <div class="result-actions">
                  <button class="btn" data-open="${project.id}">继续写作</button>
                  <button class="btn btn-ghost" data-settings="${project.id}">项目设置</button>
                  <button class="btn btn-ghost btn-sm" data-dup="${project.id}">复制项目</button>
                  <button class="btn btn-ghost btn-sm" data-export="${project.id}">导出备份</button>
                  <button class="btn btn-danger btn-sm" data-del="${project.id}">删除</button>
                </div>
              </div>`;
          }).join('')}
        </div>`
      : `
        <div class="card empty">
          <div class="empty-icon">文</div>
          <p>还没有论文项目。V4 会按“项目”而不是“模块”推进整篇论文。</p>
          <button class="btn btn-lg" id="pc-empty-new">创建论文项目</button>
        </div>`}
    `;

    function openProject(id, target = 'dashboard') {
      setActiveProject(id);
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: target }));
    }

    function promptCreate() {
      const project = createProject({ title: '' });
      toast('论文项目已创建，下一步先补充项目设置', 'ok');
      openProject(project.id, 'project-settings');
    }

    el.querySelector('#pc-new')?.addEventListener('click', promptCreate);
    el.querySelector('#pc-empty-new')?.addEventListener('click', promptCreate);

    el.querySelectorAll('[data-open]').forEach(btn =>
      btn.addEventListener('click', () => openProject(btn.dataset.open, 'dashboard')));
    el.querySelectorAll('[data-settings]').forEach(btn =>
      btn.addEventListener('click', () => openProject(btn.dataset.settings, 'project-settings')));
    el.querySelectorAll('[data-dup]').forEach(btn =>
      btn.addEventListener('click', () => {
        const copy = duplicateProject(btn.dataset.dup);
        if (!copy) return;
        toast('已复制为新项目', 'ok');
        openProject(copy.id, 'project-settings');
      }));
    el.querySelectorAll('[data-export]').forEach(btn =>
      btn.addEventListener('click', () => {
        const project = projects.find(x => x.id === btn.dataset.export);
        if (!project) return;
        const blob = new Blob([JSON.stringify({
          app: 'paperpilot',
          version: 4,
          exportedAt: new Date().toISOString(),
          project,
        }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${(project.title || '论文项目').replace(/[\\/:*?"<>|]/g, '_')}.paperpilot.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('项目备份已导出', 'ok');
      }));
    el.querySelectorAll('[data-del]').forEach(btn =>
      btn.addEventListener('click', () => {
        const project = projects.find(x => x.id === btn.dataset.del);
        if (!project) return;
        if (!confirm(`确定删除「${project.title || '未命名论文'}」吗？草稿、文献、打卡和版本历史都会一起删除。`)) return;
        deleteProject(project.id);
        toast('项目已删除', 'ok');
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'projects' }));
      }));
  },
};
