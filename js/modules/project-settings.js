import { toast, escapeHtml } from '../ui.js';
import { getProject, updateBasics, saveProject, hasActiveProject } from '../project.js';
import { isPlaceholderTitle } from '../title-utils.js';
import { ICONS } from '../icons.js';
import { meaningfulTitle } from '../title-utils.js';

export default {
  id: 'project-settings',
  icon: '',
  title: '项目设置',
  subtitle: '论文题目、学校、导师、截止日期与引用标准',
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
    const projectTitle = meaningfulTitle(p.researchDesign?.title, p.title);
    const researchQuestion = p.researchDesign?.researchQuestions?.[0]?.question || '未单独设定';
    const researchMethod = p.researchDesign?.methods?.[0] || '未单独设定';
    const dataSource = p.researchDesign?.dataSources?.[0] || '未单独设定';
    const keywords = p.researchDesign?.keywords || '未设置';
    const hasOutline = !!(p.outline || []).length;
    const nextLabel = hasOutline ? '去写作工作台' : '去研究设计';
    const summaryDesc = hasOutline
      ? '这里展示已采用方案的核心信息。章节结构和正文调整请在写作工作台完成。'
      : '这里会在研究设计完成后展示方案摘要。先去研究设计生成题目、方案和大纲。';
    const summaryAction = hasOutline ? '去写作工作台调整' : '去研究设计';

    el.innerHTML = `
      <div class="project-settings-shell">
        <section class="card project-settings-main">
          <div class="section-head">
            <div>
              <h2><span class="mark"></span>论文基础信息</h2>
              <p class="desc">这里保存当前论文的学校、导师、截止日期与引用标准，后续计划和导出都会以这些信息为准。</p>
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
            </dl>
            <button class="btn btn-ghost" id="ps-summary-action">${summaryAction}</button>
          </section>
        </aside>
      </div>`;

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
