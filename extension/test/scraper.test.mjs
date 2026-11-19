/* Scraper heuristics test — runs the real content script against realistic
 * Hive markup in jsdom. Run with: npm run test:scraper
 */
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "content-hive.js"), "utf8");

function scrape(html) {
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
    () => 0,
    { info() {}, warn() {}, debug() {}, error() {} },
    dom.window.location,
  );

  return captured;
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

// ---- 4. page with no orders ------------------------------------------------
check("empty page yields nothing", scrape("<div>No orders yet</div>").length, 0);

console.log(failures ? `\n${failures} assertion(s) failed` : "\nAll scraper assertions passed");
process.exit(failures ? 1 : 0);
