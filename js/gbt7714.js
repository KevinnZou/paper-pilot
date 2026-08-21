// GB/T 7714 参考文献格式化（纯规则引擎，不依赖 AI）
// 供文献模块、在线文献查找、写作工作台共用

function fmtAuthors(c) {
  const authors = (c.author || '').split(/[,，;；]/).map(s => s.trim()).filter(Boolean);
  if (!authors.length) return '';
  return authors.length > 3 ? `${authors.slice(0, 3).join(', ')}, 等` : authors.join(', ');
}

export function formatCitation(c) {
  const a = fmtAuthors(c);
  const head = a ? `${a}. ` : '';
  const t = c.title || '';
  const y = c.year ? String(c.year) : '';
  const v = c.vol ? String(c.vol) : '';
  const s = c.source || '';
  switch (c.type) {
    case 'J':
      return `${head}${t}[J]. ${[s, y, v].filter(Boolean).join(', ')}.`;
    case 'D':
      return `${head}${t}[D]. ${[s, y].filter(Boolean).join(', ')}.`;
    case 'M':
      return `${head}${t}[M]. ${[s, y].filter(Boolean).join(', ')}.`;
    case 'C':
      return `${head}${t}[C]//${[s, y].filter(Boolean).join(', ')}${v ? `: ${v}` : ''}.`;
    default:
      return `${head}${t}. ${[s, y, v].filter(Boolean).join(', ')}.`;
  }
}
