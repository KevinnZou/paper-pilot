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
  insertCitationNode,
  replaceSelectionWithText,
  collectCitationUsage,
  fullTextFromDoc,
} from '../document-model.js';
import { ensureCitationIds, citationMap } from '../citation-utils.js';

const SYSTEM = '你是一位资深论文写作导师，帮助中国高校学生完成论文写作。遵守学术诚信：不代替用户完成整篇论文，只提供局部改写、结构建议和章节草稿辅助。回答直接给出结果，不要客套话和多余解释。';

const AI_ACTIONS = [
  { id: 'academic', label: '学术表达', prompt: t => `请把下面这段话改写成更规范、更克制的学术表达，只输出改写后的文字。\n\n${t}`, mode: 'selection' },
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
  const text = fullTextFromDoc(doc, citationMap(citations));
  const lines = text.split('\n');
  const html = [];
  let mode = '';
  lines.forEach(line => {
    if (!line.trim()) return;
    if (line === '摘要' || line === '关键词' || line === '参考文献' || line === '致谢' || /^第/.test(line) || /^\d+\./.test(line)) {
      html.push(`<h2 class="sec">${escapeHtml(line)}</h2>`);
      mode = line === '参考文献' ? 'refs' : 'body';
      return;
    }
    if (!html.length) {
      html.push(`<h1 class="title">${escapeHtml(line)}</h1>`);
      return;
    }
    html.push(mode === 'refs' ? `<p class="ref">${escapeHtml(line)}</p>` : `<p>${escapeHtml(line)}</p>`);
  });
  return html.join('');
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

function renderSuggestionBox(box, state) {
  if (!state.pending) {
    box.innerHTML = `
      <h3><span class="mark"></span>AI Suggestion Mode</h3>
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

function normalizeCitations() {
  const current = getCitations();
  const { list, changed } = ensureCitationIds(current);
  if (changed) saveCitations(list);
  return list;
}

export default {
  id: 'writing',
  icon: '✍️',
  title: '论文写作',
  subtitle: '结构化编辑器、AI Suggestion Mode、动态引用编号',
  projectScoped: true,

  render(el) {
    const project = getProject();
    const citations = normalizeCitations();
    const doc = docFromJSON({ ...project, citations });
    const viewState = { pending: null, rerun: null, view: null, currentChapter: project.currentChapter || project.outline?.[0]?.chapter || '' };

    el.innerHTML = `
      <div class="card" style="padding:0;overflow:hidden">
        <div class="workbench">
          <aside class="wb-left">
            <h3><span class="mark"></span>论文目录</h3>
            <p class="desc" id="wb-outline-desc">结构化章节会从编辑器实时同步到这里</p>
            <div class="chapter-list" id="wb-outline"></div>
          </aside>

          <section class="wb-center">
            <div class="wb-current">
              <span class="cur-title" id="wb-cur-title">正在写：<b>${escapeHtml(viewState.currentChapter || '未选择章节')}</b></span>
              <span class="cur-note">ProseMirror 结构化文档 · 自动保存</span>
            </div>
            <div class="wb-toolbar">
              ${AI_ACTIONS.map(item => `<button class="btn ${item.id === 'academic' ? 'btn-ai-solid' : 'btn-ai'} btn-sm" data-ai="${item.id}">${item.label}</button>`).join('')}
              <span class="wb-sep"></span>
              <button class="btn btn-ghost btn-sm" id="wb-draft">生成本章草稿</button>
              <button class="btn btn-ghost btn-sm" id="wb-done">标记本章完成</button>
              <span class="wb-sep"></span>
              <button class="btn btn-ghost btn-sm" id="wb-undo">↶ 撤销</button>
              <button class="btn btn-ghost btn-sm" id="wb-redo">↷ 重做</button>
              <span class="wb-sep"></span>
              <button class="btn btn-ghost btn-sm" id="wb-copy">复制全文</button>
              <button class="btn btn-ghost btn-sm" id="wb-download">下载 Markdown</button>
              <button class="btn btn-ghost btn-sm" id="wb-preview">排版预览</button>
            </div>
            <div id="wb-editor" class="paper-sheet pm-editor"></div>
            <div class="wb-meta">
              <span id="wb-count">全文字数 0</span>
              <span id="wb-saved">已载入</span>
              <span class="hint-plain">AI 改写先进入 Suggestion Mode，只有接受后才写回正文</span>
            </div>
            ${integrityNote()}
          </section>

          <aside class="wb-right">
            <div id="wb-suggestion"></div>
            <h3 style="margin-top:24px"><span class="mark"></span>插入引用</h3>
            <div id="wb-citations"></div>
            <p class="hint">编辑器内部保存的是 citation id，显示编号会按正文首次出现顺序自动重排。</p>
            <h3 style="margin-top:24px"><span class="mark"></span>相关证据</h3>
            <div id="wb-evidence"></div>
          </aside>
        </div>
      </div>`;

    const suggestionBox = el.querySelector('#wb-suggestion');
    const outlineBox = el.querySelector('#wb-outline');
    const citationBox = el.querySelector('#wb-citations');
    const evidenceBox = el.querySelector('#wb-evidence');
    const savedEl = el.querySelector('#wb-saved');
    const countEl = el.querySelector('#wb-count');
    let saveTimer = null;

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

    function renderOutline() {
      const sections = topLevelSections(viewState.view.state.doc);
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

    function syncCurrentChapter() {
      const section = sectionForPos(viewState.view.state.doc, viewState.view.state.selection.from);
      if (!section) return;
      viewState.currentChapter = section.chapter;
      setCurrentChapter(section.chapter);
      const title = el.querySelector('#wb-cur-title');
      if (title) title.innerHTML = `正在写：<b>${escapeHtml(section.chapter)}</b>`;
      renderEvidencePanel();
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
        return true;
      } catch (error) {
        console.error('save writing project failed', error);
        setSaveStatus('error', '保存失败，请重试');
        toast(error?.message || '保存失败，请检查本地存储空间或浏览器权限', 'err', 3000);
        return false;
      }
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
    renderSuggestionBox(suggestionBox, viewState);
    setSaveStatus('idle', '已载入');
    persistNow();

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
