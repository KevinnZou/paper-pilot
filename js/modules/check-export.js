import { escapeHtml, toast } from '../ui.js';
import { getProject, setCurrentChapter, getEvidence, getPlan } from '../project.js';
import { docFromJSON, extractProjectStateFromDoc, collectCitationUsage, buildCitationNumberMap, fullTextFromDoc } from '../document-model.js';
import { citationMap, ensureCitationIds } from '../citation-utils.js';
import { createDocxBlob } from '../docx-export.js';

function severityChip(level) {
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
      .tip { position: fixed; top: 12px; right: 16px; background: #2F4F66; color:#fff; padding: 8px 12px; border-radius: 6px; font-size:12px; }
      @media print { .tip { display:none; } body { margin:0; } }
    </style></head><body><div class="tip">Ctrl/Cmd+P 可导出 PDF</div>${html}</body></html>`);
  win.document.close();
}

function buildPreviewHtml(project, doc, citations) {
  const text = fullTextFromDoc(doc, citationMap(citations));
  const lines = text.split('\n');
  const html = [];
  let mode = 'body';
  lines.forEach(line => {
    if (!line.trim()) return;
    if (!html.length) {
      html.push(`<h1>${escapeHtml(line)}</h1>`);
      return;
    }
    if (line === '摘要' || line === '关键词' || line === '参考文献' || line === '致谢' || /^第/.test(line) || /^\d+\./.test(line)) {
      html.push(`<h2>${escapeHtml(line)}</h2>`);
      mode = line === '参考文献' ? 'refs' : 'body';
      return;
    }
    html.push(mode === 'refs' ? `<p class="ref">${escapeHtml(line)}</p>` : `<p>${escapeHtml(line)}</p>`);
  });
  return html.join('');
}

function collectIssues(project, doc, citations) {
  const state = extractProjectStateFromDoc(doc);
  const usage = collectCitationUsage(doc);
  const order = buildCitationNumberMap(doc);
  const evidence = getEvidence();
  const plan = getPlan();
  const issues = [];
  const chapterWords = state.outline.map(section => ({
    chapter: section.chapter,
    words: wordCount(state.drafts[section.chapter]?.content || ''),
    sectionId: section.sectionId,
  }));

  if (!project.title) issues.push({ level: 'high', group: '结构检查', text: '项目还没有正式论文题目。', nav: 'topic' });
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

  return issues;
}

function issueHtml(item, idx) {
  return `<div class="item">
    <div class="item-main">
      <div class="item-title"><span class="chip ${severityChip(item.level)}">${item.group}</span> ${escapeHtml(item.text)}</div>
    </div>
    <div style="display:flex;gap:6px;flex-shrink:0">
      <button class="btn btn-ghost btn-sm" data-issue-go="${idx}">去处理</button>
    </div>
  </div>`;
}

export default {
  id: 'checkExport',
  icon: '🧪',
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
    const previewHtml = buildPreviewHtml(project, doc, citations);
    const summary = {
      structure: issues.filter(item => item.group === '结构检查').length,
      logic: issues.filter(item => item.group === '逻辑检查').length,
      citation: issues.filter(item => item.group === '引用检查').length,
      format: issues.filter(item => item.group === '格式检查').length,
    };

    el.innerHTML = `
      <div class="card check-summary-card">
        <h2><span class="mark"></span>检查概览</h2>
        <p class="desc">先把最影响提交质量的问题挑出来，再决定是否导出。</p>
        <div class="hero-stats">
          <div class="stat"><span class="stat-num">${summary.structure}</span><span class="stat-label">结构问题</span></div>
          <div class="stat"><span class="stat-num">${summary.logic}</span><span class="stat-label">逻辑问题</span></div>
          <div class="stat"><span class="stat-num">${summary.citation}</span><span class="stat-label">引用问题</span></div>
          <div class="stat"><span class="stat-num">${summary.format}</span><span class="stat-label">格式问题</span></div>
        </div>
      </div>

      <div class="grid-2 check-layout">
        <div class="card">
          <h2><span class="mark"></span>检查结果</h2>
          <p class="desc">${issues.length ? `共发现 ${issues.length} 个值得处理的问题，点击可直接跳转。` : '当前没有明显问题，已经具备导出基础。'}</p>
          <div class="item-list">
            ${issues.length ? issues.map(issueHtml).join('') : '<div class="result-box filled">目前未发现明显结构、引用或格式问题，可以继续做细修或直接导出。</div>'}
          </div>
        </div>

        <div class="card side-summary-card">
          <h2><span class="mark"></span>导出与预览</h2>
          <p class="desc">先导出可继续编辑的 Word，再用排版预览去看 PDF 效果。</p>
          <div class="result-actions" style="margin-top:8px">
            <button class="btn" id="ce-docx">导出 DOCX</button>
            <button class="btn btn-ghost" id="ce-md">导出 Markdown</button>
            <button class="btn btn-ghost" id="ce-html">导出 HTML</button>
            <button class="btn btn-ghost" id="ce-pdf">排版预览 / PDF</button>
          </div>
          <div class="result-box filled" style="margin-top:16px">
            <span class="sample-tag">导出摘要</span>
            标题：${escapeHtml(project.title || '未命名论文')}<br>
            章节数：${state.outline.length}<br>
            引用数：${buildCitationNumberMap(doc).size}<br>
            证据卡：${getEvidence().length}
          </div>
        </div>
      </div>

      <div class="card preview-card">
        <h2><span class="mark"></span>排版预览</h2>
        <div class="result-box filled" style="max-height:520px;overflow:auto">${previewHtml}</div>
      </div>`;

    el.querySelectorAll('[data-issue-go]').forEach(btn =>
      btn.addEventListener('click', () => {
        const item = issues[Number(btn.dataset.issueGo)];
        if (!item) return;
        if (item.chapter) setCurrentChapter(item.chapter);
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: item.nav }));
      }));

    el.querySelector('#ce-md').addEventListener('click', () => {
      const blob = new Blob([fullTextFromDoc(doc, citationMap(citations))], { type: 'text/markdown;charset=utf-8' });
      downloadBlob(blob, `${(project.title || '论文全文').replace(/[\\/:*?"<>|]/g, '_')}.md`);
      toast('Markdown 已导出', 'ok');
    });

    el.querySelector('#ce-html').addEventListener('click', () => {
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(project.title || '论文全文')}</title></head><body>${previewHtml}</body></html>`;
      downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${(project.title || '论文全文').replace(/[\\/:*?"<>|]/g, '_')}.html`);
      toast('HTML 已导出', 'ok');
    });

    el.querySelector('#ce-docx').addEventListener('click', () => {
      const blob = createDocxBlob(project, doc, citations);
      downloadBlob(blob, `${(project.title || '论文全文').replace(/[\\/:*?"<>|]/g, '_')}.docx`);
      toast('DOCX 已导出', 'ok');
    });

    el.querySelector('#ce-pdf').addEventListener('click', () => {
      openPrintPreview(project.title || '论文排版预览', previewHtml);
    });
  },
};
