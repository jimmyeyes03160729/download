// 抓取（白名單內網域）+ 解析 + 已讀比對
import { parseHTML } from 'linkedom';
import { getAdapter } from './adapters/index.js';
import discuz from './adapters/discuz.js';
import telegram from './adapters/telegram.js';
import { HttpError } from './auth.js';
import { decryptText } from './crypto.js';

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_PAGES = 10;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// 防爬 / 驗證頁的特徵：遇到就回報「被擋」，不嘗試繞過
const CHALLENGE_MARKERS = [
  '瀏覽器安全檢查',
  '浏览器安全检查',
  'cf-browser-verification',
  'challenge-platform',
  'cf_chl_opt',
  '<title>Just a moment...</title>',
  'Attention Required! | Cloudflare',
  'Please wait while we verify your browser',
];

export const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function parseUserUrl(input, { allowPort = false } = {}) {
  let s = String(input || '').trim();
  if (!s) throw new HttpError(400, '請輸入網址');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new HttpError(400, '網址格式錯誤');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, '只支援 http / https 網址');
  if (url.username || url.password) throw new HttpError(400, '網址不可包含帳密');
  if (!allowPort && url.port && url.port !== '80' && url.port !== '443') throw new HttpError(400, '不支援自訂連接埠');
  url.hash = '';
  return url;
}

export async function listSites(env) {
  const { results } = await env.DB.prepare('SELECT domain, adapter, rules, cookie_enc, note, updated_at FROM sites').all();
  return results || [];
}

// 依網域找設定，取最長吻合（例：www.eyny.com → eyny.com）
export async function findSite(env, hostname) {
  const host = hostname.toLowerCase();
  let best = null;
  for (const s of await listSites(env)) {
    if (host === s.domain || host.endsWith('.' + s.domain)) {
      if (!best || s.domain.length > best.domain.length) best = s;
    }
  }
  return best;
}

function siteAdapter(site, url) {
  if (site?.adapter) return getAdapter(site.adapter);
  if (telegram.match(url)) return telegram;
  return getAdapter('generic');
}

function siteRules(site) {
  if (!site?.rules) return null;
  try {
    return JSON.parse(site.rules);
  } catch {
    throw new HttpError(500, `網域 ${site.domain} 的 rules 不是合法 JSON`);
  }
}

function decodeBody(buf, contentType) {
  let charset = /charset=([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = new TextDecoder('utf-8').decode(buf.slice(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  charset = (charset || 'utf-8').toLowerCase();
  if (charset === 'gb2312') charset = 'gbk';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

async function fetchHtml(env, startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const site = await findSite(env, url.hostname);
    if (!site) throw new HttpError(403, `網域 ${url.hostname} 不在白名單內，請先到「設定」加入`, 'not_allowed');
    const headers = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.6',
    };
    if (site.cookie_enc) {
      if (!env.ENC_KEY) throw new HttpError(500, '伺服器尚未設定 ENC_KEY', 'config');
      headers.Cookie = await decryptText(String(env.ENC_KEY), site.cookie_enc);
    }
    let res;
    try {
      res = await fetch(url.toString(), { headers, redirect: 'manual' });
    } catch (e) {
      throw new HttpError(502, `連線失敗：${e.message}`, 'fetch_failed');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('Location')) {
      url = parseUserUrl(new URL(res.headers.get('Location'), url).toString());
      continue; // 下一圈會重新檢查白名單
    }
    const len = Number(res.headers.get('Content-Length') || 0);
    if (len > MAX_HTML_BYTES) throw new HttpError(413, '頁面太大（超過 5MB）');
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_HTML_BYTES) throw new HttpError(413, '頁面太大（超過 5MB）');
    const html = decodeBody(buf, res.headers.get('Content-Type'));
    const blocked =
      [403, 429, 503].includes(res.status) || CHALLENGE_MARKERS.some((m) => html.includes(m));
    if (blocked) {
      throw new HttpError(
        502,
        `${url.hostname} 回傳了防爬或驗證頁面（HTTP ${res.status}），伺服器無法直接讀取。請在瀏覽器開啟該頁面後使用「書籤小工具」匯入。`,
        'blocked'
      );
    }
    if (!res.ok) throw new HttpError(502, `${url.hostname} 回應 HTTP ${res.status}`, 'upstream_error');
    return { html, finalUrl: url, site };
  }
  throw new HttpError(502, '重新導向次數過多');
}

// 解析前先移除不需要的大區塊（script/style/svg），減少 CPU 時間
export function slimHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

// 回傳 { parsed, adapter }；未設定網域時若偵測到 Discuz! 會自動改用 discuz adapter
export function parseDocument(html, url, adapter, rules, { autodetect = false } = {}) {
  const { document } = parseHTML(slimHtml(html));
  if (autodetect && adapter.id === 'generic' && discuz.detect(document)) adapter = discuz;
  try {
    return { parsed: adapter.parse(document, url, { rules }), adapter };
  } catch (e) {
    throw new HttpError(422, `解析失敗（${adapter.id}）：${e.message}`, 'parse_failed');
  }
}

async function markNew(env, sourceKey, items) {
  const keys = items.map((i) => i.key);
  const seen = new Set();
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const q = `SELECT item_key FROM seen_items WHERE source_key = ? AND item_key IN (${chunk.map(() => '?').join(',')})`;
    const { results } = await env.DB.prepare(q).bind(sourceKey, ...chunk).all();
    for (const r of results || []) seen.add(r.item_key);
  }
  for (const it of items) it.isNew = !seen.has(it.key);
  return items;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
}

// 伺服器抓取模式
export async function extractUrl(env, { url: input, untilSeen = false, maxPages = 1 }) {
  let url = parseUserUrl(input);
  const firstSite = await findSite(env, url.hostname);
  let adapter = siteAdapter(firstSite, url);
  if (adapter.normalize) {
    try {
      url = adapter.normalize(url);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }

  const pagesLimit = Math.max(1, Math.min(MAX_PAGES, Number(untilSeen ? MAX_PAGES : maxPages) || 1));
  let all = [];
  let next = url.toString();
  let title = null;
  let pages = 0;
  let sourceKey = adapter.sourceKey(url);
  while (next && pages < pagesLimit) {
    const { html, finalUrl, site } = await fetchHtml(env, parseUserUrl(next));
    if (pages === 0 && site.domain !== firstSite?.domain) {
      adapter = siteAdapter(site, finalUrl);
      sourceKey = adapter.sourceKey(finalUrl);
    }
    const out = parseDocument(html, finalUrl, adapter, siteRules(site), { autodetect: pages === 0 });
    const parsed = out.parsed;
    if (out.adapter !== adapter) {
      adapter = out.adapter;
      sourceKey = adapter.sourceKey(finalUrl);
    }
    pages++;
    title = title || parsed.title;
    await markNew(env, sourceKey, parsed.items);
    all = all.concat(parsed.items);
    next = parsed.next;
    // 「翻到上次已讀處」：這一頁出現已讀項目就停
    if (untilSeen && parsed.items.some((i) => !i.isNew)) break;
    if (!parsed.items.length) break;
  }
  return {
    source: { key: sourceKey, adapter: adapter.id, title, url: url.toString(), mode: 'server' },
    items: dedupe(all),
    next,
    pages,
  };
}

// 書籤小工具模式：HTML 由使用者的瀏覽器送來，伺服器不對外連線
export async function parseSubmitted(env, { url: input, html }) {
  if (typeof html !== 'string' || !html) throw new HttpError(400, '沒有收到頁面內容');
  if (html.length > MAX_HTML_BYTES) throw new HttpError(413, '頁面太大（超過 5MB）');
  const url = parseUserUrl(input, { allowPort: true }); // 不對外連線，所以不限制連接埠
  const site = await findSite(env, url.hostname);
  const out = parseDocument(html, url, siteAdapter(site, url), siteRules(site), { autodetect: true });
  const { parsed, adapter } = out;
  const sourceKey = adapter.sourceKey(url);
  await markNew(env, sourceKey, parsed.items);
  return {
    source: { key: sourceKey, adapter: adapter.id, title: parsed.title, url: url.toString(), mode: 'bookmarklet' },
    items: dedupe(parsed.items),
    next: parsed.next,
    pages: 1,
  };
}

export async function markSeen(env, sourceKey, keys) {
  if (typeof sourceKey !== 'string' || !sourceKey || sourceKey.length > 500) throw new HttpError(400, 'sourceKey 錯誤');
  if (!Array.isArray(keys) || keys.length > 2000) throw new HttpError(400, 'keys 錯誤');
  const now = Date.now();
  const stmts = keys
    .filter((k) => typeof k === 'string' && k && k.length <= 1000)
    .map((k) => env.DB.prepare('INSERT OR IGNORE INTO seen_items (source_key, item_key, seen_at) VALUES (?, ?, ?)').bind(sourceKey, k, now));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { marked: stmts.length };
}

export async function clearSeen(env, sourceKey) {
  if (typeof sourceKey !== 'string' || !sourceKey) throw new HttpError(400, 'sourceKey 錯誤');
  await env.DB.prepare('DELETE FROM seen_items WHERE source_key = ?').bind(sourceKey).run();
  return { ok: true };
}
