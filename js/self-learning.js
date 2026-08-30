// 个性化（自学习适配）：客户端、规则式，观察 → 归纳 → 适配（注入 AI 提示词）→ 展示
// 无后端 / 无 ML 依赖；数据存 localStorage，跨项目全局。
// 信号：每个 AI 动作的结果（接受/拒绝/重新生成）+ 已接受建议的篇幅变化（original vs suggestion）。

const KEY = 'paperpilot.selfLearning';

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object') return {
      perAction: {},
      lens: [],
      interactions: 0,
      updatedAt: 0,
      log: [],
      prefs: { tone: 'auto', length: 'auto', citationDensity: 'auto', terminology: 'auto', intensity: 'standard' },
      ...raw,
    };
  } catch (e) { /* ignore */ }
  return { perAction: {}, lens: [], interactions: 0, updatedAt: 0, log: [], prefs: { tone: 'auto', length: 'auto', citationDensity: 'auto', terminology: 'auto', intensity: 'standard' } };
}

function save(p) { localStorage.setItem(KEY, JSON.stringify(p)); }

export function reset() { save({ perAction: {}, lens: [], interactions: 0, updatedAt: 0, log: [], prefs: { tone: 'auto', length: 'auto', citationDensity: 'auto', terminology: 'auto', intensity: 'standard' } }); }

export function getPrefs() { return load().prefs; }
export function setPrefs(partial) {
  const p = load();
  p.prefs = { ...p.prefs, ...(partial || {}) };
  p.updatedAt = Date.now();
  save(p);
  return p.prefs;
}

/** 记录一次 AI 动作的结果：outcome ∈ 'accept' | 'reject' | 'regenerate' */
export function recordOutcome(actionId, outcome, label) {
  const p = load();
  const a = p.perAction[actionId] = p.perAction[actionId] || { label, used: 0, accepted: 0, rejected: 0, regenerated: 0 };
  a.used += 1;
  if (outcome === 'accept') a.accepted += 1;
  else if (outcome === 'reject') a.rejected += 1;
  else if (outcome === 'regenerate') a.regenerated += 1;
  if (label) a.label = label;
  p.interactions += 1;
  p.updatedAt = Date.now();
  p.log = [`${label || actionId} · ${outcome === 'accept' ? '接受' : outcome === 'reject' ? '拒绝' : '重新生成'}`, ...(p.log || [])].slice(0, 12);
  save(p);
}

/** 接受改写类建议时，记录篇幅变化：delta = suggestion 长度 - original 长度（正=变长，负=变短） */
export function recordLengthDelta(actionId, original, suggestion) {
  const o = String(original || '').trim().length;
  const s = String(suggestion || '').trim().length;
  if (!o) return;
  const p = load();
  p.lens.push({ actionId, delta: s - o, at: Date.now() });
  if (p.lens.length > 120) p.lens = p.lens.slice(-120);
  p.updatedAt = Date.now();
  save(p);
}

function ratio(num, den) { return den ? Math.round((num / den) * 100) : 0; }

function lengthAvg() {
  const p = load();
  if (!p.lens.length) return null;
  const avgDelta = p.lens.reduce((s, l) => s + l.delta, 0) / p.lens.length;
  if (avgDelta < -30) return '简洁';
  if (avgDelta > 50) return '详尽';
  return '适中';
}

/** 归纳出若干条"用户偏好"结论（可解释） */
export function summary() {
  const p = load();
  const out = [];
  const actions = Object.entries(p.perAction).filter(([, a]) => a.used > 0);
  if (actions.length) {
    actions.sort((a, b) => b[1].used - a[1].used);
    const top = actions[0];
    out.push(`最常用「${top[1].label || top[0]}」(${top[1].used} 次)`);
    const trusted = actions.filter(a => a[1].accepted > 0).sort((a, b) => ratio(b[1].accepted, b[1].used) - ratio(a[1].accepted, a[1].used))[0];
    if (trusted && trusted[1].accepted >= 2) out.push(`更接受「${trusted[1].label || trusted[0]}」的建议（接受率 ${ratio(trusted[1].accepted, trusted[1].used)}%）`);
  }
  const len = lengthAvg();
  if (len) out.push(`篇幅偏好：${len}（相对 AI 原稿）`);
  const prefs = p.prefs || {};
  if (prefs.tone && prefs.tone !== 'auto') out.push(`语气：${({ formal: '正式书面', concise: '简洁克制', detailed: '详尽展开' })[prefs.tone] || prefs.tone}`);
  if (prefs.citationDensity && prefs.citationDensity !== 'auto') out.push(`引用密度：${({ low: '较少引用', mid: '适中', high: '较多引用' })[prefs.citationDensity] || prefs.citationDensity}`);
  const acceptedTotal = actions.reduce((s, [, a]) => s + a.accepted, 0);
  const usedTotal = actions.reduce((s, [, a]) => s + a.used, 0);
  if (usedTotal) out.push(`AI 建议接受率 ${ratio(acceptedTotal, usedTotal)}%`);
  if (p.interactions) out.push(`累计 ${p.interactions} 次交互`);
  return out;
}

/** 组装注入 AI 提示词的偏好段（无则返回空串） */
export function buildPreferencePrompt() {
  const p = load();
  const prefs = p.prefs || {};
  const parts = [];
  if (prefs.tone === 'formal') parts.push('语气正式书面、克制学术');
  else if (prefs.tone === 'concise') parts.push('表达简洁、去掉冗余');
  else if (prefs.tone === 'detailed') parts.push('论证充分、详略有度');
  if (prefs.terminology === 'academic') parts.push('术语规范、多用学术表达');
  else if (prefs.terminology === 'plain') parts.push('少用晦涩术语、通俗易懂');
  if (prefs.citationDensity === 'high') parts.push('适当增加文献支撑');
  else if (prefs.citationDensity === 'low') parts.push('引用不要过多');
  const learned = summary();
  const learnedTxt = learned.filter(p2 => /篇幅|接受率|最常用/.test(p2)).join('；');
  if (learnedTxt) parts.push(learnedTxt);
  if (!parts.length) return '';
  const lead = prefs.intensity === 'strong' ? '请严格遵循' : prefs.intensity === 'light' ? '请酌情参考' : '请按此调整';
  return `\n\n【个性化】根据用户与你的使用习惯及设置，请${lead}以下偏好：${parts.join('；')}。让结果更贴合用户。`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.round(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.round(d / 3600000)} 小时前`;
  return `${Math.round(d / 86400000)} 天前`;
}

/** 自学习独立页 HTML（学习概览 + 偏好画像 + 各功能表现 + 手动微调 + 学习轨迹） */
export function learningPageHtml() {
  const p = load();
  const prefs = p.prefs || { tone: 'auto', length: 'auto', citationDensity: 'auto', terminology: 'auto', intensity: 'standard' };
  const actions = Object.entries(p.perAction).filter(([, a]) => a.used > 0).sort((a, b) => b[1].used - a[1].used);
  const acceptedTotal = actions.reduce((s, [, a]) => s + a.accepted, 0);
  const usedTotal = actions.reduce((s, [, a]) => s + a.used, 0);
  const rows = actions.length ? actions.map(([id, a]) => `
      <div class="learn-row"><span>${escapeLearn(a.label || id)}</span>
        <div class="learn-track"><div class="learn-fill" style="width:${Math.max(6, ratio(a.accepted, a.used))}%"></div></div>
        <b class="learn-num">使用 ${a.used} · 接受 ${ratio(a.accepted, a.used)}%</b>
      </div>`).join('') : '<p class="desc">还没有 AI 交互记录。到写作台使用一次 AI 建议，这里会显示学习结果。</p>';
  const insights = summary();
  const insightsHtml = insights.length
    ? `<ul class="learn-insights">${insights.map(x => `<li>${escapeLearn(x)}</li>`).join('')}</ul>`
    : '<p class="desc">还没有足够的交互记录。先在写作台采纳或拒绝几次 AI 建议，系统会逐步形成偏好画像。</p>';
  const trace = (p.log || []).length
    ? `<div class="learn-trace">${p.log.map(e => `<div class="learn-trace-item"><span class="dot"></span><span>${escapeLearn(e)}</span></div>`).join('')}</div>`
    : '<p class="desc">完成一次 AI 操作后，这里会记录学习轨迹。</p>';

  const len = lengthAvg();
  const prefCards = [
    { key: 'tone', label: '语气', val: ({ auto: '自动', formal: '正式书面', concise: '简洁克制', detailed: '详尽展开' })[prefs.tone] },
    { key: 'length', label: '篇幅', val: len || '自动' },
    { key: 'citationDensity', label: '引用密度', val: ({ auto: '自动', low: '较少引用', mid: '适中', high: '较多引用' })[prefs.citationDensity] },
    { key: 'terminology', label: '术语风格', val: ({ auto: '自动', academic: '规范学术', plain: '通俗易懂' })[prefs.terminology] },
  ].map(x => `<div class="learn-pref"><span>${x.label}</span><b>${x.val}</b></div>`).join('');

  return `<div class="learn-page">
    <section class="card learn-overview">
      <div class="learn-head">
        <div>
          <h2><span class="mark"></span>个性化</h2>
          <p class="desc">系统学习你的写作偏好，让 AI 建议更贴合你的表达。${p.interactions ? `已学习 <b>${p.interactions}</b> 次交互。` : '完成一次 AI 操作后开始学习。'}</p>
        </div>
      </div>
      <div class="hero-stats learn-stats">
        <div class="stat"><span class="stat-num">${p.interactions}</span><span class="stat-label">累计交互</span></div>
        <div class="stat"><span class="stat-num">${usedTotal ? ratio(acceptedTotal, usedTotal) : 0}%</span><span class="stat-label">建议接受率</span></div>
        <div class="stat"><span class="stat-num">${actions.length}</span><span class="stat-label">覆盖功能</span></div>
        <div class="stat"><span class="stat-num">${relTime(p.updatedAt) || '—'}</span><span class="stat-label">最近学习</span></div>
      </div>
    </section>

    <div class="learn-main-grid">
      <section class="card learn-panel">
        <h3><span class="mark"></span>偏好画像</h3>
        <div class="learn-pref-grid">${prefCards}</div>
        ${insightsHtml}
      </section>

      <section class="card learn-panel">
        <h3><span class="mark"></span>手动微调</h3>
        <div class="learn-form-grid">
          <div><label class="field-label">语气偏好</label>
            <select id="sl-tone">${selOpt('tone', ['auto,自动', 'formal,正式书面', 'concise,简洁克制', 'detailed,详尽展开'], prefs.tone)}</select></div>
          <div><label class="field-label">术语风格</label>
            <select id="sl-terminology">${selOpt('terminology', ['auto,自动', 'academic,规范学术', 'plain,通俗易懂'], prefs.terminology)}</select></div>
          <div><label class="field-label">引用密度</label>
            <select id="sl-cd">${selOpt('citationDensity', ['auto,自动', 'low,较少引用', 'mid,适中', 'high,较多引用'], prefs.citationDensity)}</select></div>
          <div><label class="field-label">应用程度</label>
            <select id="sl-intensity">${selOpt('intensity', ['light,轻度参考', 'standard,标准调整', 'strong,严格遵循'], prefs.intensity)}</select></div>
        </div>
        <div class="learn-actions">
          <button class="btn" id="sl-save">保存偏好</button>
          <button class="btn btn-ghost" id="sl-reset">重置学习记录</button>
        </div>
        <p class="desc learn-note">手动微调会影响后续 AI 建议；重置只清空学习记录，不会删除论文项目。</p>
      </section>
    </div>

    <div class="learn-main-grid">
      <section class="card learn-panel">
        <h3><span class="mark"></span>功能表现</h3>
        <div class="item-list">${rows}</div>
      </section>
      <section class="card learn-panel">
        <h3><span class="mark"></span>学习轨迹</h3>
        ${trace}
      </section>
    </div>
  </div>`;
}

function selOpt(key, list, cur) {
  return list.map(it => { const [v, label] = it.split(','); return `<option value="${v}"${cur === v ? ' selected' : ''}>${label}</option>`; }).join('');
}

/** 学习卡 HTML（供页面展示"系统在持续学习"） */
export function learningCardHtml() {
  const p = load();
  const s = summary();
  const topBars = Object.entries(p.perAction)
    .filter(([, a]) => a.used > 0)
    .sort((a, b) => b[1].used - a[1].used)
    .slice(0, 4);
  const bar = topBars.length ? topBars.map(([id, a]) => `
      <div class="learn-row"><span>${escapeLearn(a.label || id)}</span>
        <div class="learn-track"><div class="learn-fill" style="width:${Math.max(6, ratio(a.accepted, a.used))}%"></div></div>
        <b class="learn-num">${a.used} 次 · 接受 ${ratio(a.accepted, a.used)}%</b>
      </div>`).join('') : '<p class="desc">还没有 AI 交互记录。在写作台使用一次 AI 建议后，这里会显示学习结果。</p>';
  const insights = s.length ? `<ul class="learn-insights">${s.map(x => `<li>${escapeLearn(x)}</li>`).join('')}</ul>` : '';
  return `<div class="card learn-card">
    <div class="learn-head"><div>
      <h2><span class="mark"></span>个性化</h2>
      <p class="desc">系统观察你的写作偏好，让 AI 建议更贴合你的表达。${p.interactions ? `<b>已学习 ${p.interactions}</b> 次交互。` : ''}</p>
    </div></div>
    ${bar}
    ${insights}
  </div>`;
}

function escapeLearn(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
}
