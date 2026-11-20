// Reads leads from the Google Sheets the website forms write to.
// Mapping follows the site's sales page so the same rows mean the same leads.
// Cleaned up from a recovered esbuild bundle; behavior is unchanged from the original.

import { UTM_PLAN_TAB, planFromRows, describeFrom } from './shared.js';

export const TZ = 'Asia/Riyadh';
export const MAIN_TABS = { nahr: 'نهر', course: 'الكورس' };
export const ATMATHA_PAGE_TAB = 'أتمتها'; // the site's Atmatha page log: one row per visit or button click
export const APPS_DEFAULT = '1oMLZQ7Qr_IJzbN0p5Ljz9yNr6ymIblAzRA0z8R3zGzU';
const SRC_LABEL = { nahr: 'نموذج نهر', course: 'الكورس المجاني', apps: 'طلبات أتمتها (الموقع القديم)' };

const APPS_FIELDS = [
  ['workName', 'جهة العمل'], ['role', 'الدور'], ['city', 'المدينة'], ['country', 'الدولة'], ['teamSize', 'حجم الفريق'],
  ['aiLevel', 'مستوى الذكاء الاصطناعي'], ['readiness', 'الجاهزية'], ['paymentReadiness', 'الاستعداد للدفع'],
  ['hours', 'ساعات الهدر'], ['timeWaste', 'وين يضيع الوقت'], ['timeWasteOther', 'وين يضيع الوقت (أخرى)'],
  ['oneMonth', 'وش يبي خلال شهر'], ['ninetyDays', 'وش يبي خلال ٩٠ يوم'], ['whyNow', 'ليش الحين'],
  ['blockers', 'العوائق'], ['contribution', 'وش يقدم'], ['workType', 'طبيعة العمل'], ['repeatTasks', 'مهام متكررة'],
  ['dailyTasks', 'المهام اليومية'], ['currentTools', 'الأدوات الحالية'], ['profile', 'حساب / رابط'],
  ['heardFrom', 'من وين عرف'], ['heardFromOther', 'من وين عرف (أخرى)'],
];

export async function loadLeads(env, sheets) {
  const q = (t) => `ranges=${encodeURIComponent(`'${t}'!A1:Z`)}`;
  const got = await sheets(env.GOOGLE_SHEET_ID, `/values:batchGet?${q(MAIN_TABS.nahr)}&${q(MAIN_TABS.course)}`);
  const [nahr, course] = got.valueRanges.map((v) => v.values || []);
  const leads = [...fromSiteTab('nahr', nahr, null), ...fromSiteTab('course', course, (l) => /نهر|أتمتها/.test(l.dest))];
  const notes = [];
  let plan = new Map();
  try {
    const p = await sheets(env.GOOGLE_SHEET_ID, `/values/${encodeURIComponent(`'${UTM_PLAN_TAB}'!A1:J`)}`);
    plan = planFromRows(p.values || []);
  } catch (e) {
    console.error('utm plan', String(e));
  }
  try {
    const apps = await sheets(env.ATMATHA_APPS_SHEET_ID || APPS_DEFAULT, `/values/${encodeURIComponent("'Applications'!A1:AZ")}`);
    leads.push(...fromApps(apps.values || []));
  } catch (e) {
    console.error('apps sheet', String(e));
    notes.push('ما قدرنا نقرأ شيت طلبات أتمتها القديم، فطلباته مو ظاهرة.');
  }
  for (const l of leads) {
    const f = describeFrom(l, plan);
    l.from = f.text;
    l.fromUrl = f.url;
  }
  let atmathaPage = [];
  try {
    const pg = await sheets(env.GOOGLE_SHEET_ID, `/values/${encodeURIComponent(`'${ATMATHA_PAGE_TAB}'!A1:Z`)}`);
    atmathaPage = pageEvents(pg.values || [], plan);
  } catch (e) {
    console.error('atmatha page log', String(e));
  }
  await finishIds(leads);
  markDuplicates(leads);
  leads.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { leads, notes, atmathaPage };
}

// Visits and clicks on the site's Atmatha page. No names or contacts are in this log, only a random visit id.
function pageEvents(rows, plan) {
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => String(h).trim());
  const c = (n) => head.indexOf(n);
  const ix = {
    date: c('التاريخ'), kind: c('الحدث'), button: c('الزر'), visit: c('رقم الزيارة'),
    us: c('utm_source'), um: c('utm_medium'), uc: c('utm_campaign'), ut: c('utm_content'),
  };
  if (ix.date < 0 || ix.kind < 0 || ix.visit < 0) return [];
  const out = [];
  for (const r of rows.slice(1)) {
    const g = (k) => (ix[k] >= 0 ? String(r[ix[k]] || '').trim() : '');
    const date = g('date');
    const kind = g('kind');
    const visit = g('visit');
    if (!date || !visit || !/زيارة|ضغطة/.test(kind)) continue;
    const utm = { source: g('us').toLowerCase(), medium: g('um').toLowerCase(), campaign: g('uc').toLowerCase(), content: g('ut').toLowerCase() };
    if (/^test$/.test(utm.source) || /test/.test(utm.campaign)) continue;
    out.push({ date, click: kind === 'ضغطة', button: g('button').slice(0, 60), visit: visit.slice(0, 20), from: describeFrom({ utm }, plan).text, kit: /^(kit|email|newsletter|convertkit)$/.test(utm.source) });
  }
  return out.slice(-5000);
}

function headerIndex(head) {
  const find = (...names) => head.findIndex((h) => names.includes(String(h).trim()));
  return {
    date: find('التاريخ'), name: find('الاسم الكامل', 'الاسم'), email: find('الإيميل'), phone: find('رقم الجوال', 'الجوال'),
    grade: find('جودة العميل'), dest: find('الوجهة'), status: find('الحالة'), notes: find('ملاحظات'),
    heard: find('من وين عرفت أسامة؟'),
    us: find('utm_source'), um: find('utm_medium'), uc: find('utm_campaign'), ut: find('utm_content'), landing: find('صفحة الدخول'),
  };
}

function fromSiteTab(src, rows, keep) {
  if (rows.length < 2) return [];
  const head = rows[0];
  const ix = headerIndex(head);
  const used = new Set(Object.values(ix).filter((i) => i >= 0 && i !== ix.heard));
  const out = [];
  rows.slice(1).forEach((r) => {
    const g = (k) => (ix[k] >= 0 ? String(r[ix[k]] || '').trim() : '');
    const date = g('date');
    const name = g('name');
    if (!date && !name) return;
    const lead = {
      id: leadId(src, date, g('email'), g('phone'), name),
      legacyId: legacyKey(src, date, g('email') || g('phone'), name),
      src, srcLabel: SRC_LABEL[src], date, name, email: g('email'), phone: g('phone'),
      grade: normGrade(g('grade')), dest: g('dest'), sheetStatus: g('status'), heard: g('heard'),
      utm: { source: g('us'), medium: g('um'), campaign: g('uc'), content: g('ut') }, landing: g('landing'),
      details: [],
    };
    if (keep && !keep(lead)) return;
    head.forEach((h, c) => {
      if (used.has(c) || !h) return;
      const v = String(r[c] || '').trim();
      if (v) lead.details.push([String(h), v]);
    });
    lead.businesses = businessesOf(src, lead.dest);
    lead.test = isTest(lead);
    out.push(lead);
  });
  return out;
}

function fromApps(rows) {
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => String(h).trim());
  const col = (n) => head.indexOf(n);
  const out = [];
  rows.slice(1).forEach((r) => {
    const g = (n) => (col(n) >= 0 ? String(r[col(n)] || '').trim() : '');
    const at = g('submittedAt');
    if (!at) return;
    const date = isoToRiyadh(at);
    const name = `${g('firstName')} ${g('lastName')}`.trim();
    const readiness = g('readiness');
    const lead = {
      id: leadId('apps', date, g('email'), g('phone'), name),
      legacyId: legacyKey('apps', at, g('email') || g('phone'), name),
      src: 'apps', srcLabel: SRC_LABEL.apps, date, name, email: g('email'), phone: g('phone'),
      grade: /مستعد من الآن/.test(readiness) ? 'حار' : /تنظيم/.test(readiness) ? 'دافئ' : 'بارد',
      dest: 'أتمتها', sheetStatus: '', heard: g('heardFrom'), businesses: ['atmatha'],
      utm: {
        source: g('first_utm_source') || g('last_utm_source'), medium: g('first_utm_medium') || g('last_utm_medium'),
        campaign: g('first_utm_campaign') || g('last_utm_campaign'), content: g('first_utm_content') || g('last_utm_content'),
      },
      landing: g('first_landing_path'), details: [],
    };
    for (const [k, label] of APPS_FIELDS) {
      const v = g(k);
      if (v) lead.details.push([label, v]);
    }
    lead.test = isTest(lead);
    out.push(lead);
  });
  return out;
}

function normGrade(g) {
  if (/جدًا|جدا/.test(g)) return 'حار جدًا';
  if (/حار/.test(g)) return 'حار';
  if (/دافئ/.test(g)) return 'دافئ';
  if (/بارد/.test(g)) return 'بارد';
  return g;
}

function businessesOf(src, dest) {
  if (src === 'apps') return ['atmatha'];
  const p = [];
  if (src === 'nahr' || /نهر/.test(dest)) p.push('nahr');
  if (/أتمتها/.test(dest)) p.push('atmatha');
  return p.length ? p : ['nahr'];
}

function isTest(l) {
  return /\+test@|اختبار/.test(`${l.email} ${l.name}`) || /^test$/i.test(l.utm.source || '');
}

function markDuplicates(leads) {
  const groups = new Map();
  for (const l of leads) {
    const keys = [l.email && `e:${l.email.toLowerCase()}`, l.phone && `p:${normPhone(l.phone)}`].filter(Boolean);
    l._k = keys;
    for (const k of keys) {
      if (!groups.has(k)) groups.set(k, new Set());
      groups.get(k).add(l.id);
    }
  }
  for (const l of leads) {
    const others = new Set();
    for (const k of l._k) for (const id of groups.get(k)) if (id !== l.id) others.add(id);
    l.also = [...others];
    delete l._k;
  }
}

function leadId(src, date, email, phone, name) {
  const contact = email ? email.toLowerCase() : phone ? normPhone(phone) : name;
  return `${src}|${date}|${contact}`;
}

async function finishIds(leads) {
  const seen = new Map();
  for (const l of leads) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(l.id));
    let id = [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    l.id = id;
    l.fp = `${l.src}|${l.date}`;
  }
}

function legacyKey(src, date, contact, name) {
  return `${src}|${date}|${String(contact).toLowerCase()}|${name}`.slice(0, 300);
}

// Also used (exported) to normalize a staff member's phone number for login.
export function normPhone(v) {
  let d = String(v).replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('05')) d = `966${d.slice(1)}`;
  if (d.length === 9 && d.startsWith('5')) d = `966${d}`;
  return d;
}

function isoToRiyadh(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : riyadhStamp(d);
}

export function riyadhStamp(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
