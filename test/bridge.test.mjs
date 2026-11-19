/* Editorial bridge test — reproduces the failure the user saw:
 *
 *   popup: "20 orders captured, 20 receiver info"
 *   page : every RECEIVER / PHONE / ADDRESS cell shows —
 *
 * Cause: the service worker broadcasts once, fire-and-forget. If that message is
 * missed (extension reloaded while the tab is open, tab still booting), the page
 * keeps a stale snapshot forever. content-dashboard.js now also polls
 * `jitben:get`, so the page must converge on its own, with no push at all.
 *
 * Run with: npm run test:bridge
 */
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const bridge = fs.readFileSync(path.join(root, "extension", "content-dashboard.js"), "utf8");

// Sheet side: order exists, but with no receiver details (dashes in the table).
const sheetRows = [
  {
    fid: "F11182NXBJ9",
    order_date: "2026-11-18",
    status: "Delivered",
    receiver_name: "",
    phone: "",
    address: "",
    city: "",
    amount: null,
  },
];

// Extension side: the same order, captured from Hive, with full details.
const liveRows = [
  {
    fid: "F11182NXBJ9",
    status: "Delivered",
    receiver_name: "Md Rahim Uddin",
    phone: "01712345678",
    address: "Bhola Sadar, Bhola, Bangladesh",
    city: "Bhola",
    order_date: "2026-11-18",
    source: "hive",
  },
  { fid: "F111856V6ZH", status: "On The Way To Last Mile Hub", receiver_name: "Shirin Akter",
    phone: "01898765432", address: "Sector 7, Uttara, Dhaka", city: "Dhaka",
    order_date: "2026-11-18", source: "hive" },
];

const dom = new JSDOM(html, {
  url: "https://jitben-dashboard.jitben-746a2b.workers.dev/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(win) {
    win.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === "x-data-source" ? "sheet" : null) },
      json: async () => sheetRows,
    });
  },
});

const { window } = dom;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(400);

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n    expected: ${expected}\n    actual:   ${actual}`}`);
}

const cell = (fid, index) => {
  const tr = [...window.document.querySelectorAll("#custTable tbody tr")].find(
    (row) => row.children[1]?.textContent.trim() === fid,
  );
  return tr ? tr.children[index].textContent.trim() : "no row";
};

// Before the bridge runs: exactly what the screenshot shows.
check("sheet row starts empty", cell("F11182NXBJ9", 3), "—");

// The service worker never broadcasts: the page may only pull.
const state = { at: Date.now() };
const chrome = {
  runtime: {
    sendMessage: async (msg) => {
      if (msg?.type === "jitben:get") return { rows: liveRows, updatedAt: state.at, scrapes: 3 };
      return { ok: true };
    },
    onMessage: { addListener: () => {} },
  },
};

new Function("window", "document", "chrome", "setInterval", "location", bridge)(
  window, window.document, chrome, window.setInterval, window.location,
);

await sleep(1900); // poll interval is 1.5s

check("existing row filled from polled rows", cell("F11182NXBJ9", 3), "Md Rahim Uddin");
check("phone filled", cell("F11182NXBJ9", 4), "01712345678");
check("address filled", cell("F11182NXBJ9", 5), "Bhola Sadar, Bhola, Bangladesh");
check("city filled", cell("F11182NXBJ9", 6), "Bhola");
check("new row appended", cell("F111856V6ZH", 3), "Shirin Akter");
const header = window.document.getElementById("livetxt").textContent;
check("header counts the new order", header.includes("(+1"), true);
check("header counts the in-place update", header.includes("1 updated"), true);
check("data note counts the captured name", window.document.getElementById("qualityNote").textContent.includes("2 of 2"), true);

window.close(); // stop the bridge's poll timer so node can exit

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll bridge assertions passed");
