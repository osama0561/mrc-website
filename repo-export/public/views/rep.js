import { BUSINESSES, stageOf } from '../constants.js';
import {
  esc, fmtDate, nextStepClass, listOpportunities, openDeal,
} from '../app.js';

let filterBusiness = 'all';

export function renderRep(root, App) {
  const state = App.state;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="topbar">
      <div class="brand">صفقاتي</div>
      <div class="spacer"></div>
      <div class="who">${esc(state.user.name)}</div>
      <button class="btn btn-ghost btn-sm" id="logout-btn">خروج</button>
    </div>
    <div class="page">
      <div class="tabs" id="biz-tabs">
        <button class="tab-btn ${filterBusiness === 'all' ? 'active' : ''}" data-biz="all">الكل</button>
        <button class="tab-btn ${filterBusiness === 'nahr' ? 'active' : ''}" data-biz="nahr">نهر</button>
        <button class="tab-btn ${filterBusiness === 'atmatha' ? 'active' : ''}" data-biz="atmatha">أتمتها</button>
      </div>
      <div id="card-list" class="card-list"></div>
    </div>`;
  root.appendChild(wrap);

  wrap.querySelector('#logout-btn').addEventListener('click', () => App.logout());
  wrap.querySelectorAll('#biz-tabs .tab-btn').forEach((b) => b.addEventListener('click', () => {
    filterBusiness = b.dataset.biz;
    renderRep(resetRoot(root), App);
  }));

  paintList(wrap, App);
}

function resetRoot(root) {
  root.innerHTML = '';
  return root;
}

function paintList(wrap, App) {
  const state = App.state;
  let opps = listOpportunities(state);
  if (filterBusiness !== 'all') opps = opps.filter((o) => o.business === filterBusiness);

  // Open deals first (soonest next step first, then no next step), closed deals last.
  opps.sort((a, b) => {
    const sa = stageOf(a.business, a.deal.stage), sb = stageOf(b.business, b.deal.stage);
    const closedA = sa.won || sa.lost, closedB = sb.won || sb.lost;
    if (closedA !== closedB) return closedA ? 1 : -1;
    const da = a.deal.nextStepAt || '9999-99-99';
    const db = b.deal.nextStepAt || '9999-99-99';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const list = wrap.querySelector('#card-list');
  if (!opps.length) {
    list.innerHTML = '<div class="empty-state">ما عندك صفقات بعد. إذا انتظرت شوي، راح يعيّن لك المدير عملاء.</div>';
    return;
  }
  list.innerHTML = opps.map((o) => cardHtml(o)).join('');
  list.querySelectorAll('.deal-card').forEach((card, i) => {
    card.addEventListener('click', () => openDeal(opps[i].lead, opps[i].business, opps[i].deal));
  });
}

function cardHtml({ lead, business, deal }) {
  const s = stageOf(business, deal.stage);
  const cls = nextStepClass(deal.nextStepAt);
  const nextLabel = deal.nextStepAt
    ? `${cls === 'overdue' ? 'متأخرة: ' : ''}${fmtDate(deal.nextStepAt)}${deal.nextStep ? ` · ${esc(deal.nextStep)}` : ''}`
    : 'ما فيه خطوة قادمة محددة';
  return `
    <button type="button" class="deal-card">
      <div class="row1">
        <span class="name">${esc(lead.name || 'بدون اسم')}</span>
        ${deal.value ? `<span class="value">${Number(deal.value).toLocaleString('ar-SA')} ر.س</span>` : ''}
      </div>
      <div class="row2">
        <span class="pill pill-${business}">${esc(BUSINESSES[business].name)}</span>
        <span class="pill ${s.won ? 'pill-won' : s.lost ? 'pill-lost' : ''}">${esc(s.name)}</span>
      </div>
      <div class="next ${cls}">${nextLabel}</div>
    </button>`;
}
