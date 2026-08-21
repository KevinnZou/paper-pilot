// 通用 UI 工具：toast、复制、加载态

export function toast(message, type = 'info', duration = 2600) {
  const wrap = document.getElementById('toast-wrap');
  if (!wrap) return; // DOM 未挂载时静默（各模块渲染前不会调用，防御即可）
  const el = document.createElement('div');
  el.className = `toast ${type === 'ok' ? 'ok' : type === 'err' ? 'err' : ''}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'ok');
  } catch {
    // 兼容非安全上下文（file:// 等）
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制到剪贴板', 'ok');
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 学术诚信提示条（合规立场：AI 输出场景统一展示） */
export function integrityNote() {
  return '<div class="integrity-note"><b>学术诚信提示</b>　AI 生成内容仅供参考，观点与数据请自行核实，并遵守所在学校的学术规范。</div>';
}

/** 按钮加载态：禁用并显示 loading 文字，结束后恢复
 *  原文本只存一次（首次进入 loading 时）——连续两次 loading 会存进「生成中…」，结束时无法恢复原文 */
export function setLoading(btn, loading, loadingText = '生成中…') {
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.orig) btn.dataset.orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = loadingText;
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.orig || btn.textContent;
    delete btn.dataset.orig;
  }
}

/** 打卡日历热力图（近 70 天）：dates 为 'YYYY-MM-DD' 数组；供主页与计划页共用 */
export function calGridHtml(dates) {
  const DAY = 86400000;
  const set = new Set(dates);
  const pad = n => String(n).padStart(2, '0');
  const key = ms => {
    const t = new Date(ms);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  };
  const cells = [];
  for (let i = 69; i >= 0; i--) {
    const ms = Date.now() - i * DAY;
    const k = key(ms);
    cells.push(`<div class="cal-cell ${set.has(k) ? 'on' : ''} ${i === 0 ? 'today' : ''}" title="${k}${set.has(k) ? ' · 已打卡' : ''}"></div>`);
  }
  return `<div class="cal-grid">${cells.join('')}</div>
    <p class="cal-legend">近 70 天打卡日历　<span class="cal-dot on"></span> 已打卡　<span class="cal-dot today"></span> 今天</p>`;
}
