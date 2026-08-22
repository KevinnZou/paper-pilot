// 项目仓库：V4 Phase 1 多项目模型 + IndexedDB 持久化。
// 读写走同步内存缓存，启动时从 IndexedDB 回填，避免把整个应用改成异步链。
import { get, remove } from './storage.js';
import { loadProjectSnapshot, saveProjectSnapshot, clearProjectSnapshot } from './project-db.js';

const APP_KEY = 'app';
const PROJECTS_KEY = 'projects';
const DAY = 86400000;
const LOCAL_PROJECT_KEYS = ['project', 'drafts', 'citations', 'checkins', 'versions', APP_KEY, PROJECTS_KEY];

let cacheApp = blankApp();
let cacheProjects = {};
let persistTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function emitProject() {
  document.dispatchEvent(new Event('tm:project-changed'));
}

function emitProjects() {
  document.dispatchEvent(new Event('tm:projects-changed'));
  emitProject();
}

function makeId() {
  return (globalThis.crypto?.randomUUID?.() || `pp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function blankApp() {
  return {
    schemaVersion: 4,
    activeProjectId: '',
    projectOrder: [],
    migration: {
      legacyV4Done: false,
    },
    storage: {
      engine: 'indexeddb',
      hydratedAt: '',
      lastBackupAt: '',
    },
  };
}

function blankVersions() {
  return { chapters: {}, doc: [] };
}

function blankProject(id = makeId(), partial = {}) {
  const ts = nowIso();
  return {
    id,
    title: '',
    degreeType: '',
    school: '',
    college: '',
    advisor: '',
    dueDate: '',
    referenceStandard: 'GB/T 7714-2025',
    createdAt: ts,
    updatedAt: ts,
    researchDesign: {},
    outline: [],
    chapterProgress: {},
    currentChapter: '',
    materials: [],
    evidence: [],
    plan: {
      tasks: [],
      doneTaskIds: [],
      lastTemplate: '',
      lastRescheduledAt: '',
    },
    currentStage: '',
    stages: [],
    abstract: '',
    keywords: '',
    acknowledgments: '',
    documentV2: null,
    drafts: {},
    citations: [],
    checkins: [],
    versions: blankVersions(),
    ...partial,
    id,
  };
}

function touch(project) {
  return { ...project, updatedAt: nowIso() };
}

function ensureProjectKeys(project) {
  return blankProject(project.id || makeId(), {
    ...project,
    drafts: project.drafts || {},
    citations: project.citations || [],
    checkins: project.checkins || [],
    documentV2: project.documentV2 || null,
    materials: project.materials || [],
    evidence: project.evidence || [],
    plan: {
      tasks: project.plan?.tasks || [],
      doneTaskIds: project.plan?.doneTaskIds || [],
      lastTemplate: project.plan?.lastTemplate || '',
      lastRescheduledAt: project.plan?.lastRescheduledAt || '',
    },
    outline: project.outline || [],
    chapterProgress: project.chapterProgress || {},
    stages: project.stages || [],
    versions: {
      chapters: project.versions?.chapters || {},
      doc: Array.isArray(project.versions?.doc) ? project.versions.doc : [],
    },
  });
}

function readApp() {
  return cacheApp;
}

function readProjects() {
  return cacheProjects;
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistProjectStoreNow().catch(err => console.error('[paperpilot] IndexedDB 保存失败', err));
  }, 120);
}

async function persistProjectStoreNow() {
  cacheApp = {
    ...cacheApp,
    storage: {
      ...(cacheApp.storage || {}),
      engine: 'indexeddb',
      hydratedAt: cacheApp.storage?.hydratedAt || nowIso(),
    },
  };
  await saveProjectSnapshot({
    app: cacheApp,
    projects: cacheProjects,
  });
}

function writeApp(app) {
  cacheApp = { ...blankApp(), ...app };
  schedulePersist();
}

function writeProjects(projects) {
  cacheProjects = projects;
  schedulePersist();
}

function hydrateFromLegacyLocalStorage() {
  const localApp = get(APP_KEY, null);
  const localProjects = get(PROJECTS_KEY, null);

  if (localApp && localProjects && Object.keys(localProjects).length) {
    cacheApp = { ...blankApp(), ...localApp };
    cacheProjects = localProjects;
    return;
  }

  const legacy = get('project', null);
  const legacyDrafts = get('drafts', null);
  const legacyCitations = get('citations', null);
  const legacyCheckins = get('checkins', null);
  const legacyVersions = get('versions', null);
  const hasLegacy =
    !!legacy ||
    !!(legacyDrafts && Object.keys(legacyDrafts).length) ||
    !!(legacyCitations && legacyCitations.length) ||
    !!(legacyCheckins && legacyCheckins.length) ||
    !!legacyVersions;

  if (!hasLegacy) return;

  const id = makeId();
  cacheProjects = {
    [id]: blankProject(id, {
      title: legacy?.title || '我的论文项目',
      degreeType: legacy?.degreeType || '',
      dueDate: legacy?.dueDate || '',
      researchDesign: legacy?.researchDesign || {},
      outline: legacy?.outline || [],
      chapterProgress: legacy?.chapterProgress || {},
      currentChapter: legacy?.currentChapter || '',
      materials: legacy?.materials || [],
      evidence: legacy?.evidence || [],
      plan: legacy?.plan || { tasks: [], doneTaskIds: [], lastTemplate: '', lastRescheduledAt: '' },
      stages: legacy?.stages || [],
      currentStage: legacy?.currentStage || '',
      abstract: legacy?.abstract || '',
      keywords: legacy?.keywords || '',
      acknowledgments: legacy?.acknowledgments || '',
      drafts: legacyDrafts || {},
      citations: legacyCitations || [],
      checkins: legacyCheckins || [],
      versions: legacyVersions || blankVersions(),
    }),
  };
  cacheApp = {
    ...blankApp(),
    activeProjectId: id,
    projectOrder: [id],
    migration: { legacyV4Done: true },
  };
}

function normalizeCaches() {
  let changed = false;
  cacheApp = { ...blankApp(), ...cacheApp };
  cacheProjects = cacheProjects || {};

  cacheApp.projectOrder.forEach(id => {
    if (cacheProjects[id]) {
      cacheProjects[id] = ensureProjectKeys(cacheProjects[id]);
      changed = true;
    }
  });

  Object.keys(cacheProjects).forEach(id => {
    if (!cacheApp.projectOrder.includes(id)) {
      cacheApp.projectOrder.push(id);
      changed = true;
    }
    cacheProjects[id] = ensureProjectKeys(cacheProjects[id]);
  });

  if (cacheApp.activeProjectId && !cacheProjects[cacheApp.activeProjectId]) {
    cacheApp.activeProjectId = cacheApp.projectOrder.find(id => cacheProjects[id]) || '';
    changed = true;
  }

  if (!cacheApp.activeProjectId && cacheApp.projectOrder.length) {
    cacheApp.activeProjectId = cacheApp.projectOrder[0];
    changed = true;
  }

  if (changed) schedulePersist();
}

function clearLegacyProjectKeys() {
  LOCAL_PROJECT_KEYS.forEach(key => remove(key));
}

export async function ensureProjectStore() {
  hydrateFromLegacyLocalStorage();
  normalizeCaches();

  try {
    const snapshot = await loadProjectSnapshot();
    if (snapshot?.projects && Object.keys(snapshot.projects).length) {
      cacheApp = { ...blankApp(), ...(snapshot.app || {}) };
      cacheProjects = snapshot.projects || {};
      normalizeCaches();
    } else if (Object.keys(cacheProjects).length || cacheApp.activeProjectId) {
      await persistProjectStoreNow();
    }
  } catch (err) {
    console.warn('[paperpilot] IndexedDB 不可用，当前会话退回内存缓存', err);
    cacheApp = {
      ...cacheApp,
      storage: {
        ...(cacheApp.storage || {}),
        engine: 'memory',
      },
    };
  }

  cacheApp = {
    ...cacheApp,
    storage: {
      ...(cacheApp.storage || {}),
      engine: cacheApp.storage?.engine || 'indexeddb',
      hydratedAt: nowIso(),
    },
  };
  clearLegacyProjectKeys();
  if (cacheApp.storage.engine === 'indexeddb') {
    await persistProjectStoreNow();
  }
}

export const projectStoreReady = ensureProjectStore();

export function getAppState() {
  return readApp();
}

export function listProjects() {
  const app = readApp();
  const projects = readProjects();
  return app.projectOrder
    .map(id => projects[id])
    .filter(Boolean)
    .map(project => ensureProjectKeys(project));
}

export function getActiveProjectId() {
  return readApp().activeProjectId || '';
}

export function setActiveProject(id) {
  const app = readApp();
  const projects = readProjects();
  if (!projects[id]) return false;
  app.activeProjectId = id;
  if (!app.projectOrder.includes(id)) app.projectOrder.unshift(id);
  writeApp(app);
  emitProjects();
  return true;
}

export function createProject(initial = {}) {
  const app = readApp();
  const projects = readProjects();
  const id = makeId();
  const project = blankProject(id, initial);
  projects[id] = project;
  app.projectOrder = [id, ...app.projectOrder.filter(x => x !== id)];
  app.activeProjectId = id;
  writeProjects({ ...projects });
  writeApp({ ...app });
  emitProjects();
  return project;
}

export function duplicateProject(id) {
  const projects = readProjects();
  const source = projects[id];
  if (!source) return null;
  return createProject({
    ...source,
    title: source.title ? `${source.title}（副本）` : '未命名论文（副本）',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

export function deleteProject(id) {
  const app = readApp();
  const projects = { ...readProjects() };
  if (!projects[id]) return false;
  delete projects[id];
  app.projectOrder = app.projectOrder.filter(x => x !== id);
  if (app.activeProjectId === id) app.activeProjectId = app.projectOrder[0] || '';
  writeProjects(projects);
  writeApp({ ...app });
  emitProjects();
  return true;
}

export function reorderProjects(ids) {
  const app = readApp();
  app.projectOrder = ids.filter(Boolean);
  writeApp({ ...app });
  emitProjects();
}

export function getProject(projectId = getActiveProjectId()) {
  const projects = readProjects();
  if (!projectId || !projects[projectId]) return blankProject('', {});
  return ensureProjectKeys(projects[projectId]);
}

export function saveProject(partial, projectId = getActiveProjectId()) {
  if (!projectId) return null;
  const projects = { ...readProjects() };
  const current = getProject(projectId);
  const next = touch(ensureProjectKeys({
    ...current,
    ...partial,
    id: projectId,
  }));
  projects[projectId] = next;
  writeProjects(projects);
  emitProject();
  return next;
}

export function updateBasics({ title, degreeType, dueDate, school, college, advisor, referenceStandard }, projectId = getActiveProjectId()) {
  const p = getProject(projectId);
  return saveProject({
    title: title ?? p.title,
    degreeType: degreeType ?? p.degreeType,
    dueDate: dueDate ?? p.dueDate,
    school: school ?? p.school,
    college: college ?? p.college,
    advisor: advisor ?? p.advisor,
    referenceStandard: referenceStandard ?? p.referenceStandard,
  }, projectId);
}

function getBucket(key, fallback, projectId = getActiveProjectId()) {
  const p = getProject(projectId);
  return p.id ? (p[key] ?? fallback) : fallback;
}

function saveBucket(key, value, projectId = getActiveProjectId()) {
  return saveProject({ [key]: value }, projectId);
}

export function getDrafts(projectId) {
  return getBucket('drafts', {}, projectId);
}

export function saveDrafts(drafts, projectId) {
  return saveBucket('drafts', drafts, projectId);
}

export function getCitations(projectId) {
  return getBucket('citations', [], projectId);
}

export function saveCitations(citations, projectId) {
  return saveBucket('citations', citations, projectId);
}

export function getCheckins(projectId) {
  return getBucket('checkins', [], projectId);
}

export function saveCheckins(checkins, projectId) {
  return saveBucket('checkins', checkins, projectId);
}

export function getEvidence(projectId) {
  return getBucket('evidence', [], projectId);
}

export function saveEvidence(evidence, projectId) {
  return saveBucket('evidence', evidence, projectId);
}

export function getPlan(projectId) {
  return getBucket('plan', {
    tasks: [],
    doneTaskIds: [],
    lastTemplate: '',
    lastRescheduledAt: '',
  }, projectId);
}

export function savePlan(plan, projectId) {
  return saveBucket('plan', plan, projectId);
}

export function getVersionsStore(projectId) {
  return getBucket('versions', blankVersions(), projectId);
}

export function saveVersionsStore(versions, projectId) {
  return saveBucket('versions', versions, projectId);
}

export function hasActiveProject() {
  return !!getActiveProjectId();
}

export function projectStats(projectId = getActiveProjectId()) {
  const p = getProject(projectId);
  const chapters = p.outline || [];
  const progress = p.chapterProgress || {};
  const done = chapters.filter(c => progress[c.chapter] === '已完成').length;
  const due = p.dueDate ? Math.ceil((new Date(p.dueDate).getTime() - Date.now()) / DAY) : null;
  const drafts = getDrafts(projectId);
  const totalWords = Object.values(drafts).reduce((sum, d) => sum + String(d?.content || '').replace(/\s/g, '').length, 0);
  return {
    chapterCount: chapters.length,
    doneCount: done,
    progressPct: chapters.length ? Math.round(done / chapters.length * 100) : 0,
    daysLeft: due,
    totalWords,
  };
}

export function adoptOutline(text, projectId = getActiveProjectId()) {
  const chapters = parseOutline(text);
  const progress = {};
  chapters.forEach(c => { progress[c.chapter] = '未开始'; });
  saveProject({
    outline: chapters,
    chapterProgress: progress,
    currentChapter: chapters[0]?.chapter || '',
  }, projectId);
  return chapters;
}

export function setChapterProgress(chapter, status, projectId = getActiveProjectId()) {
  const p = getProject(projectId);
  p.chapterProgress[chapter] = status;
  saveProject({ chapterProgress: p.chapterProgress }, projectId);
}

export function addMaterial({ type, title, content }, projectId = getActiveProjectId()) {
  const p = getProject(projectId);
  const item = {
    id: String(Date.now()),
    type,
    title,
    content,
    createdAt: new Date().toLocaleString('zh-CN'),
  };
  const materials = [item, ...(p.materials || [])];
  saveProject({ materials }, projectId);
  return item;
}

export function setCurrentChapter(chapter, projectId = getActiveProjectId()) {
  saveProject({ currentChapter: chapter || '' }, projectId);
}

export function removeMaterial(id, projectId = getActiveProjectId()) {
  const p = getProject(projectId);
  saveProject({ materials: (p.materials || []).filter(m => m.id !== id) }, projectId);
}

export function exportProjectStore({ includeApiKey = false } = {}) {
  return {
    app: 'paperpilot',
    version: 4,
    exportedAt: nowIso(),
    storage: 'indexeddb',
    appState: readApp(),
    projects: readProjects(),
    includeApiKey,
  };
}

export async function replaceProjectStore({ appState, projects }) {
  cacheApp = { ...blankApp(), ...(appState || {}) };
  cacheProjects = projects || {};
  normalizeCaches();
  await persistProjectStoreNow();
  emitProjects();
}

export async function clearProjectStore() {
  cacheApp = blankApp();
  cacheProjects = {};
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await clearProjectSnapshot();
  clearLegacyProjectKeys();
  emitProjects();
}

export function markBackupExported() {
  cacheApp = {
    ...cacheApp,
    storage: {
      ...(cacheApp.storage || {}),
      lastBackupAt: nowIso(),
    },
  };
  schedulePersist();
}

export function daysSinceLastBackup() {
  const last = readApp().storage?.lastBackupAt;
  if (!last) return Infinity;
  return Math.floor((Date.now() - new Date(last).getTime()) / DAY);
}

export function isoLocal(dayMs) {
  const t = new Date(dayMs);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

export function calcStreak(dates) {
  const set = new Set(dates);
  if (!set.size) return 0;
  let cur = Date.now();
  if (!set.has(isoLocal(cur))) cur -= DAY;
  let streak = 0;
  while (set.has(isoLocal(cur))) { streak++; cur -= DAY; }
  return streak;
}

function parseOutline(text) {
  const chapters = [];
  text.split('\n').map(l => l.trim()).forEach(line => {
    const clean = line.replace(/\*\*|__|`/g, '').replace(/^\s*(?:#{1,6}|[-•*])\s*/, '').trim();
    const cn = /^(第[一二三四五六七八九十百\d]+章[　\s]*.*)$/.exec(clean);
    const num = /^(\d+)[.、．]\s+(.+)$/.exec(clean);
    if (cn) chapters.push({ chapter: cn[1].trim(), sections: [] });
    else if (num) chapters.push({ chapter: `${num[1]}. ${num[2].trim()}`, sections: [] });
  });
  return chapters;
}

globalThis.__paperpilotScopedStore = {
  has(key) {
    return ['drafts', 'citations', 'checkins', 'versions'].includes(key);
  },
  read(key, fallback) {
    if (key === 'drafts') return getDrafts();
    if (key === 'citations') return getCitations();
    if (key === 'checkins') return getCheckins();
    if (key === 'versions') return getVersionsStore();
    return fallback;
  },
  write(key, value) {
    if (key === 'drafts') return saveDrafts(value);
    if (key === 'citations') return saveCitations(value);
    if (key === 'checkins') return saveCheckins(value);
    if (key === 'versions') return saveVersionsStore(value);
    return null;
  },
  remove(key) {
    if (key === 'drafts') return saveDrafts({});
    if (key === 'citations') return saveCitations([]);
    if (key === 'checkins') return saveCheckins([]);
    if (key === 'versions') return saveVersionsStore(blankVersions());
    return null;
  },
};
