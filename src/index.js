/**
 * Jitben Ops Dashboard — Cloudflare Worker entry point.
 *
 * Responsibilities (deliberately small):
 *   1. Dynamic /config.js   → hands the browser the Supabase URL + anon key
 *                             from Worker env (vars or secrets), so no
 *                             credentials are baked into the repo.
 *   2. /api/orders          → the bundled 1,098-order dataset, normalised to
 *                             the same shape the Supabase view returns. This
 *                             keeps the dashboard usable before Supabase is
 *                             wired up (and if it is ever unreachable).
 *   3. /api/health          → tiny liveness/readiness probe.
 *   4. Everything else      → static assets in ./public via the ASSETS binding.
 *
 * Assets are served before the Worker runs (the default), so only paths that
 * do not exist on disk — /config.js, /api/* — reach this code.
 */
import orders from "../data/orders.json";

/** dd/mm/yyyy (data/orders.json) → yyyy-mm-dd (what the client expects). */
function isoDate(d) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(d || "").trim());
  if (!m) return String(d || "").slice(0, 10);
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

const ROWS = orders.map((o) => ({
  fid: o.fid,
  order_date: isoDate(o.date),
  status: o.status || "Unknown",
  receiver_name: o.name || "",
  phone: o.phone || "",
  address: o.address || "",
  city: o.city || "",
  amount: o.amount == null || o.amount === "" ? null : Number(o.amount) || null,
}));

const ORDERS_JSON = JSON.stringify(ROWS);

const BASELINE_DAYS = new Set(ROWS.map((r) => r.order_date).values());
const RANGE_START = [...BASELINE_DAYS].sort()[0] || null;
const RANGE_END = [...BASELINE_DAYS].sort().at(-1) || null;

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
  const res = new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...(init.headers || {}) },
  });
  return res;
}

function configScript(env) {
  const cfg = {
    supabaseUrl: env.SUPABASE_URL || "",
    supabaseKey: env.SUPABASE_ANON_KEY || "",
  };
  return new Response(`window.JITBEN_CONFIG = ${JSON.stringify(cfg)};\n`, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      // Config is env-dependent: never let a CDN/browser cache a stale key.
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

function ordersResponse(request) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const q = (url.searchParams.get("q") || "").toLowerCase();

  let rows = ROWS;
  if (status) rows = rows.filter((r) => r.status === status);
  if (q) {
    rows = rows.filter((r) =>
      `${r.fid} ${r.receiver_name} ${r.address} ${r.phone}`.toLowerCase().includes(q),
    );
  }

  const body = rows === ROWS ? ORDERS_JSON : JSON.stringify(rows);
  const etag = `W/"${body.length}-${status || ""}${q}"`;

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, ...SECURITY_HEADERS } });
  }

  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      etag,
      ...SECURITY_HEADERS,
    },
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET, HEAD" } });
    }

    if (pathname === "/config.js") return configScript(env);

    if (pathname === "/api/health") {
      return json({
        ok: true,
        orders: ROWS.length,
        range: { start: RANGE_START, end: RANGE_END },
        supabase_configured: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
        colo: request.cf?.colo ?? null,
      });
    }

    if (pathname === "/api/orders") return ordersResponse(request);

    if (!env.ASSETS) {
      return json({ error: "assets_binding_missing" }, { status: 500 });
    }

    return withHeaders(await env.ASSETS.fetch(request));
  },
};
