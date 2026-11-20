// Shared by the worker (and, conceptually, the frontend): businesses, deal stages, reasons.
// Cleaned up from a recovered esbuild bundle; behavior is unchanged from the original.

export const BUSINESSES = {
  nahr: { id: 'nahr', name: 'نهر', short: 'نهر' },
  atmatha: { id: 'atmatha', name: 'أتمتها', short: 'أتمتها' },
};

export const STAGES = {
  nahr: [
    { id: 'new', name: 'جديد' },
    { id: 'contacted', name: 'تم التواصل' },
    { id: 'call', name: 'مكالمة اكتشاف' },
    { id: 'proposal', name: 'عرض سعر مرسل' },
    { id: 'negotiation', name: 'تفاوض' },
    { id: 'won', name: 'ربح', won: true },
    { id: 'lost', name: 'خسارة', lost: true },
  ],
  atmatha: [
    { id: 'new', name: 'جديد' },
    { id: 'contacted', name: 'تم التواصل' },
    { id: 'call', name: 'مكالمة محجوزة' },
    { id: 'attended', name: 'حضر المكالمة' },
    { id: 'won', name: 'اشترك', won: true },
    { id: 'lost', name: 'ما اشترك', lost: true },
  ],
};

export const LOST_REASONS = ['السعر', 'التوقيت', 'ما رد', 'غير مناسب', 'اختار غيرنا', 'أخرى'];
export const CALL_OUTCOMES = ['answered', 'no_answer', 'booked'];
export const CALL_OUTCOME_NAMES = { answered: 'رد', no_answer: 'ما رد', booked: 'حجز موعد' };
export const ACTIVITY_KINDS = { note: 'ملاحظة', call: 'اتصال', whatsapp: 'واتساب', email: 'إيميل', meeting: 'اجتماع' };

export function stageIndex(business, stageId) {
  return STAGES[business].findIndex((s) => s.id === stageId);
}
export function stageOf(business, stageId) {
  return STAGES[business].find((s) => s.id === stageId) || STAGES[business][0];
}
export function isOpen(business, stageId) {
  const s = stageOf(business, stageId);
  return !s.won && !s.lost;
}

// The sales page's statuses -> CRM stage, used once when a lead has no deal yet.
export function stageFromLegacy(business, status) {
  switch (status) {
    case 'تم التواصل':
    case 'ما رد':
      return 'contacted';
    case 'موعد محجوز':
      return 'call';
    case 'مهتم':
      return business === 'nahr' ? 'proposal' : 'attended';
    case 'تم البيع':
      return 'won';
    case 'غير مهتم':
    case 'غير مناسب':
      return 'lost';
    default:
      return 'new';
  }
}

// ---------- where a lead came from, in plain words ----------
// plan: Map of lowercased utm_content -> { platform, place, title, url } from the sheet tab «خطة UTM».
export const UTM_PLAN_TAB = 'خطة UTM';
const PLATFORM_AR = {
  youtube: 'يوتيوب', yt: 'يوتيوب', instagram: 'إنستقرام', ig: 'إنستقرام', 'instagram.com': 'إنستقرام', 'l.instagram.com': 'إنستقرام',
  tiktok: 'تيك توك', x: 'إكس', twitter: 'إكس', 't.co': 'إكس', linkedin: 'لينكدإن', 'linkedin.com': 'لينكدإن', 'lnkd.in': 'لينكدإن',
  kit: 'إيميل Kit', email: 'الإيميل', newsletter: 'النشرة', google: 'قوقل', 'google.com': 'قوقل', snapchat: 'سناب', whatsapp: 'واتساب',
};
const MEDIUM_AR = {
  bio: 'البايو', story: 'ستوري', post: 'منشور', pinned_post: 'المنشور المثبت', featured: 'قسم Featured', video_description: 'وصف الفيديو',
  pinned_comment: 'التعليق المثبت', referral: 'رابط عادي بدون تتبع', social: 'السوشال', email: 'إيميل', organic: 'بحث',
};
const KIT_CAMPAIGN_AR = { binge_workshop_to_coaching: 'سلسلة الـ30 يوم (من الورشة إلى الكوتشنق)' };
const GENERIC_CONTENT = /^(profile|pinned|featured|link_in_bio|channel_header|channel_link_2)$/;

export function planFromRows(rows) {
  const plan = new Map();
  if (!rows || rows.length < 2) return plan;
  const head = rows[0].map((h) => String(h).trim());
  const c = (n) => head.indexOf(n);
  const [iP, iPl, iT, iU, iS, iC] = [c('المنصة'), c('المكان'), c('العنوان / الوصف'), c('الرابط الأصلي'), c('utm_source'), c('utm_content')];
  for (const r of rows.slice(1)) {
    const content = String(r[iC] || '').trim().toLowerCase();
    if (!content || /yyyy/.test(content)) continue;
    const row = { platform: String(r[iP] || r[iS] || '').trim().toLowerCase(), place: String(r[iPl] || '').trim(), title: String(r[iT] || '').trim(), url: String(r[iU] || '').trim() };
    plan.set(`${String(r[iS] || '').trim().toLowerCase()}|${content}`, row);
    if (!plan.has(content)) plan.set(content, row);
  }
  return plan;
}

// Returns { text, url } e.g. «فيديو يوتيوب: كيف تبني اول وكيل ذكاء اصطناعي لك».
export function describeFrom(lead, plan) {
  const u = lead.utm || {};
  const source = String(u.source || '').trim().toLowerCase();
  const medium = String(u.medium || '').trim().toLowerCase();
  const content = String(u.content || '').trim().toLowerCase();
  const heard = String(lead.heard || '').trim();
  if (!source || source === 'direct' || source === '(direct)') {
    return { text: heard ? `بدون رابط تتبع · قال إنه عرف أسامة من: ${heard}` : 'دخل الموقع مباشرة (بدون رابط تتبع)', url: '' };
  }
  const platform = PLATFORM_AR[source] || source;
  if (/^(kit|email|newsletter|convertkit)$/.test(source) && (medium === 'email' || /^email_\d+$/.test(content))) {
    const campaign = String(u.campaign || '').trim().toLowerCase();
    const seq = KIT_CAMPAIGN_AR[campaign] || (campaign ? `حملة ${campaign}` : '');
    const m = content.match(/^email_(\d+)$/);
    const which = m ? `الإيميل رقم ${Number(m[1])}` : content && !GENERIC_CONTENT.test(content) ? content : '';
    return { text: ['إيميل Kit', seq, which].filter(Boolean).join(' · '), url: '' };
  }
  const hit = plan && content && (plan.get(`${source}|${content}`) || plan.get(content));
  if (hit && /video_description|pinned_comment/.test(medium)) {
    return { text: `فيديو يوتيوب: ${hit.title}${medium === 'pinned_comment' ? ' (التعليق المثبت)' : ''}`, url: /^https:\/\/(youtu\.be|www\.youtube\.com)\//.test(hit.url) ? hit.url : '' };
  }
  if (hit) return { text: `${PLATFORM_AR[hit.platform] || platform} · ${hit.place}`, url: '' };
  if (/video_description|pinned_comment/.test(medium)) {
    return { text: content ? `فيديو يوتيوب (رقمه ${content}، مو موجود في خطة الروابط)` : 'فيديو يوتيوب (بدون رقم الفيديو)', url: '' };
  }
  const where = MEDIUM_AR[medium] || medium;
  const extra = content && !GENERIC_CONTENT.test(content) ? ` · ${content}` : '';
  return { text: `${platform}${where ? ` · ${where}` : ''}${extra}`, url: '' };
}
