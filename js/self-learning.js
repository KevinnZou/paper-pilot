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
      prefs: { tone: 'auto', intensity: 'standard' },
      ...raw,
    };
  } catch (e) { /* ignore */ }
  return { perAction: {}, lens: [], interactions: 0, updatedAt: 0, prefs: { tone: 'auto', intensity: 'standard' } };
}

function save(p) { localStorage.setItem(KEY, JSON.stringify(p)); }

export function reset() { save({ perAction: {}, lens: [], interactions: 0, updatedAt: 0, prefs: { tone: 'auto', intensity: 'standard' } }); }

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

/** 归纳出若干条"用户偏好"结论（可解释） */
export function summary() {
  const p = load();
  const out = [];
  const actions = Object.entries(p.perAction).filter(([, a]) => a.used > 0);
  if (actions.length) {
    actions.sort((a, b) => b[1].used - a[1].used);
    const top = actions[0];
    out.push(`你最常用「${top[1].label || top[0]}」(${top[1].used} 次)`);
    const trusted = actions.filter(a => a[1].accepted > 0).sort((a, b) => ratio(b[1].accepted, b[1].used) - ratio(a[1].accepted, a[1].used))[0];
    if (trusted && trusted[1].accepted >= 2) out.push(`你更接受「${trusted[1].label || trusted[0]}」的建议（接受率 ${ratio(trusted[1].accepted, trusted[1].used)}%）`);
  }
  if (p.lens.length) {
    const avgDelta = p.lens.reduce((s, l) => s + l.delta, 0) / p.lens.length;
    const avgOrig = p.lens.reduce((s, l) => s + (l.delta + s === 1 ? 1 : 1), 0); // 不精确，见下
    // 用真实 original 长度近似：以 delta 正负为主，辅以绝对量
    if (avgDelta < -40) out.push('你偏好简洁表达（AI 稿倾向精简）');
    else if (avgDelta > 60) out.push('你偏好更充分的展开（AI 稿需更详尽）');
    else out.push('你基本保持 AI 建议的篇幅');
  }
  const acceptedTotal = actions.reduce((s, [, a]) => s + a.accepted, 0);
  const usedTotal = actions.reduce((s, [, a]) => s + a.used, 0);
  if (usedTotal >= 3) out.push(`你的 AI 建议接受率 ${ratio(acceptedTotal, usedTotal)}%`);
  if (p.interactions) out.push(`累计 ${p.interactions} 次交互`);
  return out;
}

/** 组装注入 AI 提示词的偏好段（无则返回空串） */
export function buildPreferencePrompt() {
  const s = summary();
  if (!s.length) return '';
  const prefs = getPrefs();
  const tone = prefs.tone === 'formal' ? '语气更正式书面、克制学术' : prefs.tone === 'concise' ? '表达更简洁、去掉冗余' : prefs.tone === 'detailed' ? '论证更充分、详略有度' : '';
  const out = [...s];
  if (tone) out.push(`当前用户手动指定：${tone}`);
  const lead = prefs.intensity === 'strong' ? '请严格遵循' : prefs.intensity === 'light' ? '请酌情参考' : '请按此调整';
  if (!s.length && !tone) return '';
  return `\n\n【个性化】根据你与用户的使用交互与设置，系统掌握：${out.join('；')}。请在本次写作中${lead}这些偏好，让结果更贴合用户习惯。`;
}

/** 自学习独立页 HTML（含学习表现 + 手动调整） */
export function learningPageHtml() {
  const p = load();
  const s = summary();
  const actions = Object.entries(p.perAction).filter(([, a]) => a.used > 0).sort((a, b) => b[1].used - a[1].used);
  const rows = actions.length ? actions.map(([id, a]) => `
      <div class="learn-row"><span>${escapeLearn(a.label || id)}</span>
        <div class="learn-track"><div class="learn-fill" style="width:${Math.max(6, ratio(a.accepted, a.used))}%"></div></div>
        <b class="learn-num">使用 ${a.used} · 接受 ${ratio(a.accepted, a.used)}%</b>
      </div>`).join('') : '<p class="desc">还没有 AI 交互记录。到写作台使用一次 AI 建议，这里会显示学习结果。</p>';
  const insights = s.length ? `<ul class="learn-insights">${s.map(x => `<li>${escapeLearn(x)}</li>`).join('')}</ul>` : '';
  const prefs = p.prefs || { tone: 'auto', intensity: 'standard' };
  return `<section class="card learn-page">
    <div class="learn-head"><div>
      <h2><span class="mark"></span>个性化</h2>
      <p class="desc">系统观察你的写作偏好，让 AI 建议更贴合你的表达。${p.interactions ? `已学习 <b>${p.interactions}</b> 次交互。` : '完成一次 AI 操作后开始学习。'}</p>
    </div></div>

    <h3 class="field-label">各功能使用与接受情况</h3>
    <div class="item-list">${rows}</div>
    ${insights}

    <h3 class="field-label">手动调整（可选）</h3>
    <div class="form-row">
      <div><label class="field-label">语气偏好</label>
        <select id="sl-tone">
          <option value="auto"${prefs.tone === 'auto' ? ' selected' : ''}>自动（跟随学习结果）</option>
          <option value="formal"${prefs.tone === 'formal' ? ' selected' : ''}>正式书面</option>
          <option value="concise"${prefs.tone === 'concise' ? ' selected' : ''}>简洁克制</option>
          <option value="detailed"${prefs.tone === 'detailed' ? ' selected' : ''}>详尽展开</option>
        </select></div>
      <div><label class="field-label">应用程度</label>
        <select id="sl-intensity">
          <option value="light"${prefs.intensity === 'light' ? ' selected' : ''}>轻度参考</option>
          <option value="standard"${prefs.intensity === 'standard' ? ' selected' : ''}>标准调整</option>
          <option value="strong"${prefs.intensity === 'strong' ? ' selected' : ''}>严格遵循</option>
        </select></div>
    </div>
    <div style="margin-top:10px"><button class="btn" id="sl-save">保存偏好</button>
      <button class="btn btn-ghost" id="sl-reset">重置学习记录</button></div>
    <p class="desc" style="margin-top:10px">这里的调整会在后续 AI 建议中生效；重置会清空已学到的交互记录。</p>
  </section>`;
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
