import { meaningfulTitle } from './title-utils.js';

export function aiDisclosureText(project = {}) {
  const title = meaningfulTitle(project?.researchDesign?.title, project?.title) || '本文';
  return `AI 辅助使用声明：${title}写作过程中可能使用 PaperPilot 的 AI 辅助功能进行选题梳理、结构建议、局部草稿生成、语言润色、论证补充、文献检索辅助与格式整理。AI 输出仅作为写作参考，论文研究思路、核心观点、数据真实性、引用准确性和最终表达均由作者审阅、修改并负责。`;
}

export function aiDisclosureMarkdown(project = {}) {
  return `## AI 辅助使用声明\n\n${aiDisclosureText(project)}`;
}

export function summarizeAiUsage(entry = {}) {
  const feature = entry.feature || 'AI 辅助';
  const target = entry.target ? ` · ${entry.target}` : '';
  const date = entry.createdAt ? new Date(entry.createdAt).toLocaleString('zh-CN') : '';
  return `${date ? `${date} · ` : ''}${feature}${target}`;
}
