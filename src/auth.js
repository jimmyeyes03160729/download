// 一次性帳密 + session cookie + 登入失敗鎖定

import {
  PBKDF2_ITERATIONS,
  b64urlDecode,
  b64urlEncode,
  hashPassword,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from './crypto.js';

const SESSION_COOKIE = 'le_sid';
const SESSION_DAYS = 30;

// 失敗鎖定參數
const IP_MAX_FAILS = 5;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_LOCK_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAILS = 20;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_LOCK_MS = 30 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

function requireSecret(env, name) {
  const v = env[name];
  if (!v || String(v).length < 16) {
    throw new HttpError(500, `伺服器尚未設定 ${name}（請用 wrangler secret put ${name} 設定，至少 16 字元）`, 'config');
  }
  return String(v);
}

export async function getAuthRow(env) {
  return env.DB.prepare('SELECT username, salt, hash, iterations, created_at FROM auth WHERE id = 1').first();
}

export async function isSetupDone(env) {
  return !!(await getAuthRow(env));
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') throw new HttpError(400, '帳號密碼格式錯誤');
  const u = username.trim();
  if (u.length < 3 || u.length > 64) throw new HttpError(400, '帳號長度需為 3–64 字元');
  if (password.length < 10 || password.length > 256) throw new HttpError(400, '密碼長度需為 10–256 字元');
  return u;
}

export async function setup(env, body) {
  const token = requireSecret(env, 'SETUP_TOKEN');
  requireSecret(env, 'SESSION_SECRET');
  if (await isSetupDone(env)) throw new HttpError(403, '帳密已設定，無法再更動', 'setup_done');
  if (!body || !timingSafeEqual(String(body.setupToken || ''), token)) {
    throw new HttpError(403, '設定密語（SETUP_TOKEN）錯誤', 'bad_setup_token');
  }
  const username = validateCredentials(body.username, body.password);
  const salt = randomBytes(16);
  const hash = await hashPassword(body.password, salt, PBKDF2_ITERATIONS);
  const now = Date.now();
  // id 固定為 1：就算兩個請求同時進來，也只有一個能寫入成功
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO auth (id, username, salt, hash, iterations, created_at) VALUES (1, ?, ?, ?, ?, ?)'
  )
    .bind(username, b64urlEncode(salt), b64urlEncode(hash), PBKDF2_ITERATIONS, now)
    .run();
  if (!res.meta || res.meta.changes !== 1) throw new HttpError(403, '帳密已設定，無法再更動', 'setup_done');
  return { username, created_at: now };
}

async function getAttempt(env, key) {
  return env.DB.prepare('SELECT fails, window_start, locked_until FROM login_attempts WHERE key = ?').bind(key).first();
}

async function recordFail(env, key, maxFails, windowMs, lockMs) {
  const now = Date.now();
  const row = await getAttempt(env, key);
  let fails = 1;
  let windowStart = now;
  if (row && now - row.window_start < windowMs) {
    fails = row.fails + 1;
    windowStart = row.window_start;
  }
  const lockedUntil = fails >= maxFails ? now + lockMs : 0;
  await env.DB.prepare(
    `INSERT INTO login_attempts (key, fails, window_start, locked_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, window_start = excluded.window_start, locked_until = excluded.locked_until`
  )
    .bind(key, lockedUntil ? 0 : fails, lockedUntil ? now : windowStart, lockedUntil)
    .run();
}

async function checkLocked(env, key) {
  const row = await getAttempt(env, key);
  if (row && row.locked_until > Date.now()) {
    const mins = Math.ceil((row.locked_until - Date.now()) / 60000);
    throw new HttpError(429, `登入失敗次數過多，請 ${mins} 分鐘後再試`, 'locked');
  }
}

export async function login(env, body, ip) {
  const secret = requireSecret(env, 'SESSION_SECRET');
  const ipKey = 'ip:' + (ip || 'unknown');
  await checkLocked(env, '*');
  await checkLocked(env, ipKey);

  const row = await getAuthRow(env);
  if (!row) throw new HttpError(409, '尚未設定帳密', 'not_setup');

  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  // 不論帳號是否正確都跑一次雜湊，回應時間一致
  const hash = await hashPassword(password, b64urlDecode(row.salt), row.iterations);
  const ok = timingSafeEqual(username, row.username) & timingSafeEqual(hash, b64urlDecode(row.hash));

  if (!ok) {
    await recordFail(env, ipKey, IP_MAX_FAILS, IP_WINDOW_MS, IP_LOCK_MS);
    await recordFail(env, '*', GLOBAL_MAX_FAILS, GLOBAL_WINDOW_MS, GLOBAL_LOCK_MS);
    throw new HttpError(401, '帳號或密碼錯誤', 'bad_credentials');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(ipKey).run();

  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  // v = 帳密建立時間：若從 D1 刪除帳密重設，舊 session 全部失效
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ u: row.username, exp, v: row.created_at })));
  const sig = await sign(secret, payload);
  return { cookie: sessionCookie(`${payload}.${sig}`, SESSION_DAYS * 86400), username: row.username };
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function logoutCookie() {
  return sessionCookie('', 0);
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function getSession(env, request) {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw || !env.SESSION_SECRET) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  if (!(await verify(String(env.SESSION_SECRET), payload, sig))) return null;
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return null;
  }
  if (!data || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
  const row = await getAuthRow(env);
  if (!row || row.created_at !== data.v || row.username !== data.u) return null;
  return { username: data.u };
}

export async function requireSession(env, request) {
  const s = await getSession(env, request);
  if (!s) throw new HttpError(401, '請先登入', 'unauthorized');
  return s;
}
