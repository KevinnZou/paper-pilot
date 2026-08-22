// DeepSeek / OpenAI 兼容接口封装
// 本应用无后端：请求从浏览器直接发送到模型服务商。
// API Key 仅保存在用户本地浏览器 localStorage 中，不经过任何服务器。
import { get, set } from './storage.js';

const CONFIG_KEY = 'config';

export const DEFAULT_CONFIG = {
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  enableLiveAI: false,
};

export function getConfig() {
  return { ...DEFAULT_CONFIG, ...get(CONFIG_KEY, {}) };
}

export function saveConfig(partial) {
  set(CONFIG_KEY, { ...getConfig(), ...partial });
}

export function shouldUseLiveAI() {
  return !!getConfig().enableLiveAI;
}

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 调用大模型对话接口（非流式）
 * @param {Array<{role:string, content:string}>} messages
 * @param {{temperature?:number, signal?:AbortSignal, timeoutMs?:number}} opts
 * @returns {Promise<string>} 模型回复文本
 */
export async function chat(messages, { temperature = 0.7, signal, timeoutMs = 180000 } = {}) {
  const cfg = getConfig();
  if (!cfg.apiKey) throw new ApiError('no_key', '请先在「设置」中填写 API Key');

  // 超时保护：避免请求挂起时按钮永久停在「生成中…」
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  let res;
  try {
    res = await fetch(`${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, messages, temperature, stream: false }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw signal?.aborted
        ? new ApiError('aborted', '请求已取消')
        : new ApiError('timeout', '请求超时：生成时间过长或网络不稳定，请重试');
    }
    throw new ApiError('network', '网络连接失败：请检查网络，或确认服务商地址支持浏览器直连');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const map = {
      400: ['bad_request', '请求参数有误，请检查模型名称'],
      401: ['auth', 'API Key 无效，请到「设置」中检查'],
      402: ['balance', '账户余额不足，请充值后再试'],
      403: ['auth', 'API Key 无权限或已被停用，请到「设置」中检查'],
      429: ['rate', '请求过于频繁，请稍等几秒再试'],
      500: ['server', '服务商暂时不可用，请稍后再试'],
    };
    const [code, message] = map[res.status] || ['http', `请求失败（HTTP ${res.status}）`];
    throw new ApiError(code, message);
  }

  // 兜底：服务商返回 200 但 body 非 JSON（网关/代理 HTML 页）时给出可读错误，而非原始 SyntaxError
  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError('bad_response', '服务商返回了无法解析的响应，请稍后重试');
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new ApiError('empty', '模型返回了空内容，请重试');
  return text.trim();
}

/** 用一条极简消息测试连接，返回 { reply, ms }（短超时，30 秒；支持外部取消 signal） */
export async function testConnection(signal) {
  const started = Date.now();
  const reply = await chat(
    [{ role: 'user', content: '请只回复两个字：正常' }],
    { temperature: 0, timeoutMs: 30000, signal }
  );
  return { reply, ms: Date.now() - started };
}
