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

export function formatCitationEntry(entry) {
  return {
    ...entry,
    formatted: formatCitation(entry),
  };
}
