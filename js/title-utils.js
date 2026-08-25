export function isPlaceholderTitle(title) {
  return /^(未命名论文|未命名项目|我的论文项目)(（副本）)?$/.test(String(title || '').trim());
}

export function meaningfulTitle(...values) {
  for (const value of values) {
    const title = String(value || '').trim();
    if (title && !isPlaceholderTitle(title)) return title;
  }
  return '';
}
