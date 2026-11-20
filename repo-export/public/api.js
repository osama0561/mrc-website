// Thin fetch wrapper for the worker's /api/* endpoints.

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function call(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (e) {
    // offline / network down: writes must fail clearly, reads fall back to cached data elsewhere.
    throw new ApiError('لا يوجد اتصال بالإنترنت حالياً', 'offline');
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok || (data && data.ok === false)) {
    const code = (data && data.error) || String(res.status);
    throw new ApiError(errorMessage(code, res.status), code);
  }
  return data;
}

function errorMessage(code, status) {
  const map = {
    auth: 'انتهت الجلسة، سجّل الدخول مرة ثانية',
    forbidden: 'ما عندك صلاحية لهذا الإجراء',
    locked: 'محاولات كثيرة فاشلة، حاول بعد شوي',
    wrong: 'اسم الدخول أو كلمة المرور غير صحيحة',
    conflict: 'تم تعديل هذه الصفقة من مكان ثاني، حدّث الصفحة',
    not_configured: 'النظام غير مُهيّأ بعد',
    already_set_up: 'تم إعداد النظام من قبل',
    phone_taken: 'اسم الدخول مستخدم من قبل',
    invalid: 'البيانات المدخلة غير صحيحة',
    offline: 'لا يوجد اتصال بالإنترنت حالياً',
  };
  return map[code] || `حدث خطأ (${code || status})`;
}

export const api = {
  setup: (body) => call('/api/setup', { method: 'POST', body }),
  login: (body) => call('/api/login', { method: 'POST', body }),
  logout: () => call('/api/logout', { method: 'POST' }),
  data: () => call('/api/data'),
  saveDeal: (body) => call('/api/deal', { method: 'POST', body }),
  addActivity: (body) => call('/api/activity', { method: 'POST', body }),
  saveSettings: (body) => call('/api/settings', { method: 'POST', body }),
  listUsers: () => call('/api/users'),
  usersAction: (body) => call('/api/users', { method: 'POST', body }),
  kitSnapshot: (fresh) => call(`/api/sources/kit${fresh ? '?fresh=1' : ''}`),
  publerSnapshot: (fresh) => call(`/api/sources/publer${fresh ? '?fresh=1' : ''}`),
};

export { ApiError };
