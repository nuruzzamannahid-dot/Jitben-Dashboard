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

## Live deployment

| | |
|---|---|
| Worker | `jitben-dashboard` |
| URL | https://jitben-dashboard.jitben-746a2b.workers.dev |
| Account | `746a2b64a6101f6172a624d51ba76b83` |
| workers.dev subdomain | `jitben-746a2b` (registered by the workflow on first deploy) |
| Pipeline | `.github/workflows/deploy-cloudflare.yml` — push to `main` |

`GET /api/health` on the live Worker answers
`{"ok":true,"source":"sheet","orders":1135,"from_sheet":1135,"with_details":1098,"range":{"start":"2026-10-10","end":"2026-11-18"},…}`
— i.e. the dashboard is reading the Google Sheet live (`1,135 orders · live`),
with customer details joined from `data/orders.json` for 1,098 of them.

The workflow creates the account's `workers.dev` subdomain automatically when
none exists — pin a specific name with the repository variable
`WORKERS_SUBDOMAIN` (Settings → Secrets and variables → Actions → Variables).

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
Add repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Dash → My Profile → API Tokens → **Create Token** → *Edit Cloudflare Workers* template → value starts with `cfut_` |
| `CLOUDFLARE_ACCOUNT_ID` | Dash → Workers & Pages → Account ID (right sidebar) |
| `CLOUDFLARE_EMAIL` | optional — only if you use a Global API Key instead of a token |

**Use an API token, not the Global API Key.** Cloudflare prefixes make the two
easy to tell apart: `cfut_…` user token, `cfat_…` account token, `cfk_…` Global
API Key. A `cfk_` key authenticates with `X-Auth-Key` + `X-Auth-Email`, so it is
rejected as `Invalid API Token` on the Bearer path — the workflow detects the
prefix and either switches to key auth (when `CLOUDFLARE_EMAIL` is set) or warns
and skips the deploy. Prefer a scoped `cfut_` token: it can be limited to
*Workers Scripts: Edit* on one account, and rolled without touching your email.

Optionally attach a custom domain in **Workers & Pages → jitben-dashboard → Settings → Domains & Routes**.

Vercel hosting still works if you prefer it: `vercel.json` points at `public/`
(no build command). Cloudflare is now the primary target.

## Live data from Hive (browser extension)

`extension/` is a Manifest V3 Chrome extension that reads
**hive.carrybee.com/orders** every second and pushes status + receiver info
straight into an open dashboard tab — no button, no export.

```
hive tab ──scrape 1×/s──▶ service worker ──merge by fid──▶ dashboard tab
```

Install: `chrome://extensions` → Developer mode → **Load unpacked** →
select `extension/`. Full details in [`extension/README.md`](extension/README.md).

Data precedence on the dashboard, strongest first:

1. **Hive live** (extension, per second) — status *and* receiver name/phone/address
2. **Google Sheet** (edge fetch, 120s cache) — status only
3. **`data/orders.json`** bundle — last known snapshot

The header pill tells you which one is active: `hive live`, `live`, or `bundled`.
Scraper heuristics are unit-tested against table / card / text-blob layouts:

```bash
npm test          # 17 scraper assertions + 12 dashboard live-bridge assertions
```

## Live data from Google Sheets

The Worker merges the **“Jitben data dump”** sheet into the dataset on every
request, so editing the sheet updates the dashboard without a redeploy.

| | |
|---|---|
| Sheet | `1vIwR22w8QfYLpt9QlC4fpbQweJGgg0MdhPXv9oMB32M` (`Sheet1`) |
| Columns used | `fid`, `transfer_status`, `created_at`, `transfer_status_updated_at` |
| Merge rule | sheet status wins per `fid`; orders that exist only in the sheet are added with blank customer details |
| Details | receiver name / phone / address come from `data/orders.json` (the sheet has none) |
| Cache | edge cache, `SHEET_TTL_SECONDS` (default 120s) |

**Requirement:** the sheet must be readable as CSV, i.e. *Share → Anyone with
the link → Viewer* (or File → Share → Publish to web). No API key is involved.

```
GET /api/orders            → merged rows; headers x-data-source: sheet|bundle
GET /api/orders?refresh=1  → bypass the edge cache
GET /api/health            → source, sheet rows, freshness, last error
```

Override the source with Worker vars `SHEET_ID` / `SHEET_NAME`, or point
`SHEET_CSV_URL` at any CSV (useful for tests). If Google is unreachable the
Worker serves the bundled dataset and `/api/health` reports why — the dashboard
never goes blank.

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
