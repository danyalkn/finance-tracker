// Pluggable data layer.
//   - DATABASE_URL set  -> Postgres (Supabase) via node-postgres `pg`
//   - otherwise         -> local SQLite via Node's built-in node:sqlite
//
// Both back ends expose the SAME async interface, so server.js never cares which
// one is live. Money is integer cents; created_at is a local-ISO string so month
// filtering is a cheap prefix match in both dialects.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL || '';
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', 'finance.db');

// First-run seed: income $8,000 / goal $5,500. Misc. trimmed to $180 so projected
// savings hits the goal exactly. Everything is editable in the app afterwards.
const SEED_SETTINGS = { monthly_income_cents: 800000, savings_goal_cents: 550000, currency: 'USD' };
const SEED_CATEGORIES = [
  ['Living', 'fixed', 122000],
  ['Health', 'variable', 5000],
  ['Groceries', 'variable', 10000],
  ['Eating Out', 'variable', 30000],
  ['Fun', 'variable', 30000],
  ['Clothing', 'variable', 35000],
  ['Misc.', 'variable', 18000],
  ['Travel', 'variable', 0],
];

// Recurring breakdown items per category (cents). A category whose items exist has
// its budget = sum(items). Backfilled once into any DB whose budget_items is empty.
const SEED_ITEMS = {
  Living: [
    ['Rent to mom', 50000],
    ['Car insurance', 33000],
    ['Fuel', 25000],
    ['Internet', 9500],
    ['Phone', 4500],
  ],
  'Misc.': [
    ['Donations', 10000],
    ['Sisters', 3300],
    ['Buffer', 4700],
  ],
};

const TXN_COLS = `t.id, t.amount_cents, t.category_id, c.name AS category_name,
                  c.type AS category_type, t.importance, t.note, t.created_at`;

// ---------------------------------------------------------------------------
// Postgres / Supabase
// ---------------------------------------------------------------------------
async function makePostgres() {
  const pgMod = await import('pg');
  const { Pool } = pgMod.default;
  // Only treat the HOST as local — don't match 'localhost' inside a password.
  let host = '';
  try {
    host = new URL(DATABASE_URL).hostname;
  } catch {
    /* malformed URL — treat as remote */
  }
  const local = host === 'localhost' || host === '127.0.0.1';
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 5,
    // Supabase requires TLS. rejectUnauthorized:false is INTENTIONAL (we don't ship
    // Supabase's CA) — encrypted, not cert-pinned. Do NOT delete this ssl object:
    // without it pg would connect WITHOUT TLS.
    ssl: local || process.env.PGSSL_DISABLE ? false : { rejectUnauthorized: false },
  });
  const all = async (text, params) => (await pool.query(text, params)).rows;
  const one = async (text, params) => (await pool.query(text, params)).rows[0];
  const run = (text, params) => pool.query(text, params);

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        monthly_income_cents INTEGER NOT NULL DEFAULT 0,
        savings_goal_cents   INTEGER NOT NULL DEFAULT 0,
        currency             TEXT    NOT NULL DEFAULT 'USD'
      );
      CREATE TABLE IF NOT EXISTS categories (
        id           SERIAL PRIMARY KEY,
        name         TEXT    NOT NULL,
        type         TEXT    NOT NULL CHECK (type IN ('fixed','variable')),
        budget_cents INTEGER NOT NULL DEFAULT 0,
        position     INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id           SERIAL PRIMARY KEY,
        amount_cents INTEGER NOT NULL,
        category_id  INTEGER NOT NULL REFERENCES categories(id),
        importance   TEXT    NOT NULL CHECK (importance IN
                       ('essential','have_to_have','nice_to_have','shouldnt_have')),
        note         TEXT,
        created_at   TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budget_items (
        id           SERIAL PRIMARY KEY,
        category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        name         TEXT    NOT NULL,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        position     INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint   TEXT PRIMARY KEY,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        tz         TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminder_state (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        last_sent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_txn_created ON transactions(created_at);
      CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);
      CREATE INDEX IF NOT EXISTS idx_item_category ON budget_items(category_id);
    `);
    const n = Number((await one('SELECT COUNT(*)::int AS n FROM settings')).n);
    if (n === 0) {
      await run(
        'INSERT INTO settings (id, monthly_income_cents, savings_goal_cents, currency) VALUES (1,$1,$2,$3)',
        [SEED_SETTINGS.monthly_income_cents, SEED_SETTINGS.savings_goal_cents, SEED_SETTINGS.currency],
      );
      for (let i = 0; i < SEED_CATEGORIES.length; i++) {
        const [name, type, budget] = SEED_CATEGORIES[i];
        await run('INSERT INTO categories (name, type, budget_cents, position) VALUES ($1,$2,$3,$4)', [
          name, type, budget, i,
        ]);
      }
      console.log('Seeded settings + 8 categories on first run.');
    }
    // backfill breakdown items (also runs once on an already-seeded DB)
    const items = Number((await one('SELECT COUNT(*)::int AS n FROM budget_items')).n);
    if (items === 0) {
      for (const [catName, list] of Object.entries(SEED_ITEMS)) {
        const cat = await one('SELECT id FROM categories WHERE name=$1 ORDER BY position, id LIMIT 1', [catName]);
        if (!cat) continue;
        let pos = 0;
        for (const [name, amt] of list) {
          await run('INSERT INTO budget_items (category_id,name,amount_cents,position) VALUES ($1,$2,$3,$4)', [
            cat.id, name, amt, pos++,
          ]);
        }
        const sum = list.reduce((s, [, a]) => s + a, 0);
        await run('UPDATE categories SET budget_cents=$1 WHERE id=$2', [sum, cat.id]);
      }
      console.log('Seeded recurring breakdown items.');
    }
  }

  return {
    kind: 'postgres',
    init,
    getSettings: () =>
      one('SELECT monthly_income_cents, savings_goal_cents, currency FROM settings WHERE id = 1'),
    updateSettings: (s) =>
      run('UPDATE settings SET monthly_income_cents=$1, savings_goal_cents=$2, currency=$3 WHERE id=1', [
        s.monthly_income_cents, s.savings_goal_cents, s.currency,
      ]),
    listCategories: () =>
      all('SELECT id, name, type, budget_cents, position FROM categories ORDER BY position, id'),
    getCategory: (id) => one('SELECT * FROM categories WHERE id = $1', [id]),
    maxCategoryPosition: async () =>
      Number((await one('SELECT COALESCE(MAX(position),-1)::int AS m FROM categories')).m),
    insertCategory: async (c) =>
      Number(
        (await one(
          'INSERT INTO categories (name, type, budget_cents, position) VALUES ($1,$2,$3,$4) RETURNING id',
          [c.name, c.type, c.budget_cents, c.position],
        )).id,
      ),
    updateCategory: (id, c) =>
      run('UPDATE categories SET name=$1, type=$2, budget_cents=$3, position=$4 WHERE id=$5', [
        c.name, c.type, c.budget_cents, c.position, id,
      ]),
    deleteCategory: (id) => run('DELETE FROM categories WHERE id = $1', [id]),
    countTransactionsForCategory: async (id) =>
      Number((await one('SELECT COUNT(*)::int AS n FROM transactions WHERE category_id = $1', [id])).n),
    listTransactionsForMonth: (month) =>
      all(
        `SELECT ${TXN_COLS} FROM transactions t JOIN categories c ON c.id = t.category_id
          WHERE left(t.created_at, 7) = $1 ORDER BY t.created_at DESC, t.id DESC`,
        [month],
      ),
    insertTransaction: async (t) =>
      Number(
        (await one(
          'INSERT INTO transactions (amount_cents, category_id, importance, note, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [t.amount_cents, t.category_id, t.importance, t.note, t.created_at],
        )).id,
      ),
    getTransaction: (id) => one('SELECT * FROM transactions WHERE id = $1', [id]),
    deleteTransaction: async (id) => (await run('DELETE FROM transactions WHERE id = $1', [id])).rowCount,
    listAllTransactions: () =>
      all(
        `SELECT t.created_at, t.amount_cents, c.name AS category, t.importance, t.note
           FROM transactions t JOIN categories c ON c.id = t.category_id
          ORDER BY t.created_at ASC, t.id ASC`,
      ),
    categoryName: async (id) => {
      const r = await one('SELECT name FROM categories WHERE id = $1', [id]);
      return r ? r.name : null;
    },
    // ---- push notifications ----
    listSubscriptions: () => all('SELECT endpoint, p256dh, auth, tz FROM push_subscriptions'),
    countSubscriptions: async () =>
      Number((await one('SELECT COUNT(*)::int AS n FROM push_subscriptions')).n),
    upsertSubscription: (s) =>
      run(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, tz, created_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, tz=EXCLUDED.tz`,
        [s.endpoint, s.p256dh, s.auth, s.tz, s.created_at],
      ),
    deleteSubscription: (endpoint) => run('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]),
    getReminderLastSent: async () => {
      const r = await one('SELECT last_sent FROM reminder_state WHERE id = 1');
      return r ? r.last_sent : null;
    },
    setReminderLastSent: (day) =>
      run(
        `INSERT INTO reminder_state (id, last_sent) VALUES (1,$1)
         ON CONFLICT (id) DO UPDATE SET last_sent=EXCLUDED.last_sent`,
        [day],
      ),
    // ---- budget breakdown items ----
    listItems: () =>
      all('SELECT id, category_id, name, amount_cents, position FROM budget_items ORDER BY category_id, position, id'),
    itemsForCategory: (cid) =>
      all('SELECT id, category_id, name, amount_cents, position FROM budget_items WHERE category_id=$1 ORDER BY position, id', [cid]),
    getItem: (id) => one('SELECT * FROM budget_items WHERE id = $1', [id]),
    maxItemPosition: async (cid) =>
      Number((await one('SELECT COALESCE(MAX(position),-1)::int AS m FROM budget_items WHERE category_id=$1', [cid])).m),
    insertItem: async (it) =>
      Number(
        (await one('INSERT INTO budget_items (category_id,name,amount_cents,position) VALUES ($1,$2,$3,$4) RETURNING id', [
          it.category_id, it.name, it.amount_cents, it.position,
        ])).id,
      ),
    updateItem: (id, it) =>
      run('UPDATE budget_items SET name=$1, amount_cents=$2 WHERE id=$3', [it.name, it.amount_cents, id]),
    deleteItem: (id) => run('DELETE FROM budget_items WHERE id = $1', [id]),
  };
}

// ---------------------------------------------------------------------------
// SQLite (local / dev)
// ---------------------------------------------------------------------------
async function makeSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  async function init() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        monthly_income_cents INTEGER NOT NULL DEFAULT 0,
        savings_goal_cents INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD'
      );
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('fixed','variable')),
        budget_cents INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount_cents INTEGER NOT NULL,
        category_id INTEGER NOT NULL REFERENCES categories(id),
        importance TEXT NOT NULL CHECK (importance IN
          ('essential','have_to_have','nice_to_have','shouldnt_have')),
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budget_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint   TEXT PRIMARY KEY,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        tz         TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminder_state (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        last_sent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_txn_created ON transactions(created_at);
      CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);
      CREATE INDEX IF NOT EXISTS idx_item_category ON budget_items(category_id);
    `);
    const n = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
    if (n === 0) {
      db.prepare(
        'INSERT INTO settings (id, monthly_income_cents, savings_goal_cents, currency) VALUES (1,?,?,?)',
      ).run(SEED_SETTINGS.monthly_income_cents, SEED_SETTINGS.savings_goal_cents, SEED_SETTINGS.currency);
      const ins = db.prepare('INSERT INTO categories (name, type, budget_cents, position) VALUES (?,?,?,?)');
      SEED_CATEGORIES.forEach((c, i) => ins.run(c[0], c[1], c[2], i));
      console.log('Seeded settings + 8 categories on first run.');
    }
    const items = db.prepare('SELECT COUNT(*) AS n FROM budget_items').get().n;
    if (items === 0) {
      const insItem = db.prepare('INSERT INTO budget_items (category_id,name,amount_cents,position) VALUES (?,?,?,?)');
      for (const [catName, list] of Object.entries(SEED_ITEMS)) {
        const cat = db.prepare('SELECT id FROM categories WHERE name=? ORDER BY position, id LIMIT 1').get(catName);
        if (!cat) continue;
        list.forEach((it, i) => insItem.run(cat.id, it[0], it[1], i));
        const sum = list.reduce((s, [, a]) => s + a, 0);
        db.prepare('UPDATE categories SET budget_cents=? WHERE id=?').run(sum, cat.id);
      }
      console.log('Seeded recurring breakdown items.');
    }
  }

  return {
    kind: 'sqlite',
    init,
    getSettings: async () =>
      db.prepare('SELECT monthly_income_cents, savings_goal_cents, currency FROM settings WHERE id = 1').get(),
    updateSettings: async (s) =>
      db
        .prepare('UPDATE settings SET monthly_income_cents=?, savings_goal_cents=?, currency=? WHERE id=1')
        .run(s.monthly_income_cents, s.savings_goal_cents, s.currency),
    listCategories: async () =>
      db.prepare('SELECT id, name, type, budget_cents, position FROM categories ORDER BY position, id').all(),
    getCategory: async (id) => db.prepare('SELECT * FROM categories WHERE id = ?').get(id),
    maxCategoryPosition: async () =>
      db.prepare('SELECT COALESCE(MAX(position),-1) AS m FROM categories').get().m,
    insertCategory: async (c) =>
      Number(
        db
          .prepare('INSERT INTO categories (name, type, budget_cents, position) VALUES (?,?,?,?)')
          .run(c.name, c.type, c.budget_cents, c.position).lastInsertRowid,
      ),
    updateCategory: async (id, c) =>
      db
        .prepare('UPDATE categories SET name=?, type=?, budget_cents=?, position=? WHERE id=?')
        .run(c.name, c.type, c.budget_cents, c.position, id),
    deleteCategory: async (id) => db.prepare('DELETE FROM categories WHERE id = ?').run(id),
    countTransactionsForCategory: async (id) =>
      db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(id).n,
    listTransactionsForMonth: async (month) =>
      db
        .prepare(
          `SELECT ${TXN_COLS} FROM transactions t JOIN categories c ON c.id = t.category_id
            WHERE substr(t.created_at, 1, 7) = ? ORDER BY t.created_at DESC, t.id DESC`,
        )
        .all(month),
    insertTransaction: async (t) =>
      Number(
        db
          .prepare(
            'INSERT INTO transactions (amount_cents, category_id, importance, note, created_at) VALUES (?,?,?,?,?)',
          )
          .run(t.amount_cents, t.category_id, t.importance, t.note, t.created_at).lastInsertRowid,
      ),
    getTransaction: async (id) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(id),
    deleteTransaction: async (id) => db.prepare('DELETE FROM transactions WHERE id = ?').run(id).changes,
    listAllTransactions: async () =>
      db
        .prepare(
          `SELECT t.created_at, t.amount_cents, c.name AS category, t.importance, t.note
             FROM transactions t JOIN categories c ON c.id = t.category_id
            ORDER BY t.created_at ASC, t.id ASC`,
        )
        .all(),
    categoryName: async (id) => {
      const r = db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
      return r ? r.name : null;
    },
    // ---- push notifications ----
    listSubscriptions: async () => db.prepare('SELECT endpoint, p256dh, auth, tz FROM push_subscriptions').all(),
    countSubscriptions: async () => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n,
    upsertSubscription: async (s) =>
      db
        .prepare(
          `INSERT INTO push_subscriptions (endpoint, p256dh, auth, tz, created_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, tz=excluded.tz`,
        )
        .run(s.endpoint, s.p256dh, s.auth, s.tz, s.created_at),
    deleteSubscription: async (endpoint) =>
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint),
    getReminderLastSent: async () => {
      const r = db.prepare('SELECT last_sent FROM reminder_state WHERE id = 1').get();
      return r ? r.last_sent : null;
    },
    setReminderLastSent: async (day) =>
      db
        .prepare(
          `INSERT INTO reminder_state (id, last_sent) VALUES (1,?)
           ON CONFLICT(id) DO UPDATE SET last_sent=excluded.last_sent`,
        )
        .run(day),
    // ---- budget breakdown items ----
    listItems: async () =>
      db.prepare('SELECT id, category_id, name, amount_cents, position FROM budget_items ORDER BY category_id, position, id').all(),
    itemsForCategory: async (cid) =>
      db.prepare('SELECT id, category_id, name, amount_cents, position FROM budget_items WHERE category_id=? ORDER BY position, id').all(cid),
    getItem: async (id) => db.prepare('SELECT * FROM budget_items WHERE id = ?').get(id),
    maxItemPosition: async (cid) =>
      db.prepare('SELECT COALESCE(MAX(position),-1) AS m FROM budget_items WHERE category_id=?').get(cid).m,
    insertItem: async (it) =>
      Number(
        db
          .prepare('INSERT INTO budget_items (category_id,name,amount_cents,position) VALUES (?,?,?,?)')
          .run(it.category_id, it.name, it.amount_cents, it.position).lastInsertRowid,
      ),
    updateItem: async (id, it) =>
      db.prepare('UPDATE budget_items SET name=?, amount_cents=? WHERE id=?').run(it.name, it.amount_cents, id),
    deleteItem: async (id) => db.prepare('DELETE FROM budget_items WHERE id = ?').run(id),
  };
}

export async function createDb() {
  if (!DATABASE_URL && (process.env.FLY_APP_NAME || process.env.RENDER || process.env.NODE_ENV === 'production')) {
    console.warn(
      '⚠  No DATABASE_URL set in a production environment — falling back to LOCAL SQLite, ' +
        'which is EPHEMERAL on most hosts and will be wiped on redeploy. Set DATABASE_URL to your Supabase connection string.',
    );
  }
  const db = DATABASE_URL ? await makePostgres() : await makeSqlite();
  db.initialized = false;
  // Best-effort init: if the DB is unreachable at boot (e.g. a paused Supabase
  // free project), start the server anyway and surface a clear per-request error,
  // then retry on demand — don't crash-loop the whole app over a sleeping DB.
  try {
    await db.init();
    db.initialized = true;
  } catch (e) {
    console.error('⚠  Database not reachable at startup (will retry on demand):', e.message);
  }
  return db;
}
