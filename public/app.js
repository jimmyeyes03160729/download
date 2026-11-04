// 連結擷取器前端（無框架，全部以 textContent 建立 DOM，不插入任何外部 HTML）

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  types: {},
  adapters: [],
  result: null, // { source, items, next }
  selected: new Set(),
  pendingImport: null,
  importMode: location.hash === '#import',
};

// ---------- 共用 ----------
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.code = data?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2500);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

function showView(name) {
  for (const v of ['loading', 'setup', 'login', 'app']) $(`#view-${v}`).hidden = v !== name;
}

function showMsg(sel, msg) {
  const p = $(sel);
  p.textContent = msg || '';
  p.hidden = !msg;
}

// 只允許安全的連結協定
function safeHref(url) {
  return /^(https?:|magnet:\?|ed2k:\/\/)/i.test(url) ? url : null;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', {}, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// ---------- 啟動 ----------
async function init() {
  if (state.importMode) listenImport();
  let status;
  try {
    status = await api('/api/status');
  } catch (e) {
    showView('loading');
    $('#view-loading p').textContent = '無法連線到伺服器：' + e.message;
    return;
  }
  if (!status.setupDone) {
    showView('setup');
    if (!status.setupTokenConfigured) showMsg('#setup-msg', '伺服器尚未設定 SETUP_TOKEN，請先用 wrangler secret put SETUP_TOKEN 設定');
    return;
  }
  if (!status.loggedIn) {
    showView('login');
    return;
  }
  await enterApp(status.username);
}

async function enterApp(username) {
  showView('app');
  $('#whoami').textContent = username || '';
  const meta = await api('/api/meta');
  state.types = meta.types;
  state.adapters = meta.adapters;
  const sel = $('#f-type');
  sel.length = 1;
  for (const [k, v] of Object.entries(state.types)) sel.append(el('option', { value: k, text: v }));
  const asel = $('#site-adapter');
  asel.textContent = '';
  for (const a of state.adapters) {
    // 新增網域時預設用「通用」（表單 reset 也會回到這個選項）
    asel.append(el('option', { value: a.id, selected: a.id === 'generic', text: `${a.name}（${a.id}）` }));
  }
  setupBookmarklet();
  loadSources();
  if (state.importMode) {
    $('#import-wait').hidden = !!state.pendingImport;
    if (state.pendingImport) runImport(state.pendingImport);
    else $('#import-wait').hidden = false;
  }
}

// ---------- 設定 / 登入 ----------
$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get('password') !== f.get('password2')) return showMsg('#setup-msg', '兩次輸入的密碼不一致');
  if (!confirm('確定建立？帳密設定後網站上無法再更改。')) return;
  try {
    await api('/api/setup', {
      method: 'POST',
      body: { setupToken: f.get('setupToken'), username: f.get('username'), password: f.get('password') },
    });
    toast('帳密已建立，請登入');
    showView('login');
  } catch (err) {
    showMsg('#setup-msg', err.message);
  }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('/api/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    e.target.reset();
    showMsg('#login-msg', '');
    await enterApp(r.username);
  } catch (err) {
    showMsg('#login-msg', err.message);
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.hash = '';
  location.reload();
});

// ---------- 分頁 ----------
for (const b of $$('.tab')) {
  b.addEventListener('click', () => {
    for (const x of $$('.tab')) x.classList.toggle('active', x === b);
    for (const p of $$('.tab-panel')) p.hidden = p.id !== `tab-${b.dataset.tab}`;
    if (b.dataset.tab === 'settings') loadSites();
  });
}

// ---------- 常用來源 ----------
async function loadSources() {
  const box = $('#sources');
  box.textContent = '';
  const { sources } = await api('/api/sources');
  for (const s of sources) {
    box.append(
      el(
        'span',
        { class: 'chip' },
        el('button', { type: 'button', class: 'chip-main', title: s.url, text: s.name, onclick: () => runExtract(s.url) }),
        el('button', {
          type: 'button',
          class: 'chip-x',
          title: '刪除',
          text: '×',
          onclick: async () => {
            if (!confirm(`刪除常用來源「${s.name}」？`)) return;
            await api(`/api/sources/${s.id}`, { method: 'DELETE' });
            loadSources();
          },
        })
      )
    );
  }
}

$('#save-source-btn').addEventListener('click', async () => {
  const url = $('#url-input').value.trim();
  if (!url) return toast('請先輸入網址', true);
  const name = prompt('來源名稱', state.result?.source?.title || '');
  if (name === null) return;
  try {
    await api('/api/sources', { method: 'POST', body: { name, url } });
    loadSources();
    toast('已加入常用來源');
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------- 擷取 ----------
$('#extract-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runExtract($('#url-input').value);
});

async function runExtract(url, { append = false } = {}) {
  const btn = append ? $('#more-btn') : $('#extract-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '讀取中…';
  if (!append) $('#url-input').value = url;
  try {
    const r = await api('/api/extract', {
      method: 'POST',
      body: { url, untilSeen: !append && $('#until-seen').checked },
    });
    showResult(r, append);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$('#more-btn').addEventListener('click', () => {
  if (state.result?.next) runExtract(state.result.next, { append: true });
});

function showResult(r, append) {
  if (append && state.result && state.result.source.key === r.source.key) {
    const have = new Set(state.result.items.map((i) => i.key));
    state.result.items.push(...r.items.filter((i) => !have.has(i.key)));
    state.result.next = r.next;
  } else {
    state.result = r;
    state.selected.clear();
  }
  $('#results').hidden = false;
  $('#import-wait').hidden = true;
  render();
}

// ---------- 篩選與表格 ----------
function matchesFilter(item) {
  const typ = $('#f-type').value;
  if (typ && !item.links.some((l) => l.type === typ)) return false;
  if ($('#f-new').checked && !item.isNew) return false;
  const terms = $('#f-text').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [item.title, item.excerpt || '', ...(item.tags || []).map((t) => '#' + t)].join(' ').toLowerCase();
  for (const t of terms) {
    if (t.startsWith('-') && t.length > 1) {
      if (hay.includes(t.slice(1))) return false;
    } else if (!hay.includes(t)) return false;
  }
  return true;
}

function visibleItems() {
  return (state.result?.items || []).filter(matchesFilter);
}

for (const id of ['#f-text', '#f-type', '#f-new']) $(id).addEventListener('input', render);

function render() {
  const r = state.result;
  if (!r) return;
  const items = visibleItems();
  const newCount = r.items.filter((i) => i.isNew).length;
  $('#res-title').textContent = r.source.title || r.source.url;
  $('#res-meta').textContent =
    `${r.items.length} 筆（新 ${newCount} 筆）・解析：${r.source.adapter}・` +
    (r.source.mode === 'bookmarklet' ? '書籤匯入' : '伺服器抓取') +
    (r.pages > 1 ? `・${r.pages} 頁` : '');
  $('#more-btn').hidden = !r.next || r.source.mode === 'bookmarklet';

  const body = $('#items-body');
  body.textContent = '';
  for (const item of items) body.append(renderRow(item));
  $('#empty-msg').hidden = items.length > 0;
  $('#check-all').checked = items.length > 0 && items.every((i) => state.selected.has(i.key));
}

function renderRow(item) {
  const cb = el('input', {
    type: 'checkbox',
    checked: state.selected.has(item.key),
    onchange: (e) => (e.target.checked ? state.selected.add(item.key) : state.selected.delete(item.key)),
  });
  const titleLink = safeHref(item.postUrl)
    ? el('a', { href: item.postUrl, target: '_blank', rel: 'noopener noreferrer', text: item.title })
    : el('span', { text: item.title });
  const metaParts = [];
  if (item.date) metaParts.push(formatDate(item.date));
  const tags = (item.tags || []).slice(0, 8).map((t) =>
    el('button', {
      type: 'button',
      class: 'tag',
      text: '#' + t,
      onclick: () => {
        $('#f-text').value = '#' + t;
        render();
      },
    })
  );
  const titleCell = el(
    'td',
    { class: 'c-title' },
    el('div', {}, item.isNew ? el('span', { class: 'badge-new', text: 'NEW' }) : null, titleLink),
    metaParts.length || tags.length ? el('div', { class: 'sub' }, el('span', { class: 'muted', text: metaParts.join(' ') }), tags) : null
  );
  const linksCell = el('td', { class: 'c-links' }, item.links.map((l) => renderLink(l)));
  return el(
    'tr',
    { class: item.isNew ? 'is-new' : '' },
    el('td', { class: 'c-check' }, cb),
    titleCell,
    el('td', { class: 'c-size', text: item.size || '' }),
    linksCell
  );
}

function renderLink(l) {
  const label = state.types[l.type] || l.type;
  const href = safeHref(l.url);
  if (!href) return null;
  const wrap = el('div', { class: 'link' });
  if (l.type === 'thread') {
    wrap.append(
      el('button', { type: 'button', class: 'btn small primary', text: '解析這篇', onclick: () => runExtract(l.url) }),
      el('a', { class: 'btn small ghost', href, target: '_blank', rel: 'noopener noreferrer', text: '開啟' })
    );
    return wrap;
  }
  const isProto = /^(magnet|ed2k):/i.test(href);
  wrap.append(
    el('a', {
      class: `btn small type-${l.type}`,
      href,
      target: isProto ? null : '_blank',
      rel: 'noopener noreferrer',
      title: l.url,
      text: label,
    }),
    el('button', {
      type: 'button',
      class: 'btn small ghost',
      title: '複製連結',
      text: '複製',
      onclick: async () => {
        await copyText(l.code ? `${l.url} 提取碼：${l.code}` : l.url);
        toast('已複製');
      },
    })
  );
  if (l.code) wrap.append(el('span', { class: 'code', text: `提取碼 ${l.code}` }));
  return wrap;
}

function formatDate(s) {
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

$('#check-all').addEventListener('change', (e) => {
  for (const i of visibleItems()) e.target.checked ? state.selected.add(i.key) : state.selected.delete(i.key);
  render();
});

function selectedItems() {
  const items = visibleItems().filter((i) => state.selected.has(i.key));
  return items.length ? items : null;
}

function downloadLinks(items) {
  return items.flatMap((i) => i.links.filter((l) => l.type !== 'thread' && safeHref(l.url)));
}

$('#copy-btn').addEventListener('click', async () => {
  const items = selectedItems();
  if (!items) return toast('請先勾選項目', true);
  const lines = downloadLinks(items).map((l) => (l.code ? `${l.url} 提取碼：${l.code}` : l.url));
  await copyText(lines.join('\n'));
  toast(`已複製 ${lines.length} 條連結`);
});

$('#open-btn').addEventListener('click', () => {
  const items = selectedItems();
  if (!items) return toast('請先勾選項目', true);
  const links = downloadLinks(items);
  if (links.length > 15 && !confirm(`要一次開啟 ${links.length} 個連結嗎？`)) return;
  let blocked = 0;
  for (const l of links) {
    if (/^(magnet|ed2k):/i.test(l.url)) {
      // magnet 交給系統預設的 BT 軟體
      const a = el('a', { href: l.url });
      document.body.append(a);
      a.click();
      a.remove();
    } else if (!window.open(l.url, '_blank', 'noopener,noreferrer')) {
      blocked++;
    }
  }
  if (blocked) toast('瀏覽器擋下了部分彈出視窗，請允許此網站開啟彈出視窗', true);
});

$('#mark-all-btn').addEventListener('click', async () => {
  const r = state.result;
  if (!r) return;
  const keys = r.items.filter((i) => i.isNew).map((i) => i.key);
  if (!keys.length) return toast('沒有新項目');
  try {
    await api('/api/seen', { method: 'POST', body: { sourceKey: r.source.key, keys } });
    for (const i of r.items) i.isNew = false;
    render();
    toast(`已標記 ${keys.length} 筆為已讀`);
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------- 書籤小工具 ----------
function bookmarkletCode() {
  const O = location.origin;
  const src = `(function(){var O=${JSON.stringify(O)};var w=window.open(O+'/#import','_blank');if(!w){alert('請允許彈出視窗');return}var d={type:'le-import',url:location.href,html:document.documentElement.outerHTML};var n=0;var t=setInterval(function(){try{w.postMessage(d,O)}catch(e){}if(++n>80)clearInterval(t)},250);window.addEventListener('message',function(e){if(e.origin===O&&e.data==='le-ack')clearInterval(t)})})();`;
  return 'javascript:' + src;
}

function setupBookmarklet() {
  const code = bookmarkletCode();
  $('#bookmarklet').setAttribute('href', code);
  $('#bookmarklet').addEventListener('click', (e) => {
    e.preventDefault();
    toast('請把這個按鈕拖到書籤列，在要擷取的頁面上點書籤');
  });
  $('#bookmarklet-code').value = code;
}

function listenImport() {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'le-import' || typeof d.url !== 'string' || typeof d.html !== 'string') return;
    // 只接受「送出頁面的網址」與「訊息來源」一致的內容
    let claimed;
    try {
      claimed = new URL(d.url);
    } catch {
      return;
    }
    if (claimed.origin !== e.origin) return;
    try {
      e.source?.postMessage('le-ack', e.origin);
    } catch {
      /* ignore */
    }
    if (state.pendingImport?.url === d.url) return; // 重送的同一份
    state.pendingImport = { url: d.url, html: d.html };
    if (!$('#view-app').hidden) runImport(state.pendingImport);
  });
}

async function runImport(data) {
  $('#import-wait').hidden = false;
  $('#import-wait').textContent = `正在解析 ${new URL(data.url).hostname} 送來的頁面…`;
  $('#url-input').value = data.url;
  try {
    const r = await api('/api/parse', { method: 'POST', body: data });
    showResult(r, false);
  } catch (e) {
    $('#import-wait').textContent = '解析失敗：' + e.message;
  }
}

// ---------- 網域設定 ----------
async function loadSites() {
  const { sites } = await api('/api/sites');
  const body = $('#sites-body');
  body.textContent = '';
  for (const s of sites) {
    body.append(
      el(
        'tr',
        {},
        el('td', { text: s.domain }),
        el('td', { text: s.adapter }),
        el('td', { text: s.hasCookie ? '已設定' : '—' }),
        el('td', { class: 'muted small', text: s.note || '' }),
        el(
          'td',
          { class: 'nowrap' },
          el('button', { type: 'button', class: 'btn small', text: '編輯', onclick: () => editSite(s) }),
          el('button', {
            type: 'button',
            class: 'btn small ghost danger',
            text: '刪除',
            onclick: async () => {
              if (!confirm(`從白名單移除 ${s.domain}？`)) return;
              await api(`/api/sites/${encodeURIComponent(s.domain)}`, { method: 'DELETE' });
              loadSites();
            },
          })
        )
      )
    );
  }
}

function editSite(s) {
  const f = $('#site-form');
  f.domain.value = s.domain;
  f.adapter.value = s.adapter;
  f.rules.value = s.rules ? JSON.stringify(s.rules, null, 2) : '';
  f.cookie.value = '';
  f.clearCookie.checked = false;
  f.note.value = s.note || '';
  toggleRules();
  $('#site-form-title').textContent = `編輯 ${s.domain}`;
  f.scrollIntoView({ behavior: 'smooth' });
}

function toggleRules() {
  $('#rules-field').hidden = $('#site-adapter').value !== 'rules';
}
$('#site-adapter').addEventListener('change', toggleRules);
$('#site-form').addEventListener('reset', () => {
  $('#site-form-title').textContent = '新增 / 編輯網域';
  setTimeout(toggleRules);
  showMsg('#site-msg', '');
});

$('#site-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { domain: f.domain.value, adapter: f.adapter.value, note: f.note.value };
  if (body.adapter === 'rules') body.rules = f.rules.value;
  if (f.clearCookie.checked) body.cookie = '';
  else if (f.cookie.value.trim()) body.cookie = f.cookie.value.trim();
  try {
    await api('/api/sites', { method: 'PUT', body });
    showMsg('#site-msg', '');
    f.reset();
    toast('已儲存');
    loadSites();
  } catch (err) {
    showMsg('#site-msg', err.message);
  }
});

init();
