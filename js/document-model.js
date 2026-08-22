import { Schema, Fragment } from 'prosemirror-model';
import { addListNodes } from 'prosemirror-schema-list';

function makeSectionId() {
  return globalThis.crypto?.randomUUID?.() || `sec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const baseNodes = {
  doc: { content: 'block+' },
  text: { group: 'inline' },
  paragraph: {
    group: 'block',
    content: 'inline*',
    parseDOM: [{ tag: 'p' }],
    toDOM() { return ['p', 0]; },
  },
  blockquote: {
    group: 'block',
    content: 'block+',
    parseDOM: [{ tag: 'blockquote' }],
    toDOM() { return ['blockquote', 0]; },
  },
  heading: {
    group: 'block',
    content: 'inline*',
    attrs: { level: { default: 2 }, role: { default: 'section' }, sectionId: { default: '' } },
    parseDOM: [1, 2, 3].map(level => ({
      tag: `h${level}`,
      getAttrs: dom => ({
        level,
        role: dom.getAttribute('data-role') || (level === 1 ? 'title' : 'section'),
        sectionId: dom.getAttribute('data-section-id') || '',
      }),
    })),
    toDOM(node) {
      return [`h${node.attrs.level}`, {
        'data-role': node.attrs.role,
        'data-section-id': node.attrs.sectionId || '',
      }, 0];
    },
  },
  citation: {
    inline: true,
    atom: true,
    group: 'inline',
    selectable: true,
    attrs: { citationId: {} },
    parseDOM: [{
      tag: 'span[data-citation-id]',
      getAttrs: dom => ({ citationId: dom.getAttribute('data-citation-id') }),
    }],
    toDOM(node) {
      return ['span', { 'data-citation-id': node.attrs.citationId, class: 'pm-citation' }, '[?]'];
    },
  },
};

export const paperSchema = new Schema({
  nodes: addListNodes(new Schema({ nodes: baseNodes, marks: {} }).spec.nodes, 'paragraph block*', 'block'),
  marks: {},
});

function textNodes(schema, text) {
  const raw = String(text || '').trim();
  if (!raw) return [schema.nodes.paragraph.create()];
  return raw.split(/\n{2,}/).map(par => {
    const pieces = [];
    const regex = /\[\[CIT:([a-zA-Z0-9-]+)\]\]/g;
    let last = 0;
    let match;
    while ((match = regex.exec(par))) {
      const before = par.slice(last, match.index);
      if (before) pieces.push(schema.text(before));
      pieces.push(schema.nodes.citation.create({ citationId: match[1] }));
      last = match.index + match[0].length;
    }
    const tail = par.slice(last);
    if (tail) pieces.push(schema.text(tail));
    return schema.nodes.paragraph.create(null, pieces);
  });
}

export function createDocumentFromProject(project) {
  const blocks = [];
  const title = project.title || '未命名论文';
  const byLitNo = new Map((project.citations || []).map(item => [item.litNo, item.id]).filter(([, id]) => !!id));
  const normalizeLegacyRefs = text => String(text || '').replace(/\[(\d+)\]/g, (_, n) => {
    const id = byLitNo.get(Number(n));
    return id ? `[[CIT:${id}]]` : `[${n}]`;
  });
  blocks.push(paperSchema.nodes.heading.create({ level: 1, role: 'title', sectionId: 'title' }, paperSchema.text(title)));
  blocks.push(paperSchema.nodes.heading.create({ level: 2, role: 'abstract', sectionId: 'abstract' }, paperSchema.text('摘要')));
  blocks.push(...textNodes(paperSchema, normalizeLegacyRefs(project.abstract || '')));
  blocks.push(paperSchema.nodes.heading.create({ level: 2, role: 'keywords', sectionId: 'keywords' }, paperSchema.text('关键词')));
  blocks.push(...textNodes(paperSchema, normalizeLegacyRefs(project.keywords || '')));
  (project.outline || []).forEach((chapter, idx) => {
    const sectionId = chapter.sectionId || `chapter-${idx + 1}-${makeSectionId()}`;
    blocks.push(
      paperSchema.nodes.heading.create(
        { level: 2, role: 'section', sectionId },
        paperSchema.text(chapter.chapter)
      )
    );
    blocks.push(...textNodes(paperSchema, normalizeLegacyRefs(project.drafts?.[chapter.chapter]?.content || '')));
  });
  blocks.push(paperSchema.nodes.heading.create({ level: 2, role: 'references', sectionId: 'references' }, paperSchema.text('参考文献')));
  blocks.push(paperSchema.nodes.paragraph.create(null, paperSchema.text('引用编号将根据正文首次出现顺序自动生成。')));
  blocks.push(paperSchema.nodes.heading.create({ level: 2, role: 'ack', sectionId: 'ack' }, paperSchema.text('致谢')));
  blocks.push(...textNodes(paperSchema, normalizeLegacyRefs(project.acknowledgments || '')));
  return paperSchema.nodes.doc.create(null, Fragment.fromArray(blocks));
}

export function docFromJSON(project) {
  const raw = project.documentV2;
  if (raw?.type === 'doc') {
    try {
      return paperSchema.nodeFromJSON(raw);
    } catch {
      return createDocumentFromProject(project);
    }
  }
  return createDocumentFromProject(project);
}

function textWithCitations(node) {
  let out = '';
  node.forEach(child => {
    if (child.isText) out += child.text;
    else if (child.type.name === 'citation') out += `[[CIT:${child.attrs.citationId}]]`;
  });
  return out.trim();
}

export function buildCitationNumberMap(doc) {
  const map = new Map();
  let next = 1;
  doc.descendants(node => {
    if (node.type.name === 'citation') {
      const id = node.attrs.citationId;
      if (!map.has(id)) map.set(id, next++);
    }
  });
  return map;
}

export function extractProjectStateFromDoc(doc) {
  const outline = [];
  const chapterProgress = {};
  const drafts = {};
  let title = '';
  let abstract = '';
  let keywords = '';
  let acknowledgments = '';
  let currentRole = '';
  let currentSection = null;
  let buffer = [];

  function flush() {
    const text = buffer.join('\n\n').trim();
    if (currentRole === 'abstract') abstract = text;
    else if (currentRole === 'keywords') keywords = text;
    else if (currentRole === 'ack') acknowledgments = text;
    else if (currentRole === 'section' && currentSection) {
      drafts[currentSection.chapter] = { content: text, updatedAt: Date.now() };
      outline.push(currentSection);
      chapterProgress[currentSection.chapter] = chapterProgress[currentSection.chapter] || '未开始';
    }
    buffer = [];
  }

  doc.forEach(node => {
    if (node.type.name === 'heading') {
      flush();
      currentRole = node.attrs.role;
      if (currentRole === 'title') title = node.textContent.trim();
      if (currentRole === 'section') {
        currentSection = {
          chapter: node.textContent.trim(),
          sectionId: node.attrs.sectionId || makeSectionId(),
          sections: [],
        };
      } else {
        currentSection = null;
      }
      return;
    }
    if (node.type.name === 'paragraph' || node.type.name === 'blockquote' || node.type.name === 'ordered_list' || node.type.name === 'bullet_list') {
      if (currentRole === 'section' || currentRole === 'abstract' || currentRole === 'keywords' || currentRole === 'ack') {
        buffer.push(textWithCitations(node));
      }
    }
  });
  flush();

  return { title, abstract, keywords, acknowledgments, outline, drafts, chapterProgress };
}

export function replaceSelectionWithText(view, text) {
  const { state } = view;
  const tr = state.tr.insertText(text, state.selection.from, state.selection.to);
  view.dispatch(tr.scrollIntoView());
}

export function insertCitationNode(view, citationId) {
  const { state } = view;
  const node = paperSchema.nodes.citation.create({ citationId });
  view.dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
}

export function collectCitationUsage(doc) {
  const order = buildCitationNumberMap(doc);
  const usage = new Map();
  doc.descendants((node, pos) => {
    if (node.type.name === 'citation') {
      const id = node.attrs.citationId;
      const row = usage.get(id) || { count: 0, positions: [], number: order.get(id) || null };
      row.count += 1;
      row.positions.push(pos);
      usage.set(id, row);
    }
  });
  return usage;
}

export function fullTextFromDoc(doc, citationsById) {
  const state = extractProjectStateFromDoc(doc);
  const numberMap = buildCitationNumberMap(doc);
  const lines = [];
  if (state.title) lines.push(state.title, '');
  lines.push('摘要', state.abstract || '', '', '关键词', state.keywords || '');
  state.outline.forEach(section => {
    const raw = state.drafts[section.chapter]?.content || '';
    const rendered = raw.replace(/\[\[CIT:([a-zA-Z0-9-]+)\]\]/g, (_, id) => `[${numberMap.get(id) || '?'}]`);
    lines.push('', section.chapter, rendered);
  });
  const refs = [...numberMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id, n]) => {
      const item = citationsById.get(id);
      return item ? `[${n}] ${item.formatted || item.title}` : `[${n}] （缺失文献）`;
    });
  lines.push('', '参考文献', refs.join('\n') || '（暂无引用）', '', '致谢', state.acknowledgments || '');
  return lines.join('\n');
}
