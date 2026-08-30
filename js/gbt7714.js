// GB/T 7714 参考文献格式化（纯规则引擎，不依赖 AI）
// 供文献模块、在线文献查找、写作工作台共用

function fmtAuthors(c) {
  const raw = Array.isArray(c.authors)
    ? c.authors.map(a => (typeof a === 'string' ? a : a?.name || '')).join(', ')
    : (c.authors || c.author || '');
  const authors = String(raw).split(/[,，;；]/).map(s => s.trim()).filter(Boolean);
  if (!authors.length) return '';
  if (authors.length > 3) {
    const head = authors.slice(0, 3).join(', ');
    // GB/T 7714-2015 4.1.3：中文文献用"等"，西文文献用"et al."
    const cjk = /[\u4e00-\u9fff]/.test(head);
    return `${head}, ${cjk ? '等' : 'et al.'}`;
  }
  return authors.join(', ');
}

function issueBlock(c) {
  const volume = c.volume || '';
  const issue = c.issue ? `(${c.issue})` : '';
  const pages = c.pages || '';
  // GB/T 7714：卷(期): 页码 —— 卷期间无冒号，页码前才加冒号
  const volIssue = [volume, issue].filter(Boolean).join('');
  return [volIssue, pages].filter(Boolean).join(': ');
}

export function formatCitation(c, standard = 'GB/T 7714-2025') {
  const a = fmtAuthors(c);
  const head = a ? (a.endsWith('.') ? `${a} ` : `${a}. `) : ''; // "et al." 已带句点时不再重复
  const t = c.title || '';
  const y = c.year ? String(c.year) : '';
  const s = c.source || '';
  const pub = [c.place, c.publisher].filter(Boolean).join(': ');
  const pubOrg = [c.place, (c.institution || c.publisher || '')].filter(Boolean).join(': ');
  const issue = issueBlock(c);
  const access = c.accessDate ? `[${c.accessDate}]` : '';
  const onlineTail = [access, c.url].filter(Boolean).join('. ');
  const joinStd = (...parts) => parts.filter(Boolean).join('. ') + (parts.some(Boolean) ? '.' : '');
  const refTag = standard === 'GB/T 7714-2015' ? '' : '';
  switch (c.type) {
    case 'J':
      return `${head}${t}[J]${refTag}. ${[s, y, issue].filter(Boolean).join(', ')}.`;
    case 'D':
      // 学位论文：作者. 题名[D]. 城市: 保存单位, 年.
      return `${head}${t}[D]${refTag}. ${[pubOrg, y].filter(Boolean).join(', ')}.`;
    case 'M':
      return `${head}${t}[M]${refTag}. ${[pub || s, y].filter(Boolean).join(', ')}.`;
    case 'C':
      // 会议（析出文献）：作者. 题名[C]//会议名. 城市: 出版者, 年: 页码.
      return `${head}${t}[C]${refTag}//${s}${pub ? `. ${pub}, ${[y, c.pages].filter(Boolean).join(': ')}` : `, ${[y, c.pages].filter(Boolean).join(': ')}`}.`;
    case 'R':
      // 报告：作者. 题名[R]. 城市: 机构, 年.
      return `${head}${t}[R]${refTag}. ${[pubOrg, y].filter(Boolean).join(', ')}.`;
    case 'S':
      // 标准：标准名: 标准号[S]. 城市: 出版者, 年.
      return `${head}${c.standardNo ? `${t}: ${c.standardNo}` : t}[S]${refTag}. ${[pub || s, y].filter(Boolean).join(', ')}.`;
    case 'P':
      return `${head}${t}[P]${refTag}. ${[c.patentNo, y].filter(Boolean).join(', ')}.`;
    case 'N':
      // 报纸：作者. 题名[N]. 报纸名, 出版日期(版次).
      return `${head}${t}[N]${refTag}. ${[s, y].filter(Boolean).join(', ')}${c.pages ? `(${c.pages})` : ''}.`;
    case 'EB/OL':
    case 'WEB':
      return joinStd(`${head}${t}[EB/OL]${refTag}`, [s, y].filter(Boolean).join(', '), onlineTail);
    default:
      return `${head}${t}. ${[s, y, issue].filter(Boolean).join(', ')}.`;
  }
}
