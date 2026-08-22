import { formatCitation } from './gbt7714.js';

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `cit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ensureCitationIds(list = []) {
  let changed = false;
  const next = list.map(item => {
    if (item.id) return item;
    changed = true;
    return { ...item, id: makeId() };
  });
  return { list: next, changed };
}

export function citationMap(list = []) {
  return new Map(list.map(item => [item.id, item]));
}

function splitLegacyVol(vol = '') {
  const raw = String(vol || '').trim();
  if (!raw) return {};
  const match = /^([^()：:,;\s]+)?(?:\(([^)]+)\))?(?::?\s*(.+))?$/.exec(raw);
  if (!match) return { pages: raw };
  return {
    volume: match[1] || '',
    issue: match[2] || '',
    pages: match[3] || '',
  };
}

export function normalizeCitationEntry(entry = {}, standard = 'GB/T 7714-2025') {
  const legacy = splitLegacyVol(entry.vol);
  const next = {
    ...entry,
    id: entry.id || makeId(),
    authors: entry.authors || entry.author || '',
    volume: entry.volume || legacy.volume || '',
    issue: entry.issue || legacy.issue || '',
    pages: entry.pages || legacy.pages || '',
    doi: entry.doi || '',
    url: entry.url || '',
    accessDate: entry.accessDate || '',
    publisher: entry.publisher || '',
    place: entry.place || '',
    institution: entry.institution || '',
    patentNo: entry.patentNo || '',
    standardNo: entry.standardNo || '',
  };
  next.formatted = formatCitation(next, standard);
  return next;
}

export function formatCitationEntry(entry, standard) {
  return {
    ...normalizeCitationEntry(entry, standard),
  };
}
