# Jitben live bridge (Chrome extension)

Reads order status and receiver info from **hive.carrybee.com/orders** every
second and streams it into the **Jitben Ops Dashboard** — no button, no export,
no manual clicking.

```
hive tab
 ├─ injected.js  (page world: watches the site's own fetch/XHR → JSON)
 └─ content-hive.js (content world: mines that JSON + scrapes the DOM)
                 └──▶ service worker ──▶ dashboard tab
                        (merge by fid)     (content-dashboard.js:
                                            push + 1.5 s poll
                                            → window.postMessage
                                            → applyLiveRows())
```

Two sources, one row shape:

1. **The page's own JSON** — `injected.js` wraps `fetch`/`XMLHttpRequest` and
   reads `#__NEXT_DATA__`. Whatever the site already loaded is walked for
   order records; this is where receiver **name / phone / address** come from.
2. **The DOM** — `content-hive.js` still scrapes rendered rows, which is what
   gives you statuses for orders that are on screen.

API data wins over DOM data for the same `fid`; the DOM fills the gaps.
`city` is derived from the tail of the address (`…, Chandanaish` → `Chandanaish`,
a trailing `Bangladesh` is dropped) when the payload does not carry one.

**Reloading the extension repairs open tabs.** Chrome does not re-inject content
scripts into tabs that are already on screen — they keep running the old file for
the rest of their life, which is why a freshly updated extension can still report
`Payload hook: —` while the Hive tab streams half the data. On install/update,
when the popup opens, and once per service-worker start (throttled), the worker
re-runs the current `content-hive.js` / `content-dashboard.js` in every matching
tab. Both scripts carry a version guard, so the re-run is a no-op in tabs that
are already current.

The dashboard tab is fed **two ways**: the instant push from the service worker
*and* a 1.5 s poll of `jitben:get`. The poll is what guarantees convergence — if
the extension is reloaded while the dashboard tab is open, or a broadcast lands
while the page is still booting, the page used to keep a stale snapshot forever
(statuses present, receiver columns stuck on `—`). It now catches up on its own.

## Install (2 minutes, unpacked)

1. Download this repo (GitHub → **Code → Download ZIP**) and unzip it, or
   `git clone` it.
2. Chrome → `chrome://extensions` → enable **Developer mode** (top right).
3. **Load unpacked** → select the `extension/` folder of the repo.
4. Open or reload <https://hive.carrybee.com/orders>.
5. Open the dashboard <https://jitben-dashboard.jitben-746a2b.workers.dev>.
6. Click the extension icon: it should show a green dot, the row count, and
   `Receiver info` > 0 once the Hive page has rendered orders.

The dashboard header switches to `N orders · hive live` with a green pill the
moment the first snapshot lands. The parenthetical tells you what changed:

| Header | Meaning |
|---|---|
| `1,153 orders · hive live (+9)` | 9 orders were seen for the first time |
| `1,153 orders · hive live (4 updated)` | 4 existing orders changed (status / receiver info) |
| `1,153 orders · hive live (+9, 4 updated)` | both |

Rows that changed flash green for ~2.5s, so a status moving from
`Assigned For Delivery` → `Delivered` is visible without hunting for it.

## What it reads

| Field | Source on the Hive page |
|---|---|
| `fid` | the order ID itself (`F` + 4 digits + 6 alphanumerics, 11 chars) |
| `status` | Hive's status vocabulary (`Delivered`, `Paid Return`, `At The Sorting Hub`, …); longest match wins so `Paid Return` never reads as `Return` |
| `receiver_name` | JSON key `receiver.name` / `customer_name` / `consignee.full_name` …, else the `Receiver` / `গ্রাহক` label in the DOM |
| `phone` | JSON `phone` / `mobile` / `contact` …, else a Bangladeshi mobile pattern in the DOM (normalised to 11 digits) |
| `address` | JSON `full_address` / `shipping_address` … , else the `Address` / `ঠিকানা` label in the DOM |
| `order_date` | JSON `created_at` / `order_date` (ISO or `dd/mm/yyyy`), else the first `dd/mm/yyyy` in the block |

Both readers are anchored on the order ID (11 chars: `F` + 4 digits + 6
alphanumerics) rather than on a fixed API shape or CSS classes, so a redesign
that keeps the id keeps working. The JSON walker accepts snake_case and
camelCase, keys nested several levels deep, and ids stored in `order.code`
style nodes; it ignores `merchant`/`store`/`product` names so the shop never
shows up as the receiver. Unit-tested layouts: `<table>` rows, cards, a single
text blob with no containers at all, and nested JSON payloads.

## Behaviour

- **Every second** (`setInterval` 1s) plus an immediate pass whenever the page
  loads new JSON or mutates the DOM.
- Rows are **accumulated by `fid`** in `chrome.storage.local`, so orders that
  scroll out of a virtualised list are not lost; newest non-empty field wins.
- Pauses when the Hive tab is hidden or you hit **Pause scraping**.
- Nothing is clicked, typed or auto-scrolled — the injected hook only reads
  responses the page requested for itself.

## Permissions

| Permission | Why |
|---|---|
| `storage` | accumulate rows between scrapes and page reloads |
| `tabs` | find the dashboard tab to push snapshots into |
| `scripting` | install `injected.js` into the Hive page's own JS context so it can see the app's `fetch`/XHR responses |
| host `hive.carrybee.com` | read order rows and payloads |
| host `*.workers.dev`, `localhost:8787` | inject the bridge into the dashboard |

No network requests of its own: every payload is one the Hive page already
fetched. Data never leaves your browser except into the dashboard tab you
already have open.

## Troubleshooting

| Symptom | Fix |
|---|---|
| popup says `waiting for Hive tab` | open `hive.carrybee.com/orders` and wait for rows to render |
| popup `Payload hook: —` | no snapshot with hook state has arrived yet: keep the popup open for ~2 s (opening it re-injects the scripts). If it stays `—`, reload the Hive tab once |
| popup `Payload hook: off` | the page-world hook never reported in — reload the Hive tab (it installs at `document_start`) and check the extension is version 1.3.0+ |
| popup `Payload hook: on`, `API rows: 0` | the page has not loaded an order payload yet — scroll or paginate the list once |
| rows counted, `Receiver info` 0 | the list view shows only id + status; reload the Hive tab so `injected.js` is installed, then scroll/paginate once so the site loads its order payloads |
| dashboard shows `—` under RECEIVER while the popup shows receiver info | stale page state: reload the dashboard tab once (1.2.0+ also self-heals within 1.5 s via polling) |
| dashboard shows `—` and popup `API rows: 0` | receiver details were never in a payload this session — scroll/paginate the Hive list once |
| dashboard shows `bundled`/`live` (sheet) instead | the extension has not sent anything yet, or the dashboard URL changed — set it in the popup |
| nothing after editing `content-hive.js` | `chrome://extensions` → reload the extension, then reload both tabs |

## Development

```bash
npm install
npm test                 # scraper + JSON miner, live bridge, dashboard
```

- `extension/test/scraper.test.mjs` — table / card / blob / JSON payloads, plus
  an end-to-end payload → snapshot check.
- `test/bridge.test.mjs` — reproduces the “popup says 20/20, page shows —”
  failure with **no** broadcast at all and proves the page self-heals by polling.
- `test/background.test.mjs` — service worker: `jitben:get` returns `meta`, a
  meta-less snapshot cannot erase details, and install/update re-injects into
  the Hive tab (+ MAIN-world hook) and the dashboard tab only.
- `test/dashboard.test.mjs` — merge, header counters, `.fresh` flash, data note.

All four run in CI before every deploy.

After editing any extension file: `chrome://extensions` → **Reload**, then
reload the Hive tab (the page-world hook is installed at `document_start`) and
the dashboard tab.
