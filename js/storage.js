// localStorage 封装：JSON 序列化 + 默认值
import { toast } from './ui.js';
const PREFIX = 'paperpilot:';

// 一次性迁移：应用改名为 PaperPilot，把旧前缀 thesismate:* 的本地数据搬移到新前缀（不覆盖已存在的新键）。
// 倒序遍历：删除元素会使后续下标前移，正向遍历会跳过被顶位的键
(function migrateLegacyPrefix() {
  const OLD = 'thesismate:';
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(OLD)) {
      const nk = PREFIX + k.slice(OLD.length);
      if (localStorage.getItem(nk) === null) {
        const v = localStorage.getItem(k);
        if (v !== null) localStorage.setItem(nk, v);
      }
      localStorage.removeItem(k);
    }
  }
})();

export function get(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function set(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (e) {
    // 容量触顶（QuotaExceededError）：显式提示而非在防抖保存等路径抛未捕获错误
    if (e?.name === 'QuotaExceededError') {
      console.error('[paperpilot] 本地存储空间不足，保存失败:', key);
      toast('本地存储空间不足，本次未保存：请先在「设置」中导出备份，再清除不需要的数据', 'err', 4200);
    } else {
      throw e;
    }
  }
}

export function remove(key) {
  localStorage.removeItem(PREFIX + key);
}
