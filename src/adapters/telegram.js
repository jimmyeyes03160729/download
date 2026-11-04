// Telegram 公開頻道預覽頁（https://t.me/s/<頻道名>）
import { collectLinks, oneLine, textOf } from './util.js';

const TG_HOSTS = new Set(['t.me', 'telegram.me', 'www.t.me', 'www.telegram.me']);
const TITLE_RE = /^(?:名称|名稱|标题|標題|片名|资源名称|資源名稱|剧名|劇名)\s*[:：]\s*(.+)$/m;
const SIZE_RE = /(?:大小|容量|檔案大小|文件大小)\s*[:：]\s*([^\n]+)/;

export default {
  id: 'telegram',
  name: 'Telegram 頻道',
  match: (url) => TG_HOSTS.has(url.hostname),

  // 把各種 t.me 網址統一成 /s/<頻道> 預覽頁
  normalize(url) {
    const parts = url.pathname.split('/').filter(Boolean);
    let channel = parts[0] === 's' ? parts[1] : parts[0];
    if (!channel || !/^[A-Za-z0-9_]{3,64}$/.test(channel)) {
      throw new Error('看不懂這個 Telegram 網址，格式應為 https://t.me/s/頻道名');
    }
    const out = new URL(`https://t.me/s/${channel}`);
    for (const k of ['before', 'after', 'q']) {
      const v = url.searchParams.get(k);
      if (v) out.searchParams.set(k, v);
    }
    // 若網址是單則貼文 t.me/頻道/12345，改成從那則往前看
    const postNum = parts[0] === 's' ? parts[2] : parts[1];
    if (postNum && /^\d+$/.test(postNum) && !out.searchParams.has('before')) {
      out.searchParams.set('before', String(Number(postNum) + 1));
    }
    return out;
  },

  sourceKey(url) {
    const parts = url.pathname.split('/').filter(Boolean);
    return 'tg:' + (parts[0] === 's' ? parts[1] : parts[0]).toLowerCase();
  },

  parse(doc, url) {
    const items = [];
    const nodes = doc.querySelectorAll('.tgme_widget_message[data-post]');
    for (const msg of nodes) {
      const post = msg.getAttribute('data-post'); // 例：Quark_Movies/77647
      const textEl = msg.querySelector('.tgme_widget_message_text');
      const text = textOf(textEl);
      const linkRoot = msg.querySelector('.tgme_widget_message_bubble') || msg;
      // 只收內文與按鈕列的連結，不收頭像、日期、圖片連結
      const containers = [textEl, ...msg.querySelectorAll('.tgme_widget_message_inline_keyboard')].filter(Boolean);
      const links = [];
      const seen = new Set();
      for (const c of containers) {
        for (const l of collectLinks(c, url.toString(), { excludeHosts: ['t.me', 'telegram.me', 'telegram.org'] })) {
          if (!seen.has(l.url)) {
            seen.add(l.url);
            links.push(l);
          }
        }
      }
      if (!links.length) continue;

      const titleMatch = TITLE_RE.exec(text);
      const firstLine = text.split('\n').find((l) => l.trim()) || '';
      const sizeMatch = SIZE_RE.exec(text);
      let size = sizeMatch ? oneLine(sizeMatch[1], 40) : null;
      if (size && !/\d/.test(size)) size = null; // 頻道常填 X、N 之類的占位字
      const tags = [...new Set([...text.matchAll(/#([^\s#，,]+)/g)].map((m) => m[1]))];
      const time = linkRoot.querySelector('time[datetime]')?.getAttribute('datetime') || null;

      items.push({
        key: post,
        title: oneLine(titleMatch ? titleMatch[1] : firstLine, 160) || post,
        size,
        tags,
        date: time,
        postUrl: `https://t.me/${post}`,
        excerpt: oneLine(text, 300),
        links,
      });
    }
    items.reverse(); // 新的在前

    const more = doc.querySelector('a.tme_messages_more[data-before]');
    let next = null;
    if (more) {
      const n = new URL(url.toString());
      n.searchParams.delete('after');
      n.searchParams.set('before', more.getAttribute('data-before'));
      next = n.toString();
    }
    const channelTitle = oneLine(doc.querySelector('.tgme_channel_info_header_title')?.textContent || '', 80);
    return { title: channelTitle || null, items, next };
  },
};
