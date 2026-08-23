// PaperPilot 应用入口：导航、模块挂载、全局状态
import projects from './modules/projects.js';
import dashboard from './modules/dashboard.js';
import topic from './modules/topic.js';
import writing from './modules/writing.js';
import citation from './modules/citation.js';
import planner from './modules/planner.js';
import checkExport from './modules/check-export.js';
import projectSettings from './modules/project-settings.js';
import settings from './modules/settings.js';
import { ICONS } from './icons.js';
import { getConfig, shouldUseLiveAI } from './api.js';
import { getProject, hasActiveProject, projectStoreReady } from './project.js';

const MODULES = [projects, dashboard, topic, citation, writing, planner, checkExport, projectSettings, settings];
const container = document.getElementById('module-container');
const navEl = document.getElementById('nav');
const sidebarToggleEl = document.getElementById('sidebar-toggle');

function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  if (sidebarToggleEl) {
    sidebarToggleEl.textContent = collapsed ? '⇥' : '⇤';
    sidebarToggleEl.title = collapsed ? '展开导航栏' : '收起导航栏';
    sidebarToggleEl.setAttribute('aria-label', collapsed ? '展开导航栏' : '收起导航栏');
  }
}

function researchDesignComplete() {
  // 研究设计是一次性初始化：大纲已采用即视为完成，不再常驻导航
  return !!(getProject().outline || []).length;
}

function renderNav() {
  navEl.innerHTML = '';
  const visible = MODULES.filter(m => m.id !== 'settings')
    .filter(m => m.id === 'projects' || hasActiveProject())
    .filter(m => m.id !== 'topic' || !researchDesignComplete());
  visible.forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.dataset.module = m.id;
    btn.innerHTML = `<span class="nav-icon">${ICONS[m.id] || ICONS.settings || ''}</span><span>${m.title}</span>`;
    // 导航统一走 tm:navigate 事件（与页内 data-nav 一致），供模块监听（如中断 AI 请求）
    btn.addEventListener('click', () =>
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: m.id })));
    navEl.appendChild(btn);
  });
  document.getElementById('nav-settings').innerHTML =
    `<span class="nav-icon">${ICONS.settings}</span><span>应用设置</span>`;
}

export function switchModule(id) {
  const target = MODULES.find(x => x.id === id) || MODULES[0];
  const m = (!hasActiveProject() && target.projectScoped) ? projects : target;
  document.body.dataset.module = m.id;
  document.querySelectorAll('.nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.module === m.id));
  document.getElementById('nav-settings').classList.toggle('active', m.id === 'settings');
  document.getElementById('module-title').textContent = m.title;
  document.getElementById('module-subtitle').textContent = m.subtitle;
  document.title = `${m.title} · PaperPilot`; // 标签页标题随模块变化
  container.innerHTML = '';
  try {
    m.render(container);
  } catch (e) {
    console.error('模块渲染失败：', m.id, e);
    const card = document.createElement('div');
    card.className = 'card';
    const h = document.createElement('h2');
    h.textContent = '页面加载失败';
    const pEl = document.createElement('p');
    pEl.className = 'desc';
    pEl.textContent = `${e.message}（请把这条信息反馈给开发者）`;
    card.append(h, pEl);
    container.append(card);
  }
  window.scrollTo({ top: 0 });
}

function updateApiPill() {
  const pill = document.getElementById('api-status');
  const cfg = getConfig();
  if (cfg.apiKey && shouldUseLiveAI()) {
    pill.textContent = `API 已配置 · ${cfg.model}`;
    pill.classList.add('ready');
    pill.classList.remove('demo');
    pill.title = '已启用真实 AI 调用';
  } else if (cfg.apiKey) {
    pill.textContent = '演示模式 · 已配 Key 未启用';
    pill.classList.add('demo');
    pill.classList.remove('ready');
    pill.title = '已填入 API Key，但尚未打开「真实 AI 调用」。到「应用设置」打开即可使用真实模型。';
  } else {
    pill.textContent = '演示模式 · Mock 结果';
    pill.classList.add('demo');
    pill.classList.remove('ready');
    pill.title = '当前为演示/模拟结果，不消耗额度。真实 AI 请到「应用设置」填入 API Key。';
  }
}

// 顶部论文徽标：显示当前论文（项目主线，链路④）
function updateProjectBadge() {
  const badge = document.getElementById('project-badge');
  if (!hasActiveProject()) {
    badge.textContent = '未打开项目';
    badge.title = '还没有创建或选择论文项目';
    badge.classList.remove('ready');
    return;
  }
  const p = getProject();
  const t = p.title.trim();
  badge.textContent = t ? `项目 · ${t.length > 12 ? t.slice(0, 12) + '…' : t}` : '未命名项目';
  badge.title = t || '未命名项目';
  badge.classList.add('ready');
}

// 模块间跳转：任何模块可通过事件导航（dispatchEvent('tm:navigate', {detail: 'topic'})）
document.addEventListener('tm:navigate', e => switchModule(e.detail));
// 配置变化时刷新状态指示
document.addEventListener('tm:config-changed', updateApiPill);
// 论文项目变化时刷新徽标
// 论文项目变化时刷新徽标；研究设计完成态变化时刷新导航（隐藏/显示"研究设计"）
let lastResearchComplete = null;
document.addEventListener('tm:project-changed', () => {
  updateProjectBadge();
  const complete = researchDesignComplete();
  if (complete !== lastResearchComplete) {
    lastResearchComplete = complete;
    renderNav();
  }
});
document.addEventListener('tm:projects-changed', renderNav);

document.getElementById('nav-settings').addEventListener('click', () =>
  document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'settings' })));

sidebarToggleEl?.addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  applySidebarCollapsed(collapsed);
  window.localStorage.setItem('paperpilot.sidebarCollapsed', collapsed ? '1' : '0');
});

await projectStoreReady;
applySidebarCollapsed(window.localStorage.getItem('paperpilot.sidebarCollapsed') === '1');
renderNav();
switchModule(hasActiveProject() ? 'dashboard' : 'projects');
updateApiPill();
updateProjectBadge();
