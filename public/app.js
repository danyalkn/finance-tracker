/* ============================================================
   Finance Tracker — front-end. Vanilla JS, no framework.
   The server DB is the source of truth; we never persist data
   locally. Every screen renders from one `state` object fetched
   from GET /api/state, and mutations return the fresh state.
   ============================================================ */

'use strict';

// ---------- domain ----------
const IMPORTANCE_LABELS = {
  essential: 'Essential',
  have_to_have: 'Have to Have',
  nice_to_have: 'Nice to Have',
  shouldnt_have: "Shouldn't Have",
};
const IMPORTANCE_ORDER = ['essential', 'have_to_have', 'nice_to_have', 'shouldnt_have'];
const IMPORTANCE_COLORS = {
  essential: '#8FB07A',
  have_to_have: '#E0B24A',
  nice_to_have: '#6C93B8',
  shouldnt_have: '#C2553D',
};
const CATEGORY_COLORS = [
  '#E0B24A', '#C2553D', '#8FB07A', '#6C93B8', '#C98A5E',
  '#A77FB0', '#D4C26A', '#7FB0A8', '#B0746A', '#9AA86A',
];
const MAX_ENTRY_CENTS = 99999999; // $999,999.99 ceiling for keypad entry

// ---------- app state ----------
let state = null;
let currency = 'USD';
let selectedMonth = localMonthStr();
let chartMode = 'category';
let pendingDeleteId = null; // recent-list inline delete confirmation

// ---------- log-sheet state ----------
let entryCents = 0;
let entryCategoryId = null;
let entryImportance = 'have_to_have';

// ---------- tiny DOM helpers ----------
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- money + date helpers ----------
function fmt(cents, withCents = true) {
  const opts = {
    style: 'currency',
    currency,
    minimumFractionDigits: withCents ? 2 : 0,
    maximumFractionDigits: withCents ? 2 : 0,
  };
  try {
    return new Intl.NumberFormat(undefined, opts).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(withCents ? 2 : 0)}`;
  }
}
function dollarsStr(cents) {
  return (cents / 100).toFixed(2);
}
function parseDollarsToCents(str) {
  // Strict decimal only — reject stray letters/exponents instead of silently
  // truncating them (e.g. "1e2"/"12abc" -> null, not $12). String-based cents
  // avoids IEEE-754 drift (e.g. "1.005" -> 101, not 100).
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(String(str).trim());
  if (!m) return null;
  const intPart = m[2] || '';
  const fracRaw = m[3] || '';
  if (intPart === '' && fracRaw === '') return null; // "", ".", "-"
  const sign = m[1] === '-' ? -1 : 1;
  const dollars = intPart === '' ? 0 : Number(intPart);
  const frac2 = Number((fracRaw + '00').slice(0, 2));
  const roundUp = fracRaw.length > 2 && Number(fracRaw[2]) >= 5 ? 1 : 0;
  return sign * (dollars * 100 + frac2 + roundUp);
}
function pad2(n) {
  return String(n).padStart(2, '0');
}
function localMonthStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function localISO(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}:${pad2(d.getSeconds())}`;
}
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
}
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function shiftMonth(month, delta) {
  let [y, m] = month.split('-').map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${pad2(m)}`;
}
// fraction of the month actually elapsed (the pace marker), from the LOCAL clock.
// Counts whole days before today plus the fraction of today, so on day 1 the
// marker sits near 0 rather than at 1/N.
function paceFraction(month) {
  const cur = localMonthStr();
  if (month < cur) return 1; // a past month is fully elapsed
  if (month > cur) return 0; // a future month hasn't started
  const now = new Date();
  const elapsedDays =
    now.getDate() - 1 + (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
  return elapsedDays / daysInMonth(month);
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// budget health: good -> warn -> over, relative to spend ratio and pace
function statusOf(spent, budget, pace) {
  if (budget <= 0) return spent > 0 ? 'over' : 'good';
  const r = spent / budget;
  if (r >= 1) return 'over';
  if (r >= 0.85 || r > pace + 0.05) return 'warn';
  return 'good';
}

// ---------- API ----------
async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("You're offline — that needs a connection.");
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new Error(data.error || (data.offline ? "You're offline." : `Error ${res.status}`));
  return data;
}
const monthQS = () => `?month=${encodeURIComponent(selectedMonth)}`;

function applyState(newState) {
  state = newState;
  currency = (state.settings && state.settings.currency) || 'USD';
  renderAll();
}

async function loadState() {
  try {
    applyState(await api(`/api/state${monthQS()}`));
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}

// ============================================================
// RENDER
// ============================================================
function renderAll() {
  if (!state) return;
  $('monthLabel').textContent = monthLabel(selectedMonth);
  renderHome();
  renderCharts();
  renderBudget();
}

function renderHome() {
  const d = state.derived;
  const pace = paceFraction(selectedMonth);
  const st = statusOf(d.variableSpent, d.variableBudget, pace);

  const hero = $('hero');
  hero.className = 'hero ' + st;
  $('heroAmount').textContent = fmt(d.leftToSpend);

  const fillPct =
    d.variableBudget > 0 ? clamp01(d.variableSpent / d.variableBudget) * 100 : d.variableSpent > 0 ? 100 : 0;
  $('heroFill').style.width = fillPct + '%';
  $('heroPace').style.width = clamp01(pace) * 100 + '%';

  $('heroSpentLabel').textContent = `${fmt(d.variableSpent)} of ${fmt(d.variableBudget)} spent`;
  const cur = localMonthStr();
  $('heroPaceLabel').textContent =
    selectedMonth === cur
      ? `Day ${new Date().getDate()} of ${daysInMonth(selectedMonth)}`
      : selectedMonth < cur
        ? 'Month ended'
        : 'Not started';

  // savings line
  $('savingsValue').textContent = fmt(d.projectedSavings);
  const savingsStat = $('savingsStat');
  if (d.savingsGap >= 0) {
    savingsStat.className = 'stat savings-ok';
    $('savingsSub').textContent = `${fmt(d.savingsGap)} over your ${fmt(d.savingsGoal)} goal`;
  } else {
    savingsStat.className = 'stat savings-short';
    $('savingsSub').textContent = `${fmt(-d.savingsGap)} short of ${fmt(d.savingsGoal)} goal`;
  }

  // regret
  $('regretValue').textContent = fmt(d.shouldntHave);

  // category cards (variable only)
  const cardsEl = $('categoryCards');
  const variableCats = state.categories.filter((c) => c.type === 'variable');
  cardsEl.innerHTML = variableCats
    .map((c) => {
      const remaining = c.budget_cents - c.spent_cents;
      const cst = statusOf(c.spent_cents, c.budget_cents, pace);
      const w = c.budget_cents > 0 ? clamp01(c.spent_cents / c.budget_cents) * 100 : c.spent_cents > 0 ? 100 : 0;
      return `<div class="cat-card ${cst}">
        <div class="cat-name">${escapeHtml(c.name)}</div>
        <div class="cat-remaining num">${fmt(remaining)}</div>
        <div class="cat-of">left of ${fmt(c.budget_cents)}</div>
        <div class="cat-bar"><span style="width:${w}%"></span></div>
      </div>`;
    })
    .join('');

  // recent purchases
  const list = $('recentList');
  const txns = state.transactions;
  if (txns.length === 0) {
    list.innerHTML = '';
    $('recentEmpty').classList.remove('hidden');
  } else {
    $('recentEmpty').classList.add('hidden');
    list.innerHTML = txns
      .map((t) => {
        const controls =
          pendingDeleteId === t.id
            ? `<div class="rec-confirm"><button class="yes" data-action="confirm" data-id="${t.id}">Delete</button><button class="no" data-action="cancel">Cancel</button></div>`
            : `<button class="rec-del" data-action="ask" data-id="${t.id}" aria-label="Delete">✕</button>`;
        const note = t.note ? `<span class="rec-note">${escapeHtml(t.note)}</span>` : '';
        return `<li>
          <div class="rec-main">
            <div class="rec-top">
              <span class="rec-cat">${escapeHtml(t.category_name)}</span>
              <span class="imp-chip imp-${t.importance}">${IMPORTANCE_LABELS[t.importance]}</span>
            </div>
            ${note}
          </div>
          <span class="rec-amount num">${fmt(t.amount_cents)}</span>
          ${controls}
        </li>`;
      })
      .join('');
  }
}

function renderCharts() {
  let items;
  if (chartMode === 'category') {
    items = state.categories
      .map((c, i) => ({ label: c.name, value: c.spent_cents, color: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value);
  } else {
    items = IMPORTANCE_ORDER.map((k) => ({
      label: IMPORTANCE_LABELS[k],
      value: state.spentByImportance[k] || 0,
      color: IMPORTANCE_COLORS[k],
    })).filter((x) => x.value > 0);
  }
  const total = items.reduce((s, x) => s + x.value, 0);

  const pie = $('pie');
  const center = $('chartCenter');
  const legend = $('legend');
  if (total <= 0) {
    pie.innerHTML = '';
    center.innerHTML = '';
    legend.innerHTML = '';
    $('chartEmpty').classList.remove('hidden');
    return;
  }
  $('chartEmpty').classList.add('hidden');
  pie.innerHTML = buildPie(items, total);
  center.innerHTML = `<div class="cc-total num">${fmt(total)}</div><div class="cc-label">${
    chartMode === 'category' ? 'by category' : 'by importance'
  }</div>`;
  const pcts = largestRemainder(items.map((x) => x.value), total);
  legend.innerHTML = items
    .map(
      (x, i) => `<li>
        <span class="swatch" style="background:${x.color}"></span>
        <span class="lg-label">${escapeHtml(x.label)}</span>
        <span class="lg-amt num">${fmt(x.value)}</span>
        <span class="lg-pct num">${pcts[i]}%</span>
      </li>`,
    )
    .join('');
}

// Integer percentages that always sum to `target` (largest-remainder method),
// so the legend never shows 101% from independent rounding.
function largestRemainder(values, total, target = 100) {
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * target);
  const out = exact.map((e) => Math.floor(e));
  let left = target - out.reduce((a, b) => a + b, 0);
  exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac)
    .forEach((o) => {
      if (left-- > 0) out[o.i] += 1;
    });
  return out;
}

function buildPie(items, total) {
  const cx = 100, cy = 100, r = 92, hole = 54;
  let svg = '';
  if (items.length === 1) {
    svg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${items[0].color}"/>`;
  } else {
    let a = -Math.PI / 2;
    for (const it of items) {
      const sweep = (it.value / total) * 2 * Math.PI;
      const a2 = a + sweep;
      const x1 = cx + r * Math.cos(a);
      const y1 = cy + r * Math.sin(a);
      const x2 = cx + r * Math.cos(a2);
      const y2 = cy + r * Math.sin(a2);
      const large = sweep > Math.PI ? 1 : 0;
      svg += `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(
        2,
      )} ${y2.toFixed(2)} Z" fill="${it.color}"/>`;
      a = a2;
    }
  }
  svg += `<circle cx="${cx}" cy="${cy}" r="${hole}" fill="#1A1714"/>`;
  return svg;
}

function renderBudget() {
  const d = state.derived;
  // income / goal inputs (don't clobber while the user is typing)
  const inc = $('incomeInput');
  const goal = $('goalInput');
  if (document.activeElement !== inc) inc.value = dollarsStr(state.settings.monthly_income_cents);
  if (document.activeElement !== goal) goal.value = dollarsStr(state.settings.savings_goal_cents);

  $('budgetSummary').innerHTML = `
    <div class="bs-row"><span>Monthly income</span><span class="num">${fmt(d.income)}</span></div>
    <div class="bs-row"><span>All budgets</span><span class="num">− ${fmt(d.allBudget)}</span></div>
    <div class="bs-row total"><span>Left to save</span><span class="num">${fmt(d.projectedSavings)}</span></div>
    <div class="flag ${d.savingsGap >= 0 ? 'ok' : 'short'}">${
      d.savingsGap >= 0
        ? `On track — ${fmt(d.savingsGap)} above your ${fmt(d.savingsGoal)} goal.`
        : `${fmt(-d.savingsGap)} short of your ${fmt(d.savingsGoal)} goal.`
    }</div>`;

  // Don't rebuild the rows while the user is editing one — replacing innerHTML
  // would destroy the focused input and drop in-flight keystrokes. The summary
  // above still refreshes; the rows resync on the next render once focus leaves.
  const catsEl = $('budgetCategories');
  if (!catsEl.contains(document.activeElement)) {
    catsEl.innerHTML = state.categories
      .map(
        (c) => `<div class="bc-row" data-id="${c.id}">
        <input class="bc-name" value="${escapeHtml(c.name)}" maxlength="40" />
        <div class="bc-budget"><span>$</span><input class="bc-budget-input" inputmode="decimal" value="${dollarsStr(
          c.budget_cents,
        )}" /></div>
        <div class="bc-controls">
          <div class="type-toggle">
            <button data-type="fixed" class="${c.type === 'fixed' ? 'active' : ''}">Fixed</button>
            <button data-type="variable" class="${c.type === 'variable' ? 'active' : ''}">Variable</button>
          </div>
          <span class="bc-spent num">${fmt(c.spent_cents)} spent</span>
          <button class="bc-del" data-del aria-label="Delete category">🗑</button>
        </div>
      </div>`,
      )
      .join('');
  }

  // sync box
  const sync = $('syncBox');
  if (state.syncEnabled) {
    sync.innerHTML = `<div class="sync-status"><span class="dot on"></span>Google Sheets sync is ON</div>
      Each saved purchase is appended to your sheet.
      <div style="margin-top:10px"><button class="ghost-btn" id="syncTestBtn">Send test row</button></div>`;
    $('syncTestBtn').onclick = syncTest;
  } else {
    sync.innerHTML = `<div class="sync-status"><span class="dot off"></span>Google Sheets sync is OFF</div>
      Using CSV export only. To enable one-way push, set <code>GSHEET_WEBAPP_URL</code> and
      <code>GSHEET_SECRET</code> on the server (see README).`;
  }
}

async function syncTest() {
  try {
    const r = await api('/api/sync/test', { method: 'POST', body: {} });
    toast(r.ok ? 'Test row sent ✓' : 'Sync failed: ' + (r.detail || 'unknown'), !r.ok);
  } catch (e) {
    toast(e.message, true);
  }
}

// ============================================================
// LOG SHEET (the 5-second fast path)
// ============================================================
function openSheet() {
  entryCents = 0;
  entryCategoryId = null;
  entryImportance = 'have_to_have';
  $('noteInput').value = '';

  // importance picker default
  document.querySelectorAll('#importancePicker .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.imp === entryImportance);
  });

  // category chips (every category is loggable — incl. fixed like Living)
  $('categoryChips').innerHTML = state.categories
    .map((c) => `<button class="chip" data-cat="${c.id}">${escapeHtml(c.name)}</button>`)
    .join('');

  updateEntryDisplay();
  $('logBackdrop').classList.remove('hidden');
  $('logSheet').classList.remove('hidden');
}
function closeSheet() {
  $('logSheet').classList.add('hidden');
  $('logBackdrop').classList.add('hidden');
}
function updateEntryDisplay() {
  $('amountDisplay').textContent = fmt(entryCents);
  const ok = entryCents > 0 && entryCategoryId != null;
  $('logSave').disabled = !ok;
  $('logSaveBig').disabled = !ok;
}
function keypadPress(key) {
  if (key === 'del') {
    entryCents = Math.floor(entryCents / 10);
  } else if (key === '00') {
    const next = entryCents * 100;
    if (next <= MAX_ENTRY_CENTS) entryCents = next;
  } else {
    const next = entryCents * 10 + Number(key);
    if (next <= MAX_ENTRY_CENTS) entryCents = next;
  }
  updateEntryDisplay();
}
async function savePurchase() {
  if (entryCents <= 0 || entryCategoryId == null) return;
  $('logSave').disabled = true;
  $('logSaveBig').disabled = true;
  // a purchase is logged "now" -> it belongs to the current local month
  const logMonth = localMonthStr();
  try {
    const resp = await api(`/api/transactions?month=${encodeURIComponent(logMonth)}`, {
      method: 'POST',
      body: {
        amount_cents: entryCents,
        category_id: entryCategoryId,
        importance: entryImportance,
        note: $('noteInput').value.trim() || null,
        created_at: localISO(),
      },
    });
    selectedMonth = logMonth; // only switch the viewed month after a successful save
    applyState(resp.state);
    closeSheet();
    showScreen('home');
    toast('Logged ✓');
  } catch (e) {
    // selectedMonth is untouched on failure, so the view stays consistent
    toast(e.message, true);
    updateEntryDisplay();
  }
}

// ============================================================
// NAVIGATION
// ============================================================
function showScreen(name) {
  for (const s of ['home', 'charts', 'budget']) {
    $('screen-' + s).classList.toggle('hidden', s !== name);
  }
  document.querySelectorAll('.tab[data-screen]').forEach((t) => {
    t.classList.toggle('active', t.dataset.screen === name);
  });
}

// ============================================================
// EVENT WIRING
// ============================================================
function wireEvents() {
  // month nav
  $('monthPrev').onclick = () => { selectedMonth = shiftMonth(selectedMonth, -1); pendingDeleteId = null; loadState(); };
  $('monthNext').onclick = () => { selectedMonth = shiftMonth(selectedMonth, 1); pendingDeleteId = null; loadState(); };

  // tabs + log button
  document.querySelectorAll('.tab[data-screen]').forEach((t) => {
    t.onclick = () => showScreen(t.dataset.screen);
  });
  $('logBtn').onclick = openSheet;

  // log sheet
  $('logCancel').onclick = closeSheet;
  $('logBackdrop').onclick = closeSheet;
  $('logSave').onclick = savePurchase;
  $('logSaveBig').onclick = savePurchase;
  $('keypad').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (btn) keypadPress(btn.dataset.key);
  });
  $('categoryChips').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cat]');
    if (!btn) return;
    entryCategoryId = Number(btn.dataset.cat);
    document.querySelectorAll('#categoryChips .chip').forEach((c) => c.classList.toggle('active', c === btn));
    updateEntryDisplay();
  });
  $('importancePicker').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-imp]');
    if (!btn) return;
    entryImportance = btn.dataset.imp;
    document.querySelectorAll('#importancePicker .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });

  // charts toggle
  $('chartToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    chartMode = btn.dataset.mode;
    document.querySelectorAll('#chartToggle .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    renderCharts();
  });

  // recent list delete (event delegation)
  $('recentList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'ask') {
      pendingDeleteId = Number(btn.dataset.id);
      renderHome();
    } else if (action === 'cancel') {
      pendingDeleteId = null;
      renderHome();
    } else if (action === 'confirm') {
      const id = Number(btn.dataset.id);
      pendingDeleteId = null;
      try {
        const resp = await api(`/api/transactions/${id}${monthQS()}`, { method: 'DELETE' });
        applyState(resp.state);
        toast('Deleted');
      } catch (err) {
        toast(err.message, true);
        renderHome(); // resync the now-cleared confirm UI after a failed delete
      }
    }
  });

  // budget: income / goal
  $('incomeInput').addEventListener('change', () => saveSetting('monthly_income_cents', $('incomeInput').value));
  $('goalInput').addEventListener('change', () => saveSetting('savings_goal_cents', $('goalInput').value));

  // budget: category edits (delegation)
  $('budgetCategories').addEventListener('change', (e) => {
    const row = e.target.closest('.bc-row');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (e.target.classList.contains('bc-name')) {
      const name = e.target.value.trim();
      if (name) saveCategory(id, { name });
      else loadState();
    } else if (e.target.classList.contains('bc-budget-input')) {
      const cents = parseDollarsToCents(e.target.value);
      if (cents != null && cents >= 0) saveCategory(id, { budget_cents: cents });
      else loadState();
    }
  });
  $('budgetCategories').addEventListener('click', (e) => {
    const row = e.target.closest('.bc-row');
    if (!row) return;
    const id = Number(row.dataset.id);
    const typeBtn = e.target.closest('button[data-type]');
    if (typeBtn) {
      saveCategory(id, { type: typeBtn.dataset.type });
      return;
    }
    if (e.target.closest('button[data-del]')) {
      deleteCategory(id);
    }
  });
  $('addCategoryBtn').onclick = addCategory;
}

async function saveSetting(field, rawValue) {
  const cents = parseDollarsToCents(rawValue);
  if (cents == null || cents < 0) {
    toast('Enter a valid amount', true);
    loadState();
    return;
  }
  try {
    applyState((await api(`/api/settings${monthQS()}`, { method: 'PUT', body: { [field]: cents } })).state);
  } catch (e) {
    toast(e.message, true);
  }
}
async function saveCategory(id, patch) {
  try {
    applyState((await api(`/api/categories/${id}${monthQS()}`, { method: 'PUT', body: patch })).state);
  } catch (e) {
    toast(e.message, true);
  }
}
async function addCategory() {
  try {
    const resp = await api(`/api/categories${monthQS()}`, {
      method: 'POST',
      body: { name: 'New category', type: 'variable', budget_cents: 0 },
    });
    applyState(resp.state);
    // focus the freshly added row's name field
    const rows = document.querySelectorAll('#budgetCategories .bc-row');
    const last = rows[rows.length - 1];
    if (last) {
      const input = last.querySelector('.bc-name');
      input.focus();
      input.select();
    }
  } catch (e) {
    toast(e.message, true);
  }
}
async function deleteCategory(id) {
  const cat = state.categories.find((c) => c.id === id);
  if (!cat) return;
  if (!confirm(`Delete category "${cat.name}"? This can't be undone.`)) return;
  try {
    applyState((await api(`/api/categories/${id}${monthQS()}`, { method: 'DELETE' })).state);
    toast('Category deleted');
  } catch (e) {
    toast(e.message, true); // e.g. 409 when transactions still use it
  }
}

// ============================================================
// INIT
// ============================================================
function init() {
  wireEvents();
  showScreen('home');
  loadState();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}
init();
