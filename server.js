// finance-tracker — a tiny personal spending-tracker backend.
// Node + Express. Storage is pluggable (see db.js): Supabase/Postgres in the
// cloud, local SQLite for dev. Money is ALWAYS integer cents; the DB is the
// single source of truth. Optional password gate guards the public deployment.

import express from 'express';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(__dirname, 'public');

let db; // chooses Postgres (DATABASE_URL) or SQLite, runs migrations + seed
try {
  db = await createDb();
} catch (e) {
  console.error('\n✗ Could not connect to the database.');
  console.error('  Check DATABASE_URL (your Supabase connection string) and that the DB is reachable.');
  console.error('  Detail:', e.message, '\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Constants / domain
// ---------------------------------------------------------------------------
const CATEGORY_TYPES = new Set(['fixed', 'variable']);
const IMPORTANCE = new Set(['essential', 'have_to_have', 'nice_to_have', 'shouldnt_have']);
const IMPORTANCE_LABELS = {
  essential: 'Essential',
  have_to_have: 'Have to Have',
  nice_to_have: 'Nice to Have',
  shouldnt_have: "Shouldn't Have",
};
const MAX_CENTS = 1_000_000_00; // $1,000,000 — sanity ceiling
const MONTH_RE = /^\d{4}-\d{2}$/;

// ---------------------------------------------------------------------------
// Auth — single shared password (set APP_PASSWORD). If unset, auth is disabled
// (handy for local dev). On login we set a signed, expiring, httpOnly cookie.
// ---------------------------------------------------------------------------
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_REQUIRED = APP_PASSWORD.length > 0;
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (AUTH_REQUIRED ? crypto.createHash('sha256').update(`ft:${APP_PASSWORD}`).digest('hex') : 'dev');
const COOKIE = 'ft_auth';
const SESSION_MS = 180 * 24 * 60 * 60 * 1000; // ~6 months

// Fail closed: never boot an internet-exposed instance with auth disabled. A
// forgotten/typo'd APP_PASSWORD would otherwise silently expose a world-writable
// financial DB. The cloud path (Postgres) or a deploy indicator means "exposed".
const EXPOSED =
  db.kind === 'postgres' ||
  Boolean(process.env.FLY_APP_NAME || process.env.RENDER) ||
  process.env.NODE_ENV === 'production';
if (!AUTH_REQUIRED && EXPOSED) {
  console.error('\n✗ Refusing to start: APP_PASSWORD is not set in a deployed environment.');
  console.error('  Set a password, e.g.:  fly secrets set APP_PASSWORD=your-strong-password\n');
  process.exit(1);
}

const sign = (payload) => crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return `${exp}.${sign(exp)}`;
}
function verifyToken(tok) {
  if (typeof tok !== 'string') return false;
  const dot = tok.lastIndexOf('.');
  if (dot < 0) return false;
  const exp = tok.slice(0, dot);
  const sig = Buffer.from(tok.slice(dot + 1));
  const expected = Buffer.from(sign(exp));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return false;
  return Number(exp) > Date.now();
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isAuthed = (req) => !AUTH_REQUIRED || verifyToken(parseCookies(req)[COOKIE]);

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
  if (value < min || value > max) throw new ApiError(400, `${name} must be between ${min} and ${max}`);
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

// Local wall-clock ISO (no timezone suffix); month bucketing reflects LOCAL date.
function serverLocalISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}
const currentMonth = () => serverLocalISO().slice(0, 7);

function validateMonth(month) {
  if (month === undefined || month === null || month === '') return currentMonth();
  if (typeof month !== 'string' || !MONTH_RE.test(month)) throw new ApiError(400, 'month must be YYYY-MM');
  return month;
}

function normalizeCreatedAt(value) {
  if (value === undefined || value === null || value === '') return serverLocalISO();
  if (typeof value !== 'string') throw new ApiError(400, 'created_at must be a string');
  const trimmed = value.trim();
  // Month filtering/ordering rely on a literal YYYY-MM-DD prefix, so require one.
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new ApiError(400, 'created_at must be local ISO starting YYYY-MM-DD');
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// State (the big read used by every screen)
// ---------------------------------------------------------------------------
async function getState(month) {
  const [settings, categories, txns] = await Promise.all([
    db.getSettings(),
    db.listCategories(),
    db.listTransactionsForMonth(month),
  ]);

  const spentByCategory = {};
  for (const c of categories) spentByCategory[c.id] = 0;
  const spentByImportance = { essential: 0, have_to_have: 0, nice_to_have: 0, shouldnt_have: 0 };
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

  return {
    month,
    settings,
    categories: cats,
    transactions: txns,
    spentByCategory,
    spentByImportance,
    derived: {
      variableBudget,
      variableSpent,
      leftToSpend: variableBudget - variableSpent,
      fixedBudget,
      allBudget,
      income: settings.monthly_income_cents,
      projectedSavings,
      savingsGoal: settings.savings_goal_cents,
      savingsGap: projectedSavings - settings.savings_goal_cents,
      shouldntHave: spentByImportance.shouldnt_have,
      totalSpent,
    },
    syncEnabled: syncEnabled(),
  };
}

// ---------------------------------------------------------------------------
// Google Sheets one-way push (optional, off unless env configured)
// ---------------------------------------------------------------------------
const syncEnabled = () => Boolean(process.env.GSHEET_WEBAPP_URL && process.env.GSHEET_SECRET);

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
      redirect: 'follow',
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

async function txnToSheetRow(txn) {
  const name = await db.categoryName(txn.category_id);
  return {
    date: txn.created_at,
    amount: (txn.amount_cents / 100).toFixed(2),
    category: name || '',
    importance: IMPORTANCE_LABELS[txn.importance] || txn.importance,
    note: txn.note || '',
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', true); // behind Fly/Render proxy: trust X-Forwarded-Proto for req.secure
app.use(express.json({ limit: '64kb' }));

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

// ---- public auth endpoints -------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/auth', (req, res) => res.json({ required: AUTH_REQUIRED, authed: isAuthed(req) }));

app.post('/api/login', (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ ok: true });
  const pw = Buffer.from(String((req.body && req.body.password) || ''));
  const expected = Buffer.from(APP_PASSWORD);
  const ok = pw.length === expected.length && crypto.timingSafeEqual(pw, expected);
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  res.cookie(COOKIE, makeToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_MS,
    path: '/',
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ---- gate: everything below requires auth ----------------------------------
// The match MUST be case-insensitive: Express routing is case-insensitive by
// default, so a request to /API/state still reaches the lowercase /api/state
// handler. A case-sensitive prefix check here would let /API/... slip past the
// gate and leak/mutate data with no cookie.
app.use((req, res, next) => {
  if (!/^\/api\//i.test(req.path)) return next();
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'auth required', authRequired: true });
});

// ---- state -----------------------------------------------------------------
app.get(
  '/api/state',
  h(async (req, res) => {
    res.json(await getState(validateMonth(req.query.month)));
  }),
);

// ---- transactions ----------------------------------------------------------
app.post(
  '/api/transactions',
  h(async (req, res) => {
    const body = req.body || {};
    const amount_cents = intField(body.amount_cents, 'amount_cents', { min: 1 });
    const category_id = intField(body.category_id, 'category_id', { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (!(await db.getCategory(category_id))) throw new ApiError(400, 'category_id does not exist');
    if (!IMPORTANCE.has(body.importance)) throw new ApiError(400, 'invalid importance');
    const note = stringField(body.note, 'note', { required: false, min: 1, max: 280 });
    const created_at = normalizeCreatedAt(body.created_at);

    const id = await db.insertTransaction({ amount_cents, category_id, importance: body.importance, note, created_at });
    const txn = await db.getTransaction(id);

    if (syncEnabled()) {
      txnToSheetRow(txn)
        .then(pushToSheet)
        .then((r) => {
          if (r && !r.ok && !r.skipped) console.warn('Sheets sync failed:', r.detail);
        })
        .catch(() => {});
    }

    // row is committed; never throw while building the response
    const q = req.query.month;
    const month = typeof q === 'string' && MONTH_RE.test(q) ? q : created_at.slice(0, 7);
    res.status(201).json({ ok: true, transaction: txn, state: await getState(month) });
  }),
);

app.delete(
  '/api/transactions/:id',
  h(async (req, res) => {
    const id = intField(req.params.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const changes = await db.deleteTransaction(id);
    if (!changes) throw new ApiError(404, 'transaction not found');
    res.json({ ok: true, state: await getState(validateMonth(req.query.month)) });
  }),
);

// ---- settings --------------------------------------------------------------
app.put(
  '/api/settings',
  h(async (req, res) => {
    const body = req.body || {};
    const current = await db.getSettings();
    const monthly_income_cents =
      body.monthly_income_cents === undefined
        ? current.monthly_income_cents
        : intField(body.monthly_income_cents, 'monthly_income_cents', { min: 0 });
    const savings_goal_cents =
      body.savings_goal_cents === undefined
        ? current.savings_goal_cents
        : intField(body.savings_goal_cents, 'savings_goal_cents', { min: 0 });
    const currency =
      body.currency === undefined ? current.currency : stringField(body.currency, 'currency', { min: 1, max: 8 });

    await db.updateSettings({ monthly_income_cents, savings_goal_cents, currency });
    res.json({ ok: true, state: await getState(validateMonth(req.query.month)) });
  }),
);

// ---- categories ------------------------------------------------------------
app.post(
  '/api/categories',
  h(async (req, res) => {
    const body = req.body || {};
    const name = stringField(body.name, 'name', { min: 1, max: 40 });
    if (!CATEGORY_TYPES.has(body.type)) throw new ApiError(400, 'type must be fixed or variable');
    const budget_cents = intField(body.budget_cents ?? 0, 'budget_cents', { min: 0 });
    const position = (await db.maxCategoryPosition()) + 1;
    const id = await db.insertCategory({ name, type: body.type, budget_cents, position });
    res.status(201).json({ ok: true, id, state: await getState(validateMonth(req.query.month)) });
  }),
);

app.put(
  '/api/categories/:id',
  h(async (req, res) => {
    const id = intField(req.params.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const current = await db.getCategory(id);
    if (!current) throw new ApiError(404, 'category not found');
    const body = req.body || {};
    const name = body.name === undefined ? current.name : stringField(body.name, 'name', { min: 1, max: 40 });
    let type = current.type;
    if (body.type !== undefined) {
      if (!CATEGORY_TYPES.has(body.type)) throw new ApiError(400, 'type must be fixed or variable');
      type = body.type;
    }
    const budget_cents =
      body.budget_cents === undefined ? current.budget_cents : intField(body.budget_cents, 'budget_cents', { min: 0 });
    const position =
      body.position === undefined ? current.position : intField(body.position, 'position', { min: 0, max: 100000 });

    await db.updateCategory(id, { name, type, budget_cents, position });
    res.json({ ok: true, state: await getState(validateMonth(req.query.month)) });
  }),
);

app.delete(
  '/api/categories/:id',
  h(async (req, res) => {
    const id = intField(req.params.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (!(await db.getCategory(id))) throw new ApiError(404, 'category not found');
    const used = await db.countTransactionsForCategory(id);
    if (used > 0) {
      throw new ApiError(409, `Cannot delete: ${used} transaction(s) use this category. Delete or reassign them first.`);
    }
    await db.deleteCategory(id);
    res.json({ ok: true, state: await getState(validateMonth(req.query.month)) });
  }),
);

// ---- CSV export ------------------------------------------------------------
function csvEscape(field) {
  let s = String(field ?? '');
  // Neutralize spreadsheet formula injection (leading = + - @ / tab / CR).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get(
  '/api/export.csv',
  h(async (req, res) => {
    const rows = await db.listAllTransactions();
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

// ---- sync test -------------------------------------------------------------
app.post(
  '/api/sync/test',
  h(async (req, res) => {
    if (!syncEnabled()) {
      return res
        .status(400)
        .json({ ok: false, error: 'Google Sheets sync is not configured (set GSHEET_WEBAPP_URL and GSHEET_SECRET).' });
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
  console.log(`Storage: ${db.kind === 'postgres' ? 'Postgres / Supabase' : 'local SQLite'}`);
  console.log(`Auth: ${AUTH_REQUIRED ? 'password required' : 'OFF (no APP_PASSWORD set)'}`);
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
