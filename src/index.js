/**
 * Jitben Ops Dashboard — Cloudflare Worker entry point.
 *
 *   1. /config.js   → Supabase URL + anon key from Worker env (secrets-safe).
 *   2. /api/orders  → the dataset: customer details bundled in data/orders.json
 *                     merged with the LIVE statuses in the Google Sheet.
 *   3. /api/health  → liveness + where the data came from and how fresh it is.
 *   4. everything else → static assets in ./public via the ASSETS binding.
 *
 * Assets are served before the Worker runs (the default), so only paths that
 * do not exist on disk — /config.js, /api/* — reach this code.
 *
 * Freshness: the sheet CSV is fetched at the edge and cached for
 * SHEET_TTL_SECONDS (default 120). If Google is unreachable, or the sheet is
 * not link-shared, the Worker serves the bundled dataset and says so.
 */
import orders from "../data/orders.json";
import {
  DEFAULT_SHEET_ID,
  DEFAULT_SHEET_NAME,
  sheetCsvUrl,
  sheetRowsFromCsv,
  mergeOrders,
  summarise,
  toIsoDate,
} from "./sheet.js";

/** Bundled customer details (name/phone/address) keyed by fid. */
const BASE_ROWS = orders.map((o) => ({
  fid: o.fid,
  order_date: toIsoDate(o.date),
  status: o.status || "Unknown",
  receiver_name: o.name || "",
  phone: o.phone || "",
  address: o.address || "",
  city: o.city || "",
  amount: o.amount == null || o.amount === "" ? null : Number(o.amount) || null,
  has_details: true,
}));

const BASE_JSON = JSON.stringify(BASE_ROWS);
const BASE_SUMMARY = summarise(BASE_ROWS);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "SAMEORIGIN",
  // Customer names/addresses/phones must never land in a search index.
  "x-robots-tag": "noindex, nofollow",
};

function withHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...(init.headers || {}),
    },
  });
}

function configScript(env) {
  const cfg = {
    supabaseUrl: env.SUPABASE_URL || "",
    supabaseKey: env.SUPABASE_ANON_KEY || "",
  };
  return new Response(`window.JITBEN_CONFIG = ${JSON.stringify(cfg)};\n`, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * Current dataset: sheet statuses merged over the bundled details.
 * Returns { rows, summary, source, fetched_at, error }.
 */
async function dataset(env, { bust = false } = {}) {
  const sheetId = env.SHEET_ID || DEFAULT_SHEET_ID;
  const sheetName = env.SHEET_NAME || DEFAULT_SHEET_NAME;
  const ttl = Number(env.SHEET_TTL_SECONDS || 120);

  if (!sheetId) {
    return { rows: BASE_ROWS, summary: BASE_SUMMARY, source: "bundle", fetched_at: null, error: null };
  }

  const url = env.SHEET_CSV_URL || sheetCsvUrl(sheetId, sheetName);
  const cache = caches.default;
  const cacheKey = new Request(
    `https://jitben.internal/dataset/${sheetId}/${encodeURIComponent(sheetName)}`,
    { method: "GET" },
  );

  if (!bust) {
    const hit = await cache.match(cacheKey);
    if (hit) return JSON.parse(await hit.text());
  }

  try {
    const res = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } });
    if (!res.ok) throw new Error(`sheet responded HTTP ${res.status}`);

    const text = await res.text();
    if (/^\s*</.test(text)) throw new Error("sheet returned HTML (not link-shared?)");

    const { rows: sheetRows, headers } = sheetRowsFromCsv(text);
    if (!sheetRows.length) throw new Error(`sheet has no data rows (headers: ${headers.join(", ")})`);

    const rows = mergeOrders(BASE_ROWS, sheetRows);
    const payload = {
      rows,
      summary: summarise(rows, sheetRows),
      source: "sheet",
      fetched_at: new Date().toISOString(),
      error: null,
    };

    const cacheable = new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${Math.max(30, ttl)}` },
    });
    await cache.put(cacheKey, cacheable);

    return payload;
  } catch (e) {
    return {
      rows: BASE_ROWS,
      summary: BASE_SUMMARY,
      source: "bundle",
      fetched_at: new Date().toISOString(),
      error: String(e && e.message ? e.message : e),
    };
  }
}

async function ordersResponse(request, env, ctx) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const q = (url.searchParams.get("q") || "").toLowerCase();

  const data = await dataset(env, { bust: url.searchParams.get("refresh") === "1" });

  let rows = data.rows;
  if (status) rows = rows.filter((r) => r.status === status);
  if (q) {
    rows = rows.filter((r) =>
      `${r.fid} ${r.receiver_name} ${r.address} ${r.phone}`.toLowerCase().includes(q),
    );
  }

  const body = rows === data.rows && data.source === "bundle" && !status && !q
    ? BASE_JSON
    : JSON.stringify(rows);

  const etag = `W/"${body.length}-${data.source}-${data.fetched_at || ""}-${status || ""}${q}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, ...SECURITY_HEADERS } });
  }

  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      etag,
      "x-data-source": data.source,
      "x-orders-total": String(data.summary.orders),
      "x-sheet-fetched-at": data.fetched_at || "",
      ...SECURITY_HEADERS,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET, HEAD" } });
    }

    if (pathname === "/config.js") return configScript(env);

    if (pathname === "/api/health") {
      const data = await dataset(env);
      return json({
        ok: true,
        source: data.source,
        sheet: {
          id: env.SHEET_ID || DEFAULT_SHEET_ID,
          name: env.SHEET_NAME || DEFAULT_SHEET_NAME,
          fetched_at: data.fetched_at,
          error: data.error,
        },
        ...data.summary,
        supabase_configured: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
        colo: request.cf?.colo ?? null,
      });
    }

    if (pathname === "/api/orders") return ordersResponse(request, env, ctx);

    if (!env.ASSETS) {
      return json({ error: "assets_binding_missing" }, { status: 500 });
    }

    return withHeaders(await env.ASSETS.fetch(request));
  },
};
