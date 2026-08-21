// 草稿版本管理：按章节版本链 + 整文档里程碑，localStorage 持久化（设计文档 version-management-design.html）
// 容量：总量 1.2MB 硬上限 → 淘汰最旧 auto 档至 900KB 以下；永不触碰 drafts/project 等主数据
// 备份兼容：设置页按 paperpilot: 前缀全量遍历，versions 自动随导出/导入/清除走
import { get, set } from './storage.js';

const KEY = 'versions';
const CHAPTER_CAP = 10;          // 每章最多保留版本数
const DOC_CAP = 5;               // 整文档里程碑上限
const EVICT_AT = 1.2 * 1024 * 1024;   // 总量触发淘汰阈值
const EVICT_TO = 900 * 1024;          // 淘汰目标水位

function blank() { return { chapters: {}, doc: [] }; }

function store() {
  const s = get(KEY, blank());
  s.chapters = s.chapters || {};
  s.doc = Array.isArray(s.doc) ? s.doc : [];
  return s;
}

function persist(s) {
  set(KEY, s);
  evictIfNeeded();
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 版本总字节数（localStorage 按 UTF-16 码元计数，JSON 字符串长度即字节数） */
export function versionsSize() {
  return JSON.stringify(store()).length;
}

/** 全部版本数量（章节 + 里程碑），用于设置页统计 */
export function versionCount() {
  const s = store();
  return Object.values(s.chapters).reduce((n, l) => n + l.length, 0) + s.doc.length;
}

/** 章节版本链（最新在前）；无则空数组 */
export function getChapterVersions(name) {
  return store().chapters[name] || [];
}

/** 整文档里程碑（最新在前） */
export function getDocVersions() {
  return store().doc;
}

/** 按章节名 + 版本 id 取单条版本 */
export function getVersion(name, id) {
  return (getChapterVersions(name) || []).find(v => v.id === id) || null;
}

/** 章节快照：name 与 drafts/outline 同键；text 为该章正文（不含标题行） */
export function snapshotChapter(name, text, src = 'auto', label = '') {
  if (!name) return null;
  const s = store();
  const list = s.chapters[name] || [];
  // 与最新版本相同则跳过（防碎片）
  if (list[0] && list[0].text === text) return null;
  const v = { id: makeId(), at: Date.now(), src, label, text };
  s.chapters[name] = [v, ...list].slice(0, CHAPTER_CAP); // 超限截断即淘汰最旧（列表最新在前）
  // 截断只删 auto 时可能误删 manual：补一刀——超限且尾部为 manual 时删最旧 auto
  const arr = s.chapters[name];
  if (arr.length === CHAPTER_CAP && arr[arr.length - 1].src !== 'auto') {
    const i = [...arr].reverse().findIndex(v => v.src === 'auto');
    if (i >= 0) arr.splice(arr.length - 1 - i, 1);
  }
  persist(s);
  return v;
}

/** 整文档里程碑（标记章节完成 / Ctrl+S） */
export function snapshotDoc(text, label = '') {
  if (!text) return null;
  const s = store();
  if (s.doc[0] && s.doc[0].text === text) return null;
  const v = { id: makeId(), at: Date.now(), src: 'milestone', label, text };
  s.doc = [v, ...s.doc].slice(0, DOC_CAP);
  // 与章节同规则：截断时优先保 milestone 之外无优先级差异，doc 全为 milestone，直接删最旧即可
  persist(s);
  return v;
}

/** 总量淘汰：超过 1.2MB 时从最旧章节的最旧 auto 起删，直到低于 900KB */
function evictIfNeeded() {
  let s = store();
  if (JSON.stringify(s).length < EVICT_AT) return;
  const under = () => JSON.stringify(store()).length < EVICT_TO;
  let guard = 200;
  while (!under() && guard-- > 0) {
    // 收集所有章节中最旧的 auto 版本
    let oldest = null; // { chapter, idx }
    for (const [name, list] of Object.entries(s.chapters)) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].src === 'auto') {
          if (!oldest || list[i].at < oldest.at) oldest = { chapter: name, idx: i, at: list[i].at };
          break; // 每章从最旧开始只取第一个 auto
        }
      }
    }
    if (oldest) {
      s.chapters[oldest.chapter].splice(oldest.idx, 1);
      if (!s.chapters[oldest.chapter].length) delete s.chapters[oldest.chapter];
      persistNoEvict(s);
      continue;
    }
    // 无 auto 可删：doc 里删最旧（保最新）
    if (s.doc.length > 1) { s.doc.pop(); persistNoEvict(s); continue; }
    break; // 全是 manual 且已无可删 → 放弃，写满时由 storage.set 的 quota 提示兜底
  }
}

function persistNoEvict(s) { set(KEY, s); }

/** 其余章节名（版本存在但当前大纲没有的章节） */
export function orphanChapters(outlineNames) {
  const s = store();
  return Object.keys(s.chapters).filter(name => !outlineNames.includes(name));
}
