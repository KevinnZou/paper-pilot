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

function mockCitationParse() {
  return JSON.stringify([
    {
      authors: '张伟, 李娜',
      title: '大语言模型在教育领域的应用研究',
      source: '现代教育技术',
      year: '2024',
      volume: '34',
      issue: '3',
      pages: '45-52',
      doi: '10.1000/mock-1',
      url: '',
      institution: '',
      publisher: '',
      place: '',
      type: 'J',
    },
    {
      authors: '刘洋',
      title: '基于深度学习的医学图像分割方法研究',
      source: '清华大学',
      year: '2023',
      volume: '',
      issue: '',
      pages: '',
      doi: '',
      url: '',
      institution: '清华大学',
      publisher: '',
      place: '北京',
      type: 'D',
    },
  ]);
}

function mockSearchQueries() {
  return JSON.stringify([
    { chapter: '论文题目', queries: ['AI-enabled standardization', 'digital transformation governance'] },
    { chapter: '研究设计', queries: ['case study methodology', 'process optimization management'] },
  ]);
}

function mockAnnotations() {
  return JSON.stringify([
    { i: 0, reason: '可用于界定研究背景与行业现状', chapter: '第1章 绪论' },
    { i: 1, reason: '可支撑研究方法与案例设计', chapter: '第3章 研究设计' },
    { i: 2, reason: '可用于对比分析与讨论部分', chapter: '第4章 实证/案例分析' },
  ]);
}

function mockTopicTitles() {
  return JSON.stringify([
    { title: '装修行业数字化转型中的 AI 赋能路径与规范化效应研究', feasibility: '适合结合企业访谈与流程制度材料展开。', innovation: '聚焦规范化效应而不是泛泛谈技术应用。' },
    { title: 'AI 驱动下装修企业标准化管理机制优化研究', feasibility: '题目边界较清晰，适合硕士论文体量。', innovation: '把研究重点落到管理机制而非工具层。' },
    { title: '基于 AI 赋能的装修企业采购规范化路径研究', feasibility: '采购流程通常更容易获取样本和制度文本。', innovation: '以采购规范化作为具体切口，便于形成实证结构。' },
    { title: 'AI 介入装修行业流程标准化的作用机制与实践路径研究', feasibility: '适合多案例比较与访谈结合。', innovation: '同时覆盖作用机制与实践路径两个层面。' },
  ]);
}

function mockTopicPlan() {
  return JSON.stringify({
    questions: [
      { id: 'rq-1', question: 'AI 介入后，装修企业标准化流程的执行效率是否会显著提升？', object: '中小型装修企业流程', variable: '标准执行效率', dataNeed: '流程前后对比与访谈', method: '案例研究法' },
      { id: 'rq-2', question: '装修行业数字化转型中，AI 对采购规范化的关键影响路径是什么？', object: '采购与供应链环节', variable: '采购规范化程度', dataNeed: '企业访谈与制度文本', method: '访谈研究法' },
      { id: 'rq-3', question: 'AI 赋能标准化管理后，企业内部协同成本会如何变化？', object: '企业协同流程', variable: '协同成本', dataNeed: '管理者访谈与流程记录', method: '多案例比较法' },
    ],
    methods: ['案例研究法', '访谈研究法', '多案例比较法'],
    dataSources: ['企业访谈记录', '内部流程制度文本', '采购与执行台账'],
    objectives: ['梳理 AI 赋能装修行业标准化的主要路径', '识别采购与流程规范化中的关键作用点', '提出可落地的管理优化建议'],
    researchGap: '现有研究更多讨论 AI 工具本身或单点应用，对装修行业如何通过 AI 推动标准化与规范化管理、并形成可复制流程的研究仍然不足。',
    hypotheses: ['AI 赋能会提升标准流程执行一致性', '采购规范化是数字化转型中最先显效的环节'],
    feasibility: {
      score: '8.6 / 10',
      risks: ['企业一手资料获取需要提前沟通', '案例过少会削弱结论说服力'],
      suggestions: ['优先锁定 2-3 家企业做访谈', '把研究问题收敛到标准化流程或采购规范化其中一条主线'],
    },
  });
}

function mockTopicOutline() {
  return `第1章 绪论
  1.1 研究背景
  1.2 研究意义
  1.3 研究思路与结构安排
第2章 理论基础与文献综述
  2.1 核心概念界定
  2.2 理论基础
  2.3 国内外研究现状
第3章 研究设计
  3.1 研究问题与分析框架
  3.2 研究方法
  3.3 数据来源与样本说明
第4章 AI 赋能装修行业规范化的案例分析
  4.1 现状与问题识别
  4.2 关键影响机制分析
  4.3 优化路径与实施条件
第5章 结论与建议
  5.1 研究结论
  5.2 管理建议
  5.3 不足与展望`;
}

function mockWritingSuggestion(prompt) {
  if (/逻辑结构|论证跳跃/.test(prompt)) {
    return '1. 第二段从现状直接跳到结论，中间缺少机制解释。\n2. 对“效率提升”的判断还没有具体证据支撑。\n3. 建议补一段案例或数据说明，再进入管理建议。';
  }
  if (/撰写 1000-1500 字中文初稿|中文摘要，300-500 字|可引用文献/.test(prompt)) {
    const refs = [...prompt.matchAll(/\[\[CIT:([a-zA-Z0-9-]+)\]\]/g)].map(match => match[1]);
    const c1 = refs[0] ? `[[CIT:${refs[0]}]]` : '';
    const c2 = refs[1] ? `[[CIT:${refs[1]}]]` : c1;
    if (/中文摘要，300-500 字/.test(prompt)) {
      return `本文围绕论文选题展开研究，重点关注研究对象在数字化转型与流程规范化中的关键问题。已有研究表明，AI 工具可以通过数据沉淀、流程识别和决策辅助改善组织管理效率${c1}。在此基础上，本文结合具体行业场景，分析 AI 赋能路径、执行机制及其对规范化管理的影响，并进一步讨论其适用边界与落地条件${c2}。研究有助于为相关企业优化管理流程、提升执行一致性提供参考。`;
    }
    return `从研究背景来看，当前行业管理正在从经验驱动逐步转向数据驱动，AI 技术的引入使流程识别、任务分解与执行反馈具备了更强的自动化基础。相关研究已经指出，数字化工具并不只是提升单点效率，更重要的是改变组织内部信息流动和流程协同方式${c1}。\n\n结合本研究主题，AI 赋能的核心价值首先体现在标准流程的显性化。通过对业务环节进行拆解，系统可以把原本依赖个人经验的操作转化为可记录、可比较、可追踪的流程节点，从而为后续评价和优化提供基础。同时，案例研究方法能够帮助研究者在真实企业情境中观察这种变化，避免只停留在概念讨论层面${c2}。\n\n因此，本章后续可以围绕“问题提出、理论依据、研究对象与分析框架”逐步展开：先说明行业为什么需要规范化，再解释 AI 为什么可能成为规范化的工具，最后把论文的研究问题落到可观察的数据来源和案例材料上。`;
  }
  if (/续写/.test(prompt)) {
    return '进一步来看，AI 技术并不是简单替代人工，而是通过流程标准化、数据沉淀与节点协同三方面重塑企业管理方式。对于装修行业而言，这种重塑首先体现在采购、质检与项目交付等高频环节，其次才会逐步扩展到组织协同与经营决策层面。';
  }
  return '演示模式示例：整体表达更收敛、论证更完整，并尽量保持原意。';
}

function mockGenericReply(messages) {
  const prompt = messages?.[messages.length - 1]?.content || '';
  if (/只回复两个字：正常/.test(prompt)) return '正常';
  if (/解析为 GB\/T 7714 条目|引用信息/.test(prompt)) return mockCitationParse();
  if (/检索词|英文关键词短语|CrossRef\/OpenAlex/.test(prompt)) return mockSearchQueries();
  if (/推荐理由|最适合关联的章节/.test(prompt)) return mockAnnotations();
  if (/题目候选|中文论文题目候选/.test(prompt)) return mockTopicTitles();
  if (/低输入.*研究方案建议包|questions:\s*\[\{id, question/.test(prompt)) return mockTopicPlan();
  if (/生成规范的中文论文大纲|输出五章结构/.test(prompt)) return mockTopicOutline();
  if (/论文写作导师|学术表达|补充论证|重构表达|续写|逻辑结构/.test(prompt)) return mockWritingSuggestion(prompt);
  return '演示模式回复：当前显示演示示例，不消耗真实调用。';
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
  if (!shouldUseLiveAI()) {
    if (signal?.aborted) throw new ApiError('aborted', '请求已取消');
    return mockGenericReply(messages);
  }
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

/**
 * 调用大模型对话接口（流式）。
 * OpenAI/DeepSeek 兼容 SSE：逐段回调 onDelta，最终返回完整文本。
 */
export async function streamChat(messages, { temperature = 0.7, signal, timeoutMs = 180000, onDelta } = {}) {
  if (!shouldUseLiveAI()) {
    if (signal?.aborted) throw new ApiError('aborted', '请求已取消');
    const text = mockGenericReply(messages);
    const chunks = String(text).match(/.{1,24}/gs) || [''];
    for (const chunk of chunks) {
      if (signal?.aborted) throw new ApiError('aborted', '请求已取消');
      onDelta?.(chunk);
      await new Promise(resolve => setTimeout(resolve, 18));
    }
    return text.trim();
  }

  const cfg = getConfig();
  if (!cfg.apiKey) throw new ApiError('no_key', '请先在「设置」中填写 API Key');

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
      body: JSON.stringify({ model: cfg.model, messages, temperature, stream: true }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      throw signal?.aborted
        ? new ApiError('aborted', '请求已取消')
        : new ApiError('timeout', '请求超时：生成时间过长或网络不稳定，请重试');
    }
    throw new ApiError('network', '网络连接失败：请检查网络，或确认服务商地址支持浏览器直连');
  }

  if (!res.ok) {
    clearTimeout(timer);
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

  if (!res.body) {
    clearTimeout(timer);
    throw new ApiError('bad_response', '服务商没有返回可读取的流式响应');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const lines = part.split('\n').map(line => line.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let data;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = data?.choices?.[0]?.delta?.content || data?.choices?.[0]?.message?.content || '';
          if (!delta) continue;
          full += delta;
          onDelta?.(delta, full);
        }
      }
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw signal?.aborted
        ? new ApiError('aborted', '请求已取消')
        : new ApiError('timeout', '请求超时：生成时间过长或网络不稳定，请重试');
    }
    throw e;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  if (!full.trim()) throw new ApiError('empty', '模型返回了空内容，请重试');
  return full.trim();
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
