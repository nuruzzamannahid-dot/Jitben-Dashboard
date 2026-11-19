/* Service-worker test: the popup's numbers and the tab repair both live here.
 *
 * Two bugs this locks down:
 *   1. `jitben:get` used to answer without `meta`, so the popup always showed
 *      "Payload hook: —" and "API rows: 0" no matter what was really happening.
 *   2. Reloading an unpacked extension does not re-inject content scripts into
 *      already-open tabs, so the Hive tab kept running the old script (no meta,
 *      no payload hook) for the rest of its life.
 *
 * Run with: npm run test:background
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "extension", "background.js"), "utf8");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`}`);
}

// ---- fake chrome ----------------------------------------------------------
const store = {};
const messageListeners = [];
const installedListeners = [];
const injected = [];
const broadcasts = [];

const chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (obj) => Object.assign(store, obj),
    },
  },
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: (fn) => installedListeners.push(fn) },
    onStartup: { addListener: () => {} },
  },
  tabs: {
    query: async () => [
      { id: 1, url: "https://hive.carrybee.com/orders" },
      { id: 2, url: "https://jitben-dashboard.jitben-746a2b.workers.dev/" },
      { id: 3, url: "https://example.com/" },
      { id: 4, url: "chrome://extensions/" },
    ],
    sendMessage: async (tabId, msg) => {
      broadcasts.push({ tabId, msg });
    },
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  scripting: {
    executeScript: async ({ target, files, world }) => {
      injected.push({ tabId: target.tabId, file: files[0], world: world || "ISOLATED" });
    },
  },
};
new Function("chrome", "console", source)(chrome, { info() {}, warn() {}, debug() {}, error() {} });

const send = (msg, sender = { tab: { id: 1 } }) =>
  new Promise((resolve) => {
    for (const fn of messageListeners) {
      const handled = fn(msg, sender, resolve);
      if (handled !== true) resolve(undefined);
    }
  });

const row = (fid, extra = {}) => ({
  fid,
  status: "Delivered",
  receiver_name: "",
  phone: "",
  address: "",
  city: "",
  order_date: "2026-11-18",
  ...extra,
});

// ---- 1. snapshot with meta is stored and answered -------------------------
await send({
  type: "jitben:snapshot",
  rows: [row("F11182NXBJ9", { receiver_name: "Md Rahim", phone: "01712345678", address: "Bhola Sadar, Bhola" })],
  meta: { hook: "on", payloads: 4, api: 1, dom: 0 },
});

const got = await send({ type: "jitben:get" });
check("snapshot stored", got.rows.length, 1);
check("popup sees hook state", got.meta?.hook, "on");
check("popup sees api rows", got.meta?.api, 1);
check("receiver name survived", got.rows[0].receiver_name, "Md Rahim");

// ---- 2. a status-only update from an older script must not erase details --
await send({ type: "jitben:snapshot", rows: [row("F11182NXBJ9", { status: "Return" })] });
const after = await send({ type: "jitben:get" });
check("status updated", after.rows[0].status, "Return");
check("details kept", after.rows[0].receiver_name, "Md Rahim");
check("meta not wiped by a meta-less snapshot", after.meta?.hook, "on");

// ---- 3. broadcast reaches the dashboard tab -------------------------------
check("broadcast sent to every tab", broadcasts.some((b) => b.tabId === 2 && b.msg.type === "jitben:live"), true);

// ---- 4. install/update repairs already-open tabs -------------------------
for (const fn of installedListeners) fn({ reason: "update" });
await new Promise((r) => setTimeout(r, 50));

const files = injected.map((i) => `${i.tabId}:${i.file}${i.world === "MAIN" ? ":MAIN" : ""}`);
check("hive tab gets the content script", files.includes("1:content-hive.js"), true);
check("hive tab gets the main-world hook", files.includes("1:injected.js:MAIN"), true);
check("dashboard tab gets the bridge", files.includes("2:content-dashboard.js"), true);
check("unrelated tabs untouched", files.some((f) => f.startsWith("3:") || f.startsWith("4:")), false);

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll background assertions passed");
