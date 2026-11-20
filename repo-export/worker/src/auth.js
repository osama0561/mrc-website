// Per-person accounts: password hashing (PBKDF2 via Web Crypto, no node libs on Workers),
// signed session cookies (HMAC, keyed on SESSION_SECRET, not CRM_PASSWORD), and the
// login-fail rate limiting (by IP and by attempted phone number).

export const COOKIE = 'crm_s';
export const SESSION_DAYS = 14;
const PBKDF2_ITERATIONS = 100000;

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function pbkdf2(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, keyMaterial, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return { hash: toHex(hash), salt: toHex(salt) };
}

export async function verifyPassword(password, hashHex, saltHex) {
  if (!hashHex || !saltHex) return false;
  const hash = await pbkdf2(password, fromHex(saltHex));
  const expected = fromHex(hashHex);
  if (hash.length !== expected.length) return false;
  let d = 0;
  for (let i = 0; i < hash.length; i++) d |= hash[i] ^ expected[i];
  return d === 0;
}

// Constant-time-ish string compare (used for the one-time legacy bootstrap secret).
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(a)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(b)),
  ]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new Uint8Array([...b].map((c) => c.charCodeAt(0)));
}

async function hmac(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${env.SESSION_SECRET}|osama-crm-session`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

// Session cookie is a signed { id, role, name, e(xpiry) } — never trust a client-supplied user.
export async function makeSessionToken(env, user) {
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ id: user.id, role: user.role, name: user.name, e: Date.now() + SESSION_DAYS * 86400000 })));
  return `${payload}.${b64u(await hmac(env, payload))}`;
}

export function sessionCookieHeader(token, maxAgeSeconds) {
  if (!token) return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

async function readSessionToken(env, request) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  if (!(await safeEqual(sig, b64u(await hmac(env, payload))))) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    if (!(data.e > Date.now())) return null;
    return { id: String(data.id), role: String(data.role), name: String(data.name || '') };
  } catch (_) {
    return null;
  }
}

// Resolves the session cookie to the *current* user row, so a deactivated account
// loses access immediately rather than at the end of its 14-day token life.
export async function authenticate(env, request) {
  const claim = await readSessionToken(env, request);
  if (!claim) return null;
  const row = await env.CRM_DB.prepare('SELECT id, name, role, active FROM users WHERE id = ?').bind(claim.id).first();
  if (!row || !row.active) return null;
  return { id: row.id, role: row.role, name: row.name };
}

// ---------- login-fail rate limiting ----------
// 8 fails / 15 minutes locks that IP, and separately locks that attempted phone number,
// so one person's bad password doesn't lock out a whole shared office IP forever.
const WINDOW_MS = 15 * 60000;
const MAX_FAILS = 8;

function phoneKey(phone) {
  return `phone:${phone}`;
}

export async function isLocked(env, ip, phone) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const keys = [ip, phoneKey(phone)];
  for (const k of keys) {
    const row = await env.CRM_DB.prepare('SELECT COUNT(*) AS n FROM login_fail WHERE ip = ? AND at > ?').bind(k, since).first();
    if (row && row.n >= MAX_FAILS) return true;
  }
  return false;
}

export async function recordFail(env, ip, phone) {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - 86400000).toISOString();
  await env.CRM_DB.batch([
    env.CRM_DB.prepare('INSERT INTO login_fail (ip, at) VALUES (?, ?)').bind(ip, now),
    env.CRM_DB.prepare('INSERT INTO login_fail (ip, at) VALUES (?, ?)').bind(phoneKey(phone), now),
    env.CRM_DB.prepare('DELETE FROM login_fail WHERE at < ?').bind(cutoff),
  ]);
}

export function uuid() {
  return crypto.randomUUID();
}

// Login identifier: a plain name/username, not a real phone number (not everyone on the
// team has one on file). Case/space-insensitive so "Zyad" and "zyad" are the same login.
export function normUsername(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
}
