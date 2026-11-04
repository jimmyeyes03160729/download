// Web Crypto 工具：密碼雜湊、HMAC 簽章、AES-GCM 加密

const enc = new TextEncoder();
const dec = new TextDecoder();

// Cloudflare Workers 的 PBKDF2 迭代次數上限是 100,000
export const PBKDF2_ITERATIONS = 100000;

export function b64urlEncode(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// 長度固定的比較，避免時間側通道
export function timingSafeEqual(a, b) {
  const x = a instanceof Uint8Array ? a : enc.encode(String(a));
  const y = b instanceof Uint8Array ? b : enc.encode(String(b));
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i % x.length] || 0) ^ (y[i % y.length] || 0);
  return diff === 0;
}

export async function hashPassword(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function sign(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64urlEncode(sig);
}

export async function verify(secret, data, sigB64) {
  const key = await hmacKey(secret);
  let sig;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(data));
}

async function aesKey(secret) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('link-extractor/aes/' + secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptText(secret, plaintext) {
  const iv = randomBytes(12);
  const key = await aesKey(secret);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return b64urlEncode(iv) + '.' + b64urlEncode(ct);
}

export async function decryptText(secret, payload) {
  const [ivB64, ctB64] = String(payload).split('.');
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(ivB64) }, key, b64urlDecode(ctB64));
  return dec.decode(pt);
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
