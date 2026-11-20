// osama-crm worker: API + static asset serving + the 10-minute Sheets mirror cron.
// Cleaned up from a recovered esbuild bundle and extended with real per-person accounts
// and server-side ownership scoping. See README.md for what changed vs the old system.

import {
  STAGES, LOST_REASONS, CALL_OUTCOMES, ACTIVITY_KINDS, stageIndex, stageOf, stageFromLegacy,
} from './shared.js';
import { loadLeads, riyadhStamp } from './leads.js';
import { kitSnapshot } from './kit.js';
import { publerSnapshot } from './publer.js';
import {
  SESSION_DAYS, hashPassword, verifyPassword, safeEqual, makeSessionToken,
  sessionCookieHeader, authenticate, isLocked, recordFail, uuid, normUsername,
} from './auth.js';
import { STATIC_FILES } from './static-files.js';

// Served directly from the worker instead of an ASSETS binding (no separate asset upload
// step needed). SPA fallback: an unknown path that isn't a static file name gets index.html.
function serveStatic(pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  let file = STATIC_FILES[p];
  if (!file) file = STATIC_FILES['/index.html'];
  const body = 'b64' in file
    ? Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0))
    : file.text;
  return new Response(body, { headers: { 'Content-Type': file.contentType } });
}

const TRACK_TAB = 'متابعة المبيعات';
const MIRROR_TAB = 'مراحل الصفقات';
const MIRROR_HEAD = ['المفتاح', 'النشاط', 'الاسم', 'المرحلة', 'المسؤول', 'القيمة (ر.س)', 'الخطوة القادمة', 'موعدها', 'سبب الخسارة', 'آخر تحديث', 'بواسطة'];

export default {
  // Every 10 minutes: rewrite the CRM's own Sheet tab from the database, so Osama sees stages in Sheets.
  async scheduled(event, env, ctx) {
    if (!env.CRM_DB) return;
    await ensureSchema(env);
    ctx.waitUntil(mirrorAll(env).catch((e) => console.error('mirror failed', String(e))));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname);
    try {
      return await api(request, env, ctx, url);
    } catch (err) {
      console.error('crm error', (err && err.stack) || String(err));
      return json({ ok: false, error: 'server' }, 500);
    }
  },
};

async function api(request, env, ctx, url) {
  const p = url.pathname.replace(/\/+$/, '');
  if (!env.CRM_DB || !env.SESSION_SECRET) return json({ ok: false, error: 'not_configured' }, 503);
  if (request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (!origin || origin !== url.origin) return json({ ok: false, error: 'origin' }, 403);
    if (!/^application\/json/.test(request.headers.get('Content-Type') || '')) return json({ ok: false, error: 'type' }, 415);
  }
  await ensureSchema(env);

  // ---- one-time bootstrap: create the first manager account, keyed on the legacy CRM_PASSWORD ----
  if (p === '/api/setup' && request.method === 'POST') return setup(env, await readJson(request));

  if (p === '/api/login' && request.method === 'POST') return login(env, request, await readJson(request));
  if (p === '/api/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookieHeader(null) });
  }

  const user = await authenticate(env, request);
  if (!user) return json({ ok: false, error: 'auth' }, 401);

  if (p === '/api/data' && request.method === 'GET') return json(await loadAll(env, user));
  if (p === '/api/deal' && request.method === 'POST') return json(await saveDeal(env, ctx, user, await readJson(request)));
  if (p === '/api/activity' && request.method === 'POST') return json(await addActivity(env, user, await readJson(request)));
  if (p === '/api/settings' && request.method === 'POST') {
    if (user.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    return json(await saveSettings(env, await readJson(request)));
  }
  if (p === '/api/users' && request.method === 'GET') {
    if (user.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    return json(await listUsers(env));
  }
  if (p === '/api/users' && request.method === 'POST') {
    if (user.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    return json(await usersAction(env, await readJson(request)));
  }
  if (p === '/api/sources/kit' && request.method === 'GET') return json(await cached(env, 'kit', 30, () => kitSnapshot(env), url.searchParams.has('fresh')));
  if (p === '/api/sources/publer' && request.method === 'GET') return json(await cached(env, 'publer', 30, () => publerSnapshot(env), url.searchParams.has('fresh')));
  return json({ ok: false, error: 'not found' }, 404);
}

// ---------- database schema ----------
// This is the target shape for a brand-new DB. An existing live DB is brought up to this
// shape once with migrations/0001_users_and_ownership.sql (ALTER TABLE, not safe to repeat
// here since CREATE TABLE IF NOT EXISTS can't add columns to an already-existing table).
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.CRM_DB.batch([
    env.CRM_DB.prepare(`CREATE TABLE IF NOT EXISTS deals (
      lead_id TEXT NOT NULL, business TEXT NOT NULL, stage TEXT NOT NULL, max_idx INTEGER NOT NULL DEFAULT 0,
      owner TEXT NOT NULL DEFAULT '', owner_user_id TEXT, value_sar REAL, next_step TEXT NOT NULL DEFAULT '', next_step_at TEXT NOT NULL DEFAULT '',
      lost_reason TEXT NOT NULL DEFAULT '', fp TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, stage_at TEXT NOT NULL, won_at TEXT, closed_at TEXT,
      updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (lead_id, business))`),
    env.CRM_DB.prepare(`CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, business TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, user_id TEXT,
      kind TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', from_stage TEXT, to_stage TEXT)`),
    env.CRM_DB.prepare('CREATE TABLE IF NOT EXISTS login_fail (ip TEXT NOT NULL, at TEXT NOT NULL)'),
    env.CRM_DB.prepare('CREATE INDEX IF NOT EXISTS activities_lead ON activities (lead_id, business)'),
    env.CRM_DB.prepare('CREATE INDEX IF NOT EXISTS deals_owner_user ON deals (owner_user_id)'),
    env.CRM_DB.prepare('CREATE INDEX IF NOT EXISTS activities_user ON activities (user_id)'),
    env.CRM_DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    env.CRM_DB.prepare('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL)'),
    env.CRM_DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, role TEXT NOT NULL DEFAULT 'rep',
      password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`),
  ]);
  schemaReady = true;
}

// ---------- accounts ----------
async function setup(env, body) {
  const count = await env.CRM_DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (count && count.n > 0) return json({ ok: false, error: 'already_set_up' }, 403);
  if (!env.CRM_PASSWORD) return json({ ok: false, error: 'not_configured' }, 503);
  if (!(await safeEqual(String(body.password || ''), env.CRM_PASSWORD))) return json({ ok: false, error: 'wrong' }, 401);
  const name = String(body.name || '').trim().slice(0, 40);
  const phone = normUsername(body.phone || '');
  const newPassword = String(body.newPassword || '');
  if (!name || !phone || newPassword.length < 8) return json({ ok: false, error: 'invalid' }, 400);
  const { hash, salt } = await hashPassword(newPassword);
  const id = uuid();
  const now = new Date().toISOString();
  await env.CRM_DB.prepare(
    'INSERT INTO users (id, name, phone, role, password_hash, password_salt, active, created_at) VALUES (?,?,?,?,?,?,1,?)',
  ).bind(id, name, phone, 'manager', hash, salt, now).run();
  const token = await makeSessionToken(env, { id, role: 'manager', name });
  return json({ ok: true, user: { id, name, role: 'manager' } }, 200, { 'Set-Cookie': sessionCookieHeader(token, SESSION_DAYS * 86400) });
}

async function login(env, request, body) {
  const phone = normUsername(body.phone || '');
  const password = String(body.password || '');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!phone) return json({ ok: false, error: 'phone' }, 401);
  if (await isLocked(env, ip, phone)) return json({ ok: false, error: 'locked' }, 429);
  const row = await env.CRM_DB.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').bind(phone).first();
  const ok = row && password && (await verifyPassword(password, row.password_hash, row.password_salt));
  if (!ok) {
    await recordFail(env, ip, phone);
    await new Promise((r) => setTimeout(r, 800));
    return json({ ok: false, error: 'wrong' }, 401);
  }
  const user = { id: row.id, role: row.role, name: row.name };
  const token = await makeSessionToken(env, user);
  return json({ ok: true, user }, 200, { 'Set-Cookie': sessionCookieHeader(token, SESSION_DAYS * 86400) });
}

function publicUser(r) {
  return { id: r.id, name: r.name, phone: r.phone, role: r.role, active: !!r.active, createdAt: r.created_at };
}

async function listUsers(env) {
  const rows = await env.CRM_DB.prepare('SELECT id, name, phone, role, active, created_at FROM users ORDER BY created_at').all();
  return { ok: true, users: rows.results.map(publicUser) };
}

async function usersAction(env, body) {
  const action = String(body.action || '');
  if (action === 'create') {
    const name = String(body.name || '').trim().slice(0, 40);
    const phone = normUsername(body.phone || '');
    const password = String(body.password || '');
    if (!name || !phone || password.length < 8) return { ok: false, error: 'invalid' };
    const existing = await env.CRM_DB.prepare('SELECT id FROM users WHERE phone = ?').bind(phone).first();
    if (existing) return { ok: false, error: 'phone_taken' };
    const { hash, salt } = await hashPassword(password);
    const id = uuid();
    const now = new Date().toISOString();
    await env.CRM_DB.prepare(
      'INSERT INTO users (id, name, phone, role, password_hash, password_salt, active, created_at) VALUES (?,?,?,?,?,?,1,?)',
    ).bind(id, name, phone, 'rep', hash, salt, now).run();
    return { ok: true, user: { id, name, phone, role: 'rep', active: true, createdAt: now } };
  }
  if (action === 'deactivate' || action === 'activate') {
    const id = String(body.id || '');
    const row = await env.CRM_DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!row || row.role !== 'rep') return { ok: false, error: 'missing' };
    await env.CRM_DB.prepare('UPDATE users SET active = ? WHERE id = ?').bind(action === 'activate' ? 1 : 0, id).run();
    return { ok: true };
  }
  if (action === 'reset_password') {
    const id = String(body.id || '');
    const password = String(body.password || '');
    if (password.length < 8) return { ok: false, error: 'invalid' };
    const row = await env.CRM_DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!row || row.role !== 'rep') return { ok: false, error: 'missing' };
    const { hash, salt } = await hashPassword(password);
    await env.CRM_DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, id).run();
    return { ok: true };
  }
  return { ok: false, error: 'bad' };
}

// ---------- leads (from Google Sheets) ----------
let leadCache = null; // per isolate, 45 seconds, so clicking around doesn't re-read the sheet every time
async function leadsFor(env) {
  if (leadCache && leadCache.exp > Date.now()) return leadCache.data;
  const data = await loadLeads(env, (id, path, init) => sheets(env, id, path, init));
  const legacy = await readLegacy(env);
  // A lead with no deal yet starts where the sales page left it, only in the business its form was for.
  for (const l of data.leads) {
    const old = legacy.get(l.legacyId);
    const status = (old && old.status) || l.sheetStatus;
    const home = l.src === 'apps' ? 'atmatha' : l.src === 'nahr' ? 'nahr' : l.businesses[0];
    l.seed = {};
    for (const b of l.businesses) {
      const stage = b === home ? stageFromLegacy(b, status) : 'new';
      l.seed[b] = { stage, at: stage !== 'new' && old ? old.at : null };
    }
  }
  leadCache = { data, exp: Date.now() + 45000 };
  return data;
}

function publicLead(l) {
  const { legacyId, sheetStatus, ...rest } = l;
  return rest;
}

// ---------- reading everything the signed-in user is allowed to see ----------
async function loadAll(env, user) {
  const [{ leads, notes, atmathaPage }, deals, acts, settings, users] = await Promise.all([
    leadsFor(env),
    env.CRM_DB.prepare('SELECT * FROM deals').all(),
    env.CRM_DB.prepare('SELECT * FROM activities ORDER BY id DESC LIMIT 20000').all(),
    env.CRM_DB.prepare('SELECT key, value FROM settings').all(),
    env.CRM_DB.prepare('SELECT id, name, role, active FROM users').all(),
  ]);
  const out = leads.map(publicLead);
  const ids = new Set(out.map((l) => l.id));
  let dealList = deals.results.map(dealOut);
  let actList = acts.results;

  // Re-attach deals/activities whose lead moved to a new id (the sheet row's stable fields changed).
  const moved = new Map();
  for (const d of dealList) {
    if (ids.has(d.leadId) || !d.fp) continue;
    const hits = out.filter((l) => l.fp === d.fp && l.businesses.includes(d.business));
    if (hits.length === 1) {
      moved.set(d.leadId, hits[0].id);
      d.leadId = hits[0].id;
    }
  }
  if (moved.size) {
    for (const a of actList) if (moved.has(a.lead_id)) a.lead_id = moved.get(a.lead_id);
    await env.CRM_DB.batch([...moved].flatMap(([from, to]) => [
      env.CRM_DB.prepare('UPDATE deals SET lead_id = ? WHERE lead_id = ?').bind(to, from),
      env.CRM_DB.prepare('UPDATE activities SET lead_id = ? WHERE lead_id = ?').bind(to, from),
    ])).catch((e) => console.error('re-attach failed', String(e)));
  }

  const userMap = new Map(users.results.map((r) => [r.id, r]));
  for (const d of dealList) {
    const u = d.ownerUserId && userMap.get(d.ownerUserId);
    d.ownerName = u ? u.name : d.owner || null;
  }

  const isManager = user.role === 'manager';
  let visibleIds;
  if (isManager) {
    visibleIds = ids; // everything, including unassigned deals/leads
  } else {
    dealList = dealList.filter((d) => d.ownerUserId === user.id);
    visibleIds = new Set(dealList.map((d) => d.leadId));
    actList = actList.filter((a) => visibleIds.has(a.lead_id));
  }
  const leadsOut = out.filter((l) => visibleIds.has(l.id));

  const set = Object.fromEntries(settings.results.map((r) => [r.key, safeParse(r.value)]));
  return {
    ok: true,
    user,
    leads: leadsOut,
    notes: isManager ? notes : [],
    atmathaPage: isManager ? atmathaPage || [] : [],
    at: new Date().toISOString(),
    deals: dealList,
    activities: actList,
    settings: set,
    team: isManager ? users.results.filter((r) => r.role === 'rep').map((r) => ({ id: r.id, name: r.name, active: !!r.active })) : [],
    sources: { kit: Boolean(env.KIT_API_KEY), publer: Boolean(env.PUBLER_API_KEY) },
  };
}

function dealOut(r) {
  return {
    leadId: r.lead_id,
    business: r.business,
    stage: r.stage,
    maxIdx: r.max_idx,
    owner: r.owner,
    ownerUserId: r.owner_user_id || null,
    value: r.value_sar,
    nextStep: r.next_step,
    nextStepAt: r.next_step_at,
    lostReason: r.lost_reason,
    fp: r.fp,
    createdAt: r.created_at,
    stageAt: r.stage_at,
    wonAt: r.won_at,
    closedAt: r.closed_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

async function saveDeal(env, ctx, user, body) {
  const leadId2 = String(body.leadId || '').slice(0, 200);
  const business = String(body.business || '');
  if (!STAGES[business] || !leadId2) return { ok: false, error: 'bad' };
  const { leads } = await leadsFor(env);
  const lead = leads.find((l) => l.id === leadId2);
  if (!lead || !lead.businesses.includes(business)) return { ok: false, error: 'missing' };
  const now = new Date().toISOString();
  const row = await env.CRM_DB.prepare('SELECT * FROM deals WHERE lead_id = ? AND business = ?').bind(leadId2, business).first();
  const seed = (lead.seed && lead.seed[business]) || { stage: 'new', at: null };
  const seedStage = stageOf(business, seed.stage);
  const cur = row ? dealOut(row) : {
    leadId: leadId2, business, stage: seedStage.id, maxIdx: Math.max(0, stageIndex(business, seedStage.id)),
    owner: '', ownerUserId: null, value: null, nextStep: '', nextStepAt: '', lostReason: '', fp: lead.fp,
    createdAt: now, stageAt: seed.at || now, wonAt: seedStage.won ? seed.at || now : null,
    closedAt: seedStage.won || seedStage.lost ? seed.at || now : null, updatedAt: null,
  };

  // ---- ownership boundary: a rep may only ever touch their own deals ----
  const isManager = user.role === 'manager';
  if (!isManager) {
    if (cur.ownerUserId !== user.id) return { ok: false, error: 'forbidden' };
    if (body.patch && body.patch.ownerUserId !== undefined) return { ok: false, error: 'forbidden' };
  }

  if (body.expect !== undefined && (body.expect || null) !== (cur.updatedAt || null)) return { ok: false, error: 'conflict', deal: cur };
  const patch = body.patch || {};
  const next = { ...cur };
  const logs = [];

  if (patch.stage !== undefined && patch.stage !== cur.stage) {
    const s = STAGES[business].find((x) => x.id === patch.stage);
    if (!s) return { ok: false, error: 'stage' };
    if (s.lost && !LOST_REASONS.includes(patch.lostReason)) return { ok: false, error: 'reason' };
    next.stage = s.id;
    next.stageAt = now;
    next.maxIdx = s.lost ? cur.maxIdx : Math.max(cur.maxIdx, stageIndex(business, s.id));
    next.wonAt = s.won ? now : null;
    next.closedAt = s.won || s.lost ? now : null;
    next.lostReason = s.lost ? patch.lostReason : '';
    logs.push(['stage', s.lost ? patch.lostReason : '', cur.stage, s.id]);
  }
  // Manager-only: assign/reassign a deal's owner to an active rep, or unassign it.
  if (patch.ownerUserId !== undefined && isManager) {
    if (!patch.ownerUserId) {
      if (cur.ownerUserId) logs.push(['owner_assign', 'غير معيّن', null, null]);
      next.ownerUserId = null;
    } else {
      const rep = await env.CRM_DB.prepare("SELECT * FROM users WHERE id = ? AND role = 'rep' AND active = 1").bind(patch.ownerUserId).first();
      if (!rep) return { ok: false, error: 'owner' };
      if (rep.id !== cur.ownerUserId) {
        next.ownerUserId = rep.id;
        next.owner = rep.name;
        logs.push(['owner_assign', rep.name, null, null]);
      }
    }
  }
  if (patch.owner !== undefined && isManager) {
    const o = String(patch.owner).trim().slice(0, 40);
    if (o !== cur.owner) {
      next.owner = o;
      logs.push(['owner', o, null, null]);
    }
  }
  if (patch.value !== undefined) {
    const v = patch.value === '' || patch.value === null ? null : Number(patch.value);
    if (v !== null && (!isFinite(v) || v < 0 || v > 1e9)) return { ok: false, error: 'value' };
    if (v !== cur.value) {
      next.value = v;
      logs.push(['value', v === null ? '' : String(v), null, null]);
    }
  }
  if (patch.nextStep !== undefined || patch.nextStepAt !== undefined) {
    const t = patch.nextStep !== undefined ? String(patch.nextStep).trim().slice(0, 300) : cur.nextStep;
    const d = patch.nextStepAt !== undefined ? String(patch.nextStepAt) : cur.nextStepAt;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'date' };
    if (t !== cur.nextStep || d !== cur.nextStepAt) {
      next.nextStep = t;
      next.nextStepAt = d;
      logs.push(['next_step', [d, t].filter(Boolean).join(' · '), null, null]);
    }
  }
  if (!logs.length && row) return { ok: true, deal: cur, activities: [] };
  next.updatedAt = now;
  next.updatedBy = user.name;
  const stmts = [env.CRM_DB.prepare(`INSERT INTO deals (lead_id, business, stage, max_idx, owner, owner_user_id, value_sar, next_step, next_step_at,
      lost_reason, fp, created_at, stage_at, won_at, closed_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (lead_id, business) DO UPDATE SET stage=excluded.stage, max_idx=excluded.max_idx, owner=excluded.owner,
      owner_user_id=excluded.owner_user_id, value_sar=excluded.value_sar, next_step=excluded.next_step, next_step_at=excluded.next_step_at,
      lost_reason=excluded.lost_reason, stage_at=excluded.stage_at, won_at=excluded.won_at, closed_at=excluded.closed_at,
      updated_at=excluded.updated_at, updated_by=excluded.updated_by`).bind(
    leadId2, business, next.stage, next.maxIdx, next.owner, next.ownerUserId, next.value, next.nextStep, next.nextStepAt,
    next.lostReason, lead.fp, next.createdAt, next.stageAt, next.wonAt, next.closedAt, next.updatedAt, next.updatedBy,
  )];
  for (const [kind, text, from, to] of logs) {
    stmts.push(env.CRM_DB.prepare('INSERT INTO activities (lead_id, business, at, by, user_id, kind, text, from_stage, to_stage) VALUES (?,?,?,?,?,?,?,?,?)').bind(leadId2, business, now, user.name, user.id, kind, text, from, to));
  }
  await env.CRM_DB.batch(stmts);
  const acts = await env.CRM_DB.prepare('SELECT * FROM activities WHERE lead_id = ? AND business = ? AND at = ?').bind(leadId2, business, now).all();
  return { ok: true, deal: next, activities: acts.results };
}

async function addActivity(env, user, body) {
  const leadId2 = String(body.leadId || '').slice(0, 200);
  const business = String(body.business || '');
  const kind = String(body.kind || '');
  const text = String(body.text || '').trim().slice(0, 2000);
  const outcome = kind === 'call' && CALL_OUTCOMES.includes(body.outcome) ? body.outcome : '';
  if (!STAGES[business] || !leadId2 || !ACTIVITY_KINDS[kind]) return { ok: false, error: 'bad' };
  if (kind === 'note' && !text) return { ok: false, error: 'empty' };
  const { leads } = await leadsFor(env);
  if (!leads.some((l) => l.id === leadId2)) return { ok: false, error: 'missing' };
  if (user.role !== 'manager') {
    const row = await env.CRM_DB.prepare('SELECT owner_user_id FROM deals WHERE lead_id = ? AND business = ?').bind(leadId2, business).first();
    if (!row || row.owner_user_id !== user.id) return { ok: false, error: 'forbidden' };
  }
  const now = new Date().toISOString();
  const r = await env.CRM_DB.prepare('INSERT INTO activities (lead_id, business, at, by, user_id, kind, outcome, text) VALUES (?,?,?,?,?,?,?,?) RETURNING *').bind(leadId2, business, now, user.name, user.id, kind, outcome, text).first();
  return { ok: true, activity: r };
}

async function saveSettings(env, body) {
  const allowed = {
    defaultValue: (v) => ({ nahr: num(v && v.nahr), atmatha: num(v && v.atmatha) }),
    team: (v) => [].concat(v || []).map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 30),
  };
  const stmts = [];
  for (const [k, fix] of Object.entries(allowed)) {
    if (body[k] !== undefined) stmts.push(env.CRM_DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(k, JSON.stringify(fix(body[k]))));
  }
  if (stmts.length) await env.CRM_DB.batch(stmts);
  return { ok: true };
}

function num(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 && n < 1e9 ? n : null;
}

async function cached(env, key, minutes, make, fresh) {
  const row = await env.CRM_DB.prepare('SELECT json, fetched_at FROM cache WHERE key = ?').bind(key).first();
  if (row && !fresh && Date.parse(row.fetched_at) > Date.now() - minutes * 60000) return JSON.parse(row.json);
  const data = await make();
  if (data && data.connected && !data.error) {
    await env.CRM_DB.prepare('INSERT INTO cache (key, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at').bind(key, JSON.stringify(data), new Date().toISOString()).run();
  }
  return data;
}

async function readLegacy(env) {
  const map = new Map();
  try {
    const got = await sheets(env, env.GOOGLE_SHEET_ID, `/values/${encodeURIComponent(`'${TRACK_TAB}'!A1:G`)}`);
    (got.values || []).forEach((r, i) => {
      if (i && r[0] && r[3]) map.set(r[0], { status: r[3], at: riyadhToIso(r[5]) });
    });
  } catch (_) {
    // the legacy tracking tab is optional
  }
  return map;
}

async function mirrorAll(env) {
  const id = env.GOOGLE_SHEET_ID;
  const range = (r) => encodeURIComponent(`'${MIRROR_TAB}'!${r}`);
  const [{ leads }, deals, users] = await Promise.all([
    leadsFor(env),
    env.CRM_DB.prepare('SELECT * FROM deals ORDER BY updated_at DESC').all(),
    env.CRM_DB.prepare('SELECT id, name FROM users').all(),
  ]);
  const byId = new Map(leads.map((l) => [l.id, l]));
  const userMap = new Map(users.results.map((r) => [r.id, r.name]));
  const rows = [MIRROR_HEAD];
  for (const d of deals.results.map(dealOut)) {
    const lead = byId.get(d.leadId);
    const ownerName = (d.ownerUserId && userMap.get(d.ownerUserId)) || d.owner || 'غير معيّن';
    rows.push([
      `${d.leadId}#${d.business}`,
      d.business === 'nahr' ? 'نهر' : 'أتمتها',
      lead ? lead.name : '(غير موجود في الشيت)',
      stageOf(d.business, d.stage).name,
      ownerName,
      d.value === null || d.value === undefined ? '' : d.value,
      d.nextStep,
      d.nextStepAt,
      d.lostReason,
      riyadhStamp(new Date(d.updatedAt)),
      d.updatedBy,
    ]);
  }
  try {
    await sheets(env, id, `/values/${range('A1:A1')}`);
  } catch (e) {
    if (!/400/.test(String(e))) throw e;
    await sheets(env, id, ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: MIRROR_TAB, gridProperties: { frozenRowCount: 1 }, rightToLeft: true } } }] }) });
  }
  await sheets(env, id, `/values/${range('A1:K')}:clear`, { method: 'POST', body: '{}' });
  await sheets(env, id, `/values/${range('A1')}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: rows }) });
}

function riyadhToIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 3, +m[5])).toISOString() : null;
}

// ---------- Google Sheets access (service account JWT, or the SITE service binding) ----------
function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToBuffer(pem) {
  const clean = pem.replace(/\n/g, '').replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
let googleToken = null;
async function accessToken(env) {
  if (env.SITE) return env.SITE.token();
  if (googleToken && googleToken.exp > Date.now()) return googleToken.token;
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!sa) throw new Error('Google service account is not configured');
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', pemToBuffer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claim}`));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${b64url(sig)}` }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Google auth failed: ${data.error || res.status}`);
  googleToken = { token: data.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return data.access_token;
}
async function sheets(env, sheetId, path, init) {
  const token = await accessToken(env);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- small utilities ----------
async function readJson(request) {
  try {
    const t = await request.text();
    return t.length > 20000 ? {} : JSON.parse(t || '{}');
  } catch (_) {
    return {};
  }
}
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...extra },
  });
}
