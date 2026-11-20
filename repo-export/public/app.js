import { api, ApiError } from './api.js';
import {
  STAGES, LOST_REASONS, CALL_OUTCOMES, ACTIVITY_KINDS, ACTIVITY_KIND_NAMES, stageOf, stageIndex, BUSINESSES,
} from './constants.js';
import { renderRep } from './views/rep.js';
import { renderManager } from './views/manager.js';

const root = document.getElementById('app');

export const App = {
  state: null,
  refreshData,
  rerender: renderMain,
  logout,
  toast,
  openDeal,
  BUSINESSES,
  STAGES,
};

// ---------- boot ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

boot();

async function boot() {
  try {
    const data = await api.data();
    App.state = data;
    renderMain();
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'auth' || e.code === '401')) renderLogin();
    else renderLogin(e.message);
  }
}

async function refreshData() {
  try {
    const data = await api.data();
    App.state = data;
    renderMain();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'auth') renderLogin();
    else toast(e.message, true);
  }
}

function renderMain() {
  root.innerHTML = '';
  if (App.state.user.role === 'manager') renderManager(root, App);
  else renderRep(root, App);
}

async function logout() {
  try { await api.logout(); } catch (_) { /* ignore */ }
  App.state = null;
  renderLogin();
}

// ---------- login / one-time setup ----------
function renderLogin(message) {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'login-wrap';
  wrap.innerHTML = `
    <div class="login-card">
      <h1>نظام المبيعات</h1>
      <div class="sub">نهر · أتمتها</div>
      ${message ? `<div class="error-box">${esc(message)}</div>` : ''}
      <form id="login-form">
        <div class="field">
          <label>اسم الدخول</label>
          <input name="phone" type="text" required autocomplete="username" />
        </div>
        <div class="field">
          <label>كلمة المرور</label>
          <input name="password" type="password" required autocomplete="current-password" />
        </div>
        <button class="btn btn-primary btn-block" type="submit">دخول</button>
      </form>
      <div class="login-switch">
        <button type="button" id="show-setup">إعداد أول حساب مدير</button>
      </div>
      <form id="setup-form" style="display:none; margin-top:14px; border-top:1px solid var(--border); padding-top:14px;">
        <div class="hint" style="margin-bottom:10px;">لمرة واحدة فقط: يُستخدم فيها كلمة مرور CRM_PASSWORD القديمة لإنشاء أول حساب مدير.</div>
        <div class="field"><label>كلمة المرور القديمة (CRM_PASSWORD)</label><input name="password" type="password" required /></div>
        <div class="field"><label>اسمك</label><input name="name" required /></div>
        <div class="field"><label>اسم دخولك</label><input name="phone" type="text" required /></div>
        <div class="field"><label>كلمة مرور جديدة (8 أحرف فأكثر)</label><input name="newPassword" type="password" minlength="8" required /></div>
        <button class="btn btn-primary btn-block" type="submit">إنشاء الحساب</button>
      </form>
    </div>`;
  root.appendChild(wrap);

  wrap.querySelector('#show-setup').addEventListener('click', () => {
    const f = wrap.querySelector('#setup-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
  });

  wrap.querySelector('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      await api.login({ phone: fd.get('phone'), password: fd.get('password') });
      await boot();
    } catch (e) {
      renderLogin(e.message);
    } finally {
      btn.disabled = false;
    }
  });

  wrap.querySelector('#setup-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const btn = ev.target.querySelector('button');
    btn.disabled = true;
    try {
      await api.setup({
        password: fd.get('password'), name: fd.get('name'), phone: fd.get('phone'), newPassword: fd.get('newPassword'),
      });
      await boot();
    } catch (e) {
      renderLogin(e.message);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- small shared helpers ----------
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(message, isErr) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

export function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('ar-SA', { day: 'numeric', month: 'short' }); } catch (_) { return iso; }
}
export function fmtDateTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('ar-SA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) { return iso; }
}
export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
export function nextStepClass(dateStr) {
  if (!dateStr) return '';
  const today = todayStr();
  if (dateStr < today) return 'overdue';
  if (dateStr === today) return 'today';
  return '';
}

// Finds the lead for a deal's leadId.
export function leadById(state, leadId) {
  return state.leads.find((l) => l.id === leadId);
}

// Builds the list of (lead, business, deal) "opportunities" a user can work with.
// Reps only ever get rows that already have a deal assigned to them (server-filtered);
// managers additionally see lead x business combinations with no deal row yet, synthesized
// from the lead's seed stage, so unassigned leads are visible and assignable.
export function listOpportunities(state) {
  const isManager = state.user.role === 'manager';
  const out = [];
  const seen = new Set();
  for (const d of state.deals) {
    out.push({ lead: leadById(state, d.leadId), business: d.business, deal: d });
    seen.add(`${d.leadId}|${d.business}`);
  }
  if (isManager) {
    for (const l of state.leads) {
      for (const b of l.businesses) {
        const key = `${l.id}|${b}`;
        if (seen.has(key)) continue;
        const seed = (l.seed && l.seed[b]) || { stage: 'new', at: null };
        const s = stageOf(b, seed.stage);
        out.push({
          lead: l, business: b,
          deal: {
            leadId: l.id, business: b, stage: s.id, maxIdx: Math.max(0, stageIndex(b, s.id)),
            owner: '', ownerUserId: null, ownerName: null, value: null, nextStep: '', nextStepAt: '',
            lostReason: '', updatedAt: null, isNew: true,
          },
        });
      }
    }
  }
  return out.filter((o) => o.lead);
}

// ---------- deal detail bottom sheet (shared by rep + manager views) ----------
export function openDeal(lead, business, deal) {
  const isManager = App.state.user.role === 'manager';
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  function close() { backdrop.remove(); }

  function activitiesFor() {
    return App.state.activities
      .filter((a) => a.lead_id === lead.id && a.business === business)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  function paint() {
    const stages = STAGES[business];
    const s = stageOf(business, deal.stage);
    const acts = activitiesFor();
    const team = App.state.team || [];
    backdrop.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="grabber"></div>
        <h2>${esc(lead.name || 'بدون اسم')}</h2>
        <div class="sub">
          <span class="pill pill-${business}">${esc(BUSINESSES[business].name)}</span>
          ${lead.grade ? ` · ${esc(lead.grade)}` : ''}
          ${lead.date ? ` · ${esc(lead.date)}` : ''}
        </div>

        <section>
          <h3>التواصل</h3>
          <div class="details-list">
            ${lead.phone ? `<div class="d-row"><span class="k">الجوال</span><a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a> · <a href="https://wa.me/${esc(lead.phone.replace(/\D/g, ''))}" target="_blank" rel="noopener">واتساب</a></div>` : ''}
            ${lead.email ? `<div class="d-row"><span class="k">الإيميل</span><a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a></div>` : ''}
            ${lead.from ? `<div class="d-row"><span class="k">مصدره</span><span>${esc(lead.from)}</span></div>` : ''}
          </div>
        </section>

        <section>
          <h3>المرحلة</h3>
          <div class="stage-grid">
            ${stages.map((st) => `<button class="btn btn-sm stage-btn ${st.id === s.id ? 'current' : ''} ${st.lost ? 'lost' : ''} ${st.won ? 'won' : ''}" data-stage="${st.id}">${esc(st.name)}</button>`).join('')}
          </div>
          <div id="lost-reason-wrap" style="display:none; margin-top:10px;">
            <label>سبب الخسارة</label>
            <div class="stage-grid">${LOST_REASONS.map((r) => `<button type="button" class="btn btn-sm" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>
          </div>
        </section>

        ${isManager ? `
        <section>
          <h3>المسؤول</h3>
          <select id="owner-select">
            <option value="">غير معيّن</option>
            ${team.map((t) => `<option value="${t.id}" ${deal.ownerUserId === t.id ? 'selected' : ''} ${!t.active ? 'disabled' : ''}>${esc(t.name)}${!t.active ? ' (موقوف)' : ''}</option>`).join('')}
          </select>
        </section>` : ''}

        <section>
          <h3>القيمة المتوقعة (ر.س)</h3>
          <div style="display:flex; gap:8px;">
            <input id="value-input" type="number" min="0" step="1" value="${deal.value ?? ''}" placeholder="القيمة" />
            <button class="btn btn-sm" id="save-value">حفظ</button>
          </div>
        </section>

        <section>
          <h3>الخطوة القادمة</h3>
          <div class="field"><input id="next-step-text" placeholder="مثال: اتصال متابعة" value="${esc(deal.nextStep || '')}" /></div>
          <div style="display:flex; gap:8px;">
            <input id="next-step-date" type="date" value="${esc(deal.nextStepAt || '')}" />
            <button class="btn btn-sm" id="save-next">حفظ</button>
          </div>
        </section>

        <section>
          <h3>تسجيل نشاط</h3>
          <div class="activity-grid">
            ${ACTIVITY_KINDS.map((k) => `<button type="button" class="btn activity-btn" data-kind="${k.id}"><span class="ic">${k.icon}</span><span>${esc(k.name)}</span></button>`).join('')}
          </div>
          <div id="activity-form" style="display:none; margin-top:10px;"></div>
        </section>

        <section>
          <h3>السجل</h3>
          <div class="activity-log">
            ${acts.length ? acts.map((a) => `
              <div class="activity-item">
                <div>${describeActivity(a)}</div>
                <div class="meta">${esc(a.by)} · ${fmtDateTime(a.at)}</div>
              </div>`).join('') : '<div class="hint">ما فيه نشاط مسجل بعد.</div>'}
          </div>
        </section>

        <button class="btn btn-ghost btn-block" id="close-sheet">إغلاق</button>
      </div>`;

    backdrop.querySelector('#close-sheet').addEventListener('click', close);

    backdrop.querySelectorAll('.stage-btn').forEach((btn) => btn.addEventListener('click', () => {
      const stageId = btn.dataset.stage;
      const target = stages.find((x) => x.id === stageId);
      if (target.lost) {
        backdrop.querySelector('#lost-reason-wrap').style.display = 'block';
        return;
      }
      doPatch({ stage: stageId });
    }));
    backdrop.querySelectorAll('[data-reason]').forEach((btn) => btn.addEventListener('click', () => {
      doPatch({ stage: 'lost', lostReason: btn.dataset.reason });
    }));

    if (isManager) {
      backdrop.querySelector('#owner-select').addEventListener('change', (e) => {
        doPatch({ ownerUserId: e.target.value || null });
      });
    }

    backdrop.querySelector('#save-value').addEventListener('click', () => {
      const v = backdrop.querySelector('#value-input').value;
      doPatch({ value: v === '' ? null : v });
    });
    backdrop.querySelector('#save-next').addEventListener('click', () => {
      doPatch({ nextStep: backdrop.querySelector('#next-step-text').value, nextStepAt: backdrop.querySelector('#next-step-date').value });
    });

    backdrop.querySelectorAll('[data-kind]').forEach((btn) => btn.addEventListener('click', () => showActivityForm(btn.dataset.kind)));
  }

  function showActivityForm(kind) {
    const wrap = backdrop.querySelector('#activity-form');
    const needsOutcome = kind === 'call';
    const needsText = kind === 'note';
    wrap.style.display = 'block';
    wrap.innerHTML = `
      ${needsOutcome ? `<div class="stage-grid" style="margin-bottom:8px;">${CALL_OUTCOMES.map((o) => `<button type="button" class="btn btn-sm" data-outcome="${o.id}">${esc(o.name)}</button>`).join('')}</div>` : ''}
      <textarea id="activity-text" placeholder="${needsText ? 'اكتب الملاحظة...' : 'تفاصيل إضافية (اختياري)'}"></textarea>
      <button class="btn btn-primary btn-sm" style="margin-top:8px;" id="send-activity">تسجيل ${esc(ACTIVITY_KIND_NAMES[kind])}</button>`;
    let outcome = '';
    wrap.querySelectorAll('[data-outcome]').forEach((b) => b.addEventListener('click', () => {
      outcome = b.dataset.outcome;
      wrap.querySelectorAll('[data-outcome]').forEach((x) => x.classList.remove('current'));
      b.classList.add('current');
    }));
    wrap.querySelector('#send-activity').addEventListener('click', async () => {
      const text = wrap.querySelector('#activity-text').value.trim();
      if (needsText && !text) { toast('اكتب الملاحظة أولاً', true); return; }
      try {
        await api.addActivity({ leadId: lead.id, business, kind, text, outcome });
        await App.refreshData();
        toast('تم التسجيل');
        reopenFromState();
      } catch (e) { toast(e.message, true); }
    });
  }

  async function doPatch(patch) {
    try {
      await api.saveDeal({ leadId: lead.id, business, expect: deal.updatedAt || null, patch });
      await App.refreshData();
      toast('تم الحفظ');
      reopenFromState();
    } catch (e) {
      if (e.code === 'conflict') { toast('تم تعديلها من مكان ثاني، أعِد المحاولة', true); await App.refreshData(); close(); }
      else toast(e.message, true);
    }
  }

  function reopenFromState() {
    const fresh = App.state.deals.find((d) => d.leadId === lead.id && d.business === business);
    if (fresh) { deal = fresh; paint(); } else close();
  }

  paint();
}

function describeActivity(a) {
  const names = { stage: 'تغيير مرحلة', owner_assign: 'تعيين مسؤول', owner: 'تعديل المسؤول', value: 'تعديل القيمة', next_step: 'خطوة قادمة' };
  if (a.kind in names) {
    if (a.kind === 'stage') return `${names.stage}: ${esc(stageLabel(a.business, a.from_stage))} ← ${esc(stageLabel(a.business, a.to_stage))}${a.text ? ` (${esc(a.text)})` : ''}`;
    return `${names[a.kind]}${a.text ? `: ${esc(a.text)}` : ''}`;
  }
  const kindName = ACTIVITY_KIND_NAMES[a.kind] || a.kind;
  const outcomeName = CALL_OUTCOMES.find((o) => o.id === a.outcome);
  return `${esc(kindName)}${outcomeName ? ` · ${esc(outcomeName.name)}` : ''}${a.text ? `: ${esc(a.text)}` : ''}`;
}
function stageLabel(business, stageId) {
  if (!stageId) return '—';
  return stageOf(business, stageId).name;
}
