# Jitben live bridge (Chrome extension)

Reads order status and receiver info from **hive.carrybee.com/orders** every
second and streams it into the **Jitben Ops Dashboard** — no button, no export,
no manual clicking.

```
hive tab ──content-hive.js──▶ service worker ──▶ dashboard tab
   (scrape 1×/s)                (merge by fid)     (content-dashboard.js
                                                     → window.postMessage
                                                     → applyLiveRows())
```

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
| `receiver_name` | `Receiver` / `Customer` / `গ্রাহক` / `প্রাপক` label, else the most name-like short line in the order block |
| `phone` | Bangladeshi mobile pattern, normalised to 11 digits |
| `address` | `Address` / `ঠিকানা` label, else the longest line with a Bangla character or an address keyword |
| `order_date` | first `dd/mm/yyyy` in the order block |

Extraction is anchored on the order ID rather than on CSS classes, so a Hive
redesign that keeps its markup semantics keeps working. Three layouts are
covered and unit-tested: `<table>` rows, cards, and a single text blob with no
containers at all.

## Behaviour

- **Every second** (`setInterval` 1s) plus an immediate pass on DOM mutations.
- Rows are **accumulated by `fid`** in `chrome.storage.local`, so orders that
  scroll out of a virtualised list are not lost; newest non-empty field wins.
- Pauses when the Hive tab is hidden or you hit **Pause scraping**.
- Nothing is clicked, typed or auto-scrolled. The extension only reads the DOM.

## Permissions

| Permission | Why |
|---|---|
| `storage` | accumulate rows between scrapes and page reloads |
| `tabs` | find the dashboard tab to push snapshots into |
| host `hive.carrybee.com` | read order rows |
| host `*.workers.dev`, `localhost:8787` | inject the bridge into the dashboard |

No `scripting`, no network requests, no data leaves your browser except into
the dashboard tab you already have open.

## Troubleshooting

| Symptom | Fix |
|---|---|
| popup says `waiting for Hive tab` | open `hive.carrybee.com/orders` and wait for rows to render |
| rows counted, `Receiver info` 0 | open one order's detail panel once — details are read from expanded rows |
| dashboard shows `bundled`/`live` (sheet) instead | the extension has not sent anything yet, or the dashboard URL changed — set it in the popup |
| nothing after editing `content-hive.js` | `chrome://extensions` → reload the extension, then reload both tabs |

## Development

```bash
npm install
npm run test:scraper     # jsdom against table / card / blob layouts
```

The test lives in `extension/test/scraper.test.mjs` and also runs in CI before
every deploy.
