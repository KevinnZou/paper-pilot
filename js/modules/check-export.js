import { escapeHtml, toast } from '../ui.js';
import { getProject, setCurrentChapter, getEvidence, getPlan } from '../project.js';
import { docFromJSON, extractProjectStateFromDoc, collectCitationUsage, buildCitationNumberMap, fullTextFromDoc, buildRenderableBlocks } from '../document-model.js';
import { citationMap, ensureCitationIds } from '../citation-utils.js';
import { createDocxBlob } from '../docx-export.js';
import { meaningfulTitle } from '../title-utils.js';

export function severityChip(level) {
  if (level === 'high') return 'uncited';
  if (level === 'medium') return 'doing';
  return 'done';
}

function wordCount(text) {
  return String(text || '').replace(/\s/g, '').length;
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function openPrintPreview(title, html) {
  const win = window.open('', '_blank');
  if (!win) {
    toast('浏览器拦截了导出窗口，请允许弹窗后重试', 'err');
    return;
  }
  win.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
    <style>
      body { max-width: 820px; margin: 32px auto; padding: 0 24px 48px; font-family: "Songti SC", STSong, SimSun, serif; line-height: 1.9; color: #26303B; }
      h1 { text-align:center; font-size:24px; margin: 0 0 18px; }
      h2 { font-size:18px; margin: 28px 0 12px; border-bottom:1px solid #ddd; padding-bottom:6px; }
      p { text-indent: 2em; margin: 8px 0; }
      .ref { text-indent: -2em; padding-left: 2em; font-size: 13px; }
      .pp-note-row { text-indent: 0; padding-left: 0; }
      blockquote { margin: 12px 0; padding: 8px 16px; border-left: 3px solid #C03B2D; background: #FBF7F0; }
      ul, ol { margin: 10px 0 14px 32px; }
      .pp-figure, .pp-table-wrap, .pp-formula { margin: 18px 0; }
      .pp-formula-body { padding: 14px 16px; border: 1px solid #DDD7CA; background: #FCFBF8; font-family: "SFMono-Regular", Menlo, Consolas, monospace; text-align: center; white-space: pre-wrap; }
      .pp-figure img { max-width: 100%; display: block; margin: 0 auto; border: 1px solid #DDD7CA; }
      .pp-figure figcaption, .pp-table-wrap figcaption, .pp-formula figcaption { margin-top: 8px; text-align: center; font-size: 13px; color: #4A5560; }
      .pp-note { margin: 6px 0 0; text-indent: 0; font-size: 13px; color: #5A6570; }
      .pp-table { width: 100%; border-collapse: collapse; font-size: 14px; background: #fff; }
      .pp-table th, .pp-table td { border: 1px solid #CFC9BB; padding: 8px 10px; text-align: left; vertical-align: top; }
      .pp-table th { background: #F5F1EA; }
      .tip { position: fixed; top: 12px; right: 16px; background: #2F4F66; color:#fff; padding: 8px 12px; border-radius: 6px; font-size:12px; }
      @media print { .tip { display:none; } body { margin:0; } }
    </style></head><body><div class="tip">Ctrl/Cmd+P 可导出 PDF</div>${html}</body></html>`);
  win.document.close();
}

export function buildPreviewHtml(project, doc, citations) {
  const blocks = buildRenderableBlocks(doc, citationMap(citations));
  return blocks.map(block => {
    if (block.type === 'title') return `<h1>${escapeHtml(block.text)}</h1>`;
    if (block.type === 'heading') return `<h2>${escapeHtml(block.text)}</h2>`;
    if (block.type === 'notes_heading') return `<h2>${escapeHtml(block.text)}</h2>`;
    if (block.type === 'paragraph') return `<p>${escapeHtml(block.text)}</p>`;
    if (block.type === 'blockquote') return `<blockquote>${escapeHtml(block.text)}</blockquote>`;
    if (block.type === 'reference') return `<p class="ref">${escapeHtml(block.text)}</p>`;
    if (block.type === 'note') return `<p class="ref pp-note-row">[注${block.number}] ${escapeHtml(block.text)}</p>`;
    if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag}>${block.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
    }
    if (block.type === 'formula') {
      return `<figure class="pp-formula">
        <div class="pp-formula-body">${escapeHtml(block.latex || '')}</div>
        <figcaption>式${block.number}${block.label ? `　${escapeHtml(block.label)}` : ''}</figcaption>
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

export function collectIssues(project, doc, citations) {
  const state = extractProjectStateFromDoc(doc);
  const usage = collectCitationUsage(doc);
  const order = buildCitationNumberMap(doc);
  const renderable = buildRenderableBlocks(doc, citationMap(citations));
  const evidence = getEvidence();
  const plan = getPlan();
  const issues = [];
  const chapterWords = state.outline.map(section => ({
    chapter: section.chapter,
    words: wordCount(state.drafts[section.chapter]?.content || ''),
    sectionId: section.sectionId,
  }));

  if (!meaningfulTitle(project.title, state.title)) issues.push({ level: 'high', group: '结构检查', text: '项目还没有正式论文题目。', nav: 'topic' });
  if (!state.abstract) issues.push({ level: 'high', group: '结构检查', text: '摘要为空，导出前应至少形成初稿。', nav: 'writing' });
  if (!state.keywords) issues.push({ level: 'medium', group: '格式检查', text: '关键词为空。', nav: 'writing' });
  if (state.outline.length < 3) issues.push({ level: 'medium', group: '结构检查', text: `当前仅有 ${state.outline.length} 个章节，建议检查是否缺少核心章节。`, nav: 'topic' });

  if (chapterWords.length) {
    const max = Math.max(...chapterWords.map(item => item.words));
    const min = Math.min(...chapterWords.map(item => item.words));
    if (max >= 4 * Math.max(min, 1) && max > 1200) {
      const sparse = chapterWords.find(item => item.words === min);
      issues.push({
        level: 'medium',
        group: '结构检查',
        text: `章节篇幅失衡：${sparse?.chapter || '某章节'} 明显偏短，建议补充分析或证据。`,
        nav: 'writing',
        chapter: sparse?.chapter || '',
      });
    }
  }

  const conclusion = state.outline.find(section => /总结|结论|展望/.test(section.chapter));
  if (!conclusion) {
    issues.push({ level: 'medium', group: '结构检查', text: '尚未看到“总结/结论/展望”类章节。', nav: 'topic' });
  } else if (wordCount(state.drafts[conclusion.chapter]?.content || '') < 300) {
    issues.push({ level: 'medium', group: '逻辑检查', text: `结论章节「${conclusion.chapter}」内容偏少，可能还没有回应研究问题。`, nav: 'writing', chapter: conclusion.chapter });
  }

  const uncited = citations.filter(item => !usage.has(item.id));
  if (uncited.length) {
    issues.push({ level: 'medium', group: '引用检查', text: `有 ${uncited.length} 条文献已入库但正文未引用。`, nav: 'citation' });
  }

  const missingMeta = citations.filter(item => !item.authors || !item.year || !item.title || !item.source);
  if (missingMeta.length) {
    issues.push({ level: 'medium', group: '引用检查', text: `有 ${missingMeta.length} 条文献元数据不完整，可能影响参考文献规范性。`, nav: 'citation' });
  }

  const evidenceWithoutSection = evidence.filter(item => !item.linkedSectionIds?.length);
  if (evidenceWithoutSection.length) {
    issues.push({ level: 'low', group: '逻辑检查', text: `有 ${evidenceWithoutSection.length} 张证据卡尚未关联章节。`, nav: 'citation' });
  }

  const claimParagraphs = Object.entries(state.drafts)
    .flatMap(([chapter, draft]) => String(draft?.content || '').split(/\n+/).map(text => ({ chapter, text })))
    .filter(item => /(表明|说明|发现|结果显示|研究认为|可见)/.test(item.text) && !/\[\[CIT:|\[\d+\]/.test(item.text));
  if (claimParagraphs.length) {
    issues.push({
      level: 'medium',
      group: '逻辑检查',
      text: `检测到 ${claimParagraphs.length} 段“像判断或结论”的表述未带引用，建议补证据支持。`,
      nav: 'writing',
      chapter: claimParagraphs[0].chapter,
    });
  }

  const overdueTasks = (plan.tasks || []).filter(task => task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10) && !(plan.doneTaskIds || []).includes(task.id));
  if (overdueTasks.length) {
    issues.push({ level: 'low', group: '进度检查', text: `有 ${overdueTasks.length} 个任务已逾期，建议在“计划与进度”里重排。`, nav: 'planner' });
  }

  if (!order.size) {
    issues.push({ level: 'low', group: '引用检查', text: '正文暂时没有任何正式引用编号，若已开始写作建议尽快补充文献支撑。', nav: 'writing' });
  }

  const uncapturedFigures = renderable.filter(block => block.type === 'figure' && !block.caption?.trim());
  if (uncapturedFigures.length) {
    issues.push({ level: 'medium', group: '格式检查', text: `有 ${uncapturedFigures.length} 张图片还没有图题，导出前建议补齐。`, nav: 'writing' });
  }

  const uncapturedTables = renderable.filter(block => block.type === 'table' && !block.caption?.trim());
  if (uncapturedTables.length) {
    issues.push({ level: 'medium', group: '格式检查', text: `有 ${uncapturedTables.length} 个表格还没有表题，导出前建议补齐。`, nav: 'writing' });
  }

  const unlabeledFormulas = renderable.filter(block => block.type === 'formula' && !block.label?.trim());
  if (unlabeledFormulas.length) {
    issues.push({ level: 'low', group: '格式检查', text: `有 ${unlabeledFormulas.length} 个公式还没有标题，后续校对时可能不方便定位。`, nav: 'writing' });
  }

  return issues;
}

export function issueActionLabel(item) {
  if (item.nav === 'topic') return '去研究设计';
  if (item.nav === 'writing') return item.chapter ? '去对应章节' : '去写作台';
  if (item.nav === 'citation') return '去文献库';
  if (item.nav === 'planner') return '去计划页';
  return '去处理';
}

function exportReadiness(issues) {
  const high = issues.filter(item => item.level === 'high').length;
  const medium = issues.filter(item => item.level === 'medium').length;
  if (high) {
    return {
      tone: 'danger',
      title: '暂不建议导出定稿',
      desc: `还有 ${high} 个关键问题需要先处理。可以导出过程稿，但不建议作为最终提交版本。`,
    };
  }
  if (medium) {
    return {
      tone: 'warn',
      title: '可以导出过程稿',
      desc: `还有 ${medium} 个中等风险问题。导出前建议再检查一次结构、引用和格式。`,
    };
  }
  return {
    tone: 'ready',
    title: '已具备导出基础',
    desc: '当前没有发现关键问题，可以导出 DOCX 做最终排版和人工校对。',
  };
}

export function issueHtml(item, idx) {
  return `<div class="issue-row">
    <div class="item-main">
      <div class="issue-title"><span class="chip ${severityChip(item.level)}">${item.group}</span> ${escapeHtml(item.text)}</div>
    </div>
    <button class="btn btn-ghost btn-sm" data-issue-go="${idx}">${issueActionLabel(item)}</button>
  </div>`;
}

export default {
  id: 'checkExport',
  icon: '',
  title: '检查与导出',
  subtitle: '结构、引用、格式检查，以及 Markdown / DOCX / PDF 导出',
  projectScoped: true,

  render(el) {
    const project = getProject();
    const citations = ensureCitationIds(project.citations || []).list;
    const doc = docFromJSON({ ...project, citations });
    const issues = collectIssues(project, doc, citations);
    const grouped = Array.from(new Set(issues.map(item => item.group)));
    const state = extractProjectStateFromDoc(doc);
    const exportTitle = meaningfulTitle(project.title, state.title);
    const exportFilename = (exportTitle || '论文全文').replace(/[\\/:*?"<>|]/g, '_');
    const totalWords = (fullTextFromDoc(doc, citationMap(citations)) || '').replace(/\s/g, '').length;
    const previewHtml = buildPreviewHtml(project, doc, citations);
    const readiness = exportReadiness(issues);
    const summary = {
      structure: issues.filter(item => item.group === '结构检查').length,
      logic: issues.filter(item => item.group === '逻辑检查').length,
      citation: issues.filter(item => item.group === '引用检查').length,
      format: issues.filter(item => item.group === '格式检查').length,
    };

    el.innerHTML = `
      <div class="check-export-shell">
        <section class="card check-overview-card">
          <div class="section-head">
            <div>
              <h2><span class="mark"></span>导出前检查</h2>
              <p class="desc">页面会基于当前论文自动检查结构、逻辑、引用和格式；处理完主要问题后再导出更稳。</p>
            </div>
            <button class="btn btn-ghost btn-sm" id="ce-recheck">重新检查</button>
          </div>
          <div class="check-metric-grid">
            <div class="check-metric"><span>${summary.structure}</span><b>结构问题</b></div>
            <div class="check-metric"><span>${summary.logic}</span><b>逻辑问题</b></div>
            <div class="check-metric"><span>${summary.citation}</span><b>引用问题</b></div>
            <div class="check-metric"><span>${summary.format}</span><b>格式问题</b></div>
          </div>
        </section>

        <div class="check-main-grid">
          <section class="card check-results-card">
            <h2><span class="mark"></span>检查结果</h2>
            <p class="desc">${issues.length ? `共发现 ${issues.length} 个值得处理的问题，点击可直接跳转。` : '当前没有明显问题，已经具备导出基础。'}</p>
            <div class="issue-list">
              ${issues.length ? issues.map(issueHtml).join('') : '<div class="result-box filled">目前未发现明显结构、引用或格式问题，可以继续做细修或直接导出。</div>'}
            </div>
          </section>

          <aside class="card export-panel">
            <h2><span class="mark"></span>导出与预览</h2>
            <p class="desc">优先导出 DOCX 做最终排版；Markdown 和 HTML 适合备份或迁移。</p>
            <div class="export-readiness ${readiness.tone}">
              <strong>${escapeHtml(readiness.title)}</strong>
              <span>${escapeHtml(readiness.desc)}</span>
            </div>
            <div class="export-action-grid">
              <button class="btn" id="ce-docx">导出 DOCX</button>
              <button class="btn btn-ghost" id="ce-pdf">排版预览 / PDF</button>
              <button class="btn btn-ghost" id="ce-md">导出 Markdown</button>
              <button class="btn btn-ghost" id="ce-html">导出 HTML</button>
            </div>
            <div class="export-summary">
              <div class="export-summary-label">导出摘要</div>
              <div class="export-summary-grid">
                <div class="export-summary-item export-summary-title"><span>标题</span><b>${escapeHtml(exportTitle || '未设置')}</b></div>
                <div class="export-summary-item"><span>章节数</span><b>${state.outline.length}</b></div>
                <div class="export-summary-item"><span>引用数</span><b>${buildCitationNumberMap(doc).size}</b></div>
                <div class="export-summary-item"><span>证据卡</span><b>${getEvidence().length}</b></div>
                <div class="export-summary-item"><span>总字数</span><b>${totalWords}</b></div>
              </div>
            </div>
          </aside>
        </div>
      </div>`;

    el.querySelector('#ce-recheck')?.addEventListener('click', () =>
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'checkExport' })));
    el.querySelectorAll('[data-issue-go]').forEach(btn =>
      btn.addEventListener('click', () => {
        const item = issues[Number(btn.dataset.issueGo)];
        if (!item) return;
        if (item.chapter) setCurrentChapter(item.chapter);
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: item.nav }));
      }));

    el.querySelector('#ce-md').addEventListener('click', () => {
      const blob = new Blob([fullTextFromDoc(doc, citationMap(citations))], { type: 'text/markdown;charset=utf-8' });
      downloadBlob(blob, `${exportFilename}.md`);
      toast('Markdown 已导出', 'ok');
    });

    el.querySelector('#ce-html').addEventListener('click', () => {
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(exportTitle || '论文全文')}</title></head><body>${previewHtml}</body></html>`;
      downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${exportFilename}.html`);
      toast('HTML 已导出', 'ok');
    });

    el.querySelector('#ce-docx').addEventListener('click', () => {
      const blob = createDocxBlob(project, doc, citations);
      downloadBlob(blob, `${exportFilename}.docx`);
      toast('DOCX 已导出', 'ok');
    });

    el.querySelector('#ce-pdf').addEventListener('click', () => {
      openPrintPreview(exportTitle || '论文排版预览', previewHtml);
    });
  },
};
