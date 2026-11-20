import { api } from '../api.js';
import { BUSINESSES, STAGES, stageOf } from '../constants.js';
import {
  esc, toast, fmtDate, nextStepClass, listOpportunities, openDeal,
} from '../app.js';

let activeTab = 'pipeline';
let filters = { business: 'all', rep: 'all' };

export function renderManager(root, App) {
  const state = App.state;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="topbar">
      <div class="brand">لوحة المدير</div>
      <div class="spacer"></div>
      <div class="who">${esc(state.user.name)}</div>
      <button class="btn btn-ghost btn-sm" id="logout-btn">خروج</button>
    </div>
    <div class="page" id="tab-content"></div>
    <div class="bottom-nav">
      ${navBtn('pipeline', '📋', 'الصفقات')}
      ${navBtn('team', '👥', 'الفريق')}
      ${navBtn('settings', '⚙️', 'الإعدادات')}
      ${navBtn('sources', '📡', 'المصادر')}
    </div>`;
  root.appendChild(wrap);
  wrap.querySelector('#logout-btn').addEventListener('click', () => App.logout());
  wrap.querySelectorAll('.bottom-nav button').forEach((b) => b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    renderManager(resetRoot(root), App);
  }));

  const content = wrap.querySelector('#tab-content');
  if (activeTab === 'pipeline') paintPipeline(content, App);
  else if (activeTab === 'team') paintTeam(content, App);
  else if (activeTab === 'settings') paintSettings(content, App);
  else paintSources(content, App);
}

function navBtn(tab, icon, label) {
  return `<button data-tab="${tab}" class="${activeTab === tab ? 'active' : ''}"><span class="ic">${icon}</span><span>${label}</span></button>`;
}
function resetRoot(root) { root.innerHTML = ''; return root; }

// ---------- pipeline ----------
function paintPipeline(content, App) {
  const state = App.state;
  const team = state.team || [];
  content.innerHTML = `
    <div class="filters-row">
      <select id="f-biz">
        <option value="all">كل الأنشطة</option>
        <option value="nahr">نهر</option>
        <option value="atmatha">أتمتها</option>
      </select>
      <select id="f-rep">
        <option value="all">كل الفريق</option>
        <option value="unassigned">غير معيّن</option>
        ${team.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
      </select>
    </div>
    <div id="pipeline-body"></div>`;
  content.querySelector('#f-biz').value = filters.business;
  content.querySelector('#f-rep').value = filters.rep;
  content.querySelector('#f-biz').addEventListener('change', (e) => { filters.business = e.target.value; paintPipeline(content, App); });
  content.querySelector('#f-rep').addEventListener('change', (e) => { filters.rep = e.target.value; paintPipeline(content, App); });

  let opps = listOpportunities(state);
  if (filters.business !== 'all') opps = opps.filter((o) => o.business === filters.business);
  if (filters.rep === 'unassigned') opps = opps.filter((o) => !o.deal.ownerUserId);
  else if (filters.rep !== 'all') opps = opps.filter((o) => o.deal.ownerUserId === filters.rep);

  const body = content.querySelector('#pipeline-body');
  if (!opps.length) { body.innerHTML = '<div class="empty-state">ما فيه صفقات مطابقة.</div>'; return; }

  // grouped by business then stage, like a simple vertical kanban
  const businesses = filters.business === 'all' ? ['nahr', 'atmatha'] : [filters.business];
  let html = '';
  for (const biz of businesses) {
    const rows = opps.filter((o) => o.business === biz);
    if (!rows.length) continue;
    html += `<h3 style="margin: 18px 0 8px;">${esc(BUSINESSES[biz].name)} <span class="hint">(${rows.length})</span></h3>`;
    for (const stage of STAGES[biz]) {
      const inStage = rows.filter((o) => o.deal.stage === stage.id);
      if (!inStage.length) continue;
      html += `<div class="hint" style="margin:10px 0 6px;">${esc(stage.name)} · ${inStage.length}</div>`;
      html += `<div class="card-list">${inStage.map((o, i) => cardHtml(o)).join('')}</div>`;
    }
  }
  body.innerHTML = html;
  body.querySelectorAll('.deal-card').forEach((card) => {
    const leadId = card.dataset.leadId, biz = card.dataset.biz;
    card.addEventListener('click', () => {
      const o = opps.find((x) => x.lead.id === leadId && x.business === biz);
      openDeal(o.lead, o.business, o.deal);
    });
  });
}

function cardHtml({ lead, business, deal }) {
  const s = stageOf(business, deal.stage);
  const cls = nextStepClass(deal.nextStepAt);
  const ownerLabel = deal.ownerName || 'غير معيّن';
  return `
    <button type="button" class="deal-card" data-lead-id="${esc(lead.id)}" data-biz="${esc(business)}">
      <div class="row1">
        <span class="name">${esc(lead.name || 'بدون اسم')}</span>
        ${deal.value ? `<span class="value">${Number(deal.value).toLocaleString('ar-SA')} ر.س</span>` : ''}
      </div>
      <div class="row2">
        <span class="pill ${s.won ? 'pill-won' : s.lost ? 'pill-lost' : ''}">${esc(s.name)}</span>
        <span class="hint">${esc(ownerLabel)}</span>
      </div>
      <div class="next ${cls}">${deal.nextStepAt ? fmtDate(deal.nextStepAt) : 'بدون خطوة قادمة'}</div>
    </button>`;
}

// ---------- team ----------
function paintTeam(content, App) {
  const state = App.state;
  const team = state.team || [];
  const counts = team.map((t) => {
    const mine = state.deals.filter((d) => d.ownerUserId === t.id);
    const open = mine.filter((d) => !stageOf(d.business, d.stage).won && !stageOf(d.business, d.stage).lost).length;
    const won = mine.filter((d) => stageOf(d.business, d.stage).won).length;
    return { ...t, total: mine.length, open, won };
  });
  content.innerHTML = `
    <div class="section-card">
      <h3>الفريق</h3>
      <div class="table-wrap">
        <table class="plain">
          <thead><tr><th>الاسم</th><th>مفتوحة</th><th>مربوحة</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            ${counts.map((t) => `
              <tr>
                <td>${esc(t.name)}</td>
                <td>${t.open}</td>
                <td>${t.won}</td>
                <td>${t.active ? 'نشط' : 'موقوف'}</td>
                <td style="display:flex; gap:6px;">
                  <button class="btn btn-sm" data-act="reset" data-id="${t.id}">كلمة مرور جديدة</button>
                  <button class="btn btn-sm ${t.active ? 'btn-danger' : ''}" data-act="${t.active ? 'deactivate' : 'activate'}" data-id="${t.id}">${t.active ? 'إيقاف' : 'تفعيل'}</button>
                </td>
              </tr>`).join('') || '<tr><td colspan="5" class="hint">ما فيه مندوبين بعد</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="section-card">
      <h3>إضافة مندوب</h3>
      <form id="add-rep-form">
        <div class="field"><label>الاسم</label><input name="name" required /></div>
        <div class="field"><label>اسم الدخول</label><input name="phone" type="text" required /></div>
        <div class="field"><label>كلمة مرور مبدئية (8 أحرف فأكثر)</label><input name="password" type="password" minlength="8" required /></div>
        <button class="btn btn-primary btn-block" type="submit">إضافة</button>
      </form>
    </div>`;

  content.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.id, act = btn.dataset.act;
    try {
      if (act === 'reset') {
        const pw = prompt('كلمة المرور الجديدة (8 أحرف فأكثر):');
        if (!pw) return;
        await api.usersAction({ action: 'reset_password', id, password: pw });
        toast('تم تغيير كلمة المرور');
      } else {
        await api.usersAction({ action: act, id });
        toast(act === 'deactivate' ? 'تم إيقاف الحساب' : 'تم تفعيل الحساب');
        await App.refreshData();
        App.rerender();
      }
    } catch (e) { toast(e.message, true); }
  }));

  content.querySelector('#add-rep-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api.usersAction({ action: 'create', name: fd.get('name'), phone: fd.get('phone'), password: fd.get('password') });
      toast('تمت الإضافة');
      ev.target.reset();
      await App.refreshData();
      paintTeam(content, App);
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- settings ----------
function paintSettings(content, App) {
  const state = App.state;
  const dv = (state.settings && state.settings.defaultValue) || {};
  content.innerHTML = `
    <div class="section-card">
      <h3>القيمة الافتراضية للصفقة (ر.س)</h3>
      <form id="settings-form">
        <div class="field"><label>نهر</label><input name="nahr" type="number" min="0" value="${dv.nahr ?? ''}" /></div>
        <div class="field"><label>أتمتها</label><input name="atmatha" type="number" min="0" value="${dv.atmatha ?? ''}" /></div>
        <button class="btn btn-primary btn-block" type="submit">حفظ</button>
      </form>
    </div>`;
  content.querySelector('#settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api.saveSettings({ defaultValue: { nahr: fd.get('nahr'), atmatha: fd.get('atmatha') } });
      toast('تم الحفظ');
      await App.refreshData();
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- sources (Kit / Publer snapshots) ----------
function paintSources(content, App) {
  const state = App.state;
  content.innerHTML = `
    <div class="section-card">
      <div class="row-between"><h3>Kit (النشرة البريدية)</h3><button class="btn btn-sm" id="kit-refresh">تحديث</button></div>
      <div id="kit-body" class="hint">${state.sources.kit ? 'اضغط تحديث لعرض البيانات' : 'غير مفعّل (لا يوجد KIT_API_KEY)'}</div>
    </div>
    <div class="section-card">
      <div class="row-between"><h3>Publer (النشر على السوشال)</h3><button class="btn btn-sm" id="publer-refresh">تحديث</button></div>
      <div id="publer-body" class="hint">${state.sources.publer ? 'اضغط تحديث لعرض البيانات' : 'غير مفعّل (لا يوجد PUBLER_API_KEY)'}</div>
    </div>`;

  content.querySelector('#kit-refresh').addEventListener('click', async () => {
    const body = content.querySelector('#kit-body');
    body.textContent = 'جارٍ التحميل...';
    try {
      const d = await api.kitSnapshot();
      if (!d.connected) { body.textContent = 'غير مفعّل'; return; }
      if (d.error) { body.textContent = 'تعذّر الجلب الآن'; return; }
      body.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi"><div class="n">${d.allTime ?? '—'}</div><div class="l">إجمالي المشتركين</div></div>
          <div class="kpi"><div class="n">${d.recentTotal ?? '—'}</div><div class="l">آخر 120 يوم</div></div>
          <div class="kpi"><div class="n">${(d.broadcasts || []).length}</div><div class="l">آخر الرسائل</div></div>
        </div>
        <div class="table-wrap"><table class="plain"><thead><tr><th>العنوان</th><th>التاريخ</th><th>فتح</th><th>نقر</th></tr></thead><tbody>
          ${(d.broadcasts || []).slice(0, 10).map((b) => `<tr><td>${esc(b.subject)}</td><td>${fmtDate(b.sentAt)}</td><td>${b.openRate ?? '—'}</td><td>${b.clickRate ?? '—'}</td></tr>`).join('')}
        </tbody></table></div>`;
    } catch (e) { body.textContent = e.message; }
  });

  content.querySelector('#publer-refresh').addEventListener('click', async () => {
    const body = content.querySelector('#publer-body');
    body.textContent = 'جارٍ التحميل...';
    try {
      const d = await api.publerSnapshot();
      if (!d.connected) { body.textContent = 'غير مفعّل'; return; }
      if (d.error) { body.textContent = 'تعذّر الجلب الآن'; return; }
      body.innerHTML = `<div class="table-wrap"><table class="plain"><thead><tr><th>الشبكة</th><th>النص</th><th>التاريخ</th></tr></thead><tbody>
        ${(d.posts || []).slice(0, 15).map((p) => `<tr><td>${esc(p.network)}</td><td>${esc(p.text)}</td><td>${fmtDate(p.at)}</td></tr>`).join('')}
      </tbody></table></div>`;
    } catch (e) { body.textContent = e.message; }
  });
}
