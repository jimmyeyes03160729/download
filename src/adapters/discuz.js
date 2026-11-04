// Discuz! 論壇（EYNY 等）：版塊列表頁 + 文章內頁
import { magnetHash, magnetName, ed2kName, formatBytes } from '../links.js';
import { collectLinks, oneLine, pageTitle, textOf } from './util.js';

const ATTACH_RE = /(?:attachment\.php\?(?:[^"']*&)?aid=|mod=attachment(?:&|&amp;)(?:[^"']*&)?aid=)([^&"'#]+)/i;
const THREAD_RE = /(?:viewthread\.php\?(?:[^"']*&)?tid=(\d+)|mod=viewthread(?:&|&amp;)(?:[^"']*&)?tid=(\d+)|thread-(\d+)-\d+-\d+\.html)/i;
const FORUM_RE = /(?:forumdisplay\.php\?(?:[^"']*&)?fid=(\d+)|mod=forumdisplay(?:&|&amp;)(?:[^"']*&)?fid=(\d+)|forum-(\d+)-\d+\.html)/i;
const SIZE_RE = /\(?\s*(\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB|K|M|G))\b/i;

function threadId(href) {
  const m = THREAD_RE.exec(href || '');
  return m ? m[1] || m[2] || m[3] : null;
}

function forumId(href) {
  const m = FORUM_RE.exec(href || '');
  return m ? m[1] || m[2] || m[3] : null;
}

function isListPage(doc, url) {
  if (doc.querySelector('[id^="normalthread_"]')) return true;
  return !!forumId(url.toString()) && !threadId(url.toString());
}

function parseList(doc, url) {
  const rows = doc.querySelectorAll('[id^="normalthread_"], [id^="stickthread_"]');
  const items = [];
  const seen = new Set();
  const consider = (row, sticky) => {
    let best = null;
    for (const a of row.querySelectorAll('a[href]')) {
      const tid = threadId(a.getAttribute('href'));
      if (!tid) continue;
      const t = oneLine(textOf(a), 200);
      // 同一列裡可能有「分頁」等短連結，取文字最長的那個當標題
      if (!best || t.length > best.title.length) best = { tid, title: t, href: a.getAttribute('href') };
    }
    if (!best || seen.has(best.tid) || !best.title) return;
    seen.add(best.tid);
    const date =
      row.querySelector('td.by em span[title]')?.getAttribute('title') ||
      oneLine(row.querySelector('td.by em')?.textContent || '', 30) ||
      null;
    items.push({
      key: 'tid:' + best.tid,
      title: best.title,
      size: null,
      tags: sticky ? ['置頂'] : [],
      date,
      postUrl: new URL(best.href, url).toString(),
      links: [{ type: 'thread', url: new URL(best.href, url).toString(), label: '文章', code: null }],
    });
  };
  if (rows.length) {
    for (const r of rows) consider(r, r.id.startsWith('stickthread_'));
  } else {
    // 舊版或改版過的模板：退回掃全頁的文章連結
    for (const a of doc.querySelectorAll('a[href]')) consider({ querySelectorAll: () => [a], querySelector: () => null, id: '' }, false);
  }
  return {
    title: oneLine(doc.querySelector('#ct h1, .bm_h h1, h1')?.textContent || pageTitle(doc), 120) || null,
    items,
    next: nextLink(doc, url),
  };
}

function nextLink(doc, url) {
  const a = doc.querySelector('a.nxt[href], .pg a.nxt[href], a.next[href]');
  return a ? new URL(a.getAttribute('href'), url).toString() : null;
}

function parseThread(doc, url) {
  const subject =
    oneLine(doc.querySelector('#thread_subject')?.textContent || '', 200) ||
    oneLine(doc.querySelector('h1')?.textContent || '', 200) ||
    pageTitle(doc);
  let posts = [...doc.querySelectorAll('[id^="post_"]')].filter((el) => /^post_\d+$/.test(el.id));
  if (!posts.length) posts = [...doc.querySelectorAll('table[id^="pid"]')];
  if (!posts.length) posts = [doc.body || doc.documentElement];

  const items = [];
  const seen = new Set();
  const add = (item) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };

  for (const post of posts) {
    const pid = (post.id || '').replace(/\D/g, '') || null;
    // 1) 附件（.torrent 等）
    for (const a of post.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      const m = ATTACH_RE.exec(href);
      if (!m) continue;
      const name = oneLine(textOf(a), 200);
      if (!name || a.querySelector('img') && !/\.\w{2,5}$/.test(name)) continue;
      const around = textOf(a.parentNode?.parentNode || a.parentNode) || '';
      const sm = SIZE_RE.exec(around.slice(around.indexOf(name) + name.length));
      const abs = new URL(href, url).toString();
      add({
        key: 'aid:' + m[1],
        title: name,
        size: sm ? sm[1] : null,
        tags: [],
        date: null,
        postUrl: pid ? `${url.origin}${url.pathname}${url.search}#pid${pid}` : url.toString(),
        links: [{ type: /\.torrent$/i.test(name) ? 'torrent' : 'other', url: abs, label: name, code: null }],
        subject,
      });
    }
    // 2) 內文中的 magnet / ed2k / 網盤連結
    const body = post.querySelector('[id^="postmessage_"], .t_f, .t_msgfont') || post;
    for (const l of collectLinks(body, url.toString(), { includeOther: false })) {
      if (ATTACH_RE.test(l.url)) continue;
      let title = subject;
      let size = null;
      let key = l.url;
      if (l.type === 'magnet') {
        title = magnetName(l.url) || subject;
        key = 'btih:' + (magnetHash(l.url) || l.url);
      } else if (l.type === 'ed2k') {
        const e = ed2kName(l.url);
        if (e) {
          title = e.name;
          size = formatBytes(e.size);
        }
      } else if (l.label && l.label !== l.url) {
        title = `${subject}（${l.label}）`;
      }
      add({ key, title: oneLine(title, 200), size, tags: [], date: null, postUrl: url.toString(), links: [l], subject });
    }
  }
  return { title: subject || null, items, next: nextLink(doc, url) };
}

export default {
  id: 'discuz',
  name: 'Discuz! 論壇',
  match: () => false, // 由 sites 表指定，或由 detect() 自動判斷

  // 沒有設定過的網域：看頁面特徵判斷是不是 Discuz!
  detect(doc) {
    const gen = doc.querySelector('meta[name="generator"]')?.getAttribute('content') || '';
    return /discuz/i.test(gen) || !!doc.querySelector('#postlist [id^="post_"], [id^="normalthread_"]');
  },

  sourceKey(url) {
    const s = url.toString();
    const tid = threadId(s);
    if (tid) return `dz:${url.hostname}:t${tid}`;
    const fid = forumId(s);
    if (fid) return `dz:${url.hostname}:f${fid}`;
    return `dz:${url.hostname}${url.pathname}`;
  },

  parse(doc, url) {
    return isListPage(doc, url) ? parseList(doc, url) : parseThread(doc, url);
  },
};
