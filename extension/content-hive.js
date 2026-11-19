/* Runs on hive.carrybee.com — scrapes order status + receiver info every second.
 *
 * The page markup is not something we control, so extraction is anchored on
 * things that cannot change without breaking the product itself:
 *   - order IDs: F + 4 digits + 7-9 alphanumerics (e.g. F1010R92BM9)
 *   - the status vocabulary used by Hive / the sheet
 *   - labelled receiver fields, plus a text-window fallback when the DOM has
 *     no obvious row/card containers
 *
 * Nothing is clicked, typed or scrolled. Results are accumulated by `fid`, so
 * rows seen before a page change are never lost.
 */
(() => {
  "use strict";

  const STATUSES = [
    "On The Way To Central Warehouse",
    "On The Way To Last Mile Hub",
    "Received At Last Mile Hub",
    "On The Way To Sub Sort",
    "Assigned For Delivery",
    "Pickup Cancelled",
    "Partial Delivery",
    "At The Sorting Hub",
    "Pickup Requested",
    "Paid Return",
    "In Transit",
    "Delivered",
    "Exchange",
    "On Hold",
    "Return",
  ].sort((a, b) => b.length - a.length); // longest first, so "Paid Return" beats "Return"

  const ID_RE = /F\d{4}[A-Z0-9]{6}/g; // fixed 11-char shape: F1010R92BM9
  const PHONE_RE = /(?:\+?88)?\s?0?1[3-9]\d{8}\b/;
  const DATE_RE = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/;

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

  const CITY_STOP = /^(bangladesh|bangla ?desh|bd)$/i;

  /** "Khanhat, Gachbaria, Chandanaish" → "Chandanaish" (best-effort, never guessed from digits). */
  function cityFromAddress(address) {
    const parts = String(address || "")
      .split(",")
      .map(clean)
      .filter(Boolean);
    if (parts.length < 2) return "";
    let last = parts[parts.length - 1];
    if (CITY_STOP.test(last)) {
      // "Bhola, Bangladesh" → Bhola ; "X, Y, Bangladesh" → Y
      if (parts.length < 2) return "";
      last = parts[parts.length - 2];
    }
    if (last.length > 26 || /\d/.test(last)) return "";
    return last;
  }

  function toIsoDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean(value));
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const d = DATE_RE.exec(clean(value));
    return d ? `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}` : "";
  }

  /** innerText when available; otherwise walk the DOM inserting separators so
   *  adjacent cells ("F1010R92BM9" + "Delivered") do not fuse into one word. */
  function textOf(node) {
    if (!node) return "";
    if (node.innerText && node.innerText.length) return node.innerText;
    const parts = [];
    const walk = (n) => {
      for (const child of n.childNodes) {
        if (child.nodeType === 3) parts.push(child.nodeValue);
        else if (child.nodeType === 1) {
          parts.push(" ");
          walk(child);
          parts.push(" ");
        }
      }
    };
    walk(node);
    return parts.join("");
  }

  function statusRe(status) {
    // case-insensitive, tolerant of "On-The-Way" vs "On The Way"
    return new RegExp(status.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s_-]+"), "i");
  }

  function findStatus(text) {
    const flat = clean(text);
    for (const s of STATUSES) if (statusRe(s).test(flat)) return s;
    return "";
  }

  /** Remove statuses/ids/phones so they cannot hide an address on the same line. */
  function stripStatuses(text) {
    let out = clean(text);
    for (const s of STATUSES) out = out.replace(statusRe(s), " ");
    out = out.replace(ID_RE, " ");
    out = out.replace(PHONE_RE, " ");
    return clean(out);
  }

  function findPhone(text) {
    const m = PHONE_RE.exec(text.replace(/[\u09E6-\u09EF]/g, (d) => String(d.charCodeAt(0) - 0x09e6)));
    if (!m) return "";
    const digits = m[0].replace(/\D/g, "").replace(/^88/, "");
    return digits.length === 11 ? digits : "";
  }

  function findDate(text) {
    const m = DATE_RE.exec(text);
    if (!m) return "";
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const NEXT_FIELD = /\b(address|phone|mobile|contact|receiver|customer|consignee|status|date|amount|product|invoice|order|গ্রাহক|প্রাপক|ঠিকানা|মোবাইল|ফোন|অর্ডার)\b/i;

  function labelled(text, labels) {
    for (const label of labels) {
      const re = new RegExp(`${label}\\s*(?:name|নাম)?\\s*[:\\-–]\\s*([^\\n|]{2,80})`, "i");
      const m = re.exec(text);
      if (!m) continue;
      let value = clean(m[1]);
      const stop = NEXT_FIELD.exec(value);
      if (stop && stop.index > 1) value = value.slice(0, stop.index);
      value = value.replace(/[\d+]{5,}.*$/, "").replace(/[,;|\-–—\s]+$/, "");
      if (value.length >= 2) return value.slice(0, 80);
    }
    return "";
  }

  /** Receiver name: labelled field, else the most name-like short line. */
  function findReceiverName(text, fid) {
    let labelledHit = labelled(text, ["receiver", "customer", "consignee", "গ্রাহক", "প্রাপক"]);
    if (labelledHit) {
      // "Karim Sheikh Sector 7, Uttara" → stop where the address begins
      const stop = ADDRESS_KW.exec(labelledHit);
      if (stop && stop.index > 1) labelledHit = labelledHit.slice(0, stop.index);
      return labelledHit.replace(/[,;|\-–—\s]+$/, "").slice(0, 80);
    }

    const lines = text.split(/[\n|•]+/).map(clean).filter(Boolean);
    for (const line of lines) {
      if (line.length < 2 || line.length > 60) continue;
      if (line.includes(fid)) continue;
      if (/^\d/.test(line)) continue;
      if (findStatus(line)) continue;
      if (/[:：]/.test(line)) continue;
      if (!/[\p{L}]/u.test(line)) continue;
      if (/^(orders?|status|date|action|view|details?|edit|track|invoice|payment)$/i.test(line)) continue;
      // a name is word-ish: 1-4 words, no digits
      if (/\d/.test(line)) continue;
      if (line.split(" ").length > 5) continue;
      return line.slice(0, 60);
    }
    return "";
  }

  const ADDRESS_KW = /(road|rd\.|street|thana|district|upazila|union|bazar|bazaar|market|house|flat|block|sector|post|village|lane|para|nagar|জেলা|থানা|রোড|বাজার|গ্রাম|বাড়ি|বাসা|এলাকা|পোস্ট|লেন|নগর)/i;

  function findAddress(text) {
    const stripped = stripStatuses(text);
    const labelledHit = labelled(stripped, ["address", "ঠিকানা", "shipping address", "delivery address"]);
    if (labelledHit && labelledHit.length > 4) return labelledHit.slice(0, 300);

    const lines = stripped.split(/[\n|•]+/).map(clean).filter(Boolean);
    let best = "";
    for (let line of lines) {
      if (line.length < 8) continue;
      // anchor on the first address keyword so a leading name/number is dropped
      const kw = ADDRESS_KW.exec(line);
      if (kw && kw.index > 0) line = clean(line.slice(kw.index));
      const bangla = /[\u0980-\u09FF]/.test(line);
      if ((bangla || ADDRESS_KW.test(line)) && line.length > best.length) best = line;
    }
    return best.slice(0, 300);
  }

  /** Build one row from a blob of text that is about a single order. */
  function rowFromText(text, fid) {
    const status = findStatus(text);
    if (!status) return null;

    const phone = findPhone(text);
    const address = findAddress(text);
    const labelledName = labelled(text, ["receiver", "customer", "consignee", "গ্রাহক", "প্রাপক"]);

    // findReceiverName() already prefers a labelled value and trims the address
    // off it. Its unlabelled guess is only believable when the same block also
    // carries an address or phone — otherwise it is navigation/UI text.
    const candidate = findReceiverName(text, fid);
    const name = labelledName || address || phone ? candidate : "";

    return {
      fid,
      status,
      receiver_name: name,
      phone,
      address,
      city: cityFromAddress(address),
      order_date: findDate(text),
      source: "hive",
    };
  }


  /* ------------------------------------------------------------------ *
   * JSON miner
   *
   * The list view renders only id + status + date, but the page's own API
   * payloads usually carry the receiver too. Any JSON the app loads is walked
   * and any record containing an 11-char order id is turned into a row. This is
   * structure-driven, so it survives markup changes entirely.
   * ------------------------------------------------------------------ */
  const FID_SHAPE = /^F\d{4}[A-Z0-9]{6}$/;
  const NAME_KEY = /(receiver|customer|consignee|recipient|buyer).*name|^name$|^full_?name$/i;
  const PHONE_KEY = /(phone|mobile|contact|msisdn)/i;
  const ADDR_KEY = /(full_?address|shipping_?address|delivery_?address|address|location)/i;
  const STATUS_KEY = /(transfer_?status|order_?status|delivery_?status|status|state)/i;
  const DATE_KEY = /(created_?at|order_?date|placed_?at|date)/i;
  const NOISE_KEY = /(merchant|store|shop|vendor|product|item|sku|brand)/i;

  function deepPick(obj, keyRe, depth = 0, seen = new Set()) {
    if (!obj || typeof obj !== "object" || depth > 3 || seen.has(obj)) return "";
    seen.add(obj);
    for (const [k, v] of Object.entries(obj)) {
      if (keyRe.test(k) && !NOISE_KEY.test(k)) {
        if (typeof v === "string" || typeof v === "number") {
          const val = String(v).trim();
          if (val) return val;
        }
      }
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") {
        const hit = deepPick(v, keyRe, depth + 1, seen);
        if (hit) return hit;
      }
    }
    return "";
  }

  function fidOf(obj, depth = 0, seen = new Set()) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 2 || seen.has(obj)) return "";
    seen.add(obj);
    for (const v of Object.values(obj)) {
      if (typeof v === "string" && FID_SHAPE.test(v.trim())) return v.trim();
    }
    // ids often live in a nested node: { order: { code: "F1010…" } }
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const hit = fidOf(v, depth + 1, seen);
        if (hit) return hit;
      }
    }
    return "";
  }

  function normaliseStatus(value) {
    const flat = clean(value);
    for (const s of STATUSES) if (s.toLowerCase() === flat.toLowerCase()) return s;
    return findStatus(flat) || "";
  }

  function rowFromRecord(obj) {
    const fid = fidOf(obj);
    if (!fid) return null;

    const status = normaliseStatus(deepPick(obj, STATUS_KEY));
    const phoneRaw = deepPick(obj, PHONE_KEY);
    const phone = phoneRaw ? findPhone(phoneRaw) || "" : "";

    const address = deepPick(obj, ADDR_KEY);

    return {
      fid,
      status: status || "Unknown",
      receiver_name: deepPick(obj, NAME_KEY),
      phone,
      address,
      city: cityFromAddress(address),
      order_date: toIsoDate(deepPick(obj, DATE_KEY)),
      via: "api",
    };
  }

  function minePayload(payload) {
    const out = new Map();
    const seen = new WeakSet();

    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 12 || seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }

      const row = rowFromRecord(node);
      if (row) {
        const prev = out.get(row.fid);
        out.set(row.fid, prev ? mergeRecords(prev, row) : row);
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === "object") walk(v, depth + 1);
      }
    };

    walk(payload, 0);
    // An id with nothing else is just an embedded reference, not an order.
    return [...out.values()].filter(
      (r) => r.status !== "Unknown" || r.receiver_name || r.address || r.phone,
    );
  }

  function mergeRecords(prev, next) {
    const out = { ...prev };
    for (const [k, v] of Object.entries(next)) {
      if (v !== "" && v != null && !(k === "status" && v === "Unknown")) out[k] = v;
    }
    return out;
  }

  /** Candidate containers, most-specific first. */
  function containerCandidates() {
    const selectors = [
      "table tbody tr",
      '[role="row"]',
      '[class*="order" i]', '[class*="order"]', '[class*="Order"]',
      '[class*="card" i]', '[class*="card"]', '[class*="Card"]',
      '[class*="row" i]', '[class*="row"]', '[class*="Row"]',
      '[class*="item" i]', '[class*="item"]', '[class*="Item"]',
      "li",
      "article",
    ];
    const seen = new Set();
    const out = [];
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (seen.has(node)) continue;
        seen.add(node);
        const text = node.textContent || "";
        if (text.length < 8 || text.length > 4000) continue;
        if (!/F\d{4}[A-Z0-9]{6}/.test(text)) continue;
        out.push(node);
      }
      if (out.length) break; // trust the most specific selector that yields rows
    }
    return out;
  }

  function scrapeByContainers() {
    const found = new Map();
    for (const node of containerCandidates()) {
      const text = clean(textOf(node));
      const ids = [...new Set(text.match(ID_RE) || [])];
      // A container holding several orders is a table wrapper, not a row: skip
      // unless nothing better exists.
      if (ids.length !== 1) continue;
      const row = rowFromText(text, ids[0]);
      if (!row) continue;
      const prev = found.get(row.fid);
      // keep the richest record
      if (!prev || countFields(row) > countFields(prev)) found.set(row.fid, row);
    }
    return [...found.values()];
  }

  function countFields(row) {
    return ["status", "receiver_name", "phone", "address", "order_date"].filter((k) => row[k]).length;
  }

  /** Fallback: split the page text around each order ID. */
  function scrapeByTextWindows() {
    const body = document.body;
    const text = clean(textOf(body));
    const rows = [];
    const matches = [...text.matchAll(ID_RE)];
    for (let i = 0; i < matches.length; i++) {
      const fid = matches[i][0];
      const start = matches[i].index;
      const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(text.length, start + 700);
      const segment = text.slice(start, end);
      const row = rowFromText(segment, fid);
      if (row && (row.status || row.receiver_name || row.address)) rows.push(row);
    }
    return rows;
  }

  function scrape() {
    try {
      let rows = scrapeByContainers();
      if (!rows.length) rows = scrapeByTextWindows();
      return rows.filter((r) => r.fid);
    } catch (e) {
      console.warn("[jitben] scrape failed", e);
      return [];
    }
  }

  let lastSignature = "";
  let paused = false;
  const apiRows = new Map(); // fid -> row mined from the page's JSON
  let hookAt = 0; // when the MAIN-world hook last said hello
  let payloads = 0; // JSON payloads received from it

  function currentRows() {
    const byFid = new Map(apiRows);
    for (const row of scrape()) {
      const prev = byFid.get(row.fid);
      byFid.set(row.fid, prev ? mergeRecords(prev, row) : row);
    }
    return [...byFid.values()];
  }

  function tick() {
    if (paused || document.hidden) return;
    const rows = currentRows();
    if (!rows.length) return;

    const signature = rows
      .map((r) => `${r.fid}:${r.status}:${r.receiver_name}:${r.phone}:${r.address.length}`)
      .join("|");
    if (signature === lastSignature) return; // nothing changed, stay quiet
    lastSignature = signature;

    try {
      chrome.runtime.sendMessage({
        type: "jitben:snapshot",
        rows,
        url: location.href,
        at: Date.now(),
        meta: {
          hook: hookAt ? "on" : "off",
          hookAt,
          payloads,
          api: apiRows.size,
          dom: rows.length - apiRows.size,
        },
      });
    } catch (e) {
      // extension context can be reloaded out from under us
      console.debug("[jitben] send failed", e);
    }
  }

  // Ask the background worker to install the MAIN-world fetch/XHR hook, and ask
  // again if it never reports back (e.g. the page was restored from bfcache).
  const askForHook = () => {
    try {
      chrome.runtime.sendMessage({ type: "jitben:inject-main" });
    } catch {
      /* extension reloaded */
    }
  };
  askForHook();
  setTimeout(() => {
    if (!hookAt) askForHook();
  }, 3000);
  setInterval(() => {
    if (!hookAt) askForHook();
  }, 30000);

  window.addEventListener("message", (e) => {
    if (e.source && e.source !== window) return;
    const d = e.data;
    if (!d) return;
    if (d.__jitben === "hello") {
      hookAt = Date.now();
      return;
    }
    if (d.__jitben !== "json") return;
    payloads++;

    let rows = [];
    try {
      rows = minePayload(d.data);
    } catch (err) {
      console.debug("[jitben] payload mine failed", err);
      return;
    }
    if (!rows.length) return;

    let changed = false;
    for (const row of rows) {
      const prev = apiRows.get(row.fid);
      const next = prev ? mergeRecords(prev, row) : row;
      if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) {
        apiRows.set(row.fid, next);
        changed = true;
      }
    }
    if (changed) lastSignature = ""; // force the next tick to publish
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "jitben:pause") paused = !!msg.value;
    if (msg?.type === "jitben:scrape-now") {
      lastSignature = "";
      const rows = scrape();
      chrome.runtime.sendMessage({
        type: "jitben:snapshot",
        rows,
        url: location.href,
        at: Date.now(),
        meta: {
          hook: hookAt ? "on" : "off",
          hookAt,
          payloads,
          api: apiRows.size,
          dom: rows.length - apiRows.size,
        },
      });
    }
  });

  // 1s poll (requirement), plus an immediate pass on DOM changes for latency.
  setInterval(tick, 1000);
  tick();

  const mo = new MutationObserver(() => {
    if (Date.now() - (mo._last || 0) < 900) return;
    mo._last = Date.now();
    tick();
  });

  const observeBody = () => {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", observeBody, { once: true });
      return;
    }
    try {
      mo.observe(document.body, { childList: true, subtree: true });
    } catch {
      /* ignore */
    }
  };
  observeBody();

  window.__jitbenMiner = { minePayload, rowFromRecord, toIsoDate, scrape };

  console.info("[jitben] live bridge active on", location.host);
})();
