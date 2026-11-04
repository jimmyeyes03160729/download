// 連結分類與從純文字中抓取連結

const TYPES = [
  { type: 'quark', label: '夸克', test: (u) => /(^|\.)pan\.quark\.cn$/.test(u.hostname) },
  { type: 'baidu', label: '百度', test: (u) => /(^|\.)pan\.baidu\.com$/.test(u.hostname) },
  { type: 'aliyun', label: '阿里', test: (u) => /(^|\.)(alipan\.com|aliyundrive\.com)$/.test(u.hostname) },
  { type: 'xunlei', label: '迅雷', test: (u) => /(^|\.)pan\.xunlei\.com$/.test(u.hostname) },
  { type: '115', label: '115', test: (u) => /(^|\.)(115\.com|115cdn\.com|anxia\.com)$/.test(u.hostname) },
  { type: '123pan', label: '123盤', test: (u) => /(^|\.)(123pan\.com|123pan\.cn|123684\.com|123865\.com|123912\.com)$/.test(u.hostname) },
  { type: 'uc', label: 'UC', test: (u) => /(^|\.)drive\.uc\.cn$/.test(u.hostname) },
  { type: 'tianyi', label: '天翼', test: (u) => /(^|\.)cloud\.189\.cn$/.test(u.hostname) },
  { type: 'mega', label: 'MEGA', test: (u) => /(^|\.)mega\.(nz|io)$/.test(u.hostname) },
  { type: 'gdrive', label: 'Google Drive', test: (u) => /(^|\.)drive\.google\.com$/.test(u.hostname) },
  { type: 'onedrive', label: 'OneDrive', test: (u) => /(^|\.)(1drv\.ms|onedrive\.live\.com)$/.test(u.hostname) },
  { type: 'mediafire', label: 'MediaFire', test: (u) => /(^|\.)mediafire\.com$/.test(u.hostname) },
  {
    type: 'torrent',
    label: 'Torrent',
    test: (u, text) =>
      /\.torrent$/i.test(u.pathname) || /\.torrent\b/i.test(text || ''),
  },
];

export const TYPE_LABELS = Object.fromEntries([
  ...TYPES.map((t) => [t.type, t.label]),
  ['magnet', 'Magnet'],
  ['ed2k', 'ed2k'],
  ['thread', '文章'],
  ['other', '其他'],
]);

export const DOWNLOAD_TYPES = new Set([...TYPES.map((t) => t.type), 'magnet', 'ed2k']);

// 純文字中的連結
const TEXT_LINK_RE = /(magnet:\?xt=urn:bt[im]h:[a-zA-Z0-9]{32,40}[^\s"'<>]*|ed2k:\/\/\|file\|[^\s"'<>]+?\|\/|https?:\/\/[^\s"'<>，。、）)\]]+)/g;
const CODE_RE = /(?:提取码|提取碼|密码|密碼|访问码|訪問碼|pwd|code)\s*[:：=]?\s*([A-Za-z0-9]{4,8})/i;

export function classify(href, text = '') {
  if (!href) return null;
  const h = String(href).trim();
  if (/^magnet:\?/i.test(h)) return 'magnet';
  if (/^ed2k:\/\//i.test(h)) return 'ed2k';
  let u;
  try {
    u = new URL(h);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  for (const t of TYPES) if (t.test(u, text)) return t.type;
  return 'other';
}

export function magnetName(href) {
  try {
    const dn = new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('dn');
    return dn || null;
  } catch {
    return null;
  }
}

export function magnetHash(href) {
  const m = /urn:bt[im]h:([a-zA-Z0-9]{32,40})/i.exec(href);
  return m ? m[1].toLowerCase() : null;
}

export function ed2kName(href) {
  const m = /^ed2k:\/\/\|file\|([^|]+)\|(\d+)\|/i.exec(href);
  if (!m) return null;
  try {
    return { name: decodeURIComponent(m[1]), size: Number(m[2]) };
  } catch {
    return { name: m[1], size: Number(m[2]) };
  }
}

export function findTextLinks(text) {
  const out = [];
  if (!text) return out;
  for (const m of text.matchAll(TEXT_LINK_RE)) out.push(m[0].replace(/[.,;:!?]+$/, ''));
  return out;
}

// 在連結附近（同一段文字）找提取碼
export function findCode(text) {
  const m = CODE_RE.exec(text || '');
  return m ? m[1] : null;
}

// 從網址 query 裡的 pwd= 參數取提取碼
export function codeFromUrl(href) {
  try {
    const u = new URL(href);
    return u.searchParams.get('pwd') || u.searchParams.get('password') || null;
  } catch {
    return null;
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

// 將連結物件化，失敗回 null
export function makeLink(href, { base, text = '', context = '' } = {}) {
  if (!href) return null;
  let url = String(href).trim();
  if (!/^(magnet|ed2k):/i.test(url)) url = absolutize(url, base);
  if (!url) return null;
  const type = classify(url, text);
  if (!type) return null;
  const link = { type, url, label: (text || '').trim().slice(0, 200) || null, code: null };
  if (type !== 'magnet' && type !== 'ed2k' && type !== 'other' && type !== 'torrent') {
    link.code = codeFromUrl(url) || findCode(context);
  }
  return link;
}
