# Jitben live bridge (Chrome extension)

Reads order status and receiver info from **hive.carrybee.com/orders** every
second and streams it into the **Jitben Ops Dashboard** — no button, no export,
no manual clicking.

```
hive tab
 ├─ injected.js  (page world: watches the site's own fetch/XHR → JSON)
 └─ content-hive.js (content world: mines that JSON + scrapes the DOM)
                 └──▶ service worker ──▶ dashboard tab
                        (merge by fid)     (content-dashboard.js
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
| rows counted, `Receiver info` 0 | the list view shows only id + status; reload the Hive tab so `injected.js` is installed, then scroll/paginate once so the site loads its order payloads |
| dashboard shows `—` under RECEIVER | that order's receiver was never in a payload the page loaded (old rows) — open the order once, or scroll its page, and the cells fill in |
| dashboard shows `bundled`/`live` (sheet) instead | the extension has not sent anything yet, or the dashboard URL changed — set it in the popup |
| nothing after editing `content-hive.js` | `chrome://extensions` → reload the extension, then reload both tabs |

## Development

```bash
npm install
npm test                 # scraper + JSON miner + dashboard bridge
```

Tests live in `extension/test/scraper.test.mjs` (table / card / blob / JSON /
end-to-end payload → snapshot) and `test/dashboard.test.mjs`; both run in CI
before every deploy.

After editing any extension file: `chrome://extensions` → **Reload**, then
reload the Hive tab (the page-world hook is installed at `document_start`) and
the dashboard tab.
