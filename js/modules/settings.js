// 设置：API 配置（已实现真实保存与连接测试）+ 数据备份（导出/导入）+ 本地数据管理
import { getConfig, saveConfig, testConnection } from '../api.js';
import { toast, setLoading, escapeHtml } from '../ui.js';
import { get } from '../storage.js';
import { getProject, updateBasics } from '../project.js';
import { loadDemoData, hasExistingData } from '../demo-data.js';

const PROVIDERS = [
  { value: 'https://api.deepseek.com', name: 'DeepSeek（默认）' },
  { value: 'https://api.openai.com', name: 'OpenAI' },
  { value: 'https://api.moonshot.cn', name: 'Moonshot Kimi' },
  { value: '__custom__', name: '自定义…' },
];

// 中断恢复：导航离开时取消进行中的连接测试（幂等——与其他模块共用 __tmAbort）
if (!window.__tmAbort) {
  window.__tmAbort = new AbortController();
  document.addEventListener('tm:navigate', () => {
    window.__tmAbort.abort();
    window.__tmAbort = new AbortController();
  });
}
const abortSignal = () => window.__tmAbort.signal;

export default {
  id: 'settings',
  icon: '⚙️',
  title: '设置',
  subtitle: 'API 配置与本地数据管理',

  render(el) {
    const cfg = getConfig();
    const p = getProject();

    el.innerHTML = `
      <div class="card">
        <h2><span class="mark"></span>大模型 API 配置</h2>
        <p class="desc">本应用无后端：请求从你的浏览器直接发送到模型服务商。Key 仅保存在本机浏览器 localStorage，不会上传到任何服务器。</p>

        <label class="field-label">API Key</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-key" value="${escapeHtml(cfg.apiKey)}" placeholder="sk-..." style="flex:1;font-family:var(--font-mono)" autocomplete="off">
          <button class="btn btn-ghost" id="cfg-key-toggle">显示</button>
        </div>
        <p class="hint">还没有 Key？去 <a href="https://platform.deepseek.com" target="_blank" rel="noopener">DeepSeek 开放平台</a> 免费注册申请（兼容任何 OpenAI 协议服务商）</p>

        <div class="form-row">
          <div>
            <label class="field-label">服务商</label>
            <select id="cfg-provider">
              ${PROVIDERS.map(p => `<option value="${p.value}">${p.name}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field-label">模型名称</label>
            <input type="text" id="cfg-model" value="${escapeHtml(cfg.model)}" placeholder="deepseek-chat" style="font-family:var(--font-mono)">
          </div>
        </div>

        <div id="cfg-custom-wrap" style="display:none">
          <label class="field-label">自定义 Base URL</label>
          <input type="text" id="cfg-baseurl" value="${escapeHtml(cfg.baseURL || '')}" placeholder="https://api.example.com" style="font-family:var(--font-mono)">
        </div>

        <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" id="cfg-save">保存配置</button>
          <button class="btn btn-ai" id="cfg-test">测试连接</button>
          <button class="btn btn-ghost" id="cfg-back-home" style="display:none" data-nav="dashboard">回论文主页看下一步 →</button>
        </div>
        <div class="result-box" id="cfg-test-out"><span class="placeholder">测试结果将显示在这里</span></div>
      </div>

      <div class="card">
        <h2><span class="mark"></span>论文基本信息</h2>
        <p class="desc">这里是论文项目的主线信息（论文主页的数据来源），其他模块会预填并汇总到这里</p>
        <div class="form-row">
          <div>
            <label class="field-label">论文题目</label>
            <input type="text" id="cfg-p-title" value="${escapeHtml(p.title)}" placeholder="例如：基于大语言模型的智能客服满意度研究">
          </div>
          <div>
            <label class="field-label">学位类型</label>
            <select id="cfg-p-degree">
              <option value="">未设置</option>
              <option value="本科论文">本科论文</option><option value="硕士论文">硕士论文</option>
              <option value="博士论文">博士论文</option><option value="课程论文">课程论文</option>
            </select>
          </div>
        </div>
        <label class="field-label">论文截止日期</label>
        <input type="date" id="cfg-p-due" value="${p.dueDate || ''}">
        <div style="margin-top:14px">
          <button class="btn" id="cfg-p-save">保存论文信息</button>
        </div>
      </div>

      <div class="card">
        <h2><span class="mark"></span>演示模式</h2>
        <p class="desc">一键载入示例论文（题目、五章大纲、两章草稿、3 条文献、3 天打卡记录），适合课堂演示或快速体验完整功能。${hasExistingData() ? '⚠️ 当前已有本地数据，载入将覆盖。' : ''}</p>
        <button class="btn" id="cfg-demo">载入演示数据</button>
      </div>

      <div class="card">
        <h2><span class="mark"></span>数据备份</h2>
        <p class="desc">当前本地：文献 <b>${get('citations', []).length}</b> 条 · 打卡 <b>${get('checkins', []).length}</b> 天 · 草稿 <b>${Object.keys(get('drafts', {})).length}</b> 章。所有数据存在浏览器本地——导出成文件，换电脑、清缓存都不丢论文。</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" id="cfg-export">导出备份文件</button>
          <button class="btn btn-ghost" id="cfg-import-btn">导入并恢复</button>
          <input type="file" id="cfg-import" accept=".json,application/json" style="display:none">
        </div>
        <p class="hint">备份文件包含论文、草稿、文献、打卡与 API 配置（含你的 API Key），请妥善保管、勿外传。</p>
      </div>

      <div class="card">
        <h2><span class="mark"></span>本地数据</h2>
        <p class="desc">文献库、写作计划、打卡记录均保存在本机浏览器中。</p>
        <button class="btn btn-danger" id="cfg-clear">清除全部本地数据</button>
      </div>`;

    // 服务商回显：当前 baseURL 不在预设列表则视为自定义
    const provider = el.querySelector('#cfg-provider');
    const customWrap = el.querySelector('#cfg-custom-wrap');
    const customInput = el.querySelector('#cfg-baseurl');
    provider.value = PROVIDERS.some(p => p.value === cfg.baseURL) ? cfg.baseURL : '__custom__';
    if (provider.value === '__custom__') {
      customWrap.style.display = 'block';
      customInput.value = cfg.baseURL;
    }
    provider.addEventListener('change', () => {
      customWrap.style.display = provider.value === '__custom__' ? 'block' : 'none';
    });

    // 回显已保存的学位类型
    const pDegree = el.querySelector('#cfg-p-degree');
    if (p.degreeType && [...pDegree.options].some(o => o.value === p.degreeType)) {
      pDegree.value = p.degreeType;
    }

    el.querySelector('#cfg-key-toggle').addEventListener('click', () => {
      const inp = el.querySelector('#cfg-key');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    /** 收集当前表单并保存配置 */
    function saveFromForm() {
      const baseURL = provider.value === '__custom__' ? customInput.value.trim() : provider.value;
      if (!baseURL) {
        toast('请填写自定义 Base URL', 'err');
        return false;
      }
      saveConfig({
        apiKey: el.querySelector('#cfg-key').value.trim(),
        baseURL,
        model: el.querySelector('#cfg-model').value.trim() || 'deepseek-chat',
      });
      return true;
    }

    // 「回主页看下一步」引导：已配 Key 且旅程未完成（无论文题目）时显示，避免新用户配置完不知道下一步去哪（KR1）
    const backHomeBtn = el.querySelector('#cfg-back-home');
    const syncBackHome = () => {
      backHomeBtn.style.display = (getConfig().apiKey && !getProject().title) ? '' : 'none';
    };
    backHomeBtn.addEventListener('click', () =>
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'dashboard' })));
    syncBackHome();

    el.querySelector('#cfg-save').addEventListener('click', () => {
      if (saveFromForm()) {
        toast('配置已保存（仅存本机浏览器）', 'ok');
        document.dispatchEvent(new Event('tm:config-changed'));
        syncBackHome();
      }
    });

    el.querySelector('#cfg-p-save').addEventListener('click', () => {
      updateBasics({
        title: el.querySelector('#cfg-p-title').value.trim(),
        degreeType: el.querySelector('#cfg-p-degree').value,
        dueDate: el.querySelector('#cfg-p-due').value,
      });
      toast('论文信息已保存', 'ok');
    });

    el.querySelector('#cfg-test').addEventListener('click', async () => {
      if (!saveFromForm()) return;
      document.dispatchEvent(new Event('tm:config-changed'));
      const btn = el.querySelector('#cfg-test');
      const out = el.querySelector('#cfg-test-out');
      setLoading(btn, true, '测试中…');
      out.innerHTML = '<span class="placeholder">正在连接模型…</span>';
      try {
        const { reply, ms } = await testConnection(abortSignal());
        out.innerHTML = `连接成功（${ms} ms）\n模型回复：${escapeHtml(reply)}`;
        out.classList.add('filled');
        toast('API 连接正常', 'ok');
      } catch (e) {
        if (e?.code === 'aborted') return; // 主动取消（切页），不打扰
        out.innerHTML = `连接失败\n${e.message}`;
        toast(e.message, 'err', 3600);
      } finally {
        setLoading(btn, false);
      }
    });

    el.querySelector('#cfg-demo').addEventListener('click', () => {
      if (hasExistingData() && !confirm('载入演示数据将覆盖当前的论文、文献、打卡等本地数据。继续吗？')) return;
      loadDemoData();
      toast('演示数据已载入——带你回论文主页看看完整状态', 'ok');
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'dashboard' }));
    });

    // —— 数据备份：导出全部本地数据为 JSON 文件 ——
    el.querySelector('#cfg-export').addEventListener('click', () => {
      const data = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith('paperpilot:')) data[k] = localStorage.getItem(k);
      }
      const payload = JSON.stringify({
        app: 'paperpilot', version: 1, exportedAt: new Date().toISOString(), data,
      }, null, 2);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      a.download = `paperpilot-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('备份文件已下载（含论文、草稿、文献、打卡、配置）', 'ok');
    });

    // —— 导入恢复：校验 → 确认覆盖 → 写入 → 回论文主页 ——
    const importInput = el.querySelector('#cfg-import');
    el.querySelector('#cfg-import-btn').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', () => {
      const f = importInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        let parsed;
        try {
          parsed = JSON.parse(reader.result);
        } catch {
          toast('文件格式无效：不是有效的 JSON 文件', 'err', 3600);
          return;
        }
        const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
        // 兼容旧版本（thesismate: 前缀）与当前版本（paperpilot: 前缀）的备份文件
        const entries = Object.entries(data).filter(([k, v]) => (k.startsWith('paperpilot:') || k.startsWith('thesismate:')) && typeof v === 'string');
        if (!entries.length) {
          toast('备份文件中没有可识别的数据（需要使用 PaperPilot 导出的备份文件）', 'err', 4000);
          return;
        }
        if (!confirm(`将用备份覆盖当前的 ${entries.length} 类本地数据（论文、草稿、文献、打卡、配置）。继续吗？`)) return;
        entries.forEach(([k, v]) => localStorage.setItem(k.startsWith('thesismate:') ? 'paperpilot:' + k.slice(11) : k, v));
        toast('数据已恢复，带你回到论文主页', 'ok');
        document.dispatchEvent(new Event('tm:config-changed'));
        document.dispatchEvent(new Event('tm:project-changed'));
        document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'dashboard' }));
      };
      reader.readAsText(f);
      importInput.value = '';
    });

    el.querySelector('#cfg-clear').addEventListener('click', () => {
      if (!confirm('确定清除全部本地数据吗？（论文、草稿、文献库、计划、打卡、配置——清除后无法恢复）')) return;
      // 与导出对称：遍历清掉全部 paperpilot: 前缀数据（兼容旧 thesismate: 前缀；硬编码 key 清单会漏掉未来的新 key）
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('paperpilot:') || k.startsWith('thesismate:'))) localStorage.removeItem(k);
      }
      toast('本地数据已清除', 'ok');
      document.dispatchEvent(new Event('tm:config-changed'));
      document.dispatchEvent(new Event('tm:project-changed'));
      // 走导航事件重渲染本模块（清除后表单回显复位）
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'settings' }));
    });
  },
};
