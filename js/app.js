// PaperPilot 应用入口：导航、模块挂载、全局状态
import projects from './modules/projects.js';
import dashboard from './modules/dashboard.js';
import topic from './modules/topic.js';
import writing from './modules/writing.js';
import citation from './modules/citation.js';
import planner from './modules/planner.js';
import projectSettings from './modules/project-settings.js';
import settings from './modules/settings.js';
import { ICONS } from './icons.js';
import { getConfig } from './api.js';
import { getProject, hasActiveProject, projectStoreReady } from './project.js';

const MODULES = [projects, dashboard, topic, citation, writing, planner, projectSettings, settings];
const container = document.getElementById('module-container');
const navEl = document.getElementById('nav');

function renderNav() {
  navEl.innerHTML = '';
  const visible = MODULES.filter(m => m.id !== 'settings')
    .filter(m => m.id === 'projects' || hasActiveProject());
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
  if (cfg.apiKey) {
    pill.textContent = `API 已配置 · ${cfg.model}`;
    pill.classList.add('ready');
  } else {
    pill.textContent = '未配置 API';
    pill.classList.remove('ready');
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
document.addEventListener('tm:project-changed', updateProjectBadge);
document.addEventListener('tm:projects-changed', renderNav);

document.getElementById('nav-settings').addEventListener('click', () =>
  document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'settings' })));

await projectStoreReady;
renderNav();
switchModule(hasActiveProject() ? 'dashboard' : 'projects');
updateApiPill();
updateProjectBadge();
