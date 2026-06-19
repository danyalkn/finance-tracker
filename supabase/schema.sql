-- finance-tracker — Postgres schema for Supabase.
--
-- You normally DON'T need to run this by hand: the server creates these tables
-- (and seeds defaults) automatically on first boot via db.js. It's provided for
-- reference, or if you'd rather set things up in the Supabase SQL editor first.
--
-- Money is integer cents. created_at is a local-ISO string ("2026-06-18T14:30:00")
-- so month filtering is a cheap prefix match: left(created_at, 7) = '2026-06'.

CREATE TABLE IF NOT EXISTS settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  monthly_income_cents INTEGER NOT NULL DEFAULT 0,
  savings_goal_cents   INTEGER NOT NULL DEFAULT 0,
  currency             TEXT    NOT NULL DEFAULT 'USD'
);

CREATE TABLE IF NOT EXISTS categories (
  id           SERIAL PRIMARY KEY,
  name         TEXT    NOT NULL,
  type         TEXT    NOT NULL CHECK (type IN ('fixed', 'variable')),
  budget_cents INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  id           SERIAL PRIMARY KEY,
  amount_cents INTEGER NOT NULL,
  category_id  INTEGER NOT NULL REFERENCES categories(id),
  importance   TEXT    NOT NULL CHECK (importance IN
                 ('essential', 'have_to_have', 'nice_to_have', 'shouldnt_have')),
  note         TEXT,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_txn_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);

-- Optional seed (income $8,000 / goal $5,500; Misc. trimmed to $180 to hit goal).
-- The server seeds the same values automatically if the settings table is empty.
INSERT INTO settings (id, monthly_income_cents, savings_goal_cents, currency)
VALUES (1, 800000, 550000, 'USD')
ON CONFLICT (id) DO NOTHING;

INSERT INTO categories (name, type, budget_cents, position)
SELECT * FROM (VALUES
  ('Living',     'fixed',    122000, 0),
  ('Health',     'variable',   5000, 1),
  ('Groceries',  'variable',  10000, 2),
  ('Eating Out', 'variable',  30000, 3),
  ('Fun',        'variable',  30000, 4),
  ('Clothing',   'variable',  35000, 5),
  ('Misc.',      'variable',  18000, 6),
  ('Travel',     'variable',      0, 7)
) AS seed(name, type, budget_cents, position)
WHERE NOT EXISTS (SELECT 1 FROM categories);
