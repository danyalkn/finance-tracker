# Finance Tracker

A tiny personal spending-tracker **PWA** with a one-file Node backend. One user,
one iPhone, logging every purchase in a few taps and staying on a monthly budget.

- **Optimised for a 5-second log.** The home hero is "left to spend" this month and
  visibly depletes, with a pace marker so you can see if you're spending ahead of
  schedule.
- **Manual logging only** — no bank/Plaid integration, on purpose.
- **The server DB is the source of truth.** Nothing important lives in
  localStorage/IndexedDB (iOS evicts those). The phone is a thin client.

| | |
|---|---|
| Frontend | Single-page PWA — vanilla HTML/CSS/JS, no framework. Installable on iOS. |
| Backend | Node + Express, one file (`server.js`). |
| Database | SQLite via Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) (Node ≥ 22.5). No native build. |
| Money | Always stored and computed as **integer cents**. |

---

## Screens

1. **Home** — big "left to spend" (variable budgets − variable spent) with a depletion
   bar + pace marker; projected-savings vs goal line; a prominent "Shouldn't Have"
   regret total; per-category cards; recent purchases with delete.
2. **Log** — a custom ATM-style numeric keypad (type `1 2 5 0` → `$12.50`, no decimal
   key), category chips, the 4 importance levels, an optional note, and Save.
3. **Charts** — a donut of spending by Category, with a toggle to view by Importance.
   Hand-drawn SVG, no chart library, works fully offline.
4. **Budget** — edit income, savings goal, and each category (name, budget,
   fixed/variable, add/remove); live "income − budgets = left to save vs goal" summary;
   CSV export and Google Sheets sync controls.

Every purchase has an **amount**, a **Category**
(Fun, Eating Out, Health, Misc., Groceries, Clothing, Living, Travel), an
**Importance** (Essential, Have to Have, Nice to Have, Shouldn't Have), and an
optional **note**.

---

## Run locally

Requires **Node ≥ 22.5** (this repo is tested on Node 22.11). Check with `node -v`.

```bash
npm install
npm start          # -> http://localhost:3000
```

`npm start` runs `node --experimental-sqlite server.js` (the flag is required until
`node:sqlite` graduates from experimental). Open <http://localhost:3000> in a browser.

On first run the DB is created at `./data/finance.db` and **seeded** with the budget
below. All values are editable on the Budget screen.

| Category   | Type     | Monthly budget |
|------------|----------|---------------:|
| Living     | fixed    | $1,220 |
| Health     | variable | $50 |
| Groceries  | variable | $100 |
| Eating Out | variable | $300 |
| Fun        | variable | $300 |
| Clothing   | variable | $350 |
| Misc.      | variable | $180 |
| Travel     | variable | $0 |

Income $8,000 / mo, savings goal $5,500 / mo. Budgets total $2,550, leaving exactly
$5,500 to save — Misc. is seeded at $180 (trimmed from $230) so projected savings hits
the goal on the nose. Change anything you like.

### Config (environment variables)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | HTTP port. |
| `DB_PATH` | `./data/finance.db` | SQLite file location. **Point this at a persistent disk in production.** |
| `GSHEET_WEBAPP_URL` | — | Apps Script web-app URL for optional Google Sheets sync (see below). |
| `GSHEET_SECRET` | — | Shared secret sent with each sync request. |

---

## Install on your iPhone (Add to Home Screen)

1. Make the server reachable from the phone — either deploy it (below) or, on the same
   Wi-Fi, browse to your computer's LAN address (e.g. `http://192.168.1.20:3000`).
2. Open that URL in **Safari** (Add to Home Screen only works from Safari, not Chrome).
3. Tap the **Share** button → **Add to Home Screen** → **Add**.
4. Launch it from the new icon. It opens **fullscreen** (no Safari chrome), uses the
   brass coin icon, and the app shell is cached by the service worker so it still
   launches when you're offline.

> Logging a purchase needs a connection (the DB is on the server). Offline launch shows
> the cached shell; saves will retry once you're back online.

---

## Deploy (with a persistent disk for the DB)

The database is a single file. The **one rule**: put it on storage that survives
restarts and redeploys, and point `DB_PATH` at it. Ephemeral container filesystems
(the default on most PaaS) will wipe your data on every deploy.

Generic Node host:

```bash
# on the server
git clone <your fork> && cd finance-tracker
npm ci
DB_PATH=/var/data/finance.db PORT=8080 npm start
```

Platform notes:

- **Render / Railway / Fly.io** — attach a **Persistent Disk / Volume**, mount it at
  e.g. `/var/data`, and set `DB_PATH=/var/data/finance.db`. Start command:
  `npm start`. Health check path: `/api/health`.
- **A small VPS** — run under a process manager (`pm2 start "npm start"` or a systemd
  unit) behind nginx/Caddy with HTTPS. iOS requires **HTTPS** to install a PWA from a
  public domain (localhost/LAN is exempt). The DB just lives on the box's disk.
- Always keep `data/` out of git — it already is, via `.gitignore`. Back up the `.db`
  file (and `-wal`/`-shm` siblings) however you back up the host; or just use the CSV
  export.

---

## Data & API

All money fields are **integer cents**. Mutating endpoints accept `?month=YYYY-MM` and
return the recomputed `state` for that month so the UI updates in one round-trip.

| Method & path | Purpose |
|---|---|
| `GET /api/state?month=YYYY-MM` | settings + categories (with spent) + that month's transactions + spent-per-category + spent-per-importance + derived totals |
| `POST /api/transactions` | create `{ amount_cents, category_id, importance, note?, created_at? }` |
| `DELETE /api/transactions/:id` | delete a purchase |
| `PUT /api/settings` | update `monthly_income_cents`, `savings_goal_cents`, `currency` |
| `POST /api/categories` | add `{ name, type, budget_cents }` |
| `PUT /api/categories/:id` | edit name / type / budget / position |
| `DELETE /api/categories/:id` | remove (blocked with 409 while transactions still reference it) |
| `GET /api/export.csv` | **download all transactions** (date, amount, category, importance, note) |
| `POST /api/sync/test` | send a test row to Google Sheets (if configured) |
| `GET /api/health` | liveness probe |

`importance` is one of `essential`, `have_to_have`, `nice_to_have`, `shouldnt_have`.
`type` is `fixed` or `variable` — only **variable** budgets feed the home "left to
spend" hero; fixed bills (rent, insurance…) are treated as already committed.

### Tables

```
settings(id=1, monthly_income_cents, savings_goal_cents, currency)
categories(id, name, type['fixed'|'variable'], budget_cents, position)
transactions(id, amount_cents, category_id -> categories.id,
             importance, note, created_at ISO)
```

---

## Export & Google Sheets

### CSV export (always on)

`GET /api/export.csv` (also the **Export all data** button on the Budget screen)
downloads every transaction as `date,amount,category,importance,note`. This is the
baseline backup and always works regardless of the sync setting.

### Google Sheets sync (optional, off by default)

A **one-way** push: whenever a purchase is saved, a row is appended to a Google Sheet.
There is intentionally no two-way / live sync. If the env vars are absent the feature
is skipped silently and only CSV export is used. A failed push **never** blocks or
fails a save — it's fire-and-forget and logged on the server.

This implementation uses a **Google Apps Script web app + a shared secret** (the
tiniest option — no service-account JSON, no extra npm dependencies). Setup:

1. Create a Google Sheet. Add a header row in the first sheet/tab:
   `date | amount | category | importance | note`.
2. **Extensions → Apps Script**, replace the contents with:

   ```js
   const SECRET = 'CHANGE_ME_to_a_long_random_string';

   function doPost(e) {
     try {
       const body = JSON.parse(e.postData.contents);
       if (body.secret !== SECRET) {
         return ContentService.createTextOutput('forbidden');
       }
       const r = body.row || {};
       SpreadsheetApp.getActiveSpreadsheet()
         .getSheets()[0]
         .appendRow([r.date, r.amount, r.category, r.importance, r.note]);
       return ContentService.createTextOutput('ok');
     } catch (err) {
       return ContentService.createTextOutput('error: ' + err);
     }
   }
   ```

3. **Deploy → New deployment → type "Web app"**. Execute as **Me**, who has access
   **Anyone**. Copy the resulting `/exec` URL.
4. Set the two env vars on your server and restart:

   ```bash
   GSHEET_WEBAPP_URL='https://script.google.com/macros/s/.../exec' \
   GSHEET_SECRET='CHANGE_ME_to_a_long_random_string' \
   npm start
   ```

5. On the Budget screen the sync box now shows **ON**; tap **Send test row** to confirm
   a `TEST` row lands in your sheet.

> Prefer a service account instead? You can swap `pushToSheet()` in `server.js` to call
> the Sheets API with a service-account key (share the sheet with the service-account
> email, drop its JSON key on the server, read the path from an env var). The Apps
> Script route is the default here purely because it keeps the dependency list empty.

---

## Project layout

```
server.js                 # the entire backend (Express + node:sqlite)
package.json
tools/gen-icons.js        # regenerates the PWA icons (no image libs); `npm run gen-icons`
public/
  index.html              # app shell
  styles.css              # dark, warm, calm theme
  app.js                  # all front-end logic (state, screens, keypad, charts)
  manifest.webmanifest    # PWA manifest
  sw.js                   # service worker (caches shell; /api is always network-only)
  icons/                  # generated PNGs (192/512/maskable/apple-touch/favicon)
data/                      # SQLite DB (git-ignored; persistent disk in prod)
```

---

## License

MIT.
