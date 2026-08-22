// 项目仓库：V4 Phase 1 改为多项目模型。
// 统一管理 activeProjectId / projects，并把草稿、文献、打卡、版本等都挂到项目上。
import { get, set } from './storage.js';

const APP_KEY = 'app';
const PROJECTS_KEY = 'projects';
const DAY = 86400000;

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
    currentStage: '',
    stages: [],
    abstract: '',
    keywords: '',
    acknowledgments: '',
    drafts: {},
    citations: [],
    checkins: [],
    versions: blankVersions(),
    ...partial,
    id,
  };
}

function readApp() {
  return { ...blankApp(), ...get(APP_KEY, {}) };
}

function writeApp(app) {
  set(APP_KEY, { ...blankApp(), ...app });
}

function readProjects() {
  return get(PROJECTS_KEY, {});
}

function writeProjects(projects) {
  set(PROJECTS_KEY, projects);
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
    materials: project.materials || [],
    outline: project.outline || [],
    chapterProgress: project.chapterProgress || {},
    stages: project.stages || [],
    versions: {
      chapters: project.versions?.chapters || {},
      doc: Array.isArray(project.versions?.doc) ? project.versions.doc : [],
    },
  });
}

function migrateLegacyIfNeeded() {
  const app = readApp();
  const projects = readProjects();
  if (app.migration?.legacyV4Done || Object.keys(projects).length) return;

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

  if (!hasLegacy) {
    writeApp({
      ...app,
      schemaVersion: 4,
      migration: { ...app.migration, legacyV4Done: true },
    });
    return;
  }

  const id = makeId();
  const migrated = blankProject(id, {
    title: legacy?.title || '我的论文项目',
    degreeType: legacy?.degreeType || '',
    dueDate: legacy?.dueDate || '',
    researchDesign: legacy?.researchDesign || {},
    outline: legacy?.outline || [],
    chapterProgress: legacy?.chapterProgress || {},
    currentChapter: legacy?.currentChapter || '',
    materials: legacy?.materials || [],
    stages: legacy?.stages || [],
    currentStage: legacy?.currentStage || '',
    abstract: legacy?.abstract || '',
    keywords: legacy?.keywords || '',
    acknowledgments: legacy?.acknowledgments || '',
    drafts: legacyDrafts || {},
    citations: legacyCitations || [],
    checkins: legacyCheckins || [],
    versions: legacyVersions || blankVersions(),
  });

  writeProjects({ [id]: migrated });
  writeApp({
    ...app,
    schemaVersion: 4,
    activeProjectId: id,
    projectOrder: [id],
    migration: { ...app.migration, legacyV4Done: true },
  });
}

export function ensureProjectStore() {
  migrateLegacyIfNeeded();
  const app = readApp();
  const projects = readProjects();
  let changed = false;

  app.projectOrder.forEach(id => {
    if (projects[id]) {
      projects[id] = ensureProjectKeys(projects[id]);
      changed = true;
    }
  });

  Object.keys(projects).forEach(id => {
    if (!app.projectOrder.includes(id)) {
      app.projectOrder.push(id);
      changed = true;
    }
    projects[id] = ensureProjectKeys(projects[id]);
  });

  if (app.activeProjectId && !projects[app.activeProjectId]) {
    app.activeProjectId = app.projectOrder.find(id => projects[id]) || '';
    changed = true;
  }

  if (changed) {
    writeProjects(projects);
    writeApp(app);
  }
}

ensureProjectStore();

export function getAppState() {
  ensureProjectStore();
  return readApp();
}

export function listProjects() {
  ensureProjectStore();
  const app = readApp();
  const projects = readProjects();
  return app.projectOrder
    .map(id => projects[id])
    .filter(Boolean)
    .map(project => ensureProjectKeys(project));
}

export function getActiveProjectId() {
  ensureProjectStore();
  return readApp().activeProjectId || '';
}

export function setActiveProject(id) {
  ensureProjectStore();
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
  ensureProjectStore();
  const app = readApp();
  const projects = readProjects();
  const id = makeId();
  const project = blankProject(id, initial);
  projects[id] = project;
  app.projectOrder = [id, ...app.projectOrder.filter(x => x !== id)];
  app.activeProjectId = id;
  writeProjects(projects);
  writeApp(app);
  emitProjects();
  return project;
}

export function duplicateProject(id) {
  ensureProjectStore();
  const projects = readProjects();
  const source = projects[id];
  if (!source) return null;
  const copy = createProject({
    ...source,
    title: source.title ? `${source.title}（副本）` : '未命名论文（副本）',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  return copy;
}

export function deleteProject(id) {
  ensureProjectStore();
  const app = readApp();
  const projects = readProjects();
  if (!projects[id]) return false;
  delete projects[id];
  app.projectOrder = app.projectOrder.filter(x => x !== id);
  if (app.activeProjectId === id) {
    app.activeProjectId = app.projectOrder[0] || '';
  }
  writeProjects(projects);
  writeApp(app);
  emitProjects();
  return true;
}

export function reorderProjects(ids) {
  ensureProjectStore();
  const app = readApp();
  app.projectOrder = ids.filter(Boolean);
  writeApp(app);
  emitProjects();
}

export function getProject(projectId = getActiveProjectId()) {
  ensureProjectStore();
  const projects = readProjects();
  if (!projectId || !projects[projectId]) return blankProject('', {});
  return ensureProjectKeys(projects[projectId]);
}

export function saveProject(partial, projectId = getActiveProjectId()) {
  ensureProjectStore();
  if (!projectId) return null;
  const projects = readProjects();
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

/** 采用大纲：解析章节并初始化各章进度为「未开始」 */
export function adoptOutline(text, projectId = getActiveProjectId()) {
  const chapters = parseOutline(text);
  const progress = {};
  chapters.forEach(c => { progress[c.chapter] = '未开始'; });
  saveProject({ outline: chapters, chapterProgress: progress }, projectId);
  return chapters;
}

/** 更新某一章的写作状态 */
export function setChapterProgress(chapter, status, projectId = getActiveProjectId()) {
  const p = getProject(projectId);
  p.chapterProgress[chapter] = status;
  saveProject({ chapterProgress: p.chapterProgress }, projectId);
}

/** 新增写作素材（摘要/段落草稿等） */
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

/** 设置当前写作章节 */
export function setCurrentChapter(chapter, projectId = getActiveProjectId()) {
  saveProject({ currentChapter: chapter || '' }, projectId);
}

/** 删除写作素材 */
export function removeMaterial(id, projectId = getActiveProjectId()) {
  const p = getProject(projectId);
  saveProject({ materials: (p.materials || []).filter(m => m.id !== id) }, projectId);
}

/** 本地日期 ISO（YYYY-MM-DD） */
export function isoLocal(dayMs) {
  const t = new Date(dayMs);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** 连续打卡天数（今天未打卡则从昨天起算；全部用本地日期，UTC 天序号会跨时区错位） */
export function calcStreak(dates) {
  const set = new Set(dates);
  if (!set.size) return 0;
  let cur = Date.now();
  if (!set.has(isoLocal(cur))) cur -= DAY;
  let streak = 0;
  while (set.has(isoLocal(cur))) { streak++; cur -= DAY; }
  return streak;
}

/** 解析大纲文本为章节数组：支持「第X章 …」与「1. …」两种格式；容忍 AI 常见的 markdown 包裹 */
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
