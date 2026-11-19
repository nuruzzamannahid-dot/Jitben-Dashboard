# Jitben Ops Dashboard

Two tabs, as requested:
- **Jitben DOD** — KPIs, status breakdown, orders-per-day trend, and a day × status delivery matrix.
- **Customer Details** — searchable/filterable per-order table (ID, name, phone, address, city).

Stack: static dashboard → **Cloudflare Workers** (edge hosting + tiny JSON API) → **Supabase** (Postgres) as the live data source.

```
public/index.html          the dashboard (no build step)
public/_headers            edge headers for static assets
src/index.js               Worker: /config.js, /api/orders, /api/health, ASSETS passthrough
wrangler.jsonc             Worker config (assets binding + env vars)
data/orders.json           the parsed source data (1,098 orders, bundled fallback)
supabase/schema.sql        tables, indexes, views, RLS
supabase/seed_*.sql        1,098 orders
```

## Why a Worker instead of a plain static host

- **No credentials in Git.** `/config.js` is generated at the edge from `SUPABASE_URL` /
  `SUPABASE_ANON_KEY`, so the anon key lives in Worker vars/secrets, not in a committed file.
- **Works before Supabase is wired up.** `/api/orders` serves the bundled
  `data/orders.json` (normalised to the same shape as the `jitben_dod` view), and the
  dashboard automatically falls back to it if Supabase is unreachable — the header
  shows `… orders · live` vs `… orders · bundled`.
- **Same edge, one deploy.** Assets and API share one Worker at one URL.

## 1. Supabase

Run, in order, in the SQL editor:

```
supabase/schema.sql
supabase/seed_01.sql … seed_05.sql
supabase/seed_99_finalize.sql
```

Then **Project Settings → API** and copy:
- `Project URL` → Worker var `SUPABASE_URL`
- `anon public` key → Worker var `SUPABASE_ANON_KEY`

The anon key is safe to ship **because** RLS is enabled with a read-only policy.
Never put the `service_role` key in a Worker var.

## 2. Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in Supabase values, or leave blank to use the bundled data
npm run dev                      # http://localhost:8787
```

Endpoints: `GET /`, `GET /config.js`, `GET /api/orders[?status=&q=]`, `GET /api/health`.

## 3. Deploy to Cloudflare Workers

```bash
npx wrangler login          # browser OAuth, once
npm run deploy:dry-run      # optional: validate the bundle without uploading
npm run deploy              # npx wrangler deploy
```

Then set the Supabase values for the deployed Worker (re-deploy is not required):

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
```

The Worker is published to `https://jitben-dashboard.<your-subdomain>.workers.dev`
(rename with `"name"` in `wrangler.jsonc`). `wrangler tail` / `npm run logs` streams live logs.

### CI deploy from GitHub

`.github/workflows/deploy-cloudflare.yml` deploys on every push to `main`.
Add two repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Dash → My Profile → API Tokens → *Edit Cloudflare Workers* template |
| `CLOUDFLARE_ACCOUNT_ID` | Dash → Workers & Pages → Account ID (right sidebar) |

Optionally attach a custom domain in **Workers & Pages → jitben-dashboard → Settings → Domains & Routes**.

Vercel hosting still works if you prefer it: `vercel.json` points at `public/`
(no build command). Cloudflare is now the primary target.

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
`on conflict (fid) do update`, so it is idempotent. If `data/orders.json`
changes, redeploy so `/api/orders` picks up the new bundle.
