import { toast, escapeHtml } from '../ui.js';
import { getProject, updateBasics, saveProject, hasActiveProject, getTemplate, getAiUsageLog } from '../project.js';
import { isPlaceholderTitle } from '../title-utils.js';
import { ICONS } from '../icons.js';
import { meaningfulTitle } from '../title-utils.js';
import { aiDisclosureText, summarizeAiUsage } from '../ai-compliance.js';

function choiceText(value) {
  if (Array.isArray(value)) return choiceText(value[0]);
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value === 'object') {
    const keys = ['question', 'title', 'label', 'name', 'text', 'content', 'value'];
    for (const key of keys) {
      const text = choiceText(value[key]);
      if (text) return text;
    }
  }
  return '';
}

function summaryValue(value, fallback = '未单独设定') {
  return choiceText(value) || fallback;
}

export default {
  id: 'project-settings',
  icon: '',
  title: '项目设置',
  subtitle: '论文题目、学校、导师、格式与可选计划',
  projectScoped: true,

  render(el) {
    if (!hasActiveProject()) {
      el.innerHTML = `
        <div class="card empty">
          <div class="empty-icon">${ICONS.projects}</div>
          <p>还没有打开的论文项目。先去项目中心创建或选择一个项目。</p>
          <button class="btn" data-nav="projects">去项目中心</button>
        </div>`;
      el.querySelector('[data-nav]').addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'projects' })));
      return;
    }

    const p = getProject();
    const tm = getTemplate(p);
    const projectTitle = meaningfulTitle(p.researchDesign?.title, p.title);
    const hasOutline = !!(p.outline || []).length;
    const adoptedFallback = hasOutline ? '已随大纲采用，后续在写作台细化' : '未单独设定';
    const researchQuestion = summaryValue(p.researchDesign?.researchQuestions, hasOutline ? '以当前题目和大纲为主线' : '未单独设定');
    const researchMethod = summaryValue(p.researchDesign?.methods, adoptedFallback);
    const dataSource = summaryValue(p.researchDesign?.dataSources, adoptedFallback);
    const keywords = summaryValue(p.researchDesign?.keywords || p.keywords, '未设置');
    const currentChapter = summaryValue(p.currentChapter, hasOutline ? (p.outline[0]?.chapter || '未开始写作') : '未开始写作');
    const nextLabel = hasOutline ? '去写作工作台' : '去研究设计';
    const summaryDesc = hasOutline
      ? '这里展示已采用方案的核心信息。章节结构和正文调整请在写作工作台完成。'
      : '这里会在研究设计完成后展示方案摘要。先去研究设计生成题目、方案和大纲。';
    const summaryAction = hasOutline ? '去写作工作台调整' : '去研究设计';
    const aiLogs = getAiUsageLog().slice(0, 8);

    el.innerHTML = `
      <div class="project-settings-shell">
        <section class="card project-settings-main">
          <div class="section-head">
            <div>
              <h2><span class="mark"></span>论文基础信息</h2>
              <p class="desc">这里保存当前论文的基础信息、引用标准和格式模板；截止日期只用于可选计划，不影响继续写作。</p>
            </div>
          </div>

          <label class="field-label">论文题目</label>
          <input type="text" id="ps-title" value="${escapeHtml(projectTitle)}" placeholder="例如：基于大语言模型的智能客服满意度研究">

          <div class="form-row">
            <div>
              <label class="field-label">学校</label>
              <input type="text" id="ps-school" value="${escapeHtml(p.school || '')}" placeholder="例如：清华大学">
            </div>
            <div>
              <label class="field-label">学院</label>
              <input type="text" id="ps-college" value="${escapeHtml(p.college || '')}" placeholder="例如：经济管理学院">
            </div>
          </div>

          <div class="form-row">
            <div>
              <label class="field-label">学位类型</label>
              <select id="ps-degree">
                <option value="">未设置</option>
                ${['本科论文', '硕士论文', '博士论文', '课程论文'].map(x => `<option value="${x}"${x === p.degreeType ? ' selected' : ''}>${x}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="field-label">导师</label>
              <input type="text" id="ps-advisor" value="${escapeHtml(p.advisor || '')}" placeholder="例如：张老师">
            </div>
          </div>

          <div class="form-row">
            <div>
              <label class="field-label">截止日期</label>
              <input type="date" id="ps-due" value="${p.dueDate || ''}">
            </div>
            <div>
              <label class="field-label">参考文献标准</label>
              <select id="ps-ref">
                <option value="GB/T 7714-2025"${p.referenceStandard === 'GB/T 7714-2025' ? ' selected' : ''}>GB/T 7714-2025</option>
                <option value="GB/T 7714-2015"${p.referenceStandard === 'GB/T 7714-2015' ? ' selected' : ''}>GB/T 7714-2015</option>
              </select>
            </div>
          </div>

          <div class="project-settings-actions">
            <button class="btn" id="ps-save">保存项目设置</button>
            <button class="btn btn-ghost" id="ps-next">${nextLabel}</button>
          </div>
        </section>

        <aside class="project-settings-side">
          <section class="card project-settings-summary">
            <h2><span class="mark"></span>研究方案摘要</h2>
            <p class="desc">${summaryDesc}</p>
            <dl class="compact-summary-list">
              <div><dt>研究问题</dt><dd>${escapeHtml(researchQuestion)}</dd></div>
              <div><dt>研究方法</dt><dd>${escapeHtml(researchMethod)}</dd></div>
              <div><dt>数据来源</dt><dd>${escapeHtml(dataSource)}</dd></div>
              <div><dt>关键词</dt><dd>${escapeHtml(keywords)}</dd></div>
              ${hasOutline ? `<div><dt>大纲章节</dt><dd>${p.outline.length} 章 · 当前 ${escapeHtml(currentChapter)}</dd></div>` : ''}
            </dl>
            <button class="btn btn-ghost" id="ps-summary-action">${summaryAction}</button>
          </section>

          <section class="card project-settings-summary">
            <h2><span class="mark"></span>AI 使用声明</h2>
            <p class="desc">${escapeHtml(aiDisclosureText(p))}</p>
            <dl class="compact-summary-list">
              <div><dt>最近记录</dt><dd>${aiLogs.length ? `${aiLogs.length} 条` : '暂无 AI 使用记录'}</dd></div>
            </dl>
            ${aiLogs.length ? `<div class="compact-log-list">${aiLogs.map(item => `<p>${escapeHtml(summarizeAiUsage(item))}</p>`).join('')}</div>` : ''}
          </section>
        </aside>
      </div>

      <details class="card template-settings-card">
        <summary>
          <span>
            <b><span class="mark"></span>论文格式模板</b>
            <small>通用学位论文默认样式；需要按学校规范调整时再展开。</small>
          </span>
          <span class="template-summary">${escapeHtml(tm.bodyFont)} ${tm.bodySize}pt · ${tm.lineHeight} 倍行距 · 页边距 ${tm.margins.top}/${tm.margins.bottom}/${tm.margins.left}/${tm.margins.right}cm</span>
        </summary>
        <p class="desc">模板会影响 Word 文档导出与排版预览，不宣称属于某一学校；你可以按本校规范自定义。</p>
        <div class="form-row">
          <div><label class="field-label">上边距(cm)</label><input type="number" step="0.1" id="tf-mt" value="${tm.margins.top}"></div>
          <div><label class="field-label">下边距(cm)</label><input type="number" step="0.1" id="tf-mb" value="${tm.margins.bottom}"></div>
          <div><label class="field-label">左边距(cm)</label><input type="number" step="0.1" id="tf-ml" value="${tm.margins.left}"></div>
          <div><label class="field-label">右边距(cm)</label><input type="number" step="0.1" id="tf-mr" value="${tm.margins.right}"></div>
        </div>
        <div class="form-row">
          <div><label class="field-label">正文中文字体</label><input type="text" id="tf-bodyfont" value="${escapeHtml(tm.bodyFont)}"></div>
          <div><label class="field-label">正文西文字体</label><input type="text" id="tf-bodylatin" value="${escapeHtml(tm.bodyFontLatin)}"></div>
          <div><label class="field-label">正文字号(pt)</label><input type="number" step="0.5" id="tf-bodysz" value="${tm.bodySize}"></div>
        </div>
        <div class="form-row">
          <div><label class="field-label">标题字体</label><input type="text" id="tf-headfont" value="${escapeHtml(tm.headingFont)}"></div>
          <div><label class="field-label">标题字号(pt)</label><input type="number" step="0.5" id="tf-headsz" value="${tm.headingSize}"></div>
          <div><label class="field-label">行距(倍)</label><input type="number" step="0.1" id="tf-line" value="${tm.lineHeight}"></div>
        </div>
        <div class="project-settings-actions">
          <button class="btn" id="tf-save">保存格式模板</button>
          <button class="btn btn-ghost" id="tf-reset">还原默认</button>
        </div>
      </details>`;


    el.querySelector('#ps-save').addEventListener('click', () => {
      const title = el.querySelector('#ps-title').value.trim();
      updateBasics({
        title,
        school: el.querySelector('#ps-school').value.trim(),
        college: el.querySelector('#ps-college').value.trim(),
        degreeType: el.querySelector('#ps-degree').value,
        advisor: el.querySelector('#ps-advisor').value.trim(),
        dueDate: el.querySelector('#ps-due').value,
        referenceStandard: el.querySelector('#ps-ref').value,
      });
      // 保证题目与"研究设计题目"同源：改题同步写 researchDesign.title，避免被其覆盖（P1-1）
      const p = getProject();
      const rd = p.researchDesign || {};
      if (!isPlaceholderTitle(String(rd.title || '')) || String(rd.title || '') !== title) {
        saveProject({ researchDesign: { ...rd, title } });
        if (title) updateBasics({ title });
      }
      toast('项目设置已保存', 'ok');
    });

    el.querySelector('#tf-save')?.addEventListener('click', () => {
      const num = id => Number(el.querySelector(id).value);
      saveProject({ template: {
        margins: { top: num('#tf-mt'), bottom: num('#tf-mb'), left: num('#tf-ml'), right: num('#tf-mr') },
        bodyFont: el.querySelector('#tf-bodyfont').value.trim() || '宋体',
        bodyFontLatin: el.querySelector('#tf-bodylatin').value.trim() || 'Times New Roman',
        bodySize: num('#tf-bodysz') || 12,
        headingFont: el.querySelector('#tf-headfont').value.trim() || '黑体',
        headingSize: num('#tf-headsz') || 16,
        lineHeight: num('#tf-line') || 1.5,
      } });
      toast('格式模板已保存，导出与预览将按此生效', 'ok');
    });
    el.querySelector('#tf-reset')?.addEventListener('click', () => {
      saveProject({ template: {} });
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'project-settings' }));
      toast('已还原为通用默认模板', 'ok');
    });

    el.querySelector('#ps-next').addEventListener('click', () => {
      const target = (getProject().outline || []).length ? 'writing' : 'topic';
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: target }));
    });

    el.querySelector('#ps-summary-action').addEventListener('click', () => {
      const target = (getProject().outline || []).length ? 'writing' : 'topic';
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: target }));
    });
  },
};
