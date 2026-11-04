// 備援：掃全頁的下載連結（magnet、ed2k、.torrent、網盤）
import { ed2kName, formatBytes, magnetHash, magnetName } from '../links.js';
import { collectLinks, fileNameFromUrl, oneLine, pageTitle } from './util.js';

export function linkToItem(l, fallbackTitle, postUrl) {
  let title = l.label && l.label !== l.url ? l.label : null;
  let size = null;
  let key = l.url;
  if (l.type === 'magnet') {
    title = magnetName(l.url) || title;
    key = 'btih:' + (magnetHash(l.url) || l.url);
  } else if (l.type === 'ed2k') {
    const e = ed2kName(l.url);
    if (e) {
      title = e.name;
      size = formatBytes(e.size);
    }
  } else if (!title) {
    title = fileNameFromUrl(l.url);
  }
  return {
    key,
    title: oneLine(title || fallbackTitle || l.url, 200),
    size,
    tags: [],
    date: null,
    postUrl,
    links: [l],
  };
}

export default {
  id: 'generic',
  name: '通用（全頁掃描）',
  match: () => false,

  sourceKey(url) {
    return `g:${url.hostname}${url.pathname}${url.search}`;
  },

  parse(doc, url) {
    const title = pageTitle(doc);
    const root = doc.body || doc.documentElement;
    const links = collectLinks(root, url.toString(), { includeOther: false });
    const items = links.map((l) => linkToItem(l, title, url.toString()));
    return { title: title || null, items, next: null };
  },
};
