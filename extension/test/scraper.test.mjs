/* Scraper heuristics test — runs the real content script against realistic
 * Hive markup in jsdom. Run with: npm run test:scraper
 */
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "content-hive.js"), "utf8");

function load(html, opts = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    url: "https://hive.carrybee.com/orders",
    pretendToBeVisual: true, // otherwise document.hidden === true and the loop no-ops
  });

  const captured = [];
  const chrome = {
    runtime: {
      sendMessage: (msg) => {
        if (msg?.type === "jitben:snapshot") captured.push(...msg.rows);
      },
      onMessage: { addListener: () => {} },
    },
  };

  new Function("window", "document", "chrome", "MutationObserver", "setInterval", "console", "location", source)(
    dom.window,
    dom.window.document,
    chrome,
    dom.window.MutationObserver,
    opts.timers ? dom.window.setInterval : () => 0,
    { info() {}, warn() {}, debug() {}, error() {} },
    dom.window.location,
  );

  return { captured, window: dom.window };
}

function scrape(html) {
  return load(html).captured;
}

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n    expected: ${expected}\n    actual:   ${actual}`}`);
}

// ---- 1. table layout -------------------------------------------------------
const table = scrape(`
<table><tbody>
  <tr><td>F1010R92BM9</td><td>Delivered</td><td>Receiver Name: Fahim</td>
      <td>01712345678</td><td>Address: জেলা ভোলা। থানা শশীভূষণ। ঠিকানা পাঁচ নং ওয়ার্ড</td></tr>
  <tr><td>F1010FKMR6G</td><td>Paid Return</td><td>Receiver: Nazim Uddin</td>
      <td>+8801912345678</td><td>Address: Khanhat, Gachbaria, Chandanaish</td></tr>
  <tr><td>F1020NEWONE</td><td>At The Sorting Hub</td><td>Customer Name: Rumi Akter</td>
      <td></td><td>Address: House 12, Road 4, Dhanmondi</td></tr>
</tbody></table>`);

check("table: row count", table.length, 3);
check("table: fids", table.map((r) => r.fid).join(","), "F1010R92BM9,F1010FKMR6G,F1020NEWONE");
check("table: longest-status-first (Paid Return)", table[1].status, "Paid Return");
check("table: new status recognised", table[2].status, "At The Sorting Hub");
check("table: names", table.map((r) => r.receiver_name).join("|"), "Fahim|Nazim Uddin|Rumi Akter");
check("table: phone normalised to 11 digits", table[1].phone, "01912345678");
check("table: bangla address", table[0].address, "জেলা ভোলা। থানা শশীভূষণ। ঠিকানা পাঁচ নং ওয়ার্ড");

// ---- 2. card layout (no table) --------------------------------------------
const cards = scrape(`
<div class="order-card"><div class="id">#F1030CARD01</div>
  <div class="badge">On The Way To Last Mile Hub</div><div>গ্রাহক: Karim Sheikh</div>
  <div>01987654321</div><div>বাসা ৭, রোড ২, মিরপুর ১০, ঢাকা</div></div>
<div class="order-card"><div class="id">F1030CARD02</div>
  <div class="badge">Exchange</div><div>Receiver: Taslima Begum</div>
  <div>Sector 7, Uttara, Dhaka</div></div>`);

check("cards: row count", cards.length, 2);
check("cards: name", cards[0].receiver_name, "Karim Sheikh");
check("cards: bangla address", cards[0].address, "বাসা ৭, রোড ২, মিরপুর ১০, ঢাকা");
check("cards: name does not swallow address", cards[1].receiver_name, "Taslima Begum");
check("cards: english address kept", cards[1].address, "Sector 7, Uttara, Dhaka");

// ---- 3. no containers at all: text-window fallback -------------------------
const blob = scrape(`
<div>
  Order F1040BLOB01 — Delivered — Receiver: Abdul Karim — 01711111111 — Address: 22 Baker Street, Gulshan, Dhaka
  Order F1040BLOB02 — Return — Receiver: Shirin Sultana — Address: Mirpur 1, Dhaka
</div>`);

check("fallback: row count", blob.length, 2);
check("fallback: no bleed into next order", blob[1].status, "Return");
check("fallback: second receiver", blob[1].receiver_name, "Shirin Sultana");
check("fallback: full address retained", blob[0].address, "22 Baker Street, Gulshan, Dhaka");


// ---- 4. JSON miner: reads the site's own API payloads ----------------------
// (the list view shows only id + status + date, so this is how receiver info
//  is captured without clicking anything)
{
  const { window: win } = load("<div>no orders in the dom</div>");
  const { minePayload } = win.__jitbenMiner;

  const listPayload = {
    status: "ok",
    data: {
      meta: { total: 2 },
      orders: [
        {
          id: 9132,
          order: { code: "F1010R92BM9" },
          transfer_status: "Delivered",
          created_at: "2026-10-10T20:53:10Z",
          receiver: { name: "Fahim", phone: "01712345678", address: "Bhola, Bangladesh" },
          merchant: { name: "Jitben.com" },
        },
        {
          order_code: "F1010FKMR6G",
          status: "paid return",
          customer_name: "Nazim Uddin",
          customer_phone: "+8801912345678",
          shipping_address: "Khanhat, Gachbaria, Chandanaish",
          order_date: "2026-10-11 09:12:00",
        },
      ],
    },
  };

  const mined = minePayload(listPayload);
  check("miner: finds both records", mined.length, 2);
  check("miner: fid from nested code", mined[0].fid, "F1010R92BM9");
  check("miner: receiver nested object", mined[0].receiver_name, "Fahim");
  check("miner: phone normalised", mined[0].phone, "01712345678");
  check("miner: address", mined[0].address, "Bhola, Bangladesh");
  check("miner: city dropped country suffix", mined[0].city, "Bhola");
  check("miner: city from flat address", mined[1].city, "Chandanaish");
  check("miner: merchant is not the receiver", mined[0].receiver_name === "Jitben.com", false);
  check("miner: iso date", mined[0].order_date, "2026-10-10");
  check("miner: status casing normalised", mined[1].status, "Paid Return");
  check("miner: flat customer_name", mined[1].receiver_name, "Nazim Uddin");
  check("miner: date from plain string", mined[1].order_date, "2026-10-11");

  const nested = minePayload({ a: [{ b: { c: [{ result: { rows: [
    { consignment: "F1020NEWONE", delivery_status: "At The Sorting Hub",
      consignee: { full_name: "Rumi Akter", mobile: "01898765432", full_address: "House 12, Road 4, Dhanmondi" } },
  ] } }] } }] });
  check("miner: walks deep nesting", nested.length, 1);
  check("miner: consignee full_name", nested[0].receiver_name, "Rumi Akter");
  check("miner: mobile key", nested[0].phone, "01898765432");

  check("miner: ignores payloads without order ids", minePayload({ users: [{ name: "x" }], total: 3 }).length, 0);
  check("miner: handles null safely", minePayload(null).length, 0);
}

// ---- 5. DOM rows must not invent a name from navigation text --------------
{
  const rows = scrape(`
  <nav><a>Orders</a><a>Dashboard</a><a>Settings</a></nav>
  <div class="order-row"><span>F1050NAVONLY</span><span>Delivered</span></div>`);
  check("dom: status kept", rows[0]?.status, "Delivered");
  check("dom: no fabricated receiver", rows[0]?.receiver_name, "");
}


// ---- 6. end to end: a JSON payload becomes a sent snapshot ---------------
// This is the whole point: the page loads orders over fetch/XHR, the MAIN-world
// hook posts the payload here, and the receiver fields ride along into the
// dashboard without anyone clicking anything.
{
  const { captured, window: win } = load("<div>loading…</div>", { timers: true });

  win.dispatchEvent(
    new win.MessageEvent("message", {
      source: null,
      data: {
        __jitben: "json",
        url: "https://hive.carrybee.com/api/v1/orders?page=1",
        data: {
          data: {
            orders: [
              {
                order: { code: "F1060E2E001" },
                transfer_status: "Delivered",
                receiver: { name: "E2E Receiver", phone: "01700000000", address: "Road 1, Dhanmondi, Dhaka" },
                created_at: "2026-11-18T10:00:00Z",
              },
              {
                order_code: "F1060E2E002",
                order_status: "On The Way To Last Mile Hub",
                customer_name: "Second Person",
                customer_phone: "01811111111",
                shipping_address: "Sector 9, Uttara",
              },
            ],
          },
        },
      },
    }),
  );

  await new Promise((r) => setTimeout(r, 1300));

  const first = captured.find((r) => r.fid === "F1060E2E001");
  const second = captured.find((r) => r.fid === "F1060E2E002");
  check("e2e: payload reached the snapshot", captured.length, 2);
  check("e2e: receiver name", first?.receiver_name, "E2E Receiver");
  check("e2e: receiver phone", first?.phone, "01700000000");
  check("e2e: receiver address", first?.address, "Road 1, Dhanmondi, Dhaka");
  check("e2e: city derived", first?.city, "Dhaka");
  check("e2e: status", first?.status, "Delivered");
  check("e2e: order date", first?.order_date, "2026-11-18");
  check("e2e: second row name", second?.receiver_name, "Second Person");
}

// ---- 7. page with no orders ------------------------------------------------
check("empty page yields nothing", scrape("<div>No orders yet</div>").length, 0);

console.log(failures ? `\n${failures} assertion(s) failed` : "\nAll scraper assertions passed");
process.exit(failures ? 1 : 0);
