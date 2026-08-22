// GB/T 7714 参考文献格式化（纯规则引擎，不依赖 AI）
// 供文献模块、在线文献查找、写作工作台共用

function fmtAuthors(c) {
  const raw = Array.isArray(c.authors)
    ? c.authors.map(a => (typeof a === 'string' ? a : a?.name || '')).join(', ')
    : (c.authors || c.author || '');
  const authors = String(raw).split(/[,，;；]/).map(s => s.trim()).filter(Boolean);
  if (!authors.length) return '';
  return authors.length > 3 ? `${authors.slice(0, 3).join(', ')}, 等` : authors.join(', ');
}

function issueBlock(c) {
  const volume = c.volume || '';
  const issue = c.issue ? `(${c.issue})` : '';
  const pages = c.pages || '';
  return [volume, issue, pages].filter(Boolean).join(': ').replace(/\(\):\s*/, '');
}

export function formatCitation(c, standard = 'GB/T 7714-2025') {
  const a = fmtAuthors(c);
  const head = a ? `${a}. ` : '';
  const t = c.title || '';
  const y = c.year ? String(c.year) : '';
  const s = c.source || '';
  const pub = [c.place, c.publisher].filter(Boolean).join(': ');
  const issue = issueBlock(c);
  const access = c.accessDate ? `[${c.accessDate}]` : '';
  const onlineTail = [c.url, access].filter(Boolean).join('. ');
  const joinStd = (...parts) => parts.filter(Boolean).join('. ') + (parts.some(Boolean) ? '.' : '');
  const refTag = standard === 'GB/T 7714-2015' ? '' : '';
  switch (c.type) {
    case 'J':
      return `${head}${t}[J]${refTag}. ${[s, y, issue].filter(Boolean).join(', ')}.`;
    case 'D':
      return `${head}${t}[D]${refTag}. ${[c.institution || s, y].filter(Boolean).join(', ')}.`;
    case 'M':
      return `${head}${t}[M]${refTag}. ${[pub || s, y].filter(Boolean).join(', ')}.`;
    case 'C':
      return `${head}${t}[C]${refTag}//${[s, y, issue].filter(Boolean).join(', ')}.`;
    case 'R':
      return `${head}${t}[R]${refTag}. ${[c.institution || s, y].filter(Boolean).join(', ')}.`;
    case 'S':
      return `${head}${t}[S]${refTag}. ${[c.standardNo, pub || s, y].filter(Boolean).join(', ')}.`;
    case 'P':
      return `${head}${t}[P]${refTag}. ${[c.patentNo, y].filter(Boolean).join(', ')}.`;
    case 'N':
      return `${head}${t}[N]${refTag}. ${[s, y, c.pages].filter(Boolean).join(', ')}.`;
    case 'EB/OL':
    case 'WEB':
      return joinStd(`${head}${t}[EB/OL]${refTag}`, [s, y].filter(Boolean).join(', '), onlineTail);
    default:
      return `${head}${t}. ${[s, y, issue].filter(Boolean).join(', ')}.`;
  }
}
