import { EditorState, TextSelection, Plugin, PluginKey } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { Fragment, Slice } from 'prosemirror-model';
import { toast, integrityNote, escapeHtml, setLoading, copyText, cleanAiText } from '../ui.js';
import { chat, streamChat } from '../api.js';
import { searchLiterature } from '../litsearch.js';
import { get } from '../storage.js';
import { getProject, saveProject, setCurrentChapter, setChapterProgress, getCitations, saveCitations, getEvidence, saveEvidence, listProjects } from '../project.js';
import { snapshotChapter, snapshotDoc, getChapterVersions, getDocVersions } from '../versions.js';
import { createDocxBlob } from '../docx-export.js';
import { collectIssues as collectExportIssues, issueHtml as exportIssueHtml } from './check-export.js';
import {
  paperSchema,
  docFromJSON,
  extractProjectStateFromDoc,
  buildCitationNumberMap,
  buildRenderableBlocks,
  insertCitationNode,
  insertFootnoteNode,
  insertFormulaNode,
  insertFigureNode,
  insertTableNode,
  collectCitationUsage,
  fullTextFromDoc,
} from '../document-model.js';
import { ensureCitationIds, citationMap, normalizeCitationEntry } from '../citation-utils.js';
import { ICONS } from '../icons.js';
import { meaningfulTitle } from '../title-utils.js';
import { recordOutcome, recordLengthDelta, buildPreferencePrompt } from '../self-learning.js';

const SYSTEM = '你是一位资深论文写作导师，帮助中国高校学生完成论文写作。遵守学术诚信：不代替用户完成整篇论文，只提供局部改写、结构建议和章节草稿辅助。回答直接给出结果，不要客套话和多余解释。';
const systemPrompt = () => SYSTEM + buildPreferencePrompt();

const AI_ACTIONS = [
  { id: 'academic', label: '学术润色', prompt: t => `请把下面这段话改写成更规范、更克制的学术表达，只输出改写后的文字。\n\n${t}`, mode: 'selection' },
  { id: 'argument', label: '补充论证', prompt: t => `请在不改变原意的前提下，为下面这段内容补充论证和分析层次，只输出修改后的文字。\n\n${t}`, mode: 'selection' },
  { id: 'reframe', label: '重构表达', prompt: t => `请保留原意，重构下面这段文字的表达方式，使其更清晰、更有层次，只输出改写后的文字。\n\n${t}`, mode: 'selection' },
  { id: 'continue', label: '基于上下文续写', prompt: t => `请基于下面这段论文上下文续写 250-400 字，保持论题和风格一致，只输出续写内容。\n\n${t}`, mode: 'cursor' },
  { id: 'logic', label: '本章逻辑检查', prompt: t => `请从导师视角检查下面这段章节内容的逻辑结构，指出论证跳跃、只有描述没有分析、缺少证据支持的位置。请用简短分点输出。 \n\n${t}`, mode: 'review' },
];

const SIDE_PANELS = {
  assistant: { label: '写作助手', hint: '查看 AI 建议，确认后再写回正文。' },
  citation: { label: '引用', hint: '插入文献引用，编号会自动更新。' },
  evidence: { label: '证据', hint: '优先取用和当前章节直接相关的证据。' },
  todos: { label: '待修改', hint: '把这一章后续要改的点先挂住。' },
  versions: { label: '版本', hint: '在关键节点留档，需要时可以回退。' },
};

if (!window.__tmWritingAbort) {
  window.__tmWritingAbort = new AbortController();
  document.addEventListener('tm:navigate', () => {
    window.__tmWritingAbort.abort();
    window.__tmWritingAbort = new AbortController();
  });
}

const writingSignal = () => window.__tmWritingAbort.signal;

function wordCount(text) {
  return String(text || '').replace(/\s/g, '').length;
}

function makeSectionId() {
  return globalThis.crypto?.randomUUID?.() || `sec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sectionMetaFromProject(project) {
  return (project.outline || []).map((item, index) => ({
    chapter: item.chapter,
    sectionId: item.sectionId || `chapter-${index + 1}`,
    sections: Array.isArray(item.sections) ? item.sections : [],
  }));
}

function topLevelSections(doc) {
  const sections = [];
  const boundaries = []; // 顶层标题（非 subsection）作为章节体边界
  doc.forEach((node, offset, index) => {
    if (node.type.name !== 'heading') return;
    if (node.attrs.role === 'subsection') return; // 章内子标题，不作为边界
    boundaries.push({ offset, index, role: node.attrs.role });
    if (node.attrs.role === 'section') {
      sections.push({
        chapter: node.textContent.trim(),
        sectionId: node.attrs.sectionId,
        startIndex: index,
        headingFrom: offset + 1,
        bodyFrom: offset + node.nodeSize,
      });
    }
  });
  sections.forEach(item => {
    const next = boundaries.find(h => h.offset > item.headingFrom - 1);
    item.endIndex = next ? next.index - 1 : doc.childCount - 1;
    item.bodyTo = next ? next.offset : doc.content.size;
  });
  return sections;
}

function sectionForPos(doc, pos) {
  // 半开区间 [headingFrom, bodyTo)：标题行归属其所在章节，光标落在标题边界不漂移到下一节
  return topLevelSections(doc).find(sec => pos >= sec.headingFrom && pos < sec.bodyTo) || null;
}

function specialSectionRange(doc, role, label) {
  let found = null;
  const headings = [];
  doc.forEach((node, offset, index) => {
    if (node.type.name === 'heading') {
      headings.push({
        role: node.attrs.role,
        title: node.textContent.trim(),
        index,
        headingFrom: offset + 1,
        bodyFrom: offset + node.nodeSize,
      });
    }
  });
  headings.forEach((item, idx) => {
    if (item.role !== role) return;
    const next = headings.slice(idx + 1).find(head => head.role !== 'subsection');
    found = {
      kind: role,
      title: item.title || label,
      label,
      headingFrom: item.headingFrom,
      bodyFrom: item.bodyFrom,
      bodyTo: next ? next.headingFrom - 1 : doc.content.size,
    };
  });
  return found;
}

function currentWritingTarget(view) {
  const { doc, selection } = view.state;
  const section = sectionForPos(doc, selection.from);
  if (section) return { ...section, kind: 'chapter', title: section.chapter, label: section.chapter };
  const abstract = specialSectionRange(doc, 'abstract', '摘要');
  if (abstract && selection.from >= abstract.headingFrom && selection.from <= abstract.bodyTo) return abstract;
  const keywords = specialSectionRange(doc, 'keywords', '关键词');
  if (keywords && selection.from >= keywords.headingFrom && selection.from <= keywords.bodyTo) return keywords;
  return null;
}

function subsectionsForSection(doc, section) {
  const items = [];
  if (!section) return items;
  const found = [];
  doc.nodesBetween(section.bodyFrom, section.bodyTo, (node, pos) => {
    if (node.type.name === 'heading' && node.attrs.role === 'subsection') {
      found.push({ title: node.textContent.trim(), pos: pos + 1, headingFrom: pos, bodyFrom: pos + node.nodeSize });
    }
  });
  // 计算每个小节的正文区间 [bodyFrom, bodyTo)：本节标题后 → 下一个小节标题前（或章节体末尾）
  found.forEach((item, idx) => {
    const next = found[idx + 1];
    item.bodyTo = next ? next.headingFrom - 1 : section.bodyTo;
  });
  return found;
}

function inlineContentFromText(text) {
  const pieces = [];
  const regex = /\[\[CIT:([^\]]+)\]\]/g;
  let last = 0;
  let match;
  while ((match = regex.exec(text))) {
    const before = text.slice(last, match.index);
    if (before) pieces.push(paperSchema.text(before));
    pieces.push(paperSchema.nodes.citation.create({ citationId: match[1] }));
    last = match.index + match[0].length;
  }
  const tail = text.slice(last);
  if (tail) pieces.push(paperSchema.text(tail));
  return pieces;
}

function stripLightMarkdown(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .trim();
}

function normalizeHeadingText(text) {
  return String(text || '')
    .replace(/^#+\s*/, '')
    .replace(/^第?[一二三四五六七八九十百千万\d]+[章节、.\s]+/, '')
    .replace(/^\d+(?:\.\d+)*\s*/, '')
    .replace(/[：:。,.，\s]/g, '')
    .toLowerCase();
}

function aiTextFragment(text, options = {}) {
  const target = options.target || null;
  const knownHeadings = new Set([
    normalizeHeadingText(target?.label),
    normalizeHeadingText(target?.chapter),
    ...(options.subsections || []).map(normalizeHeadingText),
  ].filter(Boolean));
  const blocks = [];
  let paragraph = [];
  const pushParagraph = () => {
    const body = stripLightMarkdown(paragraph.join(' ').replace(/\s+/g, ' '));
    paragraph = [];
    if (!body) return;
    blocks.push(paperSchema.nodes.paragraph.create(null, inlineContentFromText(body)));
  };
  String(text || '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '')
    .split(/\n/)
    .forEach(rawLine => {
      const line = rawLine.trim();
      if (!line) {
        pushParagraph();
        return;
      }
      const plainHeading = stripLightMarkdown(line);
      if (knownHeadings.has(normalizeHeadingText(plainHeading)) && plainHeading.length <= 60) {
        pushParagraph();
        return;
      }
      if (/^(第[一二三四五六七八九十百千万\d]+章|\d+(?:\.\d+)*\s+)/.test(plainHeading) && knownHeadings.has(normalizeHeadingText(plainHeading))) {
        pushParagraph();
        return;
      }
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        pushParagraph();
        const title = stripLightMarkdown(headingMatch[2]);
        if (knownHeadings.has(normalizeHeadingText(title))) return;
        blocks.push(paperSchema.nodes.heading.create(
          { level: 3, role: 'subsection', sectionId: makeSectionId() },
          paperSchema.text(title)
        ));
        return;
      }
      paragraph.push(line);
    });
  pushParagraph();
  return Fragment.fromArray(blocks.length ? blocks : [paperSchema.nodes.paragraph.create()]);
}

function replaceAiTextRange(view, from, to, text, options = {}) {
  const cleaned = normalizeDraftCitationMarkers(cleanAiText(text), options.refs || []);
  const $from = view.state.doc.resolve(from);
  const $to = view.state.doc.resolve(to);
  if ($from.sameParent($to) && $from.parent.isTextblock) {
    const inlineText = stripLightMarkdown(cleaned)
      .replace(/^#+\s*/gm, '')
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
    try {
      view.dispatch(
        view.state.tr.replaceWith(from, to, Fragment.fromArray(inlineContentFromText(inlineText))).scrollIntoView()
      );
      return;
    } catch (error) {
      view.dispatch(view.state.tr.insertText(inlineText, from, to).scrollIntoView());
      return;
    }
  }
  try {
    view.dispatch(
      view.state.tr.replaceWith(from, to, aiTextFragment(cleaned, options)).scrollIntoView()
    );
  } catch (error) {
    const fallback = stripLightMarkdown(cleaned)
      .replace(/^#+\s*/gm, '')
      .replace(/\n{2,}/g, '\n')
      .trim();
    view.dispatch(view.state.tr.insertText(fallback, from, to).scrollIntoView());
  }
}

function citationKey(item = {}) {
  return String(item.doi || item.title || '').trim().toLowerCase();
}

function nextLitNo(list) {
  return list.reduce((max, item) => Math.max(max, Number(item.litNo) || 0), 0) + 1;
}

function citationBrief(item, index) {
  return `${index + 1}. 引用标记：[[CIT:${item.id}]]
题名：${item.title || '未命名文献'}
作者：${item.authors || item.author || '未知'}
年份：${item.year || '未知'}
出处：${item.source || item.publisher || '未知'}
摘要：${item.abstract || '无摘要'}`;
}

function normalizeDraftCitationMarkers(text, refs) {
  let out = String(text || '');
  if (!refs.length) return out;
  refs.forEach((item, index) => {
    const n = index + 1;
    const marker = `[[CIT:${item.id}]]`;
    // 兼容模型可能写出的各种编号形式： [R1]、[文献1]、[1]、[[CIT:1]]（可带空格）
    out = out
      .replace(new RegExp(`\\[\\s*R\\s*${n}\\s*\\]`, 'g'), marker)
      .replace(new RegExp(`\\[\\s*文献\\s*${n}\\s*\\]`, 'g'), marker)
      .replace(new RegExp(`\\[\\s*${n}\\s*\\]`, 'g'), marker)
      .replace(new RegExp(`\\[\\[CIT:\\s*${n}\\s*\\]\\]`, 'g'), marker);
  });
  return out;
}

function replaceDraftStream(view, range, text, refs = []) {
  const normalized = normalizeDraftCitationMarkers(text, refs);
  const fragment = aiTextFragment(normalized || '正在生成草稿…', {
    target: range.target,
    subsections: range.subsections || [],
  });
  const tr = view.state.tr.replaceWith(range.from, range.to, fragment);
  view.dispatch(tr);
  range.to = range.from + fragment.size;
}

function ensureOutlineSubsections(doc, project) {
  const outline = Array.isArray(project?.outline) ? project.outline : [];
  if (!outline.some(item => Array.isArray(item.sections) && item.sections.length)) return doc;
  const sections = topLevelSections(doc);
  const existingBySection = new Map(sections.map(sec => [
    sec.sectionId || sec.chapter,
    new Set(subsectionsForSection(doc, sec).map(item => item.title)),
  ]));
  const outlineBySection = new Map(outline.map((item, index) => [
    item.sectionId || item.chapter || `chapter-${index + 1}`,
    item,
  ]));
  const blocks = [];
  let changed = false;
  doc.forEach(node => {
    blocks.push(node);
    if (node.type.name !== 'heading' || node.attrs.role !== 'section') return;
    const key = node.attrs.sectionId || node.textContent.trim();
    const outlineItem = outlineBySection.get(key) || outline.find(item => item.chapter === node.textContent.trim());
    const existing = existingBySection.get(key) || new Set();
    const missing = (outlineItem?.sections || [])
      .map(item => String(item || '').trim())
      .filter(item => item && !existing.has(item));
    missing.forEach((title, index) => {
      blocks.push(paperSchema.nodes.heading.create(
        { level: 3, role: 'subsection', sectionId: `${node.attrs.sectionId || makeSectionId()}-sub-${index + 1}` },
        paperSchema.text(title)
      ));
      blocks.push(paperSchema.nodes.paragraph.create());
      changed = true;
    });
  });
  return changed ? doc.type.create(doc.attrs, Fragment.fromArray(blocks)) : doc;
}

function serializeProjectDoc(doc, currentChapter, project) {
  const extracted = extractProjectStateFromDoc(doc);
  const oldProgress = project.chapterProgress || {};
  const oldOutline = sectionMetaFromProject(project);
  const sections = topLevelSections(doc);
  const progress = {};
  extracted.outline.forEach((item, index) => {
    const old = oldOutline.find(x => x.sectionId === item.sectionId) || oldOutline.find(x => x.chapter === item.chapter);
    const existingStatus = old ? (oldProgress[old.chapter] || '未开始') : '未开始';
    const section = sections.find(sec => sec.sectionId === item.sectionId) || sections.find(sec => sec.chapter === item.chapter);
    const sectionText = section ? doc.textBetween(section.bodyFrom, section.bodyTo, '\n').trim() : '';
    progress[item.chapter] = existingStatus === '未开始' && wordCount(sectionText) > 0 ? '进行中' : existingStatus;
    extracted.outline[index] = {
      ...item,
      sections: item.sections?.length ? item.sections : (old?.sections || []),
    };
  });
  return {
    documentV2: doc.toJSON(),
    title: extracted.title || project.title,
    abstract: extracted.abstract,
    keywords: extracted.keywords,
    acknowledgments: extracted.acknowledgments,
    outline: extracted.outline,
    drafts: extracted.drafts,
    chapterProgress: progress,
    currentChapter: currentChapter || project.currentChapter || extracted.outline[0]?.chapter || '',
    citations: getCitations(),
  };
}

function selectionText(view) {
  const { state } = view;
  if (state.selection.empty) return '';
  return state.doc.textBetween(state.selection.from, state.selection.to, '\n').trim();
}

function currentSectionText(view) {
  const sec = sectionForPos(view.state.doc, view.state.selection.from);
  if (!sec) return '';
  return view.state.doc.textBetween(sec.bodyFrom, sec.bodyTo, '\n').trim();
}

// 选中范围是否命中题名/章节标题（标题会被回写项目结构，禁止 AI 改写）
function selectionHitsHeading(view) {
  const { state } = view;
  const from = state.selection.from;
  const to = state.selection.to;
  if (!(to > from)) return false;
  let hit = false;
  state.doc.nodesBetween(from, to, n => {
    if (n.type.name === 'heading' && (n.attrs.role === 'title' || n.attrs.role === 'section')) hit = true;
  });
  return hit;
}

function buildPreviewHtml(doc, citations) {
  const blocks = buildRenderableBlocks(doc, citationMap(citations));
  // GB/T 7714-2015 顺序编码制：正文引用编号上标
  const supNums = new Set([...buildCitationNumberMap(doc).values()]);
  const supify = text => String(text || '').replace(/\[(\d+)\]/g, (m, n) => supNums.has(Number(n)) ? `<sup>${m}</sup>` : m);
  const outlineTitles = (getProject().outline || []).map(item => item.chapter).filter(Boolean);
  const pages = [];
  let currentPage = [];
  let currentPageClass = 'front-page';
  let chapterNo = 0;
  let sectionIndex = 0;
  let figureNo = 0;
  let tableNo = 0;
  let formulaNo = 0;
  const chapterIndexFrom = text => {
    const match = String(text || '').match(/第\s*(\d+)\s*章/);
    return match ? Number(match[1]) : 0;
  };
  const pushPage = () => {
    const html = currentPage.join('').trim();
    if (html) pages.push({ className: currentPageClass, html });
    currentPage = [];
    currentPageClass = 'front-page';
  };
  const renderBlock = block => {
    if (block.type === 'title') return `<h1 class="title">${escapeHtml(block.text)}</h1>`;
    if (block.type === 'heading') {
      let headingText = block.text;
      if (block.role === 'section') {
        pushPage();
        currentPageClass = 'chapter-page';
        headingText = headingText || outlineTitles[sectionIndex] || `第${sectionIndex + 1}章`;
        sectionIndex += 1;
        chapterNo = chapterIndexFrom(headingText) || chapterNo + 1;
        figureNo = 0;
        tableNo = 0;
        formulaNo = 0;
      }
      if (['references', 'ack'].includes(block.role)) {
        pushPage();
        currentPageClass = 'chapter-page';
      }
      const tag = block.role === 'section' ? 'h1' : ['abstract', 'references', 'ack'].includes(block.role) ? 'h2' : 'h3';
      const cls = block.role === 'section' || ['abstract', 'references', 'ack'].includes(block.role)
        ? 'chapter-title'
        : block.level >= 4
          ? 'subsec-3'
          : 'subsec';
      return `<${tag} class="${cls}">${escapeHtml(headingText)}</${tag}>`;
    }
    if (block.type === 'paragraph') return `<p>${supify(escapeHtml(block.text))}</p>`;
    if (block.type === 'blockquote') return `<blockquote>${supify(escapeHtml(block.text))}</blockquote>`;
    if (block.type === 'reference') return `<p class="ref">${escapeHtml(block.text)}</p>`;
    if (block.type === 'notes_heading') return `<h2 class="chapter-title">${escapeHtml(block.text)}</h2>`;
    if (block.type === 'note') return `<p class="ref pp-note-row">[注${block.number}] ${escapeHtml(block.text)}</p>`;
    if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag}>${block.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
    }
    if (block.type === 'formula') {
      formulaNo += 1;
      const formulaLabel = chapterNo ? `${chapterNo}.${formulaNo}` : block.number;
      return `<figure class="pp-formula">
        <table class="pp-formula-table"><tr>
          <td class="pp-formula-body">${escapeHtml(block.latex || '')}</td>
          <td class="pp-formula-no">（${formulaLabel}）</td>
        </tr></table>
        ${block.label ? `<figcaption>${escapeHtml(block.label)}</figcaption>` : ''}
        ${block.note ? `<p class="pp-note">说明：${escapeHtml(block.note)}</p>` : ''}
      </figure>`;
    }
    if (block.type === 'figure') {
      figureNo += 1;
      const figureLabel = chapterNo ? `${chapterNo}.${figureNo}` : block.number;
      const caption = block.caption || block.alt || '未命名图片';
      return `<figure class="pp-figure">
        <img src="${block.src}" alt="${escapeHtml(block.alt || caption)}">
        <figcaption>图 ${figureLabel}　${escapeHtml(caption)}</figcaption>
        ${block.note ? `<p class="pp-note">说明：${escapeHtml(block.note)}</p>` : ''}
      </figure>`;
    }
    if (block.type === 'table') {
      tableNo += 1;
      const tableLabel = chapterNo ? `${chapterNo}.${tableNo}` : block.number;
      const head = block.rows[0] || [];
      const body = block.rows.slice(1);
      return `<figure class="pp-table-wrap">
        <figcaption>表 ${tableLabel}　${escapeHtml(block.caption || '未命名表格')}</figcaption>
        <table class="pp-table">
          ${head.length ? `<thead><tr>${head.map(cell => `<th>${escapeHtml(cell || '—')}</th>`).join('')}</tr></thead>` : ''}
          <tbody>${body.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell || '')}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
        ${block.note ? `<p class="pp-note">说明：${escapeHtml(block.note)}</p>` : ''}
      </figure>`;
    }
    return '';
  };
  blocks.forEach(block => {
    currentPage.push(renderBlock(block));
  });
  pushPage();
  return pages.map(page => `<section class="template-page ${page.className}">${page.html}</section>`).join('');
}

function thesisTemplateCss() {
  return `
    @page { size: A4; margin: 30mm; }
    html { background: #EEECE5; }
    body {
      margin: 0;
      padding: 28px 0 64px;
      background: #EEECE5;
      color: #000;
    }
    .template-page {
      width: 210mm;
      min-height: 297mm;
      box-sizing: border-box;
      margin: 28px auto;
      padding: 30mm;
      background: #fff;
      color: #000;
      font-family: SimSun, "Songti SC", STSong, serif;
      font-size: 12pt;
      line-height: 20pt;
      box-shadow: 0 16px 45px rgba(38,48,59,.16);
      page-break-after: always;
      break-after: page;
    }
    .template-page:last-child { page-break-after: auto; break-after: auto; }
    .title {
      text-align: center;
      font-family: SimHei, "Heiti SC", sans-serif;
      font-size: 22pt;
      font-weight: 700;
      line-height: 1.25;
      margin: 0 0 24pt;
    }
    .chapter-title {
      font-family: SimHei, "Heiti SC", sans-serif;
      font-size: 16pt;
      font-weight: 700;
      text-align: center;
      line-height: 1;
      margin: 24pt 0 18pt;
      page-break-after: avoid;
      break-after: avoid;
    }
    .chapter-page > .chapter-title:first-child { margin-top: 0; }
    .subsec {
      font-family: SimHei, "Heiti SC", sans-serif;
      font-size: 14pt;
      font-weight: 700;
      line-height: 20pt;
      margin: 18pt 0 6pt;
      color: #000;
      page-break-after: avoid;
      break-after: avoid;
    }
    .subsec-3 {
      font-family: SimHei, "Heiti SC", sans-serif;
      font-size: 13pt;
      font-weight: 700;
      line-height: 20pt;
      margin: 12pt 0 6pt;
      page-break-after: avoid;
      break-after: avoid;
    }
    p { text-indent: 2em; margin: 0; text-align: justify; text-justify: inter-ideograph; }
    p.ref { text-indent: -2em; padding-left: 1cm; font-size: 10.5pt; line-height: 16pt; margin-top: 3pt; color: #000; }
    .pp-note-row { text-indent: 0; padding-left: 0; }
    blockquote { margin: 8pt 0; padding: 0 0 0 2em; border-left: 0; color: #111; font-family: KaiTi, "Kaiti SC", serif; }
    ul, ol { margin: 6pt 0 8pt 2em; padding: 0; }
    li { margin: 0; }
    .pp-formula { margin: 6pt 0; break-inside: avoid; page-break-inside: avoid; }
    .pp-formula-table { width: 100%; border-collapse: collapse; border: 0; }
    .pp-formula-table td { border: 0; padding: 0; vertical-align: middle; }
    .pp-formula-body { padding: 0 10pt; font-family: Cambria Math, "Times New Roman", SimSun, serif; font-size: 12pt; line-height: 1; text-align: center; white-space: pre-wrap; }
    .pp-formula-no { width: 48pt; text-align: right; font-family: "Times New Roman", SimSun, serif; font-size: 12pt; line-height: 1; }
    .pp-formula figcaption { margin-top: 6pt; text-align: center; font-size: 11pt; line-height: 1; color: #000; }
    .pp-figure, .pp-table-wrap { margin: 12pt 0; break-inside: avoid; page-break-inside: avoid; }
    .pp-figure img { max-width: 100%; display: block; margin: 0 auto; }
    .pp-figure figcaption { margin-top: 6pt; margin-bottom: 12pt; text-align: center; font-size: 11pt; line-height: 1; color: #000; }
    .pp-table-wrap figcaption { margin: 12pt 0 6pt; text-align: center; font-size: 11pt; line-height: 1; color: #000; }
    .pp-note { margin: 6pt 0 12pt; text-indent: 0; font-size: 10.5pt; line-height: 1; color: #000; }
    .pp-table { width: 100%; border-collapse: collapse; font-size: 11pt; line-height: 1; background: #fff; border-top: 1.5pt solid #000; border-bottom: 1.5pt solid #000; }
    .pp-table th, .pp-table td { border: 0; padding: 5pt 6pt; text-align: center; vertical-align: middle; }
    .pp-table thead th { border-bottom: 1pt solid #000; }
    .pp-table th { font-family: SimHei, "Heiti SC", sans-serif; font-weight: 700; }
    .tip { position: fixed; top: 14px; right: 16px; background: #2F4F66; color: #fff; padding: 8px 14px; border-radius: 5px; font-size: 13px; line-height: 1.4; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.16); }
    @media print {
      html, body { background:#fff; }
      body { padding: 0; }
      .tip { display:none; }
      .template-page { width:auto; min-height:auto; margin: 0; padding: 0; box-shadow:none; }
    }
  `;
}

function buildTemplateDocumentHtml(doc, citations, { showTip = true } = {}) {
  const html = buildPreviewHtml(doc, citations);
  const title = escapeHtml(meaningfulTitle(getProject().title) || '论文');
  const tip = showTip ? '<div class="tip">默认学位论文模板 · Ctrl/Cmd+P 打印或另存 PDF</div>' : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${title} - 模板格式预览</title>
  <style>${thesisTemplateCss()}</style></head><body>${tip}${html}</body></html>`;
}

function safeFileName(name) {
  return (meaningfulTitle(name) || '论文全文').replace(/[\\/:*?"<>|]/g, '_');
}

function downloadBlob(content, fileName, type) {
  const a = document.createElement('a');
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

function openPrintPreview(doc, citations, { autoPrint = false } = {}) {
  const html = buildTemplateDocumentHtml(doc, citations);
  const win = window.open('', '_blank');
  if (!win) {
    toast('浏览器拦截了新窗口，请允许弹窗后重试', 'err');
    return;
  }
  win.document.write(html);
  win.document.close();
  if (autoPrint) {
    win.addEventListener('load', () => win.print(), { once: true });
    setTimeout(() => win.print(), 500);
  }
}

function exportTemplateWord(doc, citations) {
  downloadBlob(createDocxBlob(getProject(), doc, citations), `${safeFileName(getProject().title)}.docx`);
}

function citationViewFactory(getLabel) {
  return (node) => {
    const dom = document.createElement('span');
    const sync = () => {
      dom.className = 'pm-citation';
      dom.setAttribute('data-citation-id', node.attrs.citationId);
      dom.textContent = `[${getLabel(node.attrs.citationId)}]`;
    };
    // 首次渲染时 view 可能尚未赋值（getLabel 读到 null state），先兜底，后续 update 纠正确编号
    try { sync(); } catch { dom.className = 'pm-citation'; dom.setAttribute('data-citation-id', node.attrs.citationId); dom.textContent = '[?]'; }
    return {
      dom,
      update(nextNode) {
        node = nextNode;
        sync();
        return true;
      },
    };
  };
}

function footnoteViewFactory(getLabel, openEditor) {
  return (node, view, getPos) => {
    const dom = document.createElement('button');
    const sync = () => {
      dom.className = 'pm-footnote-chip';
      dom.type = 'button';
      dom.textContent = `[注${getLabel(node.attrs.noteText)}]`;
      dom.title = node.attrs.noteText || '未填写注释';
    };
    dom.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      openEditor({ noteText: node.attrs.noteText, pos: getPos() });
    });
    sync();
    return {
      dom,
      update(nextNode) {
        node = nextNode;
        sync();
        return true;
      },
    };
  };
}

function formulaViewFactory(openEditor) {
  return (node, view, getPos) => {
    const dom = document.createElement('figure');
    const body = document.createElement('div');
    const caption = document.createElement('figcaption');
    const toolbar = document.createElement('div');
    const editBtn = document.createElement('button');
    const sync = () => {
      dom.className = 'pm-formula-card';
      body.className = 'pm-formula-body';
      caption.className = 'pm-formula-caption';
      body.textContent = node.attrs.latex || '';
      caption.textContent = node.attrs.label || '未命名公式';
      caption.title = node.attrs.note || '';
      editBtn.textContent = '编辑公式';
      editBtn.type = 'button';
      editBtn.className = 'pm-asset-edit';
      toolbar.className = 'pm-asset-toolbar';
    };
    editBtn.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      openEditor({ latex: node.attrs.latex, label: node.attrs.label, note: node.attrs.note, pos: getPos() });
    });
    toolbar.appendChild(editBtn);
    dom.append(toolbar, body, caption);
    sync();
    return {
      dom,
      update(nextNode) {
        node = nextNode;
        sync();
        return true;
      },
    };
  };
}

function figureViewFactory(openEditor) {
  return (node, view, getPos) => {
    const dom = document.createElement('figure');
    const img = document.createElement('img');
    const caption = document.createElement('figcaption');
    const toolbar = document.createElement('div');
    const editBtn = document.createElement('button');
    const deleteBtn = document.createElement('button');
    const sync = () => {
      dom.className = 'pm-figure-card';
      img.src = node.attrs.src || '';
      img.alt = node.attrs.alt || node.attrs.caption || '图片';
      caption.textContent = node.attrs.caption || node.attrs.alt || '未命名图片';
      caption.title = node.attrs.note || '';
      editBtn.textContent = '编辑图片';
      editBtn.type = 'button';
      editBtn.className = 'pm-asset-edit';
      deleteBtn.textContent = '删除图片';
      deleteBtn.type = 'button';
      deleteBtn.className = 'pm-asset-delete';
      toolbar.className = 'pm-asset-toolbar';
    };
    editBtn.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      openEditor({ ...node.attrs, pos: getPos() });
    });
    deleteBtn.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      openEditor({ ...node.attrs, pos: getPos(), requestDelete: true });
    });
    toolbar.append(editBtn, deleteBtn);
    dom.append(toolbar, img, caption);
    sync();
    return {
      dom,
      update(nextNode) {
        node = nextNode;
        sync();
        return true;
      },
    };
  };
}

function tableViewFactory(openEditor) {
  return (node, view, getPos) => {
    const dom = document.createElement('div');
    const toolbar = document.createElement('div');
    const editBtn = document.createElement('button');
    const table = document.createElement('table');
    const caption = document.createElement('div');
    const sync = () => {
      dom.className = 'pm-table-card';
      toolbar.className = 'pm-asset-toolbar';
      editBtn.textContent = '编辑表格';
      editBtn.type = 'button';
      editBtn.className = 'pm-asset-edit';
      caption.className = 'pm-table-caption';
      caption.textContent = node.attrs.caption || '未命名表格';
      caption.title = node.attrs.note || '';
      const rows = JSON.parse(node.attrs.rows || '[]');
      table.innerHTML = rows.map((row, rowIndex) => `<tr>${row.map(cell => rowIndex === 0 ? `<th>${escapeHtml(cell || '')}</th>` : `<td>${escapeHtml(cell || '')}</td>`).join('')}</tr>`).join('');
    };
    editBtn.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      openEditor({ caption: node.attrs.caption, note: node.attrs.note, rows: JSON.parse(node.attrs.rows || '[]'), pos: getPos() });
    });
    toolbar.appendChild(editBtn);
    dom.append(toolbar, table, caption);
    sync();
    return {
      dom,
      update(nextNode) {
        node = nextNode;
        sync();
        return true;
      },
    };
  };
}

// 重写类 AI 动作（润色/补论/重构）才做前后 diff；续写/逻辑检查是新增或批注，不做 rewrite diff
const DIFF_ACTIONS = new Set(['academic', 'argument', 'reframe']);

function diffTokens(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const parts = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { parts.push({ k: 'eq', v: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { parts.push({ k: 'del', v: a[i] }); i++; }
    else { parts.push({ k: 'ins', v: b[j] }); j++; }
  }
  while (i < n) { parts.push({ k: 'del', v: a[i] }); i++; }
  while (j < m) { parts.push({ k: 'ins', v: b[j] }); j++; }
  return parts;
}

// 混合中英文/数字的轻量 tokenize：西文词与数字归组、每个汉字单 token、空白与标点各一 token
function diffTokensFrom(s) {
  return String(s || '').match(/[A-Za-z0-9]+|[\u4e00-\u9fff]|\s|[^\s\u4e00-\u9fffA-Za-z0-9]/g) || [];
}

function inlineDiffHtml(original, suggestion) {
  const parts = diffTokens(diffTokensFrom(original), diffTokensFrom(suggestion));
  const runs = [];
  parts.forEach(p => {
    const last = runs[runs.length - 1];
    if (last && last.k === p.k) last.v += p.v;
    else runs.push({ k: p.k, v: p.v });
  });
  return runs.map(r => {
    const t = escapeHtml(r.v);
    if (r.k === 'del') return `<del class="pm-diff-del">${t}</del>`;
    if (r.k === 'ins') return `<ins class="pm-diff-ins">${t}</ins>`;
    return t;
  }).join('');
}

function renderSuggestionBox(box, state) {
  box.innerHTML = `
    <h3><span class="mark"></span>AI 辅助</h3>
    <p class="desc">选中文字后使用上方工具。建议会直接显示在编辑器正文旁边，确认后才写回论文。</p>
    ${state.pending && state.pending.actionId !== 'logic' ? '<p class="desc">当前有一条待处理建议，已放在正文中的选区附近。</p>' : ''}
    ${state.pending?.actionId === 'logic' ? '<p class="desc">逻辑检查报告已在弹窗中打开，可转成待修改清单。</p>' : ''}
    ${integrityNote()}`;
}

function inlineSuggestionHtml(item) {
  const isDiffPreview = (DIFF_ACTIONS.has(item.actionId) || item.actionId === 'continue') && (item.original || '').trim() && (item.suggestion || '').trim();
  const previewHtml = item.actionId === 'continue'
    ? inlineDiffHtml(item.original, `${item.original}${item.suggestion}`)
    : inlineDiffHtml(item.original, item.suggestion);
  const label = isDiffPreview
    ? '修改预览'
    : item.actionId === 'logic'
      ? '检查结果'
      : '生成内容';
  return `
    <div class="wb-inline-review-head">
      <div>
        <h3><span class="mark"></span>${escapeHtml(item.label)}</h3>
        <p class="desc">这条建议暂未写回正文。绿色为新增，红色删除线为移除。</p>
      </div>
      <span class="chip">待确认</span>
    </div>
    <label class="field-label">${label}</label>
    <div class="result-box filled">${isDiffPreview ? previewHtml : escapeHtml(item.suggestion)}</div>
    <div class="result-actions">
      <button class="btn" type="button" data-review-action="accept">接受</button>
      <button class="btn btn-ghost" type="button" data-review-action="reject">拒绝</button>
      <button class="btn btn-ai" type="button" data-review-action="regenerate">重新生成</button>
      ${item.actionId === 'logic' ? '<button class="btn btn-ghost" type="button" data-review-action="todo">转成待修改清单</button>' : ''}
    </div>`;
}

function relatedEvidenceHtml(section, citations) {
  const evidence = getEvidence();
  const byCitationId = new Map(citations.map(item => [item.id, item]));
  const relevant = evidence.filter(item =>
    !section?.sectionId || !item.linkedSectionIds?.length || item.linkedSectionIds.includes(section.sectionId));
  if (!relevant.length) return '<p class="desc">当前章节还没有关联证据卡，可去「文献与证据」补充。</p>';
  return relevant.slice(0, 6).map(item => `
    <div class="item">
      <div class="item-main">
        <div class="item-title"><span class="chip">${escapeHtml(item.type || 'finding')}</span> ${escapeHtml(byCitationId.get(item.citationId)?.title || '未关联文献')}</div>
        <div class="item-meta">${escapeHtml(item.content || '')}</div>
        <div class="item-meta">${escapeHtml(item.note || '')}</div>
      </div>
    </div>`).join('');
}

function relatedEvidenceItems(section) {
  return getEvidence().filter(item =>
    !section?.sectionId || !item.linkedSectionIds?.length || item.linkedSectionIds.includes(section.sectionId));
}

function normalizeCitations() {
  const current = getCitations();
  const { list, changed } = ensureCitationIds(current);
  if (changed) saveCitations(list);
  return list;
}

function citationRestorePools(currentList) {
  const legacy = get('citations', []);
  // 只从当前项目 + 旧本地库恢复，避免从其它项目污染当前文献库
  return [...currentList, ...(Array.isArray(legacy) ? legacy : [])].filter(Boolean);
}

function isPlaceholderCitation(item = {}) {
  return /^正文引用文献 \d+$/.test(String(item.title || '')) || item.source === '待补全来源';
}

function findCitationSource(pools, { id, doi, litNo }) {
  return pools.find(item =>
    !isPlaceholderCitation(item) &&
    ((id && item.id === id) || (doi && item.doi === doi) || (litNo && Number(item.litNo) === Number(litNo))));
}

function restoreCitationEntry(source, fallback) {
  return normalizeCitationEntry({
    ...fallback,
    ...(source || {}),
    id: fallback.id || source?.id,
    litNo: fallback.litNo,
  }, getProject().referenceStandard);
}

function restoreMissingCitationsFromDoc(doc, list) {
  const order = buildCitationNumberMap(doc);
  const existing = new Set(list.map(item => item.id).filter(Boolean));
  const existingLitNos = new Set(list.map(item => Number(item.litNo)).filter(Number.isFinite));
  const pools = citationRestorePools(list);
  const sortedCitationsByNo = [...list].sort((a, b) => Number(a.litNo || 0) - Number(b.litNo || 0));
  const missing = [...order.entries()]
    .filter(([id]) => id && !existing.has(id))
    .sort((a, b) => a[1] - b[1]);
  const plainNumbers = new Set();
  doc.descendants(node => {
    if (!node.isTextblock || node.type.name === 'heading') return;
    (node.textContent.match(/\[(\d+)\]/g) || []).forEach(mark => plainNumbers.add(Number(mark.slice(1, -1))));
  });
  const missingPlain = [...plainNumbers]
    .filter(n => n && !existingLitNos.has(n) && ![...order.values()].includes(n))
    .sort((a, b) => a - b);
  if (!missing.length && !missingPlain.length) return list;
  const restored = [];
  const dedupAgainst = () => [...list, ...restored];
  const sameCitation = (a, b) => {
    const n = s => String(s || '').toLowerCase().replace(/[\s.,:;!?'"()\[\]\/\-]+/g, '');
    const doiA = n(a?.doi), doiB = n(b?.doi);
    const tA = n(a?.title), tB = n(b?.title);
    return (a?.id && a.id === b?.id) || (doiA && doiA === doiB) || (tA && tA === tB);
  };
  missing.forEach(([id, number]) => {
    const source = findCitationSource(pools, { id, doi: id, litNo: number });
    if (!source) return; // 没有来源：不加占位
    const entry = restoreCitationEntry(source, {
      id,
      litNo: number,
      type: source.type || 'J',
      title: source.title || `正文引用文献 ${number}`,
      source: source.source || '来源未核',
      year: source.year || '',
      doi: source.doi || '',
    });
    if (dedupAgainst().some(c => sameCitation(c, entry))) return;
    restored.push(entry);
  });
  missingPlain.forEach(number => {
    let source = findCitationSource(pools, { litNo: number });
    if (!source) source = sortedCitationsByNo[number - 1] || null;
    if (!source) return; // 没有来源：不加占位
    const entry = restoreCitationEntry(source, {
      id: source.id || `legacy-cit-${number}`,
      litNo: number,
      type: source.type || 'J',
      title: source.title || `正文引用文献 ${number}`,
      source: source.source || '来源未核',
      year: source.year || '',
      doi: source.doi || '',
    });
    if (dedupAgainst().some(c => sameCitation(c, entry))) return;
    restored.push(entry);
  });
  if (!restored.length) return list;
  const next = [...list, ...restored].sort((a, b) => (a.litNo || 999999) - (b.litNo || 999999));
  saveCitations(next);
  const complete = restored.filter(item => item.title && !/^正文引用文献 \d+$/.test(item.title)).length;
  toast(complete === restored.length
    ? `已从正文引用恢复 ${restored.length} 条文献`
    : `已从正文引用恢复 ${restored.length} 条文献，其中 ${restored.length - complete} 条需要补全信息`, 'ok', 3600);
  return next;
}

function normalizeAcademicText(text) {
  let t = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\t+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/ ([，。；：！？、）】》])/g, '$1')
    .replace(/([（【《]) /g, '$1')
    .replace(/“ /g, '“')
    .replace(/ ”/g, '”')
    .replace(/‘ /g, '‘')
    .replace(/ ’/g, '’')
    .replace(/[，,]\.{2,}/g, '……')   // 中文省略号
    .replace(/\.\.\.(?!\.)/g, '…');   // 半角三点 -> 中文省略号
  // 全角字母/数字 -> 半角（中文上下文里残留的全角英数）
  t = t
    .replace(/[\uFF10-\uFF19]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF21-\uFF3A]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF41-\uFF5A]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  return t
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function normalizeInlineNodeContent(node, schema) {
  const placeholders = [];
  let raw = '';
  node.forEach(child => {
    if (child.isText) {
      raw += child.text || '';
      return;
    }
    const token = `__NODE_${placeholders.length}__`;
    placeholders.push({ token, node: child });
    raw += token;
  });
  const normalized = normalizeAcademicText(raw);
  if (normalized === raw) return node;

  const children = [];
  const regex = /__NODE_(\d+)__/g;
  let last = 0;
  let match;
  while ((match = regex.exec(normalized))) {
    const before = normalized.slice(last, match.index);
    if (before) children.push(schema.text(before));
    const entry = placeholders[Number(match[1])];
    if (entry) children.push(entry.node);
    last = match.index + match[0].length;
  }
  const tail = normalized.slice(last);
  if (tail) children.push(schema.text(tail));
  return node.type.create(node.attrs, children.length ? children : null);
}

function timeLabel(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function currentTimestampLabel() {
  return new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function workbenchState(project) {
  const state = project?.writingWorkbench && typeof project.writingWorkbench === 'object' ? project.writingWorkbench : {};
  return {
    chapterNotes: state.chapterNotes && typeof state.chapterNotes === 'object' ? state.chapterNotes : {},
  };
}

function todoId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export default {
  id: 'writing',
  icon: '',
  title: '论文写作',
  subtitle: '结构化写作、AI 辅助、动态引用编号',
  projectScoped: true,

  render(el) {
    const project = getProject();
    let citations = normalizeCitations();
    const doc = ensureOutlineSubsections(docFromJSON({ ...project, citations }), project);
    citations = restoreMissingCitationsFromDoc(doc, citations);
    const viewState = { pending: null, rerun: null, view: null, currentChapter: project.currentChapter || project.outline?.[0]?.chapter || '' };
    const panelState = { outlineCollapsed: false, activeRightTab: 'assistant' };

    el.innerHTML = `
      <div class="card wb-shell-card">
        <div class="workbench">
          <aside class="wb-left">
            <div class="wb-left-expanded">
              <div class="wb-side-head">
                <div>
                  <h3><span class="mark"></span>论文目录</h3>
                  <p class="desc" id="wb-outline-desc">按章节快速跳转与切换</p>
                </div>
                <button class="btn btn-ghost btn-sm icon-only" id="wb-toggle-outline" title="收起目录" aria-label="收起目录">${ICONS.panelLeftClose}</button>
              </div>
              <div class="chapter-list" id="wb-outline"></div>
            </div>
            <div class="wb-left-collapsed" id="wb-outline-peek" title="展开目录" aria-label="展开目录" role="button" tabindex="0">
              <button class="btn btn-ghost btn-sm icon-only wb-outline-rail-btn" type="button" id="wb-outline-rail-trigger" title="展开目录" aria-label="展开目录">${ICONS.panelLeftOpen}</button>
              <div class="wb-outline-rail-meta">
                <span class="wb-outline-rail-label">目录</span>
                <span class="wb-outline-rail-count" id="wb-outline-rail-count">0</span>
              </div>
              <div class="wb-outline-rail-dots" id="wb-outline-rail-dots"></div>
            </div>
          </aside>

          <section class="wb-center">
            <div class="wb-editor-chrome">
              <div class="wb-header">
                <div class="wb-current">
                  <span class="cur-title" id="wb-cur-title">写作区</span>
                  <span class="cur-note" id="wb-cur-note">自动保存</span>
                </div>
              </div>
              <div class="wb-format-toolbar" aria-label="编辑器常用工具">
                <div class="wb-toolbar-cluster">
                  <span class="wb-cluster-label">文档</span>
                  <button class="wb-tool-btn" type="button" id="wb-topic">项目方案</button>
                  <button class="wb-tool-btn" type="button" id="wb-done">标记完成</button>
                  <button class="wb-tool-btn icon-text" type="button" id="wb-copy">${ICONS.copy}<span>复制全文</span></button>
                </div>
                <div class="wb-toolbar-cluster">
                  <span class="wb-cluster-label">插入</span>
                  <button class="wb-tool-btn" type="button" id="wb-insert-citation">引用</button>
                  <button class="wb-tool-btn" type="button" id="wb-insert-note">注释</button>
                  <button class="wb-tool-btn" type="button" id="wb-insert-image">图片</button>
                  <button class="wb-tool-btn" type="button" id="wb-insert-table">表格</button>
                  <button class="wb-tool-btn" type="button" id="wb-insert-formula">公式</button>
                </div>
                <div class="wb-toolbar-spacer"></div>
                <div class="wb-toolbar-cluster wb-toolbar-quick">
                  <button class="wb-icon-tool" type="button" id="wb-undo" title="撤销" aria-label="撤销">${ICONS.undo}</button>
                  <button class="wb-icon-tool" type="button" id="wb-redo" title="重做" aria-label="重做">${ICONS.redo}</button>
                  <button class="wb-tool-btn" type="button" id="wb-save-version">保存版本</button>
                  <button class="wb-tool-btn" type="button" id="wb-format">格式整理</button>
                  <button class="wb-tool-btn" type="button" id="wb-clean-citations">整理文献</button>
                  <button class="wb-tool-btn" type="button" id="wb-preview">模板预览</button>
                  <details class="wb-toolbar-more wb-export-menu">
                    <summary>导出</summary>
                    <div class="wb-toolbar-more-panel">
                      <button class="btn btn-ghost btn-sm" id="wb-export-check" type="button">导出前检查</button>
                      <button class="btn btn-ghost btn-sm" id="wb-export-word" type="button">Word 文档</button>
                      <button class="btn btn-ghost btn-sm" id="wb-export-pdf" type="button">PDF 文件</button>
                      <button class="btn btn-ghost btn-sm" id="wb-download" type="button">Markdown</button>
                    </div>
                  </details>
                </div>
              </div>
              <div class="wb-editor-toolbar">
                <div class="wb-command-group" aria-label="AI 辅助工具">
                  <span class="wb-command-label">AI 辅助</span>
                  <button class="wb-command primary" type="button" id="wb-draft">生成初稿</button>
                  ${AI_ACTIONS.map(item => `<button class="wb-command" type="button" data-ai="${item.id}">${item.label}</button>`).join('')}
                </div>
              </div>
            </div>
            <div id="wb-editor" class="paper-sheet pm-editor"></div>
            <div class="wb-meta">
              <span id="wb-count">全文字数 0</span>
              <span id="wb-saved">已载入</span>
              <span class="hint-plain">建议先校对后再写回正文</span>
            </div>
            ${integrityNote()}
          </section>

          <aside class="wb-right">
            <div class="wb-side-card" id="wb-chapter-card"></div>
            <div class="wb-side-select-wrap">
              <label class="field-label" for="wb-side-select">辅助区</label>
              <select id="wb-side-select" aria-label="切换右侧辅助区">
                ${Object.entries(SIDE_PANELS).map(([id, item]) => `
                  <option value="${id}" ${id === 'assistant' ? 'selected' : ''}>${item.label}</option>
                `).join('')}
              </select>
              <p class="desc" id="wb-side-select-hint">${SIDE_PANELS.assistant.hint}</p>
            </div>
            <div class="wb-side-pane active" data-side-pane="assistant">
              <div id="wb-suggestion"></div>
            </div>
            <div class="wb-side-pane" data-side-pane="citation">
              <div class="wb-side-pane-head">
                <h3><span class="mark"></span>插入引用</h3>
                <p class="desc">编号会按正文首次出现顺序自动重排。</p>
              </div>
              <div id="wb-citations"></div>
            </div>
            <div class="wb-side-pane" data-side-pane="evidence">
              <div class="wb-side-pane-head">
                <h3><span class="mark"></span>相关证据</h3>
                <p class="desc">展示与当前章节直接相关的证据卡。</p>
              </div>
              <div id="wb-evidence"></div>
            </div>
            <div class="wb-side-pane" data-side-pane="todos">
              <div class="wb-side-pane-head">
                <h3><span class="mark"></span>待修改清单</h3>
                <p class="desc">把这一章接下来要改的点先挂住，润稿时就不会丢。</p>
              </div>
              <div id="wb-todos"></div>
            </div>
            <div class="wb-side-pane" data-side-pane="versions">
              <div class="wb-side-pane-head">
                <h3><span class="mark"></span>版本与回退</h3>
                <p class="desc">重要节点先留一个整稿版本，需要时可以回退。</p>
              </div>
              <div id="wb-versions"></div>
            </div>
          </aside>
        </div>
        <input type="file" id="wb-image-file" accept="image/png,image/jpeg" hidden>
        <div class="modal-backdrop" id="wb-asset-modal" hidden>
          <div class="modal-panel wb-asset-modal">
            <div class="citation-modal-head">
              <div>
                <h3 id="wb-asset-title">插入图片</h3>
                <p class="desc" id="wb-asset-desc">给内容补上标题和说明，排版预览和导出时会按论文结构带上编号。</p>
              </div>
              <button class="btn btn-ghost btn-sm icon-only" type="button" id="wb-asset-close-top" aria-label="关闭">${ICONS.close}</button>
            </div>
            <div id="wb-asset-form"></div>
          </div>
        </div>
        <div class="modal-backdrop" id="wb-logic-modal" hidden>
          <div class="modal-panel wb-logic-modal">
            <div class="citation-modal-head">
              <div>
                <h3>本章逻辑检查</h3>
                <p class="desc">检查结果只作为修改建议，不会直接写进论文正文。</p>
              </div>
              <button class="btn btn-ghost btn-sm icon-only" type="button" id="wb-logic-close" aria-label="关闭">${ICONS.close}</button>
            </div>
            <div id="wb-logic-result"></div>
          </div>
        </div>
      </div>`;

    const suggestionBox = el.querySelector('#wb-suggestion');
    const outlineBox = el.querySelector('#wb-outline');
    const citationBox = el.querySelector('#wb-citations');
    const evidenceBox = el.querySelector('#wb-evidence');
    const savedEl = el.querySelector('#wb-saved');
    const countEl = el.querySelector('#wb-count');
    const workbench = el.querySelector('.workbench');
    const outlineToggle = el.querySelector('#wb-toggle-outline');
    const outlinePeek = el.querySelector('#wb-outline-peek');
    const outlineRailTrigger = el.querySelector('#wb-outline-rail-trigger');
    const outlineRailCount = el.querySelector('#wb-outline-rail-count');
    const outlineRailDots = el.querySelector('#wb-outline-rail-dots');
    const chapterCard = el.querySelector('#wb-chapter-card');
    const sidePanes = [...el.querySelectorAll('[data-side-pane]')];
    const sideSelect = el.querySelector('#wb-side-select');
    const sideSelectHint = el.querySelector('#wb-side-select-hint');
    const todosBox = el.querySelector('#wb-todos');
    const versionsBox = el.querySelector('#wb-versions');
    const assetModal = el.querySelector('#wb-asset-modal');
    const assetForm = el.querySelector('#wb-asset-form');
    const assetTitle = el.querySelector('#wb-asset-title');
    const assetDesc = el.querySelector('#wb-asset-desc');
    const imageInput = el.querySelector('#wb-image-file');
    const logicModal = el.querySelector('#wb-logic-modal');
    const logicResult = el.querySelector('#wb-logic-result');
    let saveTimer = null;
    let saveProjectId = null;
    let assetDraft = null;

    function closeAssetModal() {
      if (!assetModal) return;
      assetModal.hidden = true;
      document.body.style.overflow = '';
      assetDraft = null;
      if (imageInput) imageInput.value = '';
    }

    function closeLogicModal() {
      if (!logicModal) return;
      logicModal.hidden = true;
      document.body.style.overflow = '';
    }

    function dismissLogicReview() {
      viewState.pending = null;
      closeLogicModal();
      renderSuggestionBox(suggestionBox, viewState);
    }

    function renderLogicModal(pending) {
      if (!logicModal || !logicResult || !pending) return;
      logicResult.innerHTML = `
        <div class="logic-report-body">
          <div class="logic-report-meta">
            <span class="chip">检查范围</span>
            <strong>${escapeHtml(pending.label || '本章逻辑检查')}</strong>
          </div>
          <div class="result-box filled">${escapeHtml(pending.suggestion || '暂无检查结果')}</div>
          <div class="result-actions">
            <button class="btn" type="button" data-review-action="todo">转成待修改清单</button>
            <button class="btn btn-ai" type="button" data-review-action="regenerate">重新检查</button>
            <button class="btn btn-ghost" type="button" data-review-action="reject">关闭</button>
          </div>
        </div>`;
      logicModal.hidden = false;
      document.body.style.overflow = 'hidden';
    }

    function openAssetModal(kind, payload = null) {
      assetDraft = { kind, ...(payload || {}) };
      assetModal.hidden = false;
      document.body.style.overflow = 'hidden';
      if (kind === 'image') {
        assetTitle.textContent = payload?.pos != null ? '编辑图片' : '插入图片';
        assetDesc.textContent = '支持 PNG、JPG。建议补上图题，后续排版预览和导出会自动编号。';
        assetForm.innerHTML = `
          <div class="wb-asset-grid">
            <div class="wb-asset-preview-shell">
              <div class="wb-asset-preview" id="wb-image-preview">${payload?.src ? `<img src="${payload.src}" alt="${escapeHtml(payload.alt || payload.caption || '图片')}">` : '<span class="placeholder">选择图片后会在这里预览</span>'}</div>
              <button class="btn btn-ghost btn-sm" type="button" id="wb-image-choose">${payload?.src ? '更换图片' : '选择图片'}</button>
            </div>
            <div>
              <label class="field-label">图题</label>
              <input type="text" id="wb-image-caption" value="${escapeHtml(payload?.caption || '')}" placeholder="例如：图像分割模型整体结构图">
              <label class="field-label">图片说明（可选）</label>
              <input type="text" id="wb-image-alt" value="${escapeHtml(payload?.alt || '')}" placeholder="给导出和无障碍阅读使用">
              <label class="field-label">来源说明（可选）</label>
              <textarea id="wb-image-note" placeholder="例如：资料来源为国家统计局 2025 年公开数据，作者整理。">${escapeHtml(payload?.note || '')}</textarea>
            </div>
          </div>
          <div class="citation-inline-actions block-actions">
            <button class="btn" type="button" id="wb-asset-save">保存图片</button>
            ${payload?.pos != null ? '<button class="btn btn-ghost btn-danger-soft" type="button" id="wb-asset-delete">删除图片</button>' : ''}
            <button class="btn btn-ghost" type="button" id="wb-asset-cancel">取消</button>
          </div>`;
        assetForm.querySelector('#wb-image-choose')?.addEventListener('click', () => imageInput?.click());
        assetForm.querySelector('#wb-asset-delete')?.addEventListener('click', deleteImageAsset);
        assetForm.querySelector('#wb-image-caption')?.focus();
      } else if (kind === 'table') {
        const rows = payload?.rows?.length ? payload.rows : Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ''));
        assetTitle.textContent = payload?.pos != null ? '编辑表格' : '插入表格';
        assetDesc.textContent = '表头写在第一行。保存后会按论文表格样式进入编辑器、预览和导出。';
        assetForm.innerHTML = `
          <label class="field-label">表题</label>
          <input type="text" id="wb-table-caption" value="${escapeHtml(payload?.caption || '')}" placeholder="例如：样本数据统计表">
          <label class="field-label">表格说明（可选）</label>
          <textarea id="wb-table-note" placeholder="例如：样本共 42 份，数据来源为企业访谈与内部台账整理。">${escapeHtml(payload?.note || '')}</textarea>
          <div class="wb-table-grid" id="wb-table-grid">
            ${rows.map((row, rowIndex) => `<div class="wb-table-row">${row.map((cell, cellIndex) => `<input type="text" class="wb-table-cell" data-row="${rowIndex}" data-col="${cellIndex}" value="${escapeHtml(cell)}" placeholder="${rowIndex === 0 ? `表头 ${cellIndex + 1}` : `内容 ${rowIndex}-${cellIndex + 1}`}">`).join('')}</div>`).join('')}
          </div>
          <div class="citation-inline-actions block-actions">
            <button class="btn" type="button" id="wb-table-add-row">增加一行</button>
            <button class="btn btn-ghost" type="button" id="wb-table-add-col">增加一列</button>
            <button class="btn btn-ghost" type="button" id="wb-table-remove-row">删除一行</button>
            <button class="btn btn-ghost" type="button" id="wb-table-remove-col">删除一列</button>
          </div>
          <div class="citation-inline-actions block-actions">
            <button class="btn" type="button" id="wb-asset-save">保存表格</button>
            <button class="btn btn-ghost" type="button" id="wb-asset-cancel">取消</button>
          </div>`;
        assetForm.querySelector('#wb-table-caption')?.focus();
        assetForm.querySelector('#wb-table-add-row')?.addEventListener('click', () => {
          const current = collectTableRowsFromForm();
          current.push(Array.from({ length: current[0]?.length || 3 }, () => ''));
          openAssetModal('table', { ...assetDraft, caption: assetForm.querySelector('#wb-table-caption')?.value.trim() || '', note: assetForm.querySelector('#wb-table-note')?.value.trim() || '', rows: current });
        });
        assetForm.querySelector('#wb-table-add-col')?.addEventListener('click', () => {
          const current = collectTableRowsFromForm().map(row => [...row, '']);
          openAssetModal('table', { ...assetDraft, caption: assetForm.querySelector('#wb-table-caption')?.value.trim() || '', note: assetForm.querySelector('#wb-table-note')?.value.trim() || '', rows: current });
        });
        assetForm.querySelector('#wb-table-remove-row')?.addEventListener('click', () => {
          const current = collectTableRowsFromForm();
          if (current.length <= 1) {
            toast('至少保留一行', 'err');
            return;
          }
          current.pop();
          openAssetModal('table', { ...assetDraft, caption: assetForm.querySelector('#wb-table-caption')?.value.trim() || '', note: assetForm.querySelector('#wb-table-note')?.value.trim() || '', rows: current });
        });
        assetForm.querySelector('#wb-table-remove-col')?.addEventListener('click', () => {
          const current = collectTableRowsFromForm();
          if ((current[0]?.length || 0) <= 1) {
            toast('至少保留一列', 'err');
            return;
          }
          openAssetModal('table', {
            ...assetDraft,
            caption: assetForm.querySelector('#wb-table-caption')?.value.trim() || '',
            note: assetForm.querySelector('#wb-table-note')?.value.trim() || '',
            rows: current.map(row => row.slice(0, -1)),
          });
        });
      } else if (kind === 'formula') {
        assetTitle.textContent = payload?.pos != null ? '编辑公式' : '插入公式';
        assetDesc.textContent = '支持录入 LaTeX 或普通公式文本。排版预览和 Word 导出会按公式块处理。';
        assetForm.innerHTML = `
          <label class="field-label">公式标题</label>
          <input type="text" id="wb-formula-label" value="${escapeHtml(payload?.label || '')}" placeholder="例如：样本均值计算式">
          <label class="field-label">公式内容</label>
          <textarea id="wb-formula-latex" placeholder="例如：\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i">${escapeHtml(payload?.latex || '')}</textarea>
          <label class="field-label">公式说明（可选）</label>
          <textarea id="wb-formula-note" placeholder="例如：其中 x_i 表示第 i 个样本观测值。">${escapeHtml(payload?.note || '')}</textarea>
          <div class="citation-inline-actions block-actions">
            <button class="btn" type="button" id="wb-asset-save">保存公式</button>
            <button class="btn btn-ghost" type="button" id="wb-asset-cancel">取消</button>
          </div>`;
        assetForm.querySelector('#wb-formula-latex')?.focus();
      } else {
        assetTitle.textContent = payload?.pos != null ? '编辑注释' : '插入注释';
        assetDesc.textContent = '注释会在正文中显示为注号，并在预览与导出中集中列出。';
        assetForm.innerHTML = `
          <label class="field-label">注释内容</label>
          <textarea id="wb-note-text" placeholder="例如：此处样本指 2024 年 1 月至 6 月完成全部数据回收的企业样本。">${escapeHtml(payload?.noteText || '')}</textarea>
          <div class="citation-inline-actions block-actions">
            <button class="btn" type="button" id="wb-asset-save">保存注释</button>
            <button class="btn btn-ghost" type="button" id="wb-asset-cancel">取消</button>
          </div>`;
        assetForm.querySelector('#wb-note-text')?.focus();
      }
      assetForm.querySelector('#wb-asset-cancel')?.addEventListener('click', closeAssetModal);
      assetForm.querySelector('#wb-asset-save')?.addEventListener('click', () => saveAsset(kind));
    }

    function collectTableRowsFromForm() {
      const cells = [...assetForm.querySelectorAll('.wb-table-cell')];
      const rows = [];
      cells.forEach(cell => {
        const rowIndex = Number(cell.dataset.row);
        if (!rows[rowIndex]) rows[rowIndex] = [];
        rows[rowIndex][Number(cell.dataset.col)] = cell.value.trim();
      });
      return rows.filter(row => row && row.length);
    }

    async function readImageMeta(file) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('图片读取失败，请重试'));
        reader.readAsDataURL(file);
      });
      const size = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('图片加载失败，请换一张试试'));
        img.src = dataUrl;
      });
      return { dataUrl, ...size };
    }

    function replaceNodeAtPos(pos, node) {
      const target = viewState.view.state.doc.nodeAt(pos);
      if (!target) return;
      viewState.view.dispatch(viewState.view.state.tr.replaceWith(pos, pos + target.nodeSize, node).scrollIntoView());
    }

    function deleteNodeAtPos(pos) {
      const target = viewState.view.state.doc.nodeAt(pos);
      if (!target) return false;
      viewState.view.dispatch(viewState.view.state.tr.delete(pos, pos + target.nodeSize).scrollIntoView());
      return true;
    }

    function deleteImageAsset() {
      if (assetDraft?.pos == null) return;
      const title = assetDraft.caption || assetDraft.alt || '这张图片';
      if (!window.confirm(`确认删除“${title}”吗？删除后会从正文中移除。`)) return;
      const removed = deleteNodeAtPos(assetDraft.pos);
      closeAssetModal();
      toast(removed ? '图片已删除' : '删除失败，请重试', removed ? 'ok' : 'err');
    }

    function saveAsset(kind) {
      if (kind === 'image') {
        const caption = assetForm.querySelector('#wb-image-caption')?.value.trim() || '';
        const alt = assetForm.querySelector('#wb-image-alt')?.value.trim() || '';
        const note = assetForm.querySelector('#wb-image-note')?.value.trim() || '';
        if (!assetDraft?.src) {
          toast('请先选择图片', 'err');
          return;
        }
        const attrs = { src: assetDraft.src, alt, caption, note, width: assetDraft.width || 0, height: assetDraft.height || 0 };
        const node = paperSchema.nodes.figure.create(attrs);
        if (assetDraft.pos != null) replaceNodeAtPos(assetDraft.pos, node);
        else insertFigureNode(viewState.view, attrs);
        closeAssetModal();
        toast('图片已插入', 'ok');
        return;
      }
      if (kind === 'formula') {
        const label = assetForm.querySelector('#wb-formula-label')?.value.trim() || '';
        const latex = assetForm.querySelector('#wb-formula-latex')?.value.trim() || '';
        const note = assetForm.querySelector('#wb-formula-note')?.value.trim() || '';
        if (!latex) {
          toast('请填写公式内容', 'err');
          return;
        }
        const attrs = { label, latex, note };
        const node = paperSchema.nodes.formula_block.create(attrs);
        if (assetDraft.pos != null) replaceNodeAtPos(assetDraft.pos, node);
        else insertFormulaNode(viewState.view, attrs);
        closeAssetModal();
        toast('公式已插入', 'ok');
        return;
      }
      if (kind === 'footnote') {
        const noteText = assetForm.querySelector('#wb-note-text')?.value.trim() || '';
        if (!noteText) {
          toast('请填写注释内容', 'err');
          return;
        }
        const attrs = { noteText };
        const node = paperSchema.nodes.footnote.create(attrs);
        if (assetDraft.pos != null) replaceNodeAtPos(assetDraft.pos, node);
        else insertFootnoteNode(viewState.view, attrs);
        closeAssetModal();
        toast('注释已插入', 'ok');
        return;
      }
      const caption = assetForm.querySelector('#wb-table-caption')?.value.trim() || '';
      const note = assetForm.querySelector('#wb-table-note')?.value.trim() || '';
      const rows = collectTableRowsFromForm().map(row => row.map(cell => cell || ''));
      if (!rows.length || !rows[0]?.length) {
        toast('请至少保留一行一列', 'err');
        return;
      }
      const attrs = { caption, note, rows: JSON.stringify(rows) };
      const node = paperSchema.nodes.table_block.create(attrs);
      if (assetDraft.pos != null) replaceNodeAtPos(assetDraft.pos, node);
      else insertTableNode(viewState.view, attrs);
      closeAssetModal();
      toast('表格已插入', 'ok');
    }

    function syncOutlineCollapse() {
      workbench.classList.toggle('outline-collapsed', panelState.outlineCollapsed);
      if (outlineToggle) {
        outlineToggle.innerHTML = panelState.outlineCollapsed ? ICONS.panelLeftOpen : ICONS.panelLeftClose;
        outlineToggle.title = panelState.outlineCollapsed ? '展开目录' : '收起目录';
        outlineToggle.setAttribute('aria-label', panelState.outlineCollapsed ? '展开目录' : '收起目录');
      }
    }

    function setSaveStatus(state, detail = '') {
      savedEl.dataset.state = state;
      if (state === 'saving') savedEl.textContent = '保存中…';
      else if (state === 'saved') savedEl.textContent = detail ? `已保存 ${detail}` : '已保存';
      else if (state === 'error') savedEl.textContent = detail || '保存失败';
      else savedEl.textContent = detail || '已载入';
    }

    function getCitationNumber(id) {
      // nodeView 首次渲染时 viewState.view 尚未赋值；用初始 editorState.doc 兜底即可算对编号
      const doc = viewState.view ? viewState.view.state.doc : editorState.doc;
      const map = buildCitationNumberMap(doc);
      return map.get(id) || '?';
    }

    function getFootnoteNumber(text) {
      const notes = [];
      viewState.view.state.doc.descendants(node => {
        if (node.type.name === 'footnote') {
          const note = String(node.attrs.noteText || '').trim() || '未填写注释';
          if (!notes.includes(note)) notes.push(note);
        }
      });
      const idx = notes.indexOf(String(text || '').trim() || '未填写注释');
      return idx >= 0 ? idx + 1 : '?';
    }

    function renderOutline() {
      const sections = topLevelSections(viewState.view.state.doc);
      if (outlineRailCount) outlineRailCount.textContent = String(sections.length);
      if (outlineRailDots) {
        outlineRailDots.innerHTML = sections.slice(0, 6).map(sec => {
          const isActive = sec.chapter === viewState.currentChapter;
          const st = getProject().chapterProgress?.[sec.chapter] || '未开始';
          const cls = st === '已完成' ? 'done' : st === '进行中' ? 'doing' : '';
          return `<span class="wb-outline-rail-dot ${cls} ${isActive ? 'active' : ''}" title="${escapeHtml(sec.chapter)}"></span>`;
        }).join('');
      }
      outlineBox.innerHTML = sections.length
        ? sections.map(sec => {
            const active = sec.chapter === viewState.currentChapter;
            const st = getProject().chapterProgress?.[sec.chapter] || '未开始';
            const chip = st === '已完成' ? '<span class="chip done">已完成</span>' : st === '进行中' ? '<span class="chip doing">进行中</span>' : '';
            const subs = subsectionsForSection(viewState.view.state.doc, sec);
            return `<div class="chapter-group ${active ? 'active' : ''}">
              <button class="chapter-item ${active ? 'active' : ''}" data-section="${escapeHtml(sec.sectionId)}">
                <span class="name">${escapeHtml(sec.chapter)}</span>${chip}
              </button>
              ${subs.length ? `<div class="chapter-subsection-list">
                ${subs.map(sub => `<button class="chapter-subsection" data-subsection-pos="${sub.pos}" title="${escapeHtml(sub.title)}">${escapeHtml(sub.title)}</button>`).join('')}
              </div>` : ''}
            </div>`;
          }).join('')
        : '<p class="desc">先在研究设计里生成大纲，或者直接在编辑器中新增章节标题。</p>';
      outlineBox.querySelectorAll('[data-section]').forEach(btn => {
        btn.addEventListener('click', () => {
          jumpToSection(btn.dataset.section);
        });
      });
      outlineBox.querySelectorAll('[data-subsection-pos]').forEach(btn => {
        btn.addEventListener('click', () => {
          const pos = Number(btn.dataset.subsectionPos);
          if (!Number.isFinite(pos)) return;
          jumpToPosition(pos);
        });
      });
    }

    function renderCitationPicker() {
      const map = buildCitationNumberMap(viewState.view.state.doc);
      const usage = collectCitationUsage(viewState.view.state.doc);
      const pickerItems = [...citations].sort((a, b) => {
        const aNo = map.get(a.id) || Number.POSITIVE_INFINITY;
        const bNo = map.get(b.id) || Number.POSITIVE_INFINITY;
        if (aNo !== bNo) return aNo - bNo;
        return (a.litNo || 0) - (b.litNo || 0);
      });
      citationBox.innerHTML = citations.length ? `
        <div class="wb-citation-picker-row">
          <select id="wb-cit-select">
            ${pickerItems.map(item => {
              const currentNo = map.get(item.id);
              const info = usage.get(item.id);
              const suffix = currentNo ? ` · 当前 [${currentNo}] ×${info?.count || 1}` : ' · 未引用';
              return `<option value="${item.id}">${escapeHtml((item.title || item.formatted || '').slice(0, 30))}${suffix}</option>`;
            }).join('')}
          </select>
          <button class="btn btn-sm" id="wb-cit-insert">插入</button>
        </div>` : '<p class="desc">文献库还没有条目，先去「文献与证据」收集文献。</p>';
      citationBox.querySelector('#wb-cit-insert')?.addEventListener('click', () => {
        const id = citationBox.querySelector('#wb-cit-select').value;
        insertCitationNode(viewState.view, id);
        viewState.view.focus();
        toast(`已插入引用 [${getCitationNumber(id)}]`, 'ok');
      });
    }

    function tidyCitationLibrary() {
      const usage = collectCitationUsage(viewState.view.state.doc);
      const order = buildCitationNumberMap(viewState.view.state.doc);
      const current = ensureCitationIds(getCitations()).list;
      const used = current
        .filter(item => usage.has(item.id))
        .sort((a, b) => (order.get(a.id) || 999999) - (order.get(b.id) || 999999));
      const unused = current.filter(item => !usage.has(item.id));
      // 文献库是独立库：保留全部（已用 + 未用），只把已用的排到前面并按引用顺序重排编号
      const reordered = [...used, ...unused].map((item, index) => ({ ...item, litNo: index + 1 }));
      saveCitations(reordered);
      citations = reordered;
      refreshCitationNumbers();
      renderCitationPicker();
      persistNow();
      const parts = [];
      if (unused.length) parts.push(`未用 ${unused.length} 条已保留在文献库`);
      toast(parts.length ? `已按正文引用顺序整理：已用 ${used.length} 条，${parts.join('，')}` : '已按正文引用顺序整理', 'ok', 3000);
    }

    function renderEvidencePanel() {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      evidenceBox.innerHTML = relatedEvidenceHtml(section, citations);
    }

    function sectionWorkbenchEntry(section) {
      const key = section?.sectionId || section?.chapter || '';
      const state = workbenchState(getProject());
      const entry = state.chapterNotes[key] || {};
      return {
        key,
        note: entry.note || '',
        todos: Array.isArray(entry.todos) ? entry.todos : [],
      };
    }

    function saveSectionWorkbench(section, patch) {
      if (!section) return null;
      const project = getProject();
      const state = workbenchState(project);
      const key = section.sectionId || section.chapter;
      const current = state.chapterNotes[key] || { note: '', todos: [] };
      const nextEntry = {
        note: patch.note ?? current.note ?? '',
        todos: patch.todos ?? current.todos ?? [],
      };
      const nextState = {
        ...state,
        chapterNotes: {
          ...state.chapterNotes,
          [key]: nextEntry,
        },
      };
      saveProject({ writingWorkbench: nextState });
      return nextEntry;
    }

    function addTodoToCurrentSection(text) {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      if (!section) {
        toast('请先进入某个章节', 'err');
        return;
      }
      const value = String(text || '').trim();
      if (!value) {
        toast('先写下这条要改什么', 'err');
        return;
      }
      const entry = sectionWorkbenchEntry(section);
      const todos = [{ id: todoId(), text: value, done: false, createdAt: Date.now() }, ...entry.todos];
      saveSectionWorkbench(section, { todos });
      renderTodosPanel();
      toast('已加入当前章节待修改清单', 'ok', 1800);
    }

    function toggleTodo(section, id) {
      const entry = sectionWorkbenchEntry(section);
      const todos = entry.todos.map(item => item.id === id ? { ...item, done: !item.done } : item);
      saveSectionWorkbench(section, { todos });
      renderTodosPanel();
      renderChapterCard();
    }

    function removeTodo(section, id) {
      const entry = sectionWorkbenchEntry(section);
      const todos = entry.todos.filter(item => item.id !== id);
      saveSectionWorkbench(section, { todos });
      renderTodosPanel();
      renderChapterCard();
    }

    function renderTodosPanel() {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      if (!section) {
        todosBox.innerHTML = '<p class="desc">先进入一个章节，再给这一章记录待修改事项。</p>';
        return;
      }
      const entry = sectionWorkbenchEntry(section);
      const openTodos = entry.todos.filter(item => !item.done).length;
      todosBox.innerHTML = `
        <div class="wb-todo-head">
          <div class="wb-todo-summary">
            <b>${escapeHtml(section.chapter)}</b>
            <span>${openTodos} 条未完成</span>
          </div>
        </div>
        <div class="wb-todo-input-row">
          <input type="text" id="wb-todo-input" placeholder="例如：补上这一段的数据来源，或重写结论过渡">
          <button class="btn btn-sm" type="button" id="wb-todo-add">加入</button>
        </div>
        <label class="field-label wb-section-note-label">章节备注</label>
        <textarea id="wb-chapter-note" class="wb-chapter-note" placeholder="把这一章目前的问题、老师反馈、后续修改方向记在这里。">${escapeHtml(entry.note || '')}</textarea>
        <div class="wb-todo-list">
          ${entry.todos.length ? entry.todos.map(item => `
            <div class="wb-todo-item ${item.done ? 'done' : ''}">
              <label class="wb-todo-main">
                <input type="checkbox" data-todo-toggle="${item.id}" ${item.done ? 'checked' : ''}>
                <span>${escapeHtml(item.text)}</span>
              </label>
              <button class="btn btn-ghost btn-sm icon-only" type="button" data-todo-remove="${item.id}" title="删除待修改事项" aria-label="删除待修改事项">${ICONS.trash}</button>
            </div>`).join('') : '<p class="desc">这一章还没有待修改事项。可以先记下逻辑问题、补证据点或老师反馈。</p>'}
        </div>`;
      todosBox.querySelector('#wb-todo-add')?.addEventListener('click', () => {
        const input = todosBox.querySelector('#wb-todo-input');
        addTodoToCurrentSection(input?.value || '');
      });
      todosBox.querySelector('#wb-todo-input')?.addEventListener('keydown', evt => {
        if (evt.key === 'Enter') {
          evt.preventDefault();
          addTodoToCurrentSection(evt.currentTarget.value || '');
        }
      });
      todosBox.querySelector('#wb-chapter-note')?.addEventListener('change', evt => {
        saveSectionWorkbench(section, { note: evt.currentTarget.value || '' });
        toast('章节备注已保存', 'ok', 1200);
      });
      todosBox.querySelectorAll('[data-todo-toggle]').forEach(input =>
        input.addEventListener('change', () => toggleTodo(section, input.dataset.todoToggle)));
      todosBox.querySelectorAll('[data-todo-remove]').forEach(btn =>
        btn.addEventListener('click', () => removeTodo(section, btn.dataset.todoRemove)));
    }

    function createDocSnapshot(label = '手动保存') {
      const text = fullTextFromDoc(viewState.view.state.doc, citationMap(citations));
      const version = snapshotDoc(text, label, {
        documentV2: viewState.view.state.doc.toJSON(),
        currentChapter: viewState.currentChapter,
      });
      if (version) renderVersionsPanel();
      return version;
    }

    function createChapterSnapshot(section, label = '阶段保存') {
      if (!section) return null;
      const text = viewState.view.state.doc.textBetween(section.bodyFrom, section.bodyTo, '\n').trim();
      if (!text) return null;
      // 存结构化片段（含引用/图/表/公式等原子节点），回退时不丢结构
      const slice = viewState.view.state.doc.slice(section.bodyFrom, section.bodyTo);
      const version = snapshotChapter(section.chapter, text, 'manual', label, { chapter: section.chapter, slice: slice.toJSON() });
      if (version) renderVersionsPanel();
      return version;
    }

    function restoreDocVersion(id) {
      const version = getDocVersions().find(item => item.id === id);
      if (!version) {
        toast('这个版本记录已经不存在了', 'err');
        return;
      }
      if (!window.confirm(`确认回退到 ${timeLabel(version.at)} 保存的整稿版本吗？当前未另存的修改会被覆盖。`)) return;
      if (version.documentV2?.type === 'doc') {
        const nextDoc = paperSchema.nodeFromJSON(version.documentV2);
        let tr = viewState.view.state.tr.replaceWith(0, viewState.view.state.doc.content.size, nextDoc.content);
        const focusName = version.currentChapter || topLevelSections(nextDoc)[0]?.chapter || '';
        const focusSection = topLevelSections(tr.doc).find(item => item.chapter === focusName) || topLevelSections(tr.doc)[0];
        if (focusSection) tr = tr.setSelection(TextSelection.create(tr.doc, focusSection.headingFrom));
        viewState.view.dispatch(tr.scrollIntoView());
      } else {
        toast('该整稿版本来自旧格式记录，暂不支持结构化恢复。', 'err', 2600);
        return;
      }
      toast('已回退到所选整稿版本', 'ok');
    }

    function restoreChapterVersion(id) {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      if (!section) {
        toast('请先进入要回退的章节', 'err');
        return;
      }
      const version = getChapterVersions(section.chapter).find(item => item.id === id);
      if (!version) {
        toast('当前章节没有这个版本记录', 'err');
        return;
      }
      if (!window.confirm(`确认回退章节「${section.chapter}」到 ${timeLabel(version.at)} 的版本吗？章节内的结构与引文/图表会被替换为存档内容。`)) return;
      const tr = viewState.view.state.tr;
      if (version.slice) {
        const slice = Slice.fromJSON(paperSchema, version.slice);
        viewState.view.dispatch(tr.replaceWith(section.bodyFrom, section.bodyTo, slice.content).scrollIntoView());
      } else {
        viewState.view.dispatch(tr.insertText(version.text || '', section.bodyFrom, section.bodyTo).scrollIntoView());
      }
      toast(`已回退章节「${section.chapter}」`, 'ok');
    }

    function renderVersionsPanel() {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      const docVersions = getDocVersions().slice(0, 5);
      const chapterVersions = section ? getChapterVersions(section.chapter).slice(0, 6) : [];
      const sections = topLevelSections(viewState.view.state.doc);
      const nextTodo = sections.find(item => (getProject().chapterProgress?.[item.chapter] || '未开始') !== '已完成' && item.chapter !== viewState.currentChapter);
      versionsBox.innerHTML = `
        <div class="wb-version-actions">
          <button class="btn btn-sm" type="button" id="wb-version-save">保存整稿版本</button>
          <button class="btn btn-ghost btn-sm" type="button" id="wb-go-topic">回研究设计</button>
        </div>
        <div class="wb-version-callout">
          <div>
            <b>当前结构会自动同步到项目大纲</b>
            <div class="desc">章节标题、顺序和新增删除都会直接写回项目，不用另做一次“保存大纲”。</div>
          </div>
          ${nextTodo ? `<button class="btn btn-ghost btn-sm" type="button" id="wb-next-todo">去下一个未完成章节</button>` : ''}
        </div>
        <div class="wb-version-group">
          <div class="wb-version-group-head">
            <h4>整稿版本</h4>
            <span>${docVersions.length} 条</span>
          </div>
          ${docVersions.length ? docVersions.map(item => `
            <div class="wb-version-item">
              <div class="wb-version-main">
                <div class="wb-version-title">${escapeHtml(item.label || '整稿版本')}</div>
                <div class="wb-version-meta">${timeLabel(item.at)}</div>
              </div>
              <button class="btn btn-ghost btn-sm" type="button" data-doc-restore="${item.id}">回退</button>
            </div>`).join('') : '<p class="desc">还没有整稿版本，建议在每轮大改后手动保存一次。</p>'}
        </div>
        <div class="wb-version-group">
          <div class="wb-version-group-head">
            <h4>${escapeHtml(section?.chapter || '当前章节')}的历史</h4>
            <span>${chapterVersions.length} 条</span>
          </div>
          ${section ? `
            <div class="wb-version-actions">
              <button class="btn btn-ghost btn-sm" type="button" id="wb-version-save-chapter">保存本章版本</button>
            </div>` : ''}
          ${chapterVersions.length ? chapterVersions.map(item => `
            <div class="wb-version-item">
              <div class="wb-version-main">
                <div class="wb-version-title">${escapeHtml(item.label || '章节版本')}</div>
                <div class="wb-version-meta">${timeLabel(item.at)}</div>
              </div>
              <button class="btn btn-ghost btn-sm" type="button" data-chapter-restore="${item.id}">回退</button>
            </div>`).join('') : '<p class="desc">当前章节还没有版本记录，完成一轮修改后可以手动留一个。</p>'}
        </div>`;
      versionsBox.querySelector('#wb-version-save')?.addEventListener('click', () => {
        const v = createDocSnapshot(`整稿保存 · ${currentTimestampLabel()}`);
        toast(v ? '已保存整稿版本' : '内容未变化，未重复保存', 'ok', 1800);
      });
      versionsBox.querySelector('#wb-version-save-chapter')?.addEventListener('click', () => {
        const current = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
        const v = createChapterSnapshot(current, `章节保存 · ${currentTimestampLabel()}`);
        toast(v ? '已保存本章版本' : '本章暂无新变化', 'ok', 1800);
      });
      versionsBox.querySelector('#wb-go-topic')?.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'topic' }));
      });
      versionsBox.querySelector('#wb-next-todo')?.addEventListener('click', () => {
        if (nextTodo) jumpToSection(nextTodo.sectionId);
      });
      versionsBox.querySelectorAll('[data-doc-restore]').forEach(btn =>
        btn.addEventListener('click', () => restoreDocVersion(btn.dataset.docRestore)));
      versionsBox.querySelectorAll('[data-chapter-restore]').forEach(btn =>
        btn.addEventListener('click', () => restoreChapterVersion(btn.dataset.chapterRestore)));
    }

    function switchRightTab(tab) {
      panelState.activeRightTab = tab;
      const meta = SIDE_PANELS[tab] || SIDE_PANELS.assistant;
      if (sideSelect) sideSelect.value = tab;
      if (sideSelectHint) sideSelectHint.textContent = meta.hint;
      sidePanes.forEach(pane => pane.classList.toggle('active', pane.dataset.sidePane === tab));
    }

    function scrollEditorPositionToTop(pos) {
      requestAnimationFrame(() => {
        if (!viewState.view) return;
        const sheet = viewState.view.dom.closest('.paper-sheet');
        if (!sheet) return;
        const found = viewState.view.domAtPos(Math.max(1, Math.min(pos, viewState.view.state.doc.content.size)));
        let target = found.node?.nodeType === 3 ? found.node.parentElement : found.node;
        if (target?.nodeType === 1 && !target.matches?.('h1,h2,h3,p')) {
          target = target.closest?.('h1,h2,h3,p') || target.parentElement;
        }
        if (!target || typeof target.getBoundingClientRect !== 'function') return;
        const top = sheet.scrollTop + target.getBoundingClientRect().top - sheet.getBoundingClientRect().top - 12;
        sheet.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        target.classList.add('pm-jump-flash');
        window.setTimeout(() => target.classList.remove('pm-jump-flash'), 900);
      });
    }

    function jumpToPosition(pos) {
      const safePos = Math.max(1, Math.min(Number(pos) || 1, viewState.view.state.doc.content.size));
      viewState.view.dispatch(viewState.view.state.tr.setSelection(TextSelection.create(viewState.view.state.doc, safePos)));
      viewState.view.focus();
      scrollEditorPositionToTop(safePos);
    }

    function jumpToSection(sectionId) {
      const section = topLevelSections(viewState.view.state.doc).find(x => x.sectionId === sectionId);
      if (!section) return;
      jumpToPosition(section.headingFrom);
    }

    function sectionFragment(title) {
      return [
        paperSchema.nodes.heading.create(
          { level: 2, role: 'section', sectionId: makeSectionId() },
          paperSchema.text(title)
        ),
        paperSchema.nodes.paragraph.create(),
      ];
    }

    function insertSectionRelative(position, title) {
      let tr = viewState.view.state.tr;
      tr = tr.insert(position, sectionFragment(title));
      viewState.view.dispatch(tr.scrollIntoView());
    }

    function renameCurrentSection() {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      if (!section) {
        toast('请先把光标放到要修改的章节里', 'err');
        return;
      }
      const nextTitle = window.prompt('修改章节标题', section.chapter);
      if (!nextTitle) return;
      const title = nextTitle.trim();
      if (!title || title === section.chapter) return;
      const headingNode = viewState.view.state.doc.nodeAt(section.headingFrom);
      if (!headingNode) return;
      const contentFrom = section.headingFrom + 1;
      const contentTo = section.headingFrom + headingNode.nodeSize - 1;
      viewState.view.dispatch(
        viewState.view.state.tr.replaceWith(contentFrom, contentTo, paperSchema.text(title)).scrollIntoView()
      );
      toast('章节标题已更新', 'ok');
    }

    function addSectionBeforeCurrent() {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      if (!section) {
        toast('请先进入一个章节', 'err');
        return;
      }
      const title = window.prompt('新章节标题', '新增章节');
      if (!title?.trim()) return;
      insertSectionRelative(section.headingFrom - 1, title.trim());
      toast('已在当前章节前插入新章节', 'ok');
    }

    function addSectionAfterCurrent() {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      if (!section) {
        toast('请先进入一个章节', 'err');
        return;
      }
      const title = window.prompt('新章节标题', '新增章节');
      if (!title?.trim()) return;
      insertSectionRelative(section.bodyTo + 1, title.trim());
      toast('已在当前章节后插入新章节', 'ok');
    }

    // 无章节（新建项目）时新增首个章节：插到「参考文献」标题之前
    function addFirstSection() {
      const doc = viewState.view.state.doc;
      if (topLevelSections(doc).length) { toast('已有章节，可直接切换或新增', 'ok'); return; }
      const title = window.prompt('首个章节标题', '第一章 绪论');
      if (!title?.trim()) return;
      let pos = doc.content.size;
      doc.forEach((node, offset) => {
        if (node.type.name === 'heading' && node.attrs.role === 'references') pos = offset;
      });
      insertSectionRelative(pos, title.trim());
      const created = topLevelSections(viewState.view.state.doc).find(s => s.chapter === title.trim());
      if (created) {
        viewState.currentChapter = created.chapter;
        setCurrentChapter(created.chapter);
        jumpToSection(created.sectionId);
      }
      renderOutline();
      toast('已新增首个章节', 'ok');
    }

    function moveCurrentSection(direction) {
      const doc = viewState.view.state.doc;
      const sections = topLevelSections(doc);
      const section = sectionForPos(doc, viewState.view.state.selection.from);
      if (!section) {
        toast('请先进入一个章节', 'err');
        return;
      }
      const index = sections.findIndex(item => item.sectionId === section.sectionId);
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= sections.length) {
        toast(direction === 'up' ? '已经是第一章了' : '已经是最后一章了', 'err');
        return;
      }

      const nodes = [];
      doc.forEach(node => nodes.push(node));
      const currentNodes = nodes.slice(section.startIndex, section.endIndex + 1);
      const target = sections[targetIndex];
      const targetNodes = nodes.slice(target.startIndex, target.endIndex + 1);

      let nextNodes;
      if (direction === 'up') {
        nextNodes = [
          ...nodes.slice(0, target.startIndex),
          ...currentNodes,
          ...targetNodes,
          ...nodes.slice(section.endIndex + 1),
        ];
      } else {
        nextNodes = [
          ...nodes.slice(0, section.startIndex),
          ...targetNodes,
          ...currentNodes,
          ...nodes.slice(target.endIndex + 1),
        ];
      }

      const nextDoc = paperSchema.nodes.doc.create(null, Fragment.fromArray(nextNodes));
      let tr = viewState.view.state.tr.replaceWith(0, doc.content.size, nextDoc.content);
      const moved = topLevelSections(tr.doc).find(item => item.sectionId === section.sectionId);
      if (moved) tr = tr.setSelection(TextSelection.create(tr.doc, moved.headingFrom));
      viewState.view.dispatch(tr.scrollIntoView());
      toast(direction === 'up' ? '已上移当前章节' : '已下移当前章节', 'ok');
    }

    function deleteCurrentSection() {
      const doc = viewState.view.state.doc;
      const sections = topLevelSections(doc);
      const section = sectionForPos(doc, viewState.view.state.selection.from);
      if (!section) {
        toast('请先进入一个章节', 'err');
        return;
      }
      if (sections.length <= 1) {
        toast('至少保留一个章节，若要重做结构请先新增章节', 'err', 2600);
        return;
      }
      const text = doc.textBetween(section.bodyFrom, section.bodyTo, '\n').trim();
      const chars = wordCount(text);
      const warning = chars
        ? `「${section.chapter}」当前约有 ${chars} 字正文，删除后这一整章会一起移除。确认删除吗？`
        : `确认删除章节「${section.chapter}」吗？`;
      if (!window.confirm(warning)) return;

      const prev = sections.find((item, idx) => sections[idx + 1]?.sectionId === section.sectionId) || null;
      const next = sections.find((item, idx) => sections[idx - 1]?.sectionId === section.sectionId) || null;
      let tr = viewState.view.state.tr.delete(section.headingFrom - 1, section.bodyTo);
      const nextFocus = next?.sectionId || prev?.sectionId || '';
      if (nextFocus) {
        const moved = topLevelSections(tr.doc).find(item => item.sectionId === nextFocus);
        if (moved) tr = tr.setSelection(TextSelection.create(tr.doc, moved.headingFrom));
      }
      viewState.view.dispatch(tr.scrollIntoView());
      toast(`已删除章节「${section.chapter}」`, 'ok');
    }

    function renderChapterCard() {
      const sections = topLevelSections(viewState.view.state.doc);
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from)
        || sections.find(s => s.chapter === viewState.currentChapter)
        || sections[0];
      if (!chapterCard) return;
      if (!section) {
        chapterCard.innerHTML = `
          <div class="wb-side-card-head">
            <h3><span class="mark"></span>当前章节</h3>
            <p class="desc">还没有章节。新增第一章后即可开始写作，或在「研究设计」生成大纲。</p>
          </div>
          <div class="result-actions wb-empty-actions">
            <button class="btn btn-sm" type="button" data-add-first-section>新增第一章</button>
            <button class="btn btn-ghost btn-sm" type="button" data-nav-topic>去研究设计</button>
          </div>`;
        chapterCard.querySelector('[data-add-first-section]')?.addEventListener('click', addFirstSection);
        chapterCard.querySelector('[data-nav-topic]')?.addEventListener('click', () =>
          document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'topic' })));
        return;
      }
      const chapterText = viewState.view.state.doc.textBetween(section.bodyFrom, section.bodyTo, '\n').trim();
      const citationIds = new Set();
      viewState.view.state.doc.nodesBetween(section.bodyFrom, section.bodyTo, node => {
        if (node.type.name === 'citation') citationIds.add(node.attrs.citationId);
      });
      const status = getProject().chapterProgress?.[section.chapter] || '未开始';
      const displayStatus = status === '未开始' && wordCount(chapterText) > 0 ? '进行中' : status;
      const evidenceItems = relatedEvidenceItems(section);
      const entry = sectionWorkbenchEntry(section);
      const todoOpen = entry.todos.filter(item => !item.done).length;
      const index = sections.findIndex(item => item.sectionId === section.sectionId);
      const prev = sections[index - 1];
      const next = sections[index + 1];
      chapterCard.innerHTML = `
        <div class="wb-ch-strip">
          <div class="wb-ch-row">
            <div class="wb-ch-title-wrap">
              <span class="wb-ch-chip ${displayStatus === '已完成' ? 'done' : displayStatus === '进行中' ? 'doing' : ''}">${escapeHtml(displayStatus)}</span>
              <b class="wb-ch-title" title="${escapeHtml(section.chapter)}">${escapeHtml(section.chapter)}</b>
            </div>
            <button class="btn btn-ghost btn-sm wb-ch-more" type="button" id="wb-ch-ops" aria-haspopup="true" aria-expanded="false" title="章节操作">⋯</button>
          </div>
          <div class="wb-ch-metrics">
            <span>字数 <b>${wordCount(chapterText)}</b></span><span>引用 <b>${citationIds.size}</b></span><span>待改 <b>${todoOpen}</b></span><span>证据 <b>${evidenceItems.length}</b></span>
          </div>
          <div class="wb-ch-nav">
            <button class="btn btn-ghost btn-sm" type="button" data-jump-section="${prev?.sectionId || ''}" ${prev ? '' : 'disabled'}>上一章</button>
            <button class="btn btn-ghost btn-sm" type="button" data-jump-section="${next?.sectionId || ''}" ${next ? '' : 'disabled'}>下一章</button>
          </div>
          <div class="wb-ch-ops" id="wb-ch-ops-menu" hidden>
            <button class="wb-ch-ops-item" type="button" data-go-pane="todos">待修改清单${todoOpen ? ` · ${todoOpen}` : ''}</button>
            <button class="wb-ch-ops-item" type="button" data-go-pane="versions">版本历史</button>
            <button class="wb-ch-ops-item" type="button" data-section-action="up" ${prev ? '' : 'disabled'}>上移</button>
            <button class="wb-ch-ops-item" type="button" data-section-action="down" ${next ? '' : 'disabled'}>下移</button>
            <button class="wb-ch-ops-item" type="button" data-section-action="rename">改标题</button>
            <button class="wb-ch-ops-item" type="button" data-section-action="before">前插一章</button>
            <button class="wb-ch-ops-item" type="button" data-section-action="after">后加一章</button>
            <button class="wb-ch-ops-item wb-ch-ops-danger" type="button" data-section-action="delete">删除本章</button>
          </div>
        </div>`;
      chapterCard.querySelector('#wb-ch-ops')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = chapterCard.querySelector('#wb-ch-ops-menu');
        if (!menu) return;
        const open = menu.hidden;
        menu.hidden = !open;
        e.currentTarget.setAttribute('aria-expanded', String(open));
      });
      chapterCard.querySelectorAll('[data-jump-section]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!btn.dataset.jumpSection) return;
          jumpToSection(btn.dataset.jumpSection);
        });
      });
      chapterCard.querySelectorAll('[data-section-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.dataset.sectionAction === 'up') moveCurrentSection('up');
          if (btn.dataset.sectionAction === 'down') moveCurrentSection('down');
          if (btn.dataset.sectionAction === 'rename') renameCurrentSection();
          if (btn.dataset.sectionAction === 'before') addSectionBeforeCurrent();
          if (btn.dataset.sectionAction === 'after') addSectionAfterCurrent();
          if (btn.dataset.sectionAction === 'delete') deleteCurrentSection();
        });
      });
      chapterCard.querySelectorAll('[data-go-pane]').forEach(btn =>
        btn.addEventListener('click', () => {
          const menu = chapterCard.querySelector('#wb-ch-ops-menu');
          if (menu) menu.hidden = true;
          switchRightTab(btn.dataset.goPane);
        }));
    }

    function syncCurrentChapter() {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      if (!section) return;
      viewState.currentChapter = section.chapter;
      setCurrentChapter(section.chapter);
      const title = el.querySelector('#wb-cur-title');
      if (title) title.textContent = '写作区';
      const note = el.querySelector('#wb-cur-note');
      if (note) note.textContent = `${wordCount(viewState.view.state.doc.textBetween(section.bodyFrom, section.bodyTo, '\n'))} 字 · 自动保存`;
      renderEvidencePanel();
      renderTodosPanel();
      renderChapterCard();
      renderVersionsPanel();
      renderOutline(); // 跳章/光标落章后刷新左侧目录高亮与轨道点
    }

    // 初始对齐：把光标落在「正在写」章节，使顶部标题 / 目录反色 / 右侧当前章节卡三处一致
    function alignInitialChapter() {
      const sections = topLevelSections(viewState.view.state.doc);
      const target = sections.find(s => s.chapter === viewState.currentChapter) || sections[0];
      if (!target) return;
      jumpToSection(target.sectionId);
    }

    function persistNow() {
      try {
        const current = getProject();
        // 防抖窗口内已切到别的项目：不把旧文档写进新项目
        if (saveProjectId && current.id !== saveProjectId) { saveTimer = null; return false; }
        const next = serializeProjectDoc(viewState.view.state.doc, viewState.currentChapter, current);
        saveProject(next);
        countEl.textContent = `全文字数 ${wordCount(fullTextFromDoc(viewState.view.state.doc, citationMap(citations)))}`;
        setSaveStatus('saved', new Date().toLocaleTimeString('zh-CN'));
        renderOutline();
        renderCitationPicker();
        renderEvidencePanel();
        renderTodosPanel();
        renderChapterCard();
        renderVersionsPanel();
        return true;
      } catch (error) {
        console.error('save writing project failed', error);
        setSaveStatus('error', '保存失败，请重试');
        toast(error?.message || '保存失败，请检查本地存储空间或浏览器权限', 'err', 3000);
        return false;
      }
    }

    function formatWholeDocument() {
      const view = viewState.view;
      const { doc } = view.state;
      const ops = [];
      doc.descendants((node, pos) => {
        if (node.type.name !== 'paragraph') return;
        const text = node.textContent;
        let hasAtom = false;
        node.content.forEach(child => { if (child.isAtom) hasAtom = true; });
        const isEmpty = !text.trim() && !hasAtom;
        if (isEmpty) { ops.push({ kind: 'delete', pos, node }); return; }
        const nextNode = normalizeInlineNodeContent(node, paperSchema);
        if (nextNode && !nextNode.eq(node)) ops.push({ kind: 'replace', pos, node: nextNode });
      });
      if (!ops.length) {
        toast('全文格式已规范：没有需要修正的地方', 'ok', 2000);
        return;
      }
      let tr = view.state.tr;
      let replaced = 0, removed = 0;
      ops.sort((a, b) => b.pos - a.pos).forEach(op => {
        if (op.kind === 'delete') { tr = tr.delete(op.pos, op.pos + op.node.nodeSize); removed++; }
        else { tr = tr.replaceWith(op.pos, op.pos + op.node.nodeSize, op.node); replaced++; }
      });
      view.dispatch(tr.scrollIntoView());
      toast(`已整理全文：修正 ${replaced} 段文本、移除 ${removed} 个空行`, 'ok', 2800);
    }

    function formatCurrentSection() {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      if (!section) {
        toast('请先把光标放到要整理的章节里', 'err');
        return;
      }
      const replacements = [];
      viewState.view.state.doc.nodesBetween(section.bodyFrom, section.bodyTo, (node, pos) => {
        if (!node.isTextblock || node.type.name !== 'paragraph') return;
        const nextNode = normalizeInlineNodeContent(node, paperSchema);
        if (nextNode.eq(node)) return;
        replacements.push({ pos, node: nextNode });
      });
      if (!replacements.length) {
        toast(`「${section.chapter}」当前没有可整理的正文格式`, 'ok', 1800);
        return;
      }
      let tr = viewState.view.state.tr;
      replacements.sort((a, b) => b.pos - a.pos).forEach(item => {
        tr = tr.replaceWith(item.pos, item.pos + viewState.view.state.doc.nodeAt(item.pos).nodeSize, item.node);
      });
      viewState.view.dispatch(tr.scrollIntoView());
      toast(`已整理「${section.chapter}」的 ${replacements.length} 段正文格式`, 'ok');
    }

    const reviewPluginKey = new PluginKey('paperpilot-inline-review');
    let reviewWidgetNo = 0;

    function handleReviewAction(actionName) {
      if (!viewState.pending) return;
      if (actionName === 'reject') {
        const wasLogic = viewState.pending.actionId === 'logic';
        recordOutcome(viewState.pending.actionId, 'reject', viewState.pending.label);
        viewState.pending = null;
        clearReviewWidget();
        closeLogicModal();
        renderSuggestionBox(suggestionBox, viewState);
        toast(wasLogic ? '已关闭检查报告' : '已拒绝本次建议，原文保持不变', 'ok', 1500);
        return;
      }
      if (actionName === 'regenerate') {
        recordOutcome(viewState.pending.actionId, 'regenerate', viewState.pending.label);
        clearReviewWidget();
        closeLogicModal();
        viewState.rerun?.();
        return;
      }
      if (actionName === 'todo') {
        const items = String(viewState.pending.suggestion)
          .split(/\n+/)
          .map(line => line.replace(/^\s*[-*•\d.、]+\s*/, '').trim())
          .filter(Boolean)
          .slice(0, 6);
        if (!items.length) {
          toast('这次检查结果没有识别出可转成待办的条目', 'err');
          return;
        }
        items.forEach(text => addTodoToCurrentSection(text));
        viewState.pending = null;
        clearReviewWidget();
        closeLogicModal();
        renderSuggestionBox(suggestionBox, viewState);
        switchRightTab('todos');
        return;
      }
      if (actionName !== 'accept') return;
      const { replaceFrom, replaceTo, suggestion, actionId, original, target } = viewState.pending;
      if (actionId === 'logic') {
        toast('检查结果保留为批注建议，不直接写回正文', 'ok');
        viewState.pending = null;
        clearReviewWidget();
        closeLogicModal();
        renderSuggestionBox(suggestionBox, viewState);
        return;
      }
      recordOutcome(actionId, 'accept', viewState.pending.label);
      recordLengthDelta(actionId, original, suggestion);
      replaceAiTextRange(viewState.view, replaceFrom, replaceTo, suggestion, { target });
      viewState.pending = null;
      clearReviewWidget();
      renderSuggestionBox(suggestionBox, viewState);
      toast('AI 建议已接受并写回正文', 'ok');
    }

    logicResult?.addEventListener('click', evt => {
      const btn = evt.target.closest('[data-review-action]');
      if (!btn) return;
      evt.preventDefault();
      handleReviewAction(btn.dataset.reviewAction);
    });
    el.querySelector('#wb-logic-close')?.addEventListener('click', () => {
      dismissLogicReview();
    });
    logicModal?.addEventListener('click', evt => {
      if (evt.target !== logicModal) return;
      dismissLogicReview();
    });

    function createReviewWidget(pending) {
      const dom = document.createElement('div');
      dom.className = 'wb-inline-review';
      dom.innerHTML = inlineSuggestionHtml(pending);
      dom.addEventListener('mousedown', evt => evt.preventDefault());
      dom.addEventListener('click', evt => {
        const btn = evt.target.closest('[data-review-action]');
        if (!btn) return;
        evt.preventDefault();
        handleReviewAction(btn.dataset.reviewAction);
      });
      return dom;
    }

    function clearReviewWidget() {
      if (!viewState.view) return;
      viewState.view.dispatch(viewState.view.state.tr.setMeta(reviewPluginKey, { clear: true }));
    }

    function showReviewWidget(pending) {
      if (!viewState.view || !pending) return;
      const doc = viewState.view.state.doc;
      const rawPos = Math.min(Math.max(pending.replaceTo || pending.replaceFrom || 1, 1), doc.content.size);
      const $pos = doc.resolve(rawPos);
      let pos = rawPos;
      for (let depth = $pos.depth; depth > 0; depth--) {
        if ($pos.node(depth).isTextblock) {
          pos = Math.min($pos.after(depth), doc.content.size);
          break;
        }
      }
      viewState.view.dispatch(viewState.view.state.tr.setMeta(reviewPluginKey, {
        pos,
        pending,
        key: `review-${++reviewWidgetNo}`,
      }).scrollIntoView());
    }

    const reviewPlugin = new Plugin({
      key: reviewPluginKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, old) {
          const meta = tr.getMeta(reviewPluginKey);
          if (meta?.clear) return DecorationSet.empty;
          if (meta?.pending) {
            return DecorationSet.create(tr.doc, [
              Decoration.widget(meta.pos, () => createReviewWidget(meta.pending), { side: 1, key: meta.key }),
            ]);
          }
          return old.map(tr.mapping, tr.doc);
        },
      },
      props: {
        decorations(state) {
          return reviewPluginKey.getState(state) || DecorationSet.empty;
        },
      },
    });

    const editorState = EditorState.create({
      schema: paperSchema,
      doc,
      plugins: [
        history(),
        reviewPlugin,
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Mod-Shift-z': redo,
          'Mod-s': () => {
            if (saveTimer) {
              clearTimeout(saveTimer);
              saveTimer = null;
            }
            if (persistNow()) {
              createDocSnapshot(`整稿保存 · ${currentTimestampLabel()}`);
              toast('已保存', 'ok', 1200);
            }
            return true;
          },
        }),
        keymap(baseKeymap),
      ],
    });

    function refreshCitationNumbers() {
      if (!viewState.view) return;
      const map = buildCitationNumberMap(viewState.view.state.doc);
      el.querySelectorAll('.pm-editor .pm-citation').forEach(dom => {
        const id = dom.getAttribute('data-citation-id');
        if (id) dom.textContent = `[${map.get(id) || '?'}]`;
      });
    }

    viewState.view = new EditorView(el.querySelector('#wb-editor'), {
      state: editorState,
      nodeViews: {
        citation: citationViewFactory(getCitationNumber),
        footnote: footnoteViewFactory(getFootnoteNumber, payload => openAssetModal('footnote', payload)),
        formula_block: formulaViewFactory(payload => openAssetModal('formula', payload)),
        figure: figureViewFactory(payload => openAssetModal('image', payload)),
        table_block: tableViewFactory(payload => openAssetModal('table', payload)),
      },
      dispatchTransaction(tr) {
        const nextState = viewState.view.state.apply(tr);
        viewState.view.updateState(nextState);
        refreshCitationNumbers();
        syncCurrentChapter();
        if (tr.docChanged) {
          if (saveTimer) clearTimeout(saveTimer);
          setSaveStatus('saving');
          saveProjectId = getProject().id; // 记录保存目标项目，防止防抖窗口内切项目把旧文档写进新项目
          saveTimer = setTimeout(persistNow, 500);
        }
      },
    });

    syncCurrentChapter();
    refreshCitationNumbers();
    renderOutline();
    renderCitationPicker();
    renderEvidencePanel();
    renderTodosPanel();
    renderChapterCard();
    renderVersionsPanel();
    renderSuggestionBox(suggestionBox, viewState);
    syncOutlineCollapse();
    setSaveStatus('idle', '已载入');
    alignInitialChapter();
    persistNow();
    switchRightTab(panelState.activeRightTab);

    sideSelect?.addEventListener('change', () => switchRightTab(sideSelect.value));
    el.querySelector('#wb-topic')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'project-settings' }));
    });
    el.querySelector('#wb-save-version')?.addEventListener('click', () => {
      const v = createDocSnapshot(`整稿保存 · ${currentTimestampLabel()}`);
      toast(v ? '已保存整稿版本' : '内容未变化，未重复保存', 'ok', 1800);
      switchRightTab('versions');
    });
    el.querySelector('#wb-format')?.addEventListener('click', formatWholeDocument);
    el.querySelector('#wb-clean-citations')?.addEventListener('click', tidyCitationLibrary);
    el.querySelector('#wb-insert-formula')?.addEventListener('click', () => openAssetModal('formula'));
    el.querySelector('#wb-insert-note')?.addEventListener('click', () => openAssetModal('footnote'));
    el.querySelector('#wb-insert-image')?.addEventListener('click', () => openAssetModal('image'));
    el.querySelector('#wb-insert-table')?.addEventListener('click', () => openAssetModal('table'));
    el.querySelector('#wb-insert-citation')?.addEventListener('click', () => {
      switchRightTab('citation');
      citationBox.querySelector('#wb-cit-select')?.focus();
    });
    const closeToolbarMenus = (except = null) => {
      el.querySelectorAll('.wb-toolbar-more[open]').forEach(menu => {
        if (menu !== except) menu.open = false;
      });
    };
    el.querySelectorAll('.wb-toolbar-more').forEach(menu => {
      menu.addEventListener('toggle', () => {
        if (menu.open) closeToolbarMenus(menu);
      });
    });
    el.addEventListener('click', evt => {
      if (!evt.target.closest('.wb-toolbar-more')) closeToolbarMenus();
    });
    el.querySelector('#wb-asset-close-top')?.addEventListener('click', closeAssetModal);
    assetModal?.addEventListener('click', evt => {
      if (evt.target === assetModal) closeAssetModal();
    });
    el.addEventListener('keydown', evt => {
      if (evt.key !== 'Escape') return;
      if (assetModal && !assetModal.hidden) closeAssetModal();
      else if (logicModal && !logicModal.hidden) dismissLogicReview();
      else closeToolbarMenus();
    });
    imageInput?.addEventListener('change', async () => {
      const file = imageInput.files?.[0];
      if (!file) return;
      try {
        const meta = await readImageMeta(file);
        assetDraft = { ...(assetDraft || {}), src: meta.dataUrl, width: meta.width, height: meta.height };
        const preview = assetForm.querySelector('#wb-image-preview');
        if (preview) preview.innerHTML = `<img src="${meta.dataUrl}" alt="${escapeHtml(file.name)}">`;
      } catch (error) {
        toast(error.message, 'err', 3200);
      }
    });

    outlineToggle?.addEventListener('click', () => {
      panelState.outlineCollapsed = !panelState.outlineCollapsed;
      syncOutlineCollapse();
    });
    const expandOutline = () => {
      panelState.outlineCollapsed = false;
      syncOutlineCollapse();
    };
    outlinePeek?.addEventListener('click', (evt) => {
      if (evt.target === outlineRailTrigger) return;
      expandOutline();
    });
    outlinePeek?.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        expandOutline();
      }
    });
    outlineRailTrigger?.addEventListener('click', (evt) => {
      evt.stopPropagation();
      expandOutline();
    });

    async function runSuggestion(action, sourceText, replaceFrom, replaceTo, sourceLabel) {
      const button = el.querySelector(`[data-ai="${action.id}"]`);
      setLoading(button, true, '生成中…');
      try {
        const reply = await chat([
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: action.prompt(sourceText) },
        ], { temperature: action.id === 'logic' ? 0.2 : 0.6, signal: writingSignal() });
        viewState.pending = {
          actionId: action.id,
          label: action.label,
          original: sourceText,
          suggestion: cleanAiText(reply),
          replaceFrom,
          replaceTo,
          sourceLabel,
          target: currentWritingTarget(viewState.view),
        };
        viewState.rerun = () => runSuggestion(action, sourceText, replaceFrom, replaceTo, sourceLabel);
        renderSuggestionBox(suggestionBox, viewState);
        if (action.id === 'logic') {
          renderLogicModal(viewState.pending);
        } else {
          showReviewWidget(viewState.pending);
        }
      } catch (e) {
        if (e?.code !== 'aborted') toast(e.message, 'err', 3600);
      } finally {
        setLoading(button, false);
      }
    }

    async function runDraftGeneration(existingTarget = null) {
      const target = existingTarget || currentWritingTarget(viewState.view);
      if (!target) {
        toast('请先把光标放到摘要、关键词或某个章节正文里', 'err');
        return;
      }
      const currentText = viewState.view.state.doc.textBetween(target.bodyFrom, target.bodyTo, '\n').trim();
      const btn = el.querySelector('#wb-draft');
      const title = meaningfulTitle(getProject().title) || '（未定题）';
      const allSubs = target.kind === 'chapter' ? subsectionsForSection(viewState.view.state.doc, target) : [];
      const subTitles = allSubs.map(item => item.title).filter(Boolean);
      const hasSubs = target.kind === 'chapter' && allSubs.length > 0;
            // 分小节时用宽检索（题目+章节）提供共享引用池，避免过多小节标题让检索过于具体；无小节才带小节标题
      const searchQuery = [title, target.label, ...(hasSubs ? [] : subTitles.slice(0, 3))].filter(Boolean).join(' ');
      const chapterPrompt = (sub = null) => {
        if (sub) {
          const subBody = viewState.view.state.doc.textBetween(sub.bodyFrom, sub.bodyTo, '\n').trim();
          return `请为论文《${title}》的章节「${target.chapter}」下的小节「${sub.title}」撰写 300-600 字中文内容，紧扣该小节主题与分论点展开。需要自然引用下方文献，至少使用 1 条引用，引用必须使用 [[CIT:id]] 标记，不要使用 [1] 这类普通文本编号。只输出正文，不要输出小节标题，不要使用 Markdown。\n\n该小节当前已有内容：\n${subBody || '暂无'}`;
        }
        return `请为论文《${title}》的章节「${target.chapter}」撰写 1000-1500 字中文初稿。${subTitles.length ? `编辑器里已经有这些小节标题：${subTitles.join('；')}。请按这些小节的顺序展开正文，但不要重复输出章节标题或小节标题。` : '请按章节主题自行组织清晰段落。'}需要自然引用下方文献，至少使用 2 条引用，引用必须使用 [[CIT:id]] 标记，不要使用 [1] 这类普通文本编号。只输出正文，不要输出客套说明，不要使用 Markdown 标题。\n\n当前已有内容：\n${currentText || '暂无'}`;
      };
      const userPrompt = (() => {
        if (target.kind === 'abstract') {
          return `请为论文《${title}》生成一版中文摘要，300-500 字，覆盖研究背景、目的、方法、主要发现和结论。需要自然引入下方文献中的 1-2 条作为支撑，引用必须使用提供的 [[CIT:id]] 标记。只输出摘要正文，不要输出“摘要”标题，不要使用 Markdown。`;
        }
        if (target.kind === 'keywords') {
          return `请为论文《${title}》生成 3-5 个中文关键词，用中文分号分隔。只输出关键词，不要解释。\n\n已有关键词：\n${currentText || '暂无'}`;
        }
        return chapterPrompt(null);
      })();
      setLoading(btn, true, target.kind === 'keywords' ? '生成中…' : '检索文献…');
      let streamRange = null;
      let streamed = '';
      try {
        let draftCitations = [];
        let addedCount = 0;
        if (target.kind !== 'keywords') {
          const found = await searchLiterature(searchQuery, 5, writingSignal());
          const list = ensureCitationIds(getCitations()).list;
          let nextNo = nextLitNo(list) - 1;
          const added = [];
          const selected = [];
          found.slice(0, 5).forEach(item => {
            const normalized = normalizeCitationEntry({
              ...item,
              id: item.id || crypto.randomUUID?.() || `cit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            }, getProject().referenceStandard);
            if (!normalized.title && !normalized.doi) return;
            // 按 DOI 或题名去重，避免同一文献重复入库
            const existing = list.find(c => c && (
              (normalized.doi && String(c.doi || '').trim().toLowerCase() === normalized.doi.trim().toLowerCase()) ||
              (normalized.title && String(c.title || '').trim().toLowerCase() === normalized.title.trim().toLowerCase())
            ));
            if (existing) { selected.push(existing); return; }
            normalized.litNo = ++nextNo;
            list.unshift(normalized);
            added.push(normalized);
            selected.push(normalized);
          });
          addedCount = added.length;
          saveCitations(list);
          citations = list;
          draftCitations = [...selected, ...list.slice(0, 3)]
            .filter((item, index, arr) => arr.findIndex(x => x.id === item.id) === index)
            .slice(0, 5);
          renderCitationPicker();
          if (!draftCitations.length) {
            toast('没有检索到可用文献，本次未生成草稿。请换一个更具体的题目或先到文献页补充文献。', 'err', 4200);
            return;
          }
          setLoading(btn, true, '生成草稿…');
        }
        const referencesBlock = draftCitations.length
          ? `\n\n可引用文献：\n${draftCitations.map(citationBrief).join('\n\n')}`
          : '';
        // 分小节生成：章节已有小节标题（分论点）时，逐个小节生成并插入到该小节标题下方
        const streamInto = async (range, prompt) => {
          replaceDraftStream(viewState.view, range, '', draftCitations);
          let got = '';
          const reply = await streamChat([
            { role: 'system', content: systemPrompt() },
            { role: 'user', content: `${prompt}${referencesBlock}` },
          ], {
            temperature: target.kind === 'keywords' ? 0.35 : 0.68,
            signal: writingSignal(),
            onDelta: delta => {
              got += delta;
              replaceDraftStream(viewState.view, range, got, draftCitations);
            },
          });
          const suggestion = normalizeDraftCitationMarkers(cleanAiText(reply), draftCitations);
          replaceDraftStream(viewState.view, range, suggestion, draftCitations);
          return suggestion;
        };
        if (hasSubs) {
          // 以小节为单位、正向逐个生成并插入；每次插入后重取该章节的小节当前位置，避免 ProseMirror 文档后移导致后续小节 bodyFrom 过期
          const chapterName = target.chapter;
          const count = allSubs.length;
          for (let i = 0; i < count; i++) {
            const sec = topLevelSections(viewState.view.state.doc).find(s => s.chapter === chapterName) || target;
            const curSubs = subsectionsForSection(viewState.view.state.doc, sec);
            const sub = curSubs[i];
            if (!sub) break;
            const subRange = { from: sub.bodyFrom, to: sub.bodyFrom, target, subsections: [sub.title], sub };
            streamRange = subRange;
            await streamInto(subRange, chapterPrompt(sub));
          }
        } else {
          streamRange = { from: target.bodyTo, to: target.bodyTo, target, subsections: [] };
          await streamInto(streamRange, userPrompt);
        }
        streamRange = null; // 生成完毕，避免异常时误删已成功生成的正文
        saveCitations(citations);
        if (target.kind === 'chapter' && target.chapter && (getProject().chapterProgress?.[target.chapter] || '未开始') === '未开始') {
          setChapterProgress(target.chapter, '进行中');
        }
        persistNow();
        viewState.view.focus();
        refreshCitationNumbers();
        renderCitationPicker();
        renderEvidencePanel();
        renderChapterCard();
        toast(target.kind === 'keywords' ? '关键词已插入当前部分' : `已新增 ${addedCount} 条文献，草稿已带引用插入正文`, 'ok', 3200);
      } catch (e) {
        if (streamRange && !streamed) {
          viewState.view.dispatch(viewState.view.state.tr.delete(streamRange.from, streamRange.to));
        }
        if (e?.code !== 'aborted') toast(e.message || '生成失败，请稍后重试', 'err', 3600);
      } finally {
        setLoading(btn, false);
      }
    }

    el.querySelectorAll('[data-ai]').forEach(btn => btn.addEventListener('click', () => {
      const action = AI_ACTIONS.find(item => item.id === btn.dataset.ai);
      if (!action) return;
      const text = selectionText(viewState.view);
      if (action.mode === 'selection' && selectionHitsHeading(viewState.view)) {
        toast('选中内容包含题名/章节标题。标题会同步回写项目结构，请不要对标题做 AI 改写', 'err', 3600);
        return;
      }
      if (action.mode === 'selection' && !text) {
        toast('请先在编辑器中选中要处理的文字', 'err');
        return;
      }
      if (action.mode === 'cursor' && !currentSectionText(viewState.view)) {
        toast('当前章节还没有内容，先写一些再续写', 'err');
        return;
      }
      if (action.mode === 'review') {
        const reviewText = currentSectionText(viewState.view) || text;
        if (!reviewText) {
          toast('请先选中文本，或把光标放在已有内容的章节里', 'err');
          return;
        }
        runSuggestion(action, reviewText, viewState.view.state.selection.from, viewState.view.state.selection.to, 'review');
        return;
      }
      const from = viewState.view.state.selection.from;
      const to = viewState.view.state.selection.to;
      const content = action.mode === 'cursor'
        ? (text || viewState.view.state.doc.textBetween(Math.max(0, from - 300), from, '\n'))
        : text;
      const writeFrom = action.mode === 'cursor' ? to : from;
      runSuggestion(action, content, writeFrom, to, action.id);
    }));

    el.querySelector('#wb-draft').addEventListener('click', () => runDraftGeneration());

    el.querySelector('#wb-done').addEventListener('click', () => {
      if (!viewState.currentChapter) {
        toast('请先进入某个章节', 'err');
        return;
      }
      setChapterProgress(viewState.currentChapter, '已完成');
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      createChapterSnapshot(section, `章节完成 · ${currentTimestampLabel()}`);
      createDocSnapshot(`阶段完成 · ${viewState.currentChapter}`);
      toast(`「${viewState.currentChapter}」已标记完成`, 'ok');
      renderOutline();
      renderVersionsPanel();
    });

    el.querySelector('#wb-undo').addEventListener('click', () => {
      undo(viewState.view.state, viewState.view.dispatch);
      viewState.view.focus();
    });
    el.querySelector('#wb-redo').addEventListener('click', () => {
      redo(viewState.view.state, viewState.view.dispatch);
      viewState.view.focus();
    });

    el.querySelector('#wb-copy').addEventListener('click', () => {
      copyText(fullTextFromDoc(viewState.view.state.doc, citationMap(citations)));
    });

    el.querySelector('#wb-download').addEventListener('click', () => {
      const text = fullTextFromDoc(viewState.view.state.doc, citationMap(citations));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      a.download = `${(meaningfulTitle(getProject().title) || '论文全文').replace(/[\\/:*?"<>|]/g, '_')}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast('Markdown 已下载', 'ok');
    });

    el.querySelector('#wb-preview').addEventListener('click', () => {
      openPrintPreview(viewState.view.state.doc, citations);
    });
    el.querySelector('#wb-export-check')?.addEventListener('click', () => {
      const project = getProject();
      const citations = ensureCitationIds(getCitations()).list;
      // 与导出同源：用编辑器实时 doc，而非已保存的 documentV2（防抖/流式未存内容也能被检查到）
      const doc = viewState.view.state.doc;
      const issues = collectExportIssues(project, doc, citations);
      const cnt = g => issues.filter(i => i.group === g).length;
      const existing = document.getElementById('wb-export-check-modal');
      if (existing) existing.remove();
      const modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.id = 'wb-export-check-modal';
      modal.innerHTML = `
        <div class="modal-panel">
          <div class="hero-top modal-head"><div>
            <h2>导出前检查</h2>
            <p class="desc">导出前先看有无影响质量的问题（结构 / 逻辑 / 引用 / 格式）。</p>
          </div><button class="btn btn-ghost btn-sm" data-ec-close aria-label="关闭">✕</button></div>
          <div class="hero-stats">
            <div class="stat"><span class="stat-num">${cnt('结构检查')}</span><span class="stat-label">结构</span></div>
            <div class="stat"><span class="stat-num">${cnt('逻辑检查')}</span><span class="stat-label">逻辑</span></div>
            <div class="stat"><span class="stat-num">${cnt('引用检查')}</span><span class="stat-label">引用</span></div>
            <div class="stat"><span class="stat-num">${cnt('格式检查')}</span><span class="stat-label">格式</span></div>
          </div>
          <div class="item-list" style="max-height:260px;overflow:auto;margin-top:12px">
            ${issues.length ? issues.map((i, idx) => exportIssueHtml(i, idx)).join('') : '<div class="result-box filled">当前没有明显问题，可以放心导出。</div>'}
          </div>
          <div class="result-actions" style="margin-top:14px"><button class="btn" data-ec-close>知道了</button></div>
        </div>`;
      document.body.appendChild(modal);
      const onEcKey = e => { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', onEcKey); } };
      document.addEventListener('keydown', onEcKey);
      modal.querySelectorAll('[data-ec-close]').forEach(b => b.addEventListener('click', () => { modal.remove(); document.removeEventListener('keydown', onEcKey); }));
      modal.addEventListener('click', e => { if (e.target === modal) { modal.remove(); document.removeEventListener('keydown', onEcKey); } });
      // P1-5：问题条目跳转（去对应章节 / 文献库 / 研究设计 / 计划）
      modal.querySelectorAll('[data-issue-go]').forEach(btn => btn.addEventListener('click', () => {
        const item = issues[Number(btn.dataset.issueGo)];
        if (!item) return;
        if (item.chapter) setCurrentChapter(item.chapter);
        modal.remove(); document.removeEventListener('keydown', onEcKey);
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: item.nav || 'writing' }));
      }));
    });
    el.querySelector('#wb-export-word')?.addEventListener('click', () => {
      exportTemplateWord(viewState.view.state.doc, citations);
      toast('已导出 Word 模板文档', 'ok');
    });
    el.querySelector('#wb-export-pdf')?.addEventListener('click', () => {
      openPrintPreview(viewState.view.state.doc, citations, { autoPrint: true });
      toast('已打开 PDF 导出窗口，请选择“另存为 PDF”', 'ok', 3600);
    });
  },
};
