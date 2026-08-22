// 设置：API 配置（已实现真实保存与连接测试）+ 数据备份（导出/导入）+ 本地数据管理
import { getConfig, saveConfig, testConnection, DEFAULT_CONFIG } from '../api.js';
import { toast, setLoading, escapeHtml } from '../ui.js';
import { get, remove } from '../storage.js';
import {
  listProjects,
  exportProjectStore,
  replaceProjectStore,
  clearProjectStore,
  markBackupExported,
  daysSinceLastBackup,
} from '../project.js';
import { versionCount } from '../versions.js';
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
  title: '应用设置',
  subtitle: '模型配置、备份恢复与隐私说明',

  render(el) {
    const cfg = getConfig();
    const projects = listProjects();
    const totalCitations = projects.reduce((sum, p) => sum + (p.citations || []).length, 0);
    const totalCheckins = projects.reduce((sum, p) => sum + (p.checkins || []).length, 0);
    const totalDrafts = projects.reduce((sum, p) => sum + Object.keys(p.drafts || {}).length, 0);
    const backupDays = daysSinceLastBackup();

    el.innerHTML = `
      <div class="card">
        <h2><span class="mark"></span>大模型 API 配置</h2>
        <p class="desc">论文数据默认仅存本机，无需登录。使用 AI 功能时，仅本次处理所需内容会从浏览器直接发送至你配置的模型服务商，PaperPilot 不经过自有服务器。</p>

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
        </div>
        <div class="result-box" id="cfg-test-out"><span class="placeholder">测试结果将显示在这里</span></div>
      </div>

      <div class="card">
        <h2><span class="mark"></span>演示模式</h2>
        <p class="desc">一键载入示例论文（题目、五章大纲、两章草稿、3 条文献、3 天打卡记录），适合课堂演示或快速体验完整功能。${hasExistingData() ? '⚠️ 当前已有本地数据，载入将覆盖。' : ''}</p>
        <button class="btn" id="cfg-demo">载入演示数据</button>
      </div>

      <div class="card">
        <h2><span class="mark"></span>数据备份</h2>
        <p class="desc">当前本地：项目 <b>${projects.length}</b> 个 · 文献 <b>${totalCitations}</b> 条 · 打卡 <b>${totalCheckins}</b> 天 · 草稿 <b>${totalDrafts}</b> 章 · 版本 <b>${versionCount()}</b> 份。所有数据存在浏览器本地——导出成文件，换电脑、清缓存都不丢论文。</p>
        ${backupDays >= 7 ? '<div class="integrity-note"><b>备份提醒</b>　距离上次导出备份已超过 7 天，建议现在导出一份。</div>' : ''}
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" id="cfg-export">导出备份文件</button>
          <button class="btn btn-ghost" id="cfg-import-btn">导入并恢复</button>
          <input type="file" id="cfg-import" accept=".json,application/json" style="display:none">
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12.5px;color:var(--ink-soft)">
          <input type="checkbox" id="cfg-export-key">
          包含 API Key 等敏感信息
        </label>
        <p class="hint">备份默认包含项目数据和应用设置，但不包含 API Key。只有你主动勾选后，才会把 Key 写进备份文件。</p>
      </div>

      <div class="card">
        <h2><span class="mark"></span>本地数据</h2>
        <p class="desc">AI 请求发送至模型服务商；文献检索请求发送至 CrossRef / OpenAlex；PaperPilot 自身无服务器存储正文。</p>
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

    el.querySelector('#cfg-save').addEventListener('click', () => {
      if (saveFromForm()) {
        toast('配置已保存（仅存本机浏览器）', 'ok');
        document.dispatchEvent(new Event('tm:config-changed'));
      }
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
      const includeApiKey = el.querySelector('#cfg-export-key').checked;
      const cfgNow = getConfig();
      const payload = JSON.stringify({
        ...exportProjectStore({ includeApiKey }),
        config: includeApiKey
          ? cfgNow
          : { ...cfgNow, apiKey: '' },
      }, null, 2);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      a.download = `paperpilot-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      markBackupExported();
      toast(includeApiKey ? '备份文件已下载（含 API Key）' : '备份文件已下载（未包含 API Key）', 'ok');
    });

    // —— 导入恢复：校验 → 确认覆盖 → 写入 → 回论文主页 ——
    const importInput = el.querySelector('#cfg-import');
    el.querySelector('#cfg-import-btn').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const f = importInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = async () => {
        let parsed;
        try {
          parsed = JSON.parse(reader.result);
        } catch {
          toast('文件格式无效：不是有效的 JSON 文件', 'err', 3600);
          return;
        }
        if (parsed?.appState && parsed?.projects) {
          if (!confirm(`将用备份覆盖当前的 ${Object.keys(parsed.projects || {}).length} 个项目和应用设置。继续吗？`)) return;
          await replaceProjectStore({ appState: parsed.appState, projects: parsed.projects });
          saveConfig({ ...DEFAULT_CONFIG, ...(parsed.config || {}) });
          markBackupExported();
          toast('数据已恢复，带你回到论文主页', 'ok');
          document.dispatchEvent(new Event('tm:config-changed'));
          document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'dashboard' }));
          return;
        }

        const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
        const entries = Object.entries(data).filter(([k, v]) => (k.startsWith('paperpilot:') || k.startsWith('thesismate:')) && typeof v === 'string');
        if (!entries.length) {
          toast('备份文件中没有可识别的数据（需要使用 PaperPilot 导出的备份文件）', 'err', 4000);
          return;
        }
        if (!confirm(`将用旧版备份覆盖当前本地数据。继续吗？`)) return;
        entries.forEach(([k, v]) => localStorage.setItem(k.startsWith('thesismate:') ? 'paperpilot:' + k.slice(11) : k, v));
        toast('旧版数据已恢复，请刷新页面完成迁移', 'ok');
        setTimeout(() => location.reload(), 300);
      };
      reader.readAsText(f);
      importInput.value = '';
    });

    el.querySelector('#cfg-clear').addEventListener('click', async () => {
      if (!confirm('确定清除全部本地数据吗？（论文、草稿、文献库、计划、打卡、配置——清除后无法恢复）')) return;
      await clearProjectStore();
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('paperpilot:') || k.startsWith('thesismate:'))) localStorage.removeItem(k);
      }
      remove('config');
      toast('本地数据已清除', 'ok');
      document.dispatchEvent(new Event('tm:config-changed'));
      document.dispatchEvent(new Event('tm:project-changed'));
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'projects' }));
    });
  },
};
