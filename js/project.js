// 论文项目：贯穿全局的主线状态（PRD §4.4 模块衔接设计）
// 单一数据源：paperpilot:project，各模块读写同一份项目数据
import { get, set } from './storage.js';

const KEY = 'project';
const DAY = 86400000;

function emit() {
  document.dispatchEvent(new Event('tm:project-changed'));
}

export function getProject() {
  return get(KEY, {
    title: '',
    degreeType: '',
    dueDate: '',
    outline: [],           // [{ chapter: '第一章 绪论', sections: [] }]
    stages: [],            // [{ id, name, weeks, start, end, tasks }] 由计划模块写入
    chapterProgress: {},   // { 章节名: '未开始' | '进行中' | '已完成' }
    materials: [],         // [{ id, type, title, content, createdAt }]
    currentChapter: '',    // 当前写作章节（写作工作台）
    abstract: '',          // 论文摘要（工作台全文文档）
    keywords: '',          // 关键词
    acknowledgments: '',   // 致谢
  });
}

export function saveProject(partial) {
  set(KEY, { ...getProject(), ...partial });
  emit();
}

/** 更新论文基本信息（仅覆盖传入字段） */
export function updateBasics({ title, degreeType, dueDate }) {
  const p = getProject();
  const next = {
    ...p,
    title: title ?? p.title,
    degreeType: degreeType ?? p.degreeType,
    dueDate: dueDate ?? p.dueDate,
  };
  set(KEY, next);
  emit();
  return next;
}

/** 采用大纲：解析章节并初始化各章进度为「未开始」 */
export function adoptOutline(text) {
  const chapters = parseOutline(text);
  const progress = {};
  chapters.forEach(c => { progress[c.chapter] = '未开始'; });
  saveProject({ outline: chapters, chapterProgress: progress });
  return chapters;
}

/** 更新某一章的写作状态 */
export function setChapterProgress(chapter, status) {
  const p = getProject();
  p.chapterProgress[chapter] = status;
  set(KEY, p);
  emit();
}

/** 新增写作素材（摘要/段落草稿等） */
export function addMaterial({ type, title, content }) {
  const p = getProject();
  const item = {
    id: String(Date.now()),
    type,
    title,
    content,
    createdAt: new Date().toLocaleString('zh-CN'),
  };
  p.materials.unshift(item);
  set(KEY, p);
  emit();
  return item;
}

/** 设置当前写作章节 */
export function setCurrentChapter(chapter) {
  const p = getProject();
  p.currentChapter = chapter || '';
  set(KEY, p);
  emit();
}

/** 删除写作素材 */
export function removeMaterial(id) {
  const p = getProject();
  p.materials = p.materials.filter(m => m.id !== id);
  set(KEY, p);
  emit();
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

/** 解析大纲文本为章节数组：支持「第X章 …」与「1. …」两种格式；容忍 AI 常见的 markdown 包裹（**加粗**、## 标题、- 列表）与编号变体（1、/1．） */
function parseOutline(text) {
  const chapters = [];
  text.split('\n').map(l => l.trim()).forEach(line => {
    // 清洗 markdown 修饰：去 **、__、反引号、行首 #/-/•/*（保留数字编号前缀，交给 num 分支识别）
    const clean = line.replace(/\*\*|__|`/g, '').replace(/^\s*(?:#{1,6}|[-•*])\s*/, '').trim();
    const cn = /^(第[一二三四五六七八九十百\d]+章[　\s]*.*)$/.exec(clean);
    const num = /^(\d+)[.、．]\s+(.+)$/.exec(clean);
    if (cn) chapters.push({ chapter: cn[1].trim(), sections: [] });
    else if (num) chapters.push({ chapter: `${num[1]}. ${num[2].trim()}`, sections: [] });
  });
  return chapters;
}
