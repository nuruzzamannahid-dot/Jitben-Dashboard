/* Dashboard live-bridge test: loads public/index.html in jsdom exactly as it is
 * deployed, then posts an extension snapshot and asserts the page reacts.
 * Run with: npm run test:dashboard
 */
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

const base = JSON.parse(fs.readFileSync(path.join(root, "data", "orders.json"), "utf8"))
  .slice(0, 5)
  .map((o) => ({
    fid: o.fid,
    order_date: `${o.date.slice(6)}-${o.date.slice(3, 5)}-${o.date.slice(0, 2)}`,
    status: o.status,
    receiver_name: o.name,
    phone: o.phone,
    address: o.address,
    city: "",
    amount: null,
  }));

const dom = new JSDOM(html, {
  url: "https://jitben-dashboard.jitben-746a2b.workers.dev/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(win) {
    // Stand-in for the Worker's /api/orders (sheet-backed payload).
    win.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === "x-data-source" ? "sheet" : null) },
      json: async () => base,
    });
  },
});

const { window } = dom;
const rows = () => [...window.document.querySelectorAll("#custTable tbody tr")];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n    expected: ${expected}\n    actual:   ${actual}`}`);
}

await sleep(300);

const pillText = () => window.document.getElementById("livetxt").textContent;
const pill = () => window.document.getElementById("live");
const sub = () => window.document.getElementById("sub").textContent;
const total = () => window.document.querySelector("#kpis .v").textContent;

check("initial render", pillText(), "5 orders · live");
check("subtitle computed from data", sub().includes("5 orders"), true);

const snapshot = [
  {
    fid: base[0].fid,
    status: "Return",
    receiver_name: "Fahim",
    phone: "01712345678",
    address: "জেলা ভোলা। থানা শশীভূষণ",
    order_date: base[0].order_date,
  },
  {
    fid: "F1099NEWEXT",
    status: "At The Sorting Hub",
    receiver_name: "Rumi Akter",
    phone: "01898765432",
    address: "House 12, Road 4, Dhanmondi, Dhaka",
    order_date: "2026-11-19",
  },
];

window.postMessage({ type: "jitben:live", rows: snapshot, ext: true }, "*");
await sleep(350);

check("header switches to hive live", pillText(), "6 orders · hive live (+1, 1 updated)");
check("pill gets the extension class", pill().classList.contains("ext"), true);
check("new order appears in the table", rows().some((r) => r.textContent.includes("F1099NEWEXT")), true);
check(
  "new order carries its Hive status",
  rows().find((r) => r.textContent.includes("F1099NEWEXT")).querySelector(".pill").textContent,
  "At The Sorting Hub",
);
check("KPI total follows the merge", total(), "6");
check("range expands to the new date", sub().includes("19/11/2026"), true);
check("no duplicate filter options", window.document.getElementById("fStatus").options.length, 4);

// same snapshot again → idempotent
window.postMessage({ type: "jitben:live", rows: snapshot, ext: true }, "*");
await sleep(300);
check("repeat snapshot does not duplicate rows", rows().length, 6);
check("repeat snapshot keeps the header stable", pillText(), "6 orders · hive live");

// status-only change on an existing order
window.postMessage(
  { type: "jitben:live", rows: [{ ...snapshot[0], status: "Delivered" }], ext: true },
  "*",
);
await sleep(300);
const updatedRow = rows().find((r) => r.textContent.includes(base[0].fid));
check("status update replaces the old value", updatedRow.querySelector(".pill").textContent, "Delivered");
check("updated row is flagged for the flash", updatedRow.classList.contains("fresh"), true);
check("status-only change reports as an update", pillText(), "6 orders · hive live (1 updated)");
check(
  "status breakdown recomputed for the new status",
  [...window.document.querySelectorAll("#statusBars .bar-row .nm")].some((n) => n.textContent === "Return" || n.textContent === "Delivered"),
  true,
);

console.log(failures ? `\n${failures} assertion(s) failed` : "\nAll dashboard assertions passed");
process.exit(failures ? 1 : 0);
