#!/usr/bin/env node
// 将 docs/research/*.md 渲染为带样式的单页 HTML（零依赖）
// 用法：node tools/render-reports.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RESEARCH = path.join(ROOT, 'docs', 'research');
const OUT = path.join(RESEARCH, 'reports.html');

const REPORTS = [
  { path: 'docs/PRD.md', id: 'prd', title: '产品需求文档 PRD v2', icon: '📄', desc: 'G2 评审中 · 范围冻结待确认' },
  { path: 'docs/analysis/market-and-competitor-analysis.md', id: 'mca', title: '市场与竞品分析报告', icon: '📊', desc: '竞品矩阵 · TAM/SAM/SOM · SWOT · 定位结论（G0已通过）' },
  { path: 'docs/analysis/user-research.md', id: 'ur', title: '用户研究报告', icon: '🧭', desc: '痛点清单 · 用户画像 · MoSCoW 分级（G1已通过）' },
  { path: 'docs/research/competitor-research-cn.md', id: 'cn', title: '国内竞品调研', icon: '🏢', desc: '15 个竞品 · 市场数据 · 功能矩阵' },
  { path: 'docs/research/competitor-research-intl.md', id: 'intl', title: '国外竞品调研', icon: '🌍', desc: '9 个竞品 · 定价模式 · 借鉴点' },
  { path: 'docs/research/user-research-desk.md', id: 'user', title: '用户研究（桌面调研）', icon: '🎓', desc: '痛点清单 · 使用行为 · 付费意愿' },
  { path: 'docs/analysis/market-and-competitor-analysis.md', id: 'mca', title: '市场与竞品分析报告', icon: '📊', desc: '竞品矩阵 · TAM/SAM/SOM · SWOT · 定位结论（G0已通过）' },
  { path: 'docs/analysis/user-research.md', id: 'ur', title: '用户研究报告', icon: '🧭', desc: '痛点清单 · 用户画像 · MoSCoW 分级（待G1评审）' },
];

const CSS = `
:root { --bg:#f6f5f9; --surface:#fff; --text:#1c1a26; --muted:#6b6678; --accent:#6d28d9; --border:#e6e3ee; }
* { box-sizing: border-box; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); line-height:1.75; font-size:15px; }
.topbar { position:sticky; top:0; z-index:10; background:rgba(23,19,39,.97); color:#fff; display:flex; gap:8px; align-items:center; padding:12px 24px; flex-wrap:wrap; box-shadow:0 2px 12px rgba(0,0,0,.25); }
.topbar .brand { font-weight:700; margin-right:12px; }
.topbar a { color:#d8d2ef; text-decoration:none; font-size:13.5px; padding:5px 12px; border-radius:999px; border:1px solid rgba(255,255,255,.18); }
.topbar a:hover { background:rgba(255,255,255,.1); color:#fff; }
main { max-width:920px; margin:0 auto; padding:28px 24px 80px; }
section.report { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:34px 42px; margin-bottom:26px; box-shadow:0 1px 3px rgba(28,26,38,.05); }
.report-head { border-bottom:2px solid var(--accent); padding-bottom:14px; margin-bottom:20px; }
.report-head .icon { font-size:30px; }
.report-head h1 { margin:8px 0 2px; font-size:24px; }
.report-head .desc { color:var(--muted); font-size:13.5px; margin:0; }
h1,h2,h3,h4 { line-height:1.4; }
h2 { font-size:19px; margin:28px 0 10px; padding-left:10px; border-left:4px solid var(--accent); }
h3 { font-size:16px; margin:22px 0 8px; color:#3a2d63; }
p { margin:10px 0; }
a { color:var(--accent); }
hr { border:0; border-top:1px solid var(--border); margin:22px 0; }
blockquote { margin:14px 0; padding:10px 16px; background:#f3ecfe; border-left:4px solid var(--accent); border-radius:0 8px 8px 0; color:#4a3a75; }
code { background:#eeeaf6; padding:2px 6px; border-radius:5px; font-size:13px; font-family:ui-monospace,Menlo,Consolas,monospace; }
pre { background:#1e1a2e; color:#e8e4f5; padding:16px; border-radius:10px; overflow-x:auto; font-size:13px; line-height:1.6; }
pre code { background:none; padding:0; color:inherit; }
.table-wrap { overflow-x:auto; margin:14px 0; }
table { border-collapse:collapse; width:100%; font-size:13.5px; }
th { background:var(--accent); color:#fff; text-align:left; padding:9px 12px; font-weight:600; white-space:nowrap; }
td { padding:9px 12px; border-bottom:1px solid var(--border); vertical-align:top; }
tbody tr:nth-child(even) { background:#faf9fd; }
tbody tr:hover { background:#f3eefc; }
ul, ol { margin:8px 0; padding-left:24px; }
li { margin:4px 0; }
strong { color:#2b1f52; }
@media (max-width:640px) { section.report { padding:22px 18px; } .topbar { padding:10px 14px; } }
@media print { .topbar { display:none; } body { background:#fff; } section.report { box-shadow:none; border:none; } }
`;

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function parseRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

// 按缩进构建嵌套列表
function renderList(items) {
  function build(list, startIdx, indent) {
    const tag = list[startIdx].ordered ? 'ol' : 'ul';
    let html = `<${tag}>`;
    let i = startIdx;
    while (i < list.length && list[i].indent === indent) {
      let j = i + 1;
      while (j < list.length && list[j].indent > indent) j++;
      const children = list.slice(i + 1, j);
      const inner = children.length ? build(children, 0, children[0].indent) : '';
      html += `<li>${inline(list[i].text)}${inner}</li>`;
      i = j;
    }
    return html + `</${tag}>`;
  }
  return build(items, 0, items[0].indent);
}

function mdToHtml(md) {
  const lines = md.split('\n');
  let html = '';
  let i = 0;
  let hCounter = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    if (t === '') { i++; continue; }

    // 代码块
    if (t.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      i++;
      html += `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>\n`;
      continue;
    }

    // 表格
    if (t.startsWith('|') && i + 1 < lines.length && /^\|[\s:\-|]+\|$/.test(lines[i + 1].trim())) {
      const header = parseRow(raw);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(parseRow(lines[i])); i++; }
      html += '<div class="table-wrap"><table><thead><tr>'
        + header.map(c => `<th>${inline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table></div>\n';
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      const level = h[1].length;
      const id = (h[2].replace(/[*_`#]/g, '').toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'sec') + '-' + (++hCounter);
      html += `<h${level} id="${id}">${inline(h[2])}</h${level}>\n`;
      i++;
      continue;
    }

    // 分隔线
    if (/^(\s*[-*_])\s*(\1\s*){2,}$/.test(t)) { html += '<hr>\n'; i++; continue; }

    // 引用
    if (t.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) { buf.push(lines[i].trim().replace(/^>\s?/, '')); i++; }
      html += `<blockquote>${inline(buf.join('<br>'))}</blockquote>\n`;
      continue;
    }

    // 列表（缩进嵌套）
    if (/^(\s*)([-*]|\d+[.)])\s+\S/.test(raw)) {
      const items = [];
      while (i < lines.length && /^(\s*)([-*]|\d+[.)])\s+/.test(lines[i]) && lines[i].trim() !== '') {
        const m = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        i++;
      }
      if (items.length) { html += renderList(items) + '\n'; continue; }
    }

    // 段落（合并连续行）
    const buf = [];
    while (
      i < lines.length && lines[i].trim() !== ''
      && !/^(#{1,6}\s|\||```|>|(\s*)([-*]|\d+[.)])\s+)/.test(lines[i])
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    html += `<p>${inline(buf.join(' '))}</p>\n`;
  }
  return html;
}

const sections = REPORTS.map(r => {
  const file = path.join(ROOT, r.path);
  if (!fs.existsSync(file)) {
    console.error('缺少报告文件：' + r.path);
    process.exit(1);
  }
  const md = fs.readFileSync(file, 'utf8');
  return `<section class="report" id="report-${r.id}">
<div class="report-head"><div class="icon">${r.icon}</div><h1>${r.title}</h1><p class="desc">${r.desc} · 来源：${r.path}</p></div>
${mdToHtml(md)}
</section>`;
}).join('\n');

const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PaperPilot · 调研报告合集</title>
<style>${CSS}</style></head>
<body>
<div class="topbar"><span class="brand">📝 PaperPilot 调研报告</span>
${REPORTS.map(r => `<a href="#report-${r.id}">${r.icon} ${r.title}</a>`).join('')}
<a href="#top">↑ 顶部</a></div>
<main id="top">${sections}</main>
</body></html>`;

fs.writeFileSync(OUT, page);
console.log('已渲染：' + OUT);
