// finance-tracker — a tiny personal spending-tracker backend.
// Node + Express + node:sqlite (built-in, Node >= 22.5). One file.
// Money is ALWAYS integer cents. The SQLite DB is the single source of truth.

import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(__dirname, 'public');

// DB lives on a persistent disk in production (see README). Default ./data/finance.db
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', 'finance.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

// ---------------------------------------------------------------------------
// Constants / domain
// ---------------------------------------------------------------------------
const CATEGORY_TYPES = new Set(['fixed', 'variable']);
const IMPORTANCE = new Set([
  'essential',
  'have_to_have',
  'nice_to_have',
  'shouldnt_have',
]);
const IMPORTANCE_LABELS = {
  essential: 'Essential',
  have_to_have: 'Have to Have',
  nice_to_have: 'Nice to Have',
  shouldnt_have: "Shouldn't Have",
};
const MAX_CENTS = 1_000_000_00; // $1,000,000 — sanity ceiling
const MONTH_RE = /^\d{4}-\d{2}$/;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    monthly_income_cents INTEGER NOT NULL DEFAULT 0,
    savings_goal_cents   INTEGER NOT NULL DEFAULT 0,
    currency             TEXT    NOT NULL DEFAULT 'USD'
  );

  CREATE TABLE IF NOT EXISTS categories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    type         TEXT    NOT NULL CHECK (type IN ('fixed', 'variable')),
    budget_cents INTEGER NOT NULL DEFAULT 0,
    position     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    amount_cents INTEGER NOT NULL,
    category_id  INTEGER NOT NULL REFERENCES categories(id),
    importance   TEXT    NOT NULL CHECK (importance IN
                   ('essential','have_to_have','nice_to_have','shouldnt_have')),
    note         TEXT,
    created_at   TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_txn_created ON transactions(created_at);
  CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);
`);

// First-run seed (income $8,000 / savings goal $5,500). Misc trimmed to $180
// so projected savings ($5,500) exactly hits the goal. All values editable.
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
  if (count > 0) return;
  db.prepare(
    'INSERT INTO settings (id, monthly_income_cents, savings_goal_cents, currency) VALUES (1, ?, ?, ?)',
  ).run(800000, 550000, 'USD');

  const cats = [
    ['Living', 'fixed', 122000], // rent 500 + insurance 330 + fuel 250 + internet 95 + phone 45
    ['Health', 'variable', 5000], // gym + buffer
    ['Groceries', 'variable', 10000],
    ['Eating Out', 'variable', 30000],
    ['Fun', 'variable', 30000],
    ['Clothing', 'variable', 35000],
    ['Misc.', 'variable', 18000], // donations ~100 + sisters ~33 + buffer (trimmed to hit goal)
    ['Travel', 'variable', 0],
  ];
  const ins = db.prepare(
    'INSERT INTO categories (name, type, budget_cents, position) VALUES (?, ?, ?, ?)',
  );
  cats.forEach((c, i) => ins.run(c[0], c[1], c[2], i));
  console.log('Seeded settings + 8 categories on first run.');
}
seedIfEmpty();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function intField(value, name, { min = 0, max = MAX_CENTS } = {}) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiError(400, `${name} must be an integer`);
  }
  if (value < min || value > max) {
    throw new ApiError(400, `${name} must be between ${min} and ${max}`);
  }
  return value;
}

function stringField(value, name, { min = 1, max = 280, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, `${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new ApiError(400, `${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min) {
    if (!required) return null;
    throw new ApiError(400, `${name} must not be empty`);
  }
  if (trimmed.length > max) throw new ApiError(400, `${name} must be <= ${max} chars`);
  return trimmed;
}

// Local wall-clock ISO (no timezone suffix), matching the client's localISO().
// Used for server-side fallbacks so month bucketing reflects the LOCAL calendar.
function serverLocalISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

function currentMonth() {
  return serverLocalISO().slice(0, 7);
}

function validateMonth(month) {
  if (month === undefined || month === null || month === '') return currentMonth();
  if (typeof month !== 'string' || !MONTH_RE.test(month)) {
    throw new ApiError(400, 'month must be formatted YYYY-MM');
  }
  return month;
}

// Accept a client-supplied local ISO timestamp (preferred — it reflects the
// user's wall clock). Fall back to server time. Month filtering uses the
// YYYY-MM prefix, so what matters is that this string starts with the local
// calendar date.
function normalizeCreatedAt(value) {
  if (value === undefined || value === null || value === '') {
    return serverLocalISO();
  }
  if (typeof value !== 'string') throw new ApiError(400, 'created_at must be a string');
  const trimmed = value.trim();
  // Month filtering and ordering rely on a literal YYYY-MM-DD prefix, so require
  // one. This rejects parseable-but-non-ISO strings ("03/15/2026", "March 5 2026")
  // that would otherwise be stored verbatim and become invisible to every month view.
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new ApiError(400, 'created_at must be local ISO starting YYYY-MM-DD');
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// State (the big read used by every screen)
// ---------------------------------------------------------------------------
function getState(month) {
  const settings = db
    .prepare(
      'SELECT monthly_income_cents, savings_goal_cents, currency FROM settings WHERE id = 1',
    )
    .get();

  const categories = db
    .prepare('SELECT id, name, type, budget_cents, position FROM categories ORDER BY position, id')
    .all();

  const txns = db
    .prepare(
      `SELECT t.id, t.amount_cents, t.category_id, c.name AS category_name,
              c.type AS category_type, t.importance, t.note, t.created_at
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
        WHERE substr(t.created_at, 1, 7) = ?
        ORDER BY t.created_at DESC, t.id DESC`,
    )
    .all(month);

  const spentByCategory = {};
  for (const c of categories) spentByCategory[c.id] = 0;
  const spentByImportance = {
    essential: 0,
    have_to_have: 0,
    nice_to_have: 0,
    shouldnt_have: 0,
  };
  let variableSpent = 0;
  let totalSpent = 0;
  for (const t of txns) {
    spentByCategory[t.category_id] = (spentByCategory[t.category_id] || 0) + t.amount_cents;
    spentByImportance[t.importance] += t.amount_cents;
    totalSpent += t.amount_cents;
    if (t.category_type === 'variable') variableSpent += t.amount_cents;
  }

  let variableBudget = 0;
  let fixedBudget = 0;
  const cats = categories.map((c) => {
    if (c.type === 'variable') variableBudget += c.budget_cents;
    else fixedBudget += c.budget_cents;
    return { ...c, spent_cents: spentByCategory[c.id] || 0 };
  });
  const allBudget = variableBudget + fixedBudget;
  const projectedSavings = settings.monthly_income_cents - allBudget;

  const derived = {
    variableBudget,
    variableSpent,
    leftToSpend: variableBudget - variableSpent,
    fixedBudget,
    allBudget,
    income: settings.monthly_income_cents,
    projectedSavings,
    savingsGoal: settings.savings_goal_cents,
    savingsGap: projectedSavings - settings.savings_goal_cents, // negative => short of goal
    shouldntHave: spentByImportance.shouldnt_have,
    totalSpent,
  };

  return {
    month,
    settings,
    categories: cats,
    transactions: txns,
    spentByCategory,
    spentByImportance,
    derived,
    syncEnabled: syncEnabled(),
  };
}

// ---------------------------------------------------------------------------
// Google Sheets one-way push (optional, off unless env configured)
// Apps Script web-app URL + shared secret. See README for setup.
// ---------------------------------------------------------------------------
function syncEnabled() {
  return Boolean(process.env.GSHEET_WEBAPP_URL && process.env.GSHEET_SECRET);
}

async function pushToSheet(row) {
  if (!syncEnabled()) return { ok: false, skipped: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(process.env.GSHEET_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.GSHEET_SECRET, row }),
      signal: controller.signal,
      redirect: 'follow', // Apps Script web apps 302-redirect to script.googleusercontent.com
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, detail: text.slice(0, 200) };
    return { ok: true, detail: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, detail: String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

function txnToSheetRow(txn) {
  const cat = db.prepare('SELECT name FROM categories WHERE id = ?').get(txn.category_id);
  return {
    date: txn.created_at,
    amount: (txn.amount_cents / 100).toFixed(2),
    category: cat ? cat.name : '',
    importance: IMPORTANCE_LABELS[txn.importance] || txn.importance,
    note: txn.note || '',
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '64kb' }));

// async handler wrapper that funnels ApiError -> JSON
const h = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.catch((e) => fail(res, e));
  } catch (e) {
    fail(res, e);
  }
};
function fail(res, e) {
  if (e instanceof ApiError) return res.status(e.status).json({ error: e.message });
  console.error('Unhandled error:', e);
  return res.status(500).json({ error: 'Internal server error' });
}

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- state -----------------------------------------------------------------
app.get(
  '/api/state',
  h((req, res) => {
    const month = validateMonth(req.query.month);
    res.json(getState(month));
  }),
);

// ---- transactions ----------------------------------------------------------
app.post(
  '/api/transactions',
  h((req, res) => {
    const body = req.body || {};
    const amount_cents = intField(body.amount_cents, 'amount_cents', { min: 1 });
    const category_id = intField(body.category_id, 'category_id', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id);
    if (!cat) throw new ApiError(400, 'category_id does not exist');
    if (!IMPORTANCE.has(body.importance)) throw new ApiError(400, 'invalid importance');
    const note = stringField(body.note, 'note', { required: false, min: 1, max: 280 });
    const created_at = normalizeCreatedAt(body.created_at);

    const info = db
      .prepare(
        'INSERT INTO transactions (amount_cents, category_id, importance, note, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(amount_cents, category_id, body.importance, note, created_at);

    const txn = db
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .get(Number(info.lastInsertRowid));

    // fire-and-forget push to Google Sheets; never blocks or fails the save
    if (syncEnabled()) {
      pushToSheet(txnToSheetRow(txn)).then((r) => {
        if (!r.ok && !r.skipped) console.warn('Sheets sync failed:', r.detail);
      });
    }

    // The row is already committed; never throw while building the response.
    // created_at is guaranteed to start YYYY-MM-DD, so its prefix is a valid month.
    const q = req.query.month;
    const month = typeof q === 'string' && MONTH_RE.test(q) ? q : created_at.slice(0, 7);
    res.status(201).json({ ok: true, transaction: txn, state: getState(month) });
  }),
);

app.delete(
  '/api/transactions/:id',
  h((req, res) => {
    const id = intField(req.params.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const info = db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    if (info.changes === 0) throw new ApiError(404, 'transaction not found');
    const month = validateMonth(req.query.month);
    res.json({ ok: true, state: getState(month) });
  }),
);

// ---- settings --------------------------------------------------------------
app.put(
  '/api/settings',
  h((req, res) => {
    const body = req.body || {};
    const current = db.prepare('SELECT * FROM settings WHERE id = 1').get();
    const monthly_income_cents =
      body.monthly_income_cents === undefined
        ? current.monthly_income_cents
        : intField(body.monthly_income_cents, 'monthly_income_cents', { min: 0 });
    const savings_goal_cents =
      body.savings_goal_cents === undefined
        ? current.savings_goal_cents
        : intField(body.savings_goal_cents, 'savings_goal_cents', { min: 0 });
    const currency =
      body.currency === undefined
        ? current.currency
        : stringField(body.currency, 'currency', { min: 1, max: 8 });

    db.prepare(
      'UPDATE settings SET monthly_income_cents = ?, savings_goal_cents = ?, currency = ? WHERE id = 1',
    ).run(monthly_income_cents, savings_goal_cents, currency);

    const month = validateMonth(req.query.month);
    res.json({ ok: true, state: getState(month) });
  }),
);

// ---- categories ------------------------------------------------------------
app.post(
  '/api/categories',
  h((req, res) => {
    const body = req.body || {};
    const name = stringField(body.name, 'name', { min: 1, max: 40 });
    if (!CATEGORY_TYPES.has(body.type)) throw new ApiError(400, 'type must be fixed or variable');
    const budget_cents = intField(body.budget_cents ?? 0, 'budget_cents', { min: 0 });
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM categories').get().m;
    const info = db
      .prepare('INSERT INTO categories (name, type, budget_cents, position) VALUES (?, ?, ?, ?)')
      .run(name, body.type, budget_cents, maxPos + 1);
    const month = validateMonth(req.query.month);
    res.status(201).json({ ok: true, id: Number(info.lastInsertRowid), state: getState(month) });
  }),
);

app.put(
  '/api/categories/:id',
  h((req, res) => {
    const id = intField(req.params.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const current = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!current) throw new ApiError(404, 'category not found');
    const body = req.body || {};
    const name = body.name === undefined ? current.name : stringField(body.name, 'name', { min: 1, max: 40 });
    let type = current.type;
    if (body.type !== undefined) {
      if (!CATEGORY_TYPES.has(body.type)) throw new ApiError(400, 'type must be fixed or variable');
      type = body.type;
    }
    const budget_cents =
      body.budget_cents === undefined
        ? current.budget_cents
        : intField(body.budget_cents, 'budget_cents', { min: 0 });
    const position =
      body.position === undefined
        ? current.position
        : intField(body.position, 'position', { min: 0, max: 100000 });

    db.prepare('UPDATE categories SET name = ?, type = ?, budget_cents = ?, position = ? WHERE id = ?').run(
      name,
      type,
      budget_cents,
      position,
      id,
    );
    const month = validateMonth(req.query.month);
    res.json({ ok: true, state: getState(month) });
  }),
);

app.delete(
  '/api/categories/:id',
  h((req, res) => {
    const id = intField(req.params.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const current = db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
    if (!current) throw new ApiError(404, 'category not found');
    const used = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(id).n;
    if (used > 0) {
      throw new ApiError(
        409,
        `Cannot delete: ${used} transaction(s) use this category. Delete or reassign them first.`,
      );
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    const month = validateMonth(req.query.month);
    res.json({ ok: true, state: getState(month) });
  }),
);

// ---- CSV export (all transactions, all time) -------------------------------
function csvEscape(field) {
  let s = String(field ?? '');
  // Neutralize spreadsheet formula injection: a leading = + - @ (or tab/CR) makes
  // Excel/Sheets evaluate the cell as a formula. Prefix with ' so it stays literal.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get(
  '/api/export.csv',
  h((req, res) => {
    const rows = db
      .prepare(
        `SELECT t.created_at, t.amount_cents, c.name AS category, t.importance, t.note
           FROM transactions t
           JOIN categories c ON c.id = t.category_id
          ORDER BY t.created_at ASC, t.id ASC`,
      )
      .all();
    const lines = ['date,amount,category,importance,note'];
    for (const r of rows) {
      lines.push(
        [
          csvEscape(r.created_at),
          (r.amount_cents / 100).toFixed(2),
          csvEscape(r.category),
          csvEscape(IMPORTANCE_LABELS[r.importance] || r.importance),
          csvEscape(r.note || ''),
        ].join(','),
      );
    }
    const csv = lines.join('\r\n') + '\r\n';
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="finance-tracker-${stamp}.csv"`);
    res.send(csv);
  }),
);

// ---- sync test (explicit user action; awaited) -----------------------------
app.post(
  '/api/sync/test',
  h(async (req, res) => {
    if (!syncEnabled()) {
      return res.status(400).json({ ok: false, error: 'Google Sheets sync is not configured (set GSHEET_WEBAPP_URL and GSHEET_SECRET).' });
    }
    const result = await pushToSheet({
      date: new Date().toISOString(),
      amount: '0.00',
      category: 'TEST',
      importance: 'Test row from finance-tracker',
      note: 'If you see this row, sync works. Safe to delete.',
    });
    res.status(result.ok ? 200 : 502).json(result);
  }),
);

// ---- static PWA + SPA fallback ---------------------------------------------
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      // never let the HTML shell or service worker go stale while online
      if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

// Terminal JSON error handler — keeps the {error} shape even for body-parser
// failures (malformed/oversized JSON), which throw before any route runs.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err instanceof SyntaxError)) {
    return res.status(err.status || 400).json({ error: 'Invalid request body' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`finance-tracker listening on http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Google Sheets sync: ${syncEnabled() ? 'ENABLED' : 'off (CSV export only)'}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${PORT} is already in use by another app.`);
    console.error(`  Start finance-tracker on a different port, e.g.:  PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw err;
});
