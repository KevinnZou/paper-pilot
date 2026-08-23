import { toast, escapeHtml } from '../ui.js';
import { getProject, updateBasics, hasActiveProject } from '../project.js';

export default {
  id: 'project-settings',
  icon: '🪪',
  title: '项目设置',
  subtitle: '论文题目、学校、导师、截止日期与引用标准',
  projectScoped: true,

  render(el) {
    if (!hasActiveProject()) {
      el.innerHTML = `
        <div class="card empty">
          <div class="empty-icon">文</div>
          <p>还没有打开的论文项目。先去项目中心创建或选择一个项目。</p>
          <button class="btn" data-nav="projects">去项目中心</button>
        </div>`;
      el.querySelector('[data-nav]').addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'projects' })));
      return;
    }

    const p = getProject();
    el.innerHTML = `
      <div class="card">
        <h2><span class="mark"></span>论文基础信息</h2>
        <p class="desc">这些字段已经从应用设置里拆出，改为跟论文项目绑定。后续研究设计、计划与导出都会以这里为准。</p>

        <label class="field-label">论文题目</label>
        <input type="text" id="ps-title" value="${escapeHtml(p.title || '')}" placeholder="例如：基于大语言模型的智能客服满意度研究">

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

        <div class="result-actions">
          <button class="btn" id="ps-save">保存项目设置</button>
          <button class="btn btn-ghost" id="ps-next">${(p.outline || []).length ? '去写作工作台' : '去研究设计'}</button>
        </div>
      </div>

      <div class="card">
        <h2><span class="mark"></span>研究方案</h2>
        <p class="desc">研究设计（选题、研究问题、方法与数据来源）在采用大纲后在此查看。章节结构调整请在「写作工作台」进行。</p>
        <div class="topic-summary-grid">
          <div class="topic-summary-item"><span>研究问题</span><b>${escapeHtml((p.researchDesign?.researchQuestions?.[0]?.question) || '未单独设定')}</b></div>
          <div class="topic-summary-item"><span>研究方法</span><b>${escapeHtml((p.researchDesign?.methods?.[0]) || '未单独设定')}</b></div>
          <div class="topic-summary-item"><span>数据来源</span><b>${escapeHtml((p.researchDesign?.dataSources?.[0]) || '未单独设定')}</b></div>
          <div class="topic-summary-item"><span>关键词</span><b>${escapeHtml(p.researchDesign?.keywords || '未设置')}</b></div>
        </div>
      </div>`;

    el.querySelector('#ps-save').addEventListener('click', () => {
      updateBasics({
        title: el.querySelector('#ps-title').value.trim(),
        school: el.querySelector('#ps-school').value.trim(),
        college: el.querySelector('#ps-college').value.trim(),
        degreeType: el.querySelector('#ps-degree').value,
        advisor: el.querySelector('#ps-advisor').value.trim(),
        dueDate: el.querySelector('#ps-due').value,
        referenceStandard: el.querySelector('#ps-ref').value,
      });
      toast('项目设置已保存', 'ok');
    });

    el.querySelector('#ps-next').addEventListener('click', () => {
      const target = (getProject().outline || []).length ? 'writing' : 'topic';
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: target }));
    });
  },
};
