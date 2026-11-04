// 設定式 adapter：在設定頁用 CSS selector 描述網站結構，不用寫程式
//
// rules JSON 欄位（只有 item 必填）：
//   item   每一筆項目的容器，例如 "article.post"
//   title  項目內的標題元素，例如 "h2 a"（省略時用第一個連結文字）
//   link   項目內要收的連結，例如 "a.download"（省略時收容器內所有下載連結）
//   size   項目內的大小文字，例如 ".size"
//   date   項目內的日期文字，例如 "time"
//   next   下一頁連結，例如 "a.next"
//   includeOther  true 時連一般網址也列出（預設只列下載類連結）
import { makeLink } from '../links.js';
import { linkToItem } from './generic.js';
import { collectLinks, oneLine, pageTitle, textOf } from './util.js';

export function validateRules(rules) {
  if (!rules || typeof rules !== 'object') throw new Error('rules 必須是 JSON 物件');
  if (typeof rules.item !== 'string' || !rules.item.trim()) throw new Error('rules.item（項目容器 selector）必填');
  for (const k of ['title', 'link', 'size', 'date', 'next']) {
    if (rules[k] != null && typeof rules[k] !== 'string') throw new Error(`rules.${k} 必須是字串`);
  }
  return rules;
}

export default {
  id: 'rules',
  name: '設定式（CSS selector）',
  match: () => false,

  sourceKey(url) {
    return `r:${url.hostname}${url.pathname}${url.search}`;
  },

  parse(doc, url, { rules } = {}) {
    validateRules(rules);
    const base = url.toString();
    const items = [];
    const seen = new Set();
    for (const el of doc.querySelectorAll(rules.item)) {
      const titleEl = rules.title ? el.querySelector(rules.title) : el.querySelector('a');
      const title = oneLine(textOf(titleEl), 200);
      let links;
      if (rules.link) {
        links = [];
        const context = textOf(el);
        const got = new Set();
        for (const a of el.querySelectorAll(rules.link)) {
          const l = makeLink(a.getAttribute('href'), { base, text: textOf(a), context });
          if (l && !got.has(l.url)) {
            got.add(l.url);
            links.push(l);
          }
        }
      } else {
        links = collectLinks(el, base, { includeOther: !!rules.includeOther });
      }
      if (!links.length) continue;
      const size = rules.size ? oneLine(textOf(el.querySelector(rules.size)), 40) || null : null;
      const date = rules.date
        ? el.querySelector(rules.date)?.getAttribute('datetime') || oneLine(textOf(el.querySelector(rules.date)), 40) || null
        : null;
      const postHref = titleEl?.getAttribute?.('href');
      const postUrl = postHref ? new URL(postHref, base).toString() : base;
      const item = links.length === 1 ? linkToItem(links[0], title, postUrl) : null;
      const key = item && !title ? item.key : `${title}|${links[0].url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        key,
        title: title || item?.title || links[0].url,
        size: size || item?.size || null,
        tags: [],
        date,
        postUrl,
        links,
      });
    }
    const nextEl = rules.next ? doc.querySelector(rules.next) : null;
    const next = nextEl?.getAttribute('href') ? new URL(nextEl.getAttribute('href'), base).toString() : null;
    return { title: pageTitle(doc) || null, items, next };
  },
};
