import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { toast, integrityNote, escapeHtml, setLoading, copyText } from '../ui.js';
import { chat } from '../api.js';
import { getProject, saveProject, setCurrentChapter, setChapterProgress, getCitations, saveCitations, getEvidence } from '../project.js';
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
  replaceSelectionWithText,
  collectCitationUsage,
  fullTextFromDoc,
} from '../document-model.js';
import { ensureCitationIds, citationMap } from '../citation-utils.js';

const SYSTEM = '你是一位资深论文写作导师，帮助中国高校学生完成论文写作。遵守学术诚信：不代替用户完成整篇论文，只提供局部改写、结构建议和章节草稿辅助。回答直接给出结果，不要客套话和多余解释。';

const AI_ACTIONS = [
  { id: 'academic', label: '学术润色', prompt: t => `请把下面这段话改写成更规范、更克制的学术表达，只输出改写后的文字。\n\n${t}`, mode: 'selection' },
  { id: 'argument', label: '补充论证', prompt: t => `请在不改变原意的前提下，为下面这段内容补充论证和分析层次，只输出修改后的文字。\n\n${t}`, mode: 'selection' },
  { id: 'reframe', label: '重构表达', prompt: t => `请保留原意，重构下面这段文字的表达方式，使其更清晰、更有层次，只输出改写后的文字。\n\n${t}`, mode: 'selection' },
  { id: 'continue', label: '基于上下文续写', prompt: t => `请基于下面这段论文上下文续写 250-400 字，保持论题和风格一致，只输出续写内容。\n\n${t}`, mode: 'cursor' },
  { id: 'logic', label: '本章逻辑检查', prompt: t => `请从导师视角检查下面这段章节内容的逻辑结构，指出论证跳跃、只有描述没有分析、缺少证据支持的位置。请用简短分点输出。 \n\n${t}`, mode: 'review' },
];

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

function sectionMetaFromProject(project) {
  return (project.outline || []).map((item, index) => ({
    chapter: item.chapter,
    sectionId: item.sectionId || `chapter-${index + 1}`,
  }));
}

function topLevelSections(doc) {
  const sections = [];
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading' && node.attrs.role === 'section') {
      sections.push({
        chapter: node.textContent.trim(),
        sectionId: node.attrs.sectionId,
        headingFrom: offset + 1,
        bodyFrom: offset + node.nodeSize,
      });
    }
  });
  sections.forEach((item, idx) => {
    item.bodyTo = idx + 1 < sections.length ? sections[idx + 1].headingFrom - 1 : doc.content.size;
  });
  return sections;
}

function sectionForPos(doc, pos) {
  return topLevelSections(doc).find(sec => pos >= sec.headingFrom && pos <= sec.bodyTo) || null;
}

function serializeProjectDoc(doc, currentChapter, project) {
  const extracted = extractProjectStateFromDoc(doc);
  const oldProgress = project.chapterProgress || {};
  const oldOutline = sectionMetaFromProject(project);
  const progress = {};
  extracted.outline.forEach((item, index) => {
    const old = oldOutline.find(x => x.sectionId === item.sectionId) || oldOutline.find(x => x.chapter === item.chapter);
    progress[item.chapter] = old ? (oldProgress[old.chapter] || '未开始') : '未开始';
    extracted.outline[index] = { ...item, sections: [] };
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

function buildPreviewHtml(doc, citations) {
  const blocks = buildRenderableBlocks(doc, citationMap(citations));
  return blocks.map(block => {
    if (block.type === 'title') return `<h1 class="title">${escapeHtml(block.text)}</h1>`;
    if (block.type === 'heading') return `<h2 class="sec">${escapeHtml(block.text)}</h2>`;
    if (block.type === 'paragraph') return `<p>${escapeHtml(block.text)}</p>`;
    if (block.type === 'blockquote') return `<blockquote>${escapeHtml(block.text)}</blockquote>`;
    if (block.type === 'reference') return `<p class="ref">${escapeHtml(block.text)}</p>`;
    if (block.type === 'notes_heading') return `<h2 class="sec">${escapeHtml(block.text)}</h2>`;
    if (block.type === 'note') return `<p class="ref pp-note-row">[注${block.number}] ${escapeHtml(block.text)}</p>`;
    if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag}>${block.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
    }
    if (block.type === 'formula') {
      return `<figure class="pp-formula">
        <div class="pp-formula-body">${escapeHtml(block.latex || '')}</div>
        <figcaption>式${block.number}　${escapeHtml(block.label || '未命名公式')}</figcaption>
        ${block.note ? `<p class="pp-note">说明：${escapeHtml(block.note)}</p>` : ''}
      </figure>`;
    }
    if (block.type === 'figure') {
      const caption = block.caption || block.alt || '未命名图片';
      return `<figure class="pp-figure">
        <img src="${block.src}" alt="${escapeHtml(block.alt || caption)}">
        <figcaption>图${block.number}　${escapeHtml(caption)}</figcaption>
        ${block.note ? `<p class="pp-note">说明：${escapeHtml(block.note)}</p>` : ''}
      </figure>`;
    }
    if (block.type === 'table') {
      const head = block.rows[0] || [];
      const body = block.rows.slice(1);
      return `<figure class="pp-table-wrap">
        <table class="pp-table">
          ${head.length ? `<thead><tr>${head.map(cell => `<th>${escapeHtml(cell || '—')}</th>`).join('')}</tr></thead>` : ''}
          <tbody>${body.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell || '')}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
        <figcaption>表${block.number}　${escapeHtml(block.caption || '未命名表格')}</figcaption>
        ${block.note ? `<p class="pp-note">说明：${escapeHtml(block.note)}</p>` : ''}
      </figure>`;
    }
    return '';
  }).join('');
}

function openPrintPreview(doc, citations) {
  const html = buildPreviewHtml(doc, citations);
  const win = window.open('', '_blank');
  if (!win) {
    toast('浏览器拦截了新窗口，请允许弹窗后重试', 'err');
    return;
  }
  win.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>论文排版预览</title>
  <style>
    body { max-width: 760px; margin: 44px auto; padding: 0 26px 60px; font-family: "Songti SC", STSong, SimSun, serif; line-height: 1.95; color: #26303B; background: #F6F5F1; }
    .title { text-align: center; font-size: 22px; margin: 0 0 20px; }
    .sec { font-size: 17px; margin: 28px 0 10px; border-bottom: 1px solid #E4E1D8; padding-bottom: 6px; }
    .sec::before { content: ''; display: inline-block; width: 8px; height: 8px; background: #C03B2D; margin-right: 9px; }
    p { text-indent: 2em; margin: 6px 0; font-size: 15px; }
    p.ref { text-indent: -2em; padding-left: 2em; font-size: 12.5px; line-height: 1.8; color: #4A5560; }
    .pp-note-row { text-indent: 0; padding-left: 0; }
    blockquote { margin: 12px 0; padding: 8px 16px; border-left: 3px solid #C03B2D; background: #FBF7F0; }
    ul, ol { margin: 10px 0 14px 32px; }
    .pp-formula { margin: 18px 0; }
    .pp-formula-body { padding: 14px 16px; border: 1px solid #DDD7CA; background: #FCFBF8; font-family: "SFMono-Regular", Menlo, Consolas, monospace; text-align: center; white-space: pre-wrap; }
    .pp-formula figcaption { margin-top: 8px; text-align: center; font-size: 13px; color: #4A5560; }
    .pp-figure, .pp-table-wrap { margin: 18px 0; }
    .pp-figure img { max-width: 100%; display: block; margin: 0 auto; border: 1px solid #DDD7CA; }
    .pp-figure figcaption, .pp-table-wrap figcaption { margin-top: 8px; text-align: center; font-size: 13px; color: #4A5560; }
    .pp-note { margin: 6px 0 0; text-indent: 0; font-size: 13px; color: #5A6570; }
    .pp-table { width: 100%; border-collapse: collapse; font-size: 14px; background: #fff; }
    .pp-table th, .pp-table td { border: 1px solid #CFC9BB; padding: 8px 10px; text-align: left; vertical-align: top; }
    .pp-table th { background: #F5F1EA; }
    .tip { position: fixed; top: 14px; right: 16px; background: #2F4F66; color: #fff; padding: 8px 14px; border-radius: 5px; font-size: 13px; }
    @media print { .tip { display:none; } body { background:#fff; margin: 0; } }
  </style></head><body><div class="tip">Ctrl/Cmd+P 打印或另存 PDF</div>${html}</body></html>`);
  win.document.close();
}

function citationViewFactory(getLabel) {
  return () => ({
    dom: document.createElement('span'),
    update(node) {
      this.dom.className = 'pm-citation';
      this.dom.setAttribute('data-citation-id', node.attrs.citationId);
      this.dom.textContent = `[${getLabel(node.attrs.citationId)}]`;
      return true;
    },
  });
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
    const sync = () => {
      dom.className = 'pm-figure-card';
      img.src = node.attrs.src || '';
      img.alt = node.attrs.alt || node.attrs.caption || '图片';
      caption.textContent = node.attrs.caption || node.attrs.alt || '未命名图片';
      caption.title = node.attrs.note || '';
      editBtn.textContent = '编辑图片';
      editBtn.type = 'button';
      editBtn.className = 'pm-asset-edit';
      toolbar.className = 'pm-asset-toolbar';
    };
    editBtn.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      openEditor({ ...node.attrs, pos: getPos() });
    });
    toolbar.appendChild(editBtn);
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

function renderSuggestionBox(box, state) {
  if (!state.pending) {
    box.innerHTML = `
      <h3><span class="mark"></span>AI 写作助手</h3>
      <p class="desc">选中文字后再触发 AI。生成结果会先作为建议展示在这里，只有点击「接受」才会写回正文。</p>
      ${integrityNote()}`;
    return;
  }
  const item = state.pending;
  box.innerHTML = `
    <h3><span class="mark"></span>${escapeHtml(item.label)}</h3>
    <p class="desc">AI 建议默认不直接改正文，你可以比较后决定是否接受。</p>
    <label class="field-label">原文</label>
    <div class="result-box">${escapeHtml(item.original || '（无原文，基于上下文生成）')}</div>
    <label class="field-label">AI 建议</label>
    <div class="result-box filled">${escapeHtml(item.suggestion)}</div>
    <div class="result-actions">
      <button class="btn" id="sg-accept">接受</button>
      <button class="btn btn-ghost" id="sg-reject">拒绝</button>
      <button class="btn btn-ai" id="sg-regenerate">重新生成</button>
    </div>
    ${integrityNote()}`;
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

function normalizeAcademicText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\t+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/ ([，。；：！？、）】》])/g, '$1')
    .replace(/([（【《]) /g, '$1')
    .replace(/“ /g, '“')
    .replace(/ ”/g, '”')
    .replace(/‘ /g, '‘')
    .replace(/ ’/g, '’')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
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

export default {
  id: 'writing',
  icon: '✍️',
  title: '论文写作',
  subtitle: '结构化写作、AI 写作助手、动态引用编号',
  projectScoped: true,

  render(el) {
    const project = getProject();
    const citations = normalizeCitations();
    const doc = docFromJSON({ ...project, citations });
    const viewState = { pending: null, rerun: null, view: null, currentChapter: project.currentChapter || project.outline?.[0]?.chapter || '' };
    const panelState = { outlineCollapsed: false, activeRightTab: 'assistant' };

    el.innerHTML = `
      <div class="card" style="padding:0;overflow:hidden">
        <div class="workbench">
          <aside class="wb-left">
            <div class="wb-left-expanded">
              <div class="wb-side-head">
                <div>
                  <h3><span class="mark"></span>论文目录</h3>
                  <p class="desc" id="wb-outline-desc">按章节快速跳转与切换</p>
                </div>
                <button class="btn btn-ghost btn-sm icon-only" id="wb-toggle-outline" title="收起目录" aria-label="收起目录">⇤</button>
              </div>
              <div class="chapter-list" id="wb-outline"></div>
            </div>
            <div class="wb-left-collapsed" id="wb-outline-peek" title="展开目录" aria-label="展开目录" role="button" tabindex="0">
              <button class="btn btn-ghost btn-sm icon-only wb-outline-rail-btn" type="button" id="wb-outline-rail-trigger" title="展开目录" aria-label="展开目录">⇥</button>
              <div class="wb-outline-rail-meta">
                <span class="wb-outline-rail-label">目录</span>
                <span class="wb-outline-rail-count" id="wb-outline-rail-count">0</span>
              </div>
              <div class="wb-outline-rail-dots" id="wb-outline-rail-dots"></div>
            </div>
          </aside>

          <section class="wb-center">
            <div class="wb-header">
              <div class="wb-current">
                <span class="cur-title" id="wb-cur-title">正在写：<b>${escapeHtml(viewState.currentChapter || '未选择章节')}</b></span>
                <span class="cur-note" id="wb-cur-note">自动保存</span>
              </div>
              <div class="wb-header-actions">
                <button class="btn btn-ghost btn-sm" id="wb-done">标记完成</button>
                <button class="btn btn-ghost btn-sm" id="wb-copy">复制全文</button>
                <details class="wb-toolbar-more">
                  <summary>工具</summary>
                  <div class="wb-toolbar-more-panel">
                    <button class="btn btn-ai btn-sm" data-ai="logic">逻辑检查</button>
                    <button class="btn btn-ghost btn-sm" id="wb-format">格式整理</button>
                    <button class="btn btn-ghost btn-sm" id="wb-insert-formula">插入公式</button>
                    <button class="btn btn-ghost btn-sm" id="wb-insert-note">插入注释</button>
                    <button class="btn btn-ghost btn-sm" id="wb-insert-image">插入图片</button>
                    <button class="btn btn-ghost btn-sm" id="wb-insert-table">插入表格</button>
                    <button class="btn btn-ghost btn-sm" id="wb-undo">↶ 撤销</button>
                    <button class="btn btn-ghost btn-sm" id="wb-redo">↷ 重做</button>
                    <button class="btn btn-ghost btn-sm" id="wb-download">下载 Markdown</button>
                    <button class="btn btn-ghost btn-sm" id="wb-preview">排版预览</button>
                  </div>
                </details>
              </div>
            </div>
            <div class="wb-toolbar wb-toolbar-primary">
              ${AI_ACTIONS.filter(item => item.id !== 'logic').map(item => `<button class="btn ${item.id === 'academic' ? 'btn-ai-solid' : 'btn-ai'} btn-sm" data-ai="${item.id}">${item.label}</button>`).join('')}
              <button class="btn btn-ghost btn-sm" id="wb-draft">生成本章草稿</button>
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
            <div class="wb-side-tabs">
              <button class="wb-side-tab active" type="button" data-side-tab="assistant">写作助手</button>
              <button class="wb-side-tab" type="button" data-side-tab="citation">引用</button>
              <button class="wb-side-tab" type="button" data-side-tab="evidence">证据</button>
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
                <p class="desc">优先看和当前章节直接相关的证据卡。</p>
              </div>
              <div id="wb-evidence"></div>
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
              <button class="btn btn-ghost btn-sm" type="button" id="wb-asset-close-top">关闭</button>
            </div>
            <div id="wb-asset-form"></div>
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
    const sideTabs = [...el.querySelectorAll('[data-side-tab]')];
    const sidePanes = [...el.querySelectorAll('[data-side-pane]')];
    const assetModal = el.querySelector('#wb-asset-modal');
    const assetForm = el.querySelector('#wb-asset-form');
    const assetTitle = el.querySelector('#wb-asset-title');
    const assetDesc = el.querySelector('#wb-asset-desc');
    const imageInput = el.querySelector('#wb-image-file');
    let saveTimer = null;
    let assetDraft = null;

    function closeAssetModal() {
      if (!assetModal) return;
      assetModal.hidden = true;
      document.body.style.overflow = '';
      assetDraft = null;
      if (imageInput) imageInput.value = '';
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
          <div class="citation-inline-actions" style="margin-top:16px">
            <button class="btn" type="button" id="wb-asset-save">保存图片</button>
            <button class="btn btn-ghost" type="button" id="wb-asset-cancel">取消</button>
          </div>`;
        assetForm.querySelector('#wb-image-choose')?.addEventListener('click', () => imageInput?.click());
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
          <div class="citation-inline-actions" style="margin-top:16px">
            <button class="btn" type="button" id="wb-table-add-row">增加一行</button>
            <button class="btn btn-ghost" type="button" id="wb-table-add-col">增加一列</button>
            <button class="btn btn-ghost" type="button" id="wb-table-remove-row">删除一行</button>
            <button class="btn btn-ghost" type="button" id="wb-table-remove-col">删除一列</button>
          </div>
          <div class="citation-inline-actions" style="margin-top:16px">
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
        assetDesc.textContent = '支持录入 LaTeX 或普通公式文本。排版预览和 DOCX 导出会按公式块处理。';
        assetForm.innerHTML = `
          <label class="field-label">公式标题</label>
          <input type="text" id="wb-formula-label" value="${escapeHtml(payload?.label || '')}" placeholder="例如：样本均值计算式">
          <label class="field-label">公式内容</label>
          <textarea id="wb-formula-latex" placeholder="例如：\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i">${escapeHtml(payload?.latex || '')}</textarea>
          <label class="field-label">公式说明（可选）</label>
          <textarea id="wb-formula-note" placeholder="例如：其中 x_i 表示第 i 个样本观测值。">${escapeHtml(payload?.note || '')}</textarea>
          <div class="citation-inline-actions" style="margin-top:16px">
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
          <div class="citation-inline-actions" style="margin-top:16px">
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
        outlineToggle.textContent = panelState.outlineCollapsed ? '⇥' : '⇤';
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
      const map = buildCitationNumberMap(viewState.view.state.doc);
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
            return `<button class="chapter-item ${active ? 'active' : ''}" data-section="${escapeHtml(sec.sectionId)}">
              <span class="name">${escapeHtml(sec.chapter)}</span>${chip}
            </button>`;
          }).join('')
        : '<p class="desc">先在研究设计里生成大纲，或者直接在编辑器中新增章节标题。</p>';
      outlineBox.querySelectorAll('[data-section]').forEach(btn => {
        btn.addEventListener('click', () => {
          const section = topLevelSections(viewState.view.state.doc).find(x => x.sectionId === btn.dataset.section);
          if (!section) return;
          viewState.view.dispatch(viewState.view.state.tr.setSelection(TextSelection.create(viewState.view.state.doc, section.headingFrom)).scrollIntoView());
          viewState.view.focus();
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
        <div style="display:flex;gap:6px">
          <select id="wb-cit-select" style="flex:1">
            ${pickerItems.map(item => {
              const currentNo = map.get(item.id);
              const info = usage.get(item.id);
              const suffix = currentNo ? ` · 当前 [${currentNo}] ×${info?.count || 1}` : ' · 未引用';
              return `<option value="${item.id}">${escapeHtml((item.title || item.formatted || '').slice(0, 30))}${suffix}</option>`;
            }).join('')}
          </select>
          <button class="btn btn-sm" id="wb-cit-insert">插入</button>
        </div>` : '<p class="desc">文献库还没有条目，先去「文献与格式」收集文献。</p>';
      citationBox.querySelector('#wb-cit-insert')?.addEventListener('click', () => {
        const id = citationBox.querySelector('#wb-cit-select').value;
        insertCitationNode(viewState.view, id);
        viewState.view.focus();
        toast(`已插入引用 [${getCitationNumber(id)}]`, 'ok');
      });
    }

    function renderEvidencePanel() {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      evidenceBox.innerHTML = relatedEvidenceHtml(section, citations);
    }

    function switchRightTab(tab) {
      panelState.activeRightTab = tab;
      sideTabs.forEach(btn => btn.classList.toggle('active', btn.dataset.sideTab === tab));
      sidePanes.forEach(pane => pane.classList.toggle('active', pane.dataset.sidePane === tab));
    }

    function jumpToSection(sectionId) {
      const section = topLevelSections(viewState.view.state.doc).find(x => x.sectionId === sectionId);
      if (!section) return;
      viewState.view.dispatch(viewState.view.state.tr.setSelection(TextSelection.create(viewState.view.state.doc, section.headingFrom)).scrollIntoView());
      viewState.view.focus();
    }

    function renderChapterCard() {
      const sections = topLevelSections(viewState.view.state.doc);
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from) || sections[0];
      if (!chapterCard) return;
      if (!section) {
        chapterCard.innerHTML = `
          <div class="wb-side-card-head">
            <h3><span class="mark"></span>当前章节</h3>
            <p class="desc">先选中一个章节再开始写。</p>
          </div>`;
        return;
      }
      const chapterText = viewState.view.state.doc.textBetween(section.bodyFrom, section.bodyTo, '\n').trim();
      const citationIds = new Set();
      viewState.view.state.doc.nodesBetween(section.bodyFrom, section.bodyTo, node => {
        if (node.type.name === 'citation') citationIds.add(node.attrs.citationId);
      });
      const status = getProject().chapterProgress?.[section.chapter] || '未开始';
      const evidenceItems = relatedEvidenceItems(section);
      const index = sections.findIndex(item => item.sectionId === section.sectionId);
      const prev = sections[index - 1];
      const next = sections[index + 1];
      chapterCard.innerHTML = `
        <div class="wb-side-card-head">
          <h3><span class="mark"></span>当前章节</h3>
          <p class="desc">先把这一章写顺，再切到下一章。</p>
        </div>
        <div class="wb-side-card-title">${escapeHtml(section.chapter)}</div>
        <div class="wb-side-card-chip ${status === '已完成' ? 'done' : status === '进行中' ? 'doing' : ''}">${escapeHtml(status)}</div>
        <div class="wb-side-metrics">
          <div class="wb-side-metric"><span>字数</span><b>${wordCount(chapterText)}</b></div>
          <div class="wb-side-metric"><span>引用</span><b>${citationIds.size}</b></div>
          <div class="wb-side-metric"><span>证据</span><b>${evidenceItems.length}</b></div>
        </div>
        <div class="wb-side-nav">
          <button class="btn btn-ghost btn-sm" type="button" data-jump-section="${prev?.sectionId || ''}" ${prev ? '' : 'disabled'}>上一章</button>
          <button class="btn btn-ghost btn-sm" type="button" data-jump-section="${next?.sectionId || ''}" ${next ? '' : 'disabled'}>下一章</button>
        </div>`;
      chapterCard.querySelectorAll('[data-jump-section]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!btn.dataset.jumpSection) return;
          jumpToSection(btn.dataset.jumpSection);
        });
      });
    }

    function syncCurrentChapter() {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      if (!section) return;
      viewState.currentChapter = section.chapter;
      setCurrentChapter(section.chapter);
      const title = el.querySelector('#wb-cur-title');
      if (title) title.innerHTML = `正在写：<b>${escapeHtml(section.chapter)}</b>`;
      const note = el.querySelector('#wb-cur-note');
      if (note) note.textContent = `${wordCount(viewState.view.state.doc.textBetween(section.bodyFrom, section.bodyTo, '\n'))} 字 · 自动保存`;
      renderEvidencePanel();
      renderChapterCard();
    }

    function persistNow() {
      try {
        const current = getProject();
        const next = serializeProjectDoc(viewState.view.state.doc, viewState.currentChapter, current);
        saveProject(next);
        countEl.textContent = `全文字数 ${wordCount(fullTextFromDoc(viewState.view.state.doc, citationMap(citations)))}`;
        setSaveStatus('saved', new Date().toLocaleTimeString('zh-CN'));
        renderOutline();
        renderCitationPicker();
        renderEvidencePanel();
        renderChapterCard();
        return true;
      } catch (error) {
        console.error('save writing project failed', error);
        setSaveStatus('error', '保存失败，请重试');
        toast(error?.message || '保存失败，请检查本地存储空间或浏览器权限', 'err', 3000);
        return false;
      }
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

    const editorState = EditorState.create({
      schema: paperSchema,
      doc,
      plugins: [
        history(),
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Mod-Shift-z': redo,
          'Mod-s': () => {
            if (saveTimer) {
              clearTimeout(saveTimer);
              saveTimer = null;
            }
            if (persistNow()) toast('已保存', 'ok', 1200);
            return true;
          },
        }),
      ],
    });

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
        syncCurrentChapter();
        if (saveTimer) clearTimeout(saveTimer);
        setSaveStatus('saving');
        saveTimer = setTimeout(persistNow, 500);
      },
    });

    syncCurrentChapter();
    renderOutline();
    renderCitationPicker();
    renderEvidencePanel();
    renderChapterCard();
    renderSuggestionBox(suggestionBox, viewState);
    syncOutlineCollapse();
    setSaveStatus('idle', '已载入');
    persistNow();
    switchRightTab(panelState.activeRightTab);

    sideTabs.forEach(btn => btn.addEventListener('click', () => switchRightTab(btn.dataset.sideTab)));
    el.querySelector('#wb-format')?.addEventListener('click', formatCurrentSection);
    el.querySelector('#wb-insert-formula')?.addEventListener('click', () => openAssetModal('formula'));
    el.querySelector('#wb-insert-note')?.addEventListener('click', () => openAssetModal('footnote'));
    el.querySelector('#wb-insert-image')?.addEventListener('click', () => openAssetModal('image'));
    el.querySelector('#wb-insert-table')?.addEventListener('click', () => openAssetModal('table'));
    el.querySelector('#wb-asset-close-top')?.addEventListener('click', closeAssetModal);
    assetModal?.addEventListener('click', evt => {
      if (evt.target === assetModal) closeAssetModal();
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
          { role: 'system', content: SYSTEM },
          { role: 'user', content: action.prompt(sourceText) },
        ], { temperature: action.id === 'logic' ? 0.2 : 0.6, signal: writingSignal() });
        viewState.pending = {
          actionId: action.id,
          label: action.label,
          original: sourceText,
          suggestion: reply.trim(),
          replaceFrom,
          replaceTo,
          sourceLabel,
        };
        viewState.rerun = () => runSuggestion(action, sourceText, replaceFrom, replaceTo, sourceLabel);
        renderSuggestionBox(suggestionBox, viewState);
        bindSuggestionActions();
        switchRightTab('assistant');
      } catch (e) {
        if (e?.code !== 'aborted') toast(e.message, 'err', 3600);
      } finally {
        setLoading(button, false);
      }
    }

    function bindSuggestionActions() {
      suggestionBox.querySelector('#sg-accept')?.addEventListener('click', () => {
        if (!viewState.pending) return;
        const { replaceFrom, replaceTo, suggestion, actionId } = viewState.pending;
        if (actionId === 'logic') {
          toast('检查结果保留为批注建议，不直接写回正文', 'ok');
          viewState.pending = null;
          renderSuggestionBox(suggestionBox, viewState);
          return;
        }
        viewState.view.dispatch(
          viewState.view.state.tr.insertText(suggestion, replaceFrom, replaceTo).scrollIntoView()
        );
        toast('AI 建议已接受并写回正文', 'ok');
        viewState.pending = null;
        renderSuggestionBox(suggestionBox, viewState);
      });
      suggestionBox.querySelector('#sg-reject')?.addEventListener('click', () => {
        viewState.pending = null;
        renderSuggestionBox(suggestionBox, viewState);
        toast('已拒绝本次建议，原文保持不变', 'ok', 1500);
      });
      suggestionBox.querySelector('#sg-regenerate')?.addEventListener('click', () => viewState.rerun?.());
    }

    el.querySelectorAll('[data-ai]').forEach(btn => btn.addEventListener('click', () => {
      const action = AI_ACTIONS.find(item => item.id === btn.dataset.ai);
      if (!action) return;
      const text = selectionText(viewState.view);
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
        ? viewState.view.state.doc.textBetween(Math.max(0, from - 300), from, '\n')
        : text;
      runSuggestion(action, content, from, to, action.id);
    }));

    el.querySelector('#wb-draft').addEventListener('click', async () => {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      if (!section) {
        toast('请先把光标放到某个章节里', 'err');
        return;
      }
      const currentText = viewState.view.state.doc.textBetween(section.bodyFrom, section.bodyTo, '\n').trim();
      if (currentText && !confirm(`「${section.chapter}」已有内容，接受草稿建议后会覆盖本章内容。继续生成吗？`)) return;
      const btn = el.querySelector('#wb-draft');
      setLoading(btn, true, '生成中…');
      try {
        const reply = await chat([
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `请为论文《${getProject().title || '（未定题）'}》的章节「${section.chapter}」撰写 1000-1500 字初稿。只输出正文。` },
        ], { temperature: 0.7, signal: writingSignal() });
        viewState.pending = {
          actionId: 'draft',
          label: `本章草稿建议 · ${section.chapter}`,
          original: currentText,
          suggestion: reply.trim(),
          replaceFrom: section.bodyFrom,
          replaceTo: section.bodyTo,
        };
        viewState.rerun = () => el.querySelector('#wb-draft').click();
        renderSuggestionBox(suggestionBox, viewState);
        bindSuggestionActions();
        switchRightTab('assistant');
      } catch (e) {
        if (e?.code !== 'aborted') toast(e.message, 'err', 3600);
      } finally {
        setLoading(btn, false);
      }
    });

    el.querySelector('#wb-done').addEventListener('click', () => {
      if (!viewState.currentChapter) {
        toast('请先进入某个章节', 'err');
        return;
      }
      setChapterProgress(viewState.currentChapter, '已完成');
      toast(`「${viewState.currentChapter}」已标记完成`, 'ok');
      renderOutline();
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
      a.download = `${(getProject().title || '论文全文').replace(/[\\/:*?"<>|]/g, '_')}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast('Markdown 已下载', 'ok');
    });

    el.querySelector('#wb-preview').addEventListener('click', () => {
      openPrintPreview(viewState.view.state.doc, citations);
    });
  },
};
