// adapter 共用工具
import { DOWNLOAD_TYPES, findTextLinks, makeLink } from '../links.js';

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TR', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'BLOCKQUOTE', 'PRE']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

// 取得元素文字，<br> 與區塊元素轉成換行
export function textOf(el) {
  if (!el) return '';
  let out = '';
  const walk = (node) => {
    if (node.nodeType === 3) {
      out += node.nodeValue;
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) out += '\n';
    for (const c of node.childNodes) walk(c);
    if (block) out += '\n';
  };
  walk(el);
  return out
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function oneLine(s, max = 200) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// 從一個容器收集所有連結（<a href> + 文字中的網址），去重
export function collectLinks(el, base, { includeOther = true, excludeHosts = [] } = {}) {
  if (!el) return [];
  const context = textOf(el);
  const seen = new Set();
  const out = [];
  const push = (link) => {
    if (!link || seen.has(link.url)) return;
    if (!includeOther && !DOWNLOAD_TYPES.has(link.type)) return;
    if (link.type === 'other' || link.type === 'torrent') {
      try {
        const h = new URL(link.url).hostname;
        if (excludeHosts.some((x) => h === x || h.endsWith('.' + x))) return;
      } catch {
        /* ignore */
      }
    }
    seen.add(link.url);
    out.push(link);
  };
  for (const a of el.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('?') || /^javascript:/i.test(href)) continue;
    const text = a.textContent || '';
    // 先粗分類，只有網盤連結才需要往上找提取碼（省 CPU）
    const rough = makeLink(href, { base, text });
    if (!rough) continue;
    if (!includeOther && !DOWNLOAD_TYPES.has(rough.type)) continue;
    if (rough.type === 'magnet' || rough.type === 'ed2k' || rough.type === 'other' || rough.type === 'torrent') {
      push(rough);
    } else {
      push(makeLink(href, { base, text, context: nearbyText(a) || context }));
    }
  }
  for (const raw of findTextLinks(context)) push(makeLink(raw, { base, context: lineAround(context, raw) }));
  return out;
}

// 連結所在的父元素文字（用來找提取碼）
function nearbyText(a) {
  let p = a.parentNode;
  for (let i = 0; i < 2 && p && p.parentNode; i++) p = p.parentNode;
  return p ? textOf(p).slice(0, 2000) : '';
}

function lineAround(text, needle) {
  const i = text.indexOf(needle);
  if (i < 0) return '';
  return text.slice(Math.max(0, i - 80), i + needle.length + 80);
}

export function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return /\.[a-z0-9]{2,5}$/i.test(last) ? last : null;
  } catch {
    return null;
  }
}

export function pageTitle(doc) {
  return oneLine(doc.querySelector('title')?.textContent || '', 150);
}
