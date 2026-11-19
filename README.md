# Jitben Ops Dashboard

Two tabs, as requested:
- **Jitben DOD** — KPIs, status breakdown, orders-per-day trend, and a day × status delivery matrix.
- **Customer Details** — searchable/filterable per-order table (ID, name, phone, address, city).

Stack: static HTML/JS → **Supabase** (Postgres) → **Vercel**.

```
index.html            the dashboard (no build step)
config.js             Supabase URL + anon key  ← the only file to edit
supabase/schema.sql   tables, indexes, views, RLS
supabase/seed_*.sql   1,098 orders
data/orders.json      the parsed source data
```

## 1. Supabase

Run, in order, in the SQL editor:

```
supabase/schema.sql
supabase/seed_01.sql … seed_05.sql
supabase/seed_99_finalize.sql
```

Then **Project Settings → API** and copy:
- `Project URL` → `config.js` `supabaseUrl`
- `anon public` key → `config.js` `supabaseKey`

The anon key is safe to ship **because** RLS is enabled with a read-only policy.
Never put the `service_role` key in this file.

## 2. Vercel

```
npm i -g vercel
vercel deploy --prod
```

Or connect the Git repo — framework preset **Other**, no build command,
output directory `.`.

## 3. GitHub

```
git init && git add . && git commit -m "Jitben ops dashboard"
git remote add origin git@github.com:<you>/jitben-ops-dashboard.git
git push -u origin main
```

Then in Vercel: **Add New → Project → Import** the repo.

## Data notes

| Field | Coverage |
|---|---|
| Receiver name | 1,098 / 1,098 |
| Address | 1,084 / 1,098 |
| Phone | 17 / 1,098 |
| City | 0 — never populated |

Phone is sparse by design: Hive's order page does not expose the receiver's
phone, only a shared merchant line, which the pipeline rejects rather than
writing a wrong number into 1,098 rows.

## Refreshing the data

Re-export `Receiver Info` and `IDs by Day` from the sheet, or re-run the
generator, then re-run the seed files — every insert is
`on conflict (fid) do update`, so it is idempotent.
