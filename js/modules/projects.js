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
import { loadDemoData, hasExistingData } from '../demo-data.js';
import { ICONS } from '../icons.js';
import { meaningfulTitle } from '../title-utils.js';

function fmtDate(iso) {
  if (!iso) return '未编辑';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default {
  id: 'projects',
  icon: '',
  title: '项目中心',
  subtitle: '按论文项目组织研究、写作、文献和进度',

  render(el) {
    const projects = listProjects();
    const activeId = getAppState().activeProjectId;

    const sampleDrawer = `
      <details class="project-sample-drawer">
        <summary>需要快速查看完整流程？</summary>
        <div>
          <p>可载入一份示例数据体验研究设计、写作台和文献库。载入前会再次确认。</p>
          <button class="btn btn-ghost btn-sm" id="pc-sample-load" type="button">载入示例项目</button>
        </div>
      </details>`;

    el.innerHTML = `
      ${projects.length ? `<div class="card project-center-hero">
        <div class="hero-top">
          <div>
            <h2><span class="mark"></span>我的论文项目</h2>
            <p class="desc">每篇论文都是一个独立项目。题目、研究设计、文献、草稿、计划和导出状态都会在这里汇总。</p>
          </div>
          <button class="btn btn-lg" id="pc-new">创建论文项目</button>
        </div>
      </div>` : ''}

      ${projects.length ? `
        <div class="project-grid">
          ${projects.map(project => {
            const stats = projectStats(project.id);
            const displayTitle = meaningfulTitle(project.researchDesign?.title, project.title) || '未定题项目';
            return `
              <div class="card project-card ${project.id === activeId ? 'active' : ''}">
                <div class="project-card-head">
                  <div>
                    <h2>${escapeHtml(displayTitle)}</h2>
                    <p class="desc">${escapeHtml(project.degreeType || '未设置类型')}${project.currentStage ? ` · ${escapeHtml(project.currentStage)}` : ''}</p>
                  </div>
                  ${project.id === activeId ? '<span class="seal">当前项目</span>' : ''}
                </div>
                <div class="project-meta">
                  <span class="chip">${stats.progressPct}% 进度</span>
                  <span class="chip">${stats.chapterCount} 章</span>
                  <span class="chip">${stats.totalWords} 字</span>
                  ${stats.daysLeft == null ? '' : `<span class="chip ${stats.daysLeft <= 7 ? 'doing' : ''}">距截止 ${stats.daysLeft} 天</span>`}
                </div>
                <div class="project-facts">
                  <div><span>最近编辑</span><b>${fmtDate(project.updatedAt)}</b></div>
                  <div><span>已完成章节</span><b>${stats.doneCount}/${stats.chapterCount || 0}</b></div>
                </div>
                <div class="result-actions project-actions">
                  <button class="btn" data-open="${project.id}">继续写作</button>
                  <button class="btn btn-ghost" data-settings="${project.id}">项目设置</button>
                  <details class="project-more">
                    <summary aria-label="更多项目操作">更多</summary>
                    <div class="project-more-menu">
                      <button type="button" data-dup="${project.id}">复制项目</button>
                      <button type="button" data-export="${project.id}">导出备份</button>
                      <button type="button" class="danger" data-del="${project.id}">删除项目</button>
                    </div>
                  </details>
                </div>
              </div>`;
          }).join('')}
        </div>
        ${sampleDrawer}`
      : `
        <div class="card empty project-empty-start">
          <div class="empty-icon">${ICONS.bookOpen}</div>
          <h2>创建你的第一篇论文项目</h2>
          <p>系统会按一篇论文的完整流程组织研究设计、写作、文献和导出。</p>
          <div class="empty-actions">
            <button class="btn btn-lg" id="pc-empty-new">创建论文项目</button>
          </div>
          ${sampleDrawer}
        </div>`}

      <div class="modal-backdrop" id="pc-create-modal" hidden>
        <div class="modal-panel">
          <div class="hero-top modal-head project-create-head">
            <div>
              <h2><span class="mark"></span>创建论文项目</h2>
              <p class="desc">先建一条论文主线。题目可以先留空，创建后进入研究设计，从描述研究想法开始、由 AI 生成候选题目再定稿；学位类型和截止日期之后都能改。</p>
            </div>
            <button class="btn btn-ghost btn-sm icon-only" id="pc-modal-close" type="button" aria-label="关闭">${ICONS.close}</button>
          </div>
          <label class="field-label">项目名称<span class="field-hint">（可选，留空则先去研究设计定题目）</span></label>
          <input type="text" id="pc-title" placeholder="例如：基于大语言模型的智能客服满意度研究（可留空）">
          <div class="form-row">
            <div>
              <label class="field-label">学位类型</label>
              <select id="pc-degree">
                ${['本科论文', '硕士论文', '博士论文', '课程论文'].map(d => `<option${d === '硕士论文' ? ' selected' : ''}>${d}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="field-label">截止日期（可选）</label>
              <input type="date" id="pc-due">
            </div>
          </div>
          <div class="result-actions project-create-actions">
            <button class="btn" id="pc-create-submit" type="button">创建并前往研究设计</button>
            <button class="btn btn-ghost" id="pc-create-cancel" type="button">取消</button>
          </div>
        </div>
      </div>
    `;

    function openProject(id, target = 'dashboard') {
      setActiveProject(id);
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: target }));
    }

    const modal = el.querySelector('#pc-create-modal');
    const titleInput = el.querySelector('#pc-title');
    const degreeInput = el.querySelector('#pc-degree');
    const dueInput = el.querySelector('#pc-due');

    function closeCreateModal() {
      if (!modal) return;
      modal.hidden = true;
      document.body.style.overflow = '';
    }

    function openCreateModal() {
      if (!modal) return;
      modal.hidden = false;
      document.body.style.overflow = 'hidden';
      titleInput.value = '';
      degreeInput.value = '硕士论文';
      dueInput.value = '';
      setTimeout(() => titleInput.focus(), 0);
    }

    function submitCreate() {
      const title = titleInput.value.trim();
      const project = createProject({
        title,
        degreeType: degreeInput.value,
        dueDate: dueInput.value || '',
      });
      closeCreateModal();
      // 新建后直接进入研究设计：从描述方向开始，AI 生成候选题目 → 确定 → 方案 → 大纲
      toast(title ? `论文项目已创建，去研究设计把题目定下来` : '项目已创建，先到研究设计描述方向、定题目', 'ok');
      openProject(project.id, 'topic');
    }

    el.querySelector('#pc-new')?.addEventListener('click', openCreateModal);
    el.querySelector('#pc-empty-new')?.addEventListener('click', openCreateModal);
    el.querySelector('#pc-sample-load')?.addEventListener('click', () => {
      if (hasExistingData() && !confirm('载入示例项目会覆盖当前的论文、文献、打卡等本地数据。继续吗？')) return;
      loadDemoData();
      toast('示例项目已载入', 'ok');
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'dashboard' }));
    });
    el.querySelector('#pc-modal-close')?.addEventListener('click', closeCreateModal);
    el.querySelector('#pc-create-cancel')?.addEventListener('click', closeCreateModal);
    el.querySelector('#pc-create-submit')?.addEventListener('click', submitCreate);
    modal?.addEventListener('click', e => {
      if (e.target === modal) closeCreateModal();
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal && !modal.hidden) closeCreateModal();
    });
    titleInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') submitCreate();
    });
    const closeProjectMenus = (except = null) => {
      el.querySelectorAll('.project-more[open]').forEach(menu => {
        if (menu !== except) menu.open = false;
      });
    };
    el.querySelectorAll('.project-more').forEach(menu => {
      menu.addEventListener('toggle', () => {
        if (menu.open) closeProjectMenus(menu);
      });
    });
    el.addEventListener('click', e => {
      if (!e.target.closest('.project-more')) closeProjectMenus();
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeProjectMenus();
    });

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
        closeProjectMenus();
        const project = projects.find(x => x.id === btn.dataset.export);
        if (!project) return;
        const displayTitle = meaningfulTitle(project.researchDesign?.title, project.title) || '论文项目';
        const blob = new Blob([JSON.stringify({
          app: 'paperpilot',
          version: 4,
          exportedAt: new Date().toISOString(),
          project,
        }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${displayTitle.replace(/[\\/:*?"<>|]/g, '_')}.paperpilot.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('项目备份已导出', 'ok');
      }));
    el.querySelectorAll('[data-del]').forEach(btn =>
      btn.addEventListener('click', () => {
        closeProjectMenus();
        const project = projects.find(x => x.id === btn.dataset.del);
        if (!project) return;
        const displayTitle = meaningfulTitle(project.researchDesign?.title, project.title) || '未定题项目';
        if (!confirm(`确定删除「${displayTitle}」吗？草稿、文献、打卡和版本历史都会一起删除。`)) return;
        deleteProject(project.id);
        toast('项目已删除', 'ok');
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'projects' }));
      }));
  },
};
