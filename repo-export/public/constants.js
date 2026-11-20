// Mirrors worker/src/shared.js. Duplicated on purpose: the frontend is plain static files with
// no build step, so it can't import from the worker. Keep the two in sync if stages ever change.

export const BUSINESSES = {
  nahr: { id: 'nahr', name: 'نهر' },
  atmatha: { id: 'atmatha', name: 'أتمتها' },
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
export const CALL_OUTCOMES = [
  { id: 'answered', name: 'رد' },
  { id: 'no_answer', name: 'ما رد' },
  { id: 'booked', name: 'حجز موعد' },
];
export const ACTIVITY_KINDS = [
  { id: 'call', name: 'اتصال', icon: '📞' },
  { id: 'whatsapp', name: 'واتساب', icon: '💬' },
  { id: 'note', name: 'ملاحظة', icon: '📝' },
  { id: 'email', name: 'إيميل', icon: '✉️' },
  { id: 'meeting', name: 'اجتماع', icon: '🤝' },
];
export const ACTIVITY_KIND_NAMES = Object.fromEntries(ACTIVITY_KINDS.map((k) => [k.id, k.name]));

export function stageOf(business, stageId) {
  return STAGES[business].find((s) => s.id === stageId) || STAGES[business][0];
}
export function stageIndex(business, stageId) {
  return STAGES[business].findIndex((s) => s.id === stageId);
}
