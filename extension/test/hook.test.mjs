/* Page-world hook test — the case the user is actually in: the list is
 * server-rendered, so there is no XHR to intercept and `API rows` stays at 0.
 * The order data is in the markup instead, and the hook has to hand it over.
 *
 * Run with: npm run test:hook
 */
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", f), "utf8");
const hookSrc = read("injected.js");
const hiveSrc = read("content-hive.js");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><body>
  <div class="order-row"><span>F1010R92BM9</span><span>Delivered</span></div>
  <script type="application/json" id="hive-state">${JSON.stringify({
    data: {
      orders: [
        {
          order: { code: "F1010R92BM9" },
          transfer_status: "Delivered",
          created_at: "2026-11-18T09:00:00Z",
          receiver: { name: "Fahim Ahmed", phone: "01712345678", address: "Bhola Sadar, Bhola, Bangladesh" },
        },
      ],
    },
  })}</script>
  <div data-page='${JSON.stringify({ props: { orders: [
    { order_code: "F1010FKMR6G", order_status: "Paid Return", customer_name: "Nazim Uddin",
      customer_phone: "01912345678", shipping_address: "Khanhat, Gachbaria, Chandanaish" },
  ] } })}'></div>
</body>`;

// ---- 1. the hook alone: hello + inline blobs are posted --------------------
{
  const dom = new JSDOM(PAGE, { url: "https://hive.carrybee.com/orders", runScripts: "outside-only" });
  const { window } = dom;
  const messages = [];
  window.addEventListener("message", (e) => messages.push(e.data));

  // JSON served as text/plain — the old hook skipped anything without /json/.
  window.fetch = async () => ({
    headers: { get: () => "text/plain; charset=utf-8" },
    clone() {
      return {
        text: async () =>
          JSON.stringify({ orders: [{ code: "F1020NEWONE", transfer_status: "Delivered", receiver: { name: "Rumi Akter" } }] }),
      };
    },
  });

  new Function("window", "document", "location", "setInterval", "setTimeout", "console", hookSrc)(
    window, window.document, window.location, () => 0, () => 0,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  await sleep(10);

  check("hook announces itself", messages.some((m) => m && m.__jitben === "hello"), true);

  await window.fetch("/api/orders");
  await sleep(20);
  const json = messages.filter((m) => m && m.__jitben === "json");
  check("text/plain JSON response captured", json.some((m) => JSON.stringify(m.data).includes("F1020NEWONE")), true);
  check('script[type=application/json] swept', json.some((m) => JSON.stringify(m.data).includes("F1010R92BM9")), true);
  check("data-page attribute swept", json.some((m) => JSON.stringify(m.data).includes("F1010FKMR6G")), true);
  window.close();
}

// ---- 2. hook + miner: the inline blob becomes a full row ------------------
{
  const dom = new JSDOM(PAGE, { url: "https://hive.carrybee.com/orders", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const snapshots = [];
  const chrome = {
    runtime: {
      sendMessage: (msg) => {
        if (msg?.type === "jitben:snapshot") snapshots.push(...msg.rows);
      },
      onMessage: { addListener: () => {} },
    },
  };

  new Function("window", "document", "location", "setInterval", "setTimeout", "console", hookSrc)(
    window, window.document, window.location, () => 0, () => 0,
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  new Function("window", "document", "chrome", "MutationObserver", "setInterval", "console", "location", hiveSrc)(
    window, window.document, chrome, window.MutationObserver, window.setInterval,
    { info() {}, warn() {}, debug() {}, error() {} }, window.location,
  );

  await sleep(1400); // one 1s tick after the hook's postMessage has landed

  // The first tick can predate the mined payload (DOM row only); the last
  // occurrence of a fid is the merged row the dashboard ends up with.
  const lastRow = (fid) => snapshots.filter((r) => r.fid === fid).at(-1);
  const bolha = lastRow("F1010R92BM9");
  check("SSR row reached the snapshot", Boolean(bolha), true);
  check("name from the inline blob", bolha?.receiver_name, "Fahim Ahmed");
  check("phone from the inline blob", bolha?.phone, "01712345678");
  check("address from the inline blob", bolha?.address, "Bhola Sadar, Bhola, Bangladesh");
  check("city derived", bolha?.city, "Bhola");
  check("second order from data-page", lastRow("F1010FKMR6G")?.receiver_name, "Nazim Uddin");
  window.close();
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll hook assertions passed");
