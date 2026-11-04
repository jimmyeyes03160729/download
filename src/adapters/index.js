// adapter 註冊表：新增專屬 adapter 時，在這裡 import 並加進 ADAPTERS
import discuz from './discuz.js';
import generic from './generic.js';
import rules from './rules.js';
import telegram from './telegram.js';

export const ADAPTERS = { telegram, discuz, rules, generic };

export function getAdapter(id) {
  return ADAPTERS[id] || generic;
}

export function listAdapters() {
  return Object.values(ADAPTERS).map((a) => ({ id: a.id, name: a.name }));
}
