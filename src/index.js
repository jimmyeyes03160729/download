// Worker 進入點：/api/* 路由（其餘路徑由 Workers Static Assets 回傳 public/ 內的前端）
import { listAdapters } from './adapters/index.js';
import { validateRules } from './adapters/rules.js';
import { HttpError, getSession, isSetupDone, login, logoutCookie, requireSession, setup } from './auth.js';
import { encryptText } from './crypto.js';
import { DOMAIN_RE, clearSeen, extractUrl, listSites, markSeen, parseSubmitted, parseUserUrl } from './extract.js';
import { TYPE_LABELS } from './links.js';

const MAX_BODY = 6 * 1024 * 1024;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

async function readJson(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, '需要 JSON 格式');
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, '請求太大');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, '請求太大');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'JSON 格式錯誤');
  }
}

// 寫入類請求必須來自本站（搭配 SameSite cookie 防 CSRF）
function checkOrigin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('Origin');
  const self = new URL(request.url).origin;
  if (!origin || origin !== self) throw new HttpError(403, '來源不符', 'bad_origin');
}

function normalizeDomain(d) {
  const domain = String(d || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!DOMAIN_RE.test(domain)) throw new HttpError(400, '網域格式錯誤（例：example.com）');
  return domain;
}

async function handleSites(env, request, path) {
  if (request.method === 'GET' && path === '/api/sites') {
    const sites = (await listSites(env))
      .map((s) => ({
        domain: s.domain,
        adapter: s.adapter,
        rules: s.rules ? JSON.parse(s.rules) : null,
        note: s.note,
        hasCookie: !!s.cookie_enc,
        updated_at: s.updated_at,
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
    return json({ sites, adapters: listAdapters() });
  }
  if (request.method === 'PUT' && path === '/api/sites') {
    const body = await readJson(request);
    const domain = normalizeDomain(body.domain);
    const adapter = String(body.adapter || 'generic');
    if (!listAdapters().some((a) => a.id === adapter)) throw new HttpError(400, '未知的 adapter');
    let rules = null;
    if (adapter === 'rules') {
      try {
        rules = JSON.stringify(validateRules(typeof body.rules === 'string' ? JSON.parse(body.rules) : body.rules));
      } catch (e) {
        throw new HttpError(400, 'rules 設定錯誤：' + e.message);
      }
    }
    const note = body.note ? String(body.note).slice(0, 300) : null;
    const existing = await env.DB.prepare('SELECT cookie_enc FROM sites WHERE domain = ?').bind(domain).first();
    let cookieEnc = existing?.cookie_enc || null;
    if (typeof body.cookie === 'string') {
      const c = body.cookie.trim().replace(/^cookie:\s*/i, '');
      if (c) {
        if (!env.ENC_KEY || String(env.ENC_KEY).length < 16) throw new HttpError(500, '伺服器尚未設定 ENC_KEY', 'config');
        if (c.length > 8000 || /[\r\n]/.test(c)) throw new HttpError(400, 'Cookie 格式錯誤');
        cookieEnc = await encryptText(String(env.ENC_KEY), c);
      } else {
        cookieEnc = null; // 空字串 = 清除
      }
    }
    await env.DB.prepare(
      `INSERT INTO sites (domain, adapter, rules, cookie_enc, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET adapter = excluded.adapter, rules = excluded.rules,
         cookie_enc = excluded.cookie_enc, note = excluded.note, updated_at = excluded.updated_at`
    )
      .bind(domain, adapter, rules, cookieEnc, note, Date.now())
      .run();
    return json({ ok: true, domain });
  }
  if (request.method === 'DELETE' && path.startsWith('/api/sites/')) {
    const domain = normalizeDomain(decodeURIComponent(path.slice('/api/sites/'.length)));
    await env.DB.prepare('DELETE FROM sites WHERE domain = ?').bind(domain).run();
    return json({ ok: true });
  }
  return null;
}

async function handleSources(env, request, path) {
  if (request.method === 'GET' && path === '/api/sources') {
    const { results } = await env.DB.prepare('SELECT id, name, url FROM sources ORDER BY id').all();
    return json({ sources: results || [] });
  }
  if (request.method === 'POST' && path === '/api/sources') {
    const body = await readJson(request);
    const url = parseUserUrl(body.url).toString();
    const name = String(body.name || '').trim().slice(0, 60) || new URL(url).hostname;
    const r = await env.DB.prepare('INSERT INTO sources (name, url, created_at) VALUES (?, ?, ?)')
      .bind(name, url, Date.now())
      .run();
    return json({ ok: true, id: r.meta?.last_row_id });
  }
  if (request.method === 'DELETE' && /^\/api\/sources\/\d+$/.test(path)) {
    await env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(Number(path.split('/').pop())).run();
    return json({ ok: true });
  }
  return null;
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  checkOrigin(request);

  // ---- 不需登入 ----
  if (path === '/api/status' && request.method === 'GET') {
    const session = await getSession(env, request);
    return json({
      setupDone: await isSetupDone(env),
      setupTokenConfigured: !!env.SETUP_TOKEN,
      loggedIn: !!session,
      username: session?.username || null,
    });
  }
  if (path === '/api/setup' && request.method === 'POST') {
    const r = await setup(env, await readJson(request));
    return json({ ok: true, username: r.username });
  }
  if (path === '/api/login' && request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const r = await login(env, await readJson(request), ip);
    return json({ ok: true, username: r.username }, 200, { 'Set-Cookie': r.cookie });
  }
  if (path === '/api/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': logoutCookie() });
  }

  // ---- 以下需要登入 ----
  await requireSession(env, request);

  if (path === '/api/meta' && request.method === 'GET') {
    return json({ types: TYPE_LABELS, adapters: listAdapters() });
  }
  if (path === '/api/extract' && request.method === 'POST') {
    return json(await extractUrl(env, await readJson(request)));
  }
  if (path === '/api/parse' && request.method === 'POST') {
    return json(await parseSubmitted(env, await readJson(request)));
  }
  if (path === '/api/seen' && request.method === 'POST') {
    const body = await readJson(request);
    return json(await markSeen(env, body.sourceKey, body.keys));
  }
  if (path === '/api/seen' && request.method === 'DELETE') {
    const body = await readJson(request);
    return json(await clearSeen(env, body.sourceKey));
  }
  const sites = await handleSites(env, request, path);
  if (sites) return sites;
  const sources = await handleSources(env, request, path);
  if (sources) return sources;

  throw new HttpError(404, '找不到這個 API');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      console.error(e);
      return json({ error: '伺服器錯誤：' + (e?.message || e), code: 'internal' }, 500);
    }
  },
};
