/**
 * Google Sheet → dashboard dataset.
 *
 * The "Jitben data dump" sheet is the live source of transfer statuses:
 *
 *   fid | sorted_at | transfer_status_updated_at | transfer_status | created_at
 *
 * Customer details (receiver name, phone, address) are not in the sheet, they
 * come from data/orders.json. This module merges the two by `fid`, so editing
 * the sheet updates the dashboard without touching the repo.
 */

export const DEFAULT_SHEET_ID = "1vIwR22w8QfYLpt9QlC4fpbQweJGgg0MdhPXv9oMB32M";
export const DEFAULT_SHEET_NAME = "Sheet1";

/** Public CSV endpoint for a link-shared sheet (no API key required). */
export function sheetCsvUrl(sheetId, sheetName = DEFAULT_SHEET_NAME) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

/** RFC 4180-ish CSV parser: quotes, escaped quotes, embedded newlines, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

/** "2026-10-10 20:53:10" | "10/10/2026" | ISO → "2026-10-10". */
export function toIsoDate(value) {
  const s = String(value || "").trim();
  if (!s) return "";

  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;

  return "";
}

/**
 * Sheet CSV → [{ fid, status, created_at, updated_at }]
 * Columns are located by header name so reordering the sheet is safe.
 */
export function sheetRowsFromCsv(csv) {
  const table = parseCsv(csv);
  if (!table.length) return { rows: [], headers: [] };

  const headers = table[0].map((h) => String(h).trim().toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };

  const iFid = col("fid", "order id", "order_id");
  const iStatus = col("transfer_status", "status");
  const iCreated = col("created_at", "order_date", "date");
  const iUpdated = col("transfer_status_updated_at", "updated_at");
  if (iFid === -1) throw new Error(`sheet is missing a fid column (headers: ${headers.join(", ")})`);

  const seen = new Set();
  const rows = [];
  for (let r = 1; r < table.length; r++) {
    const c = table[r];
    const fid = String(c[iFid] || "").trim();
    if (!fid || seen.has(fid)) continue;
    seen.add(fid);
    rows.push({
      fid,
      status: String((iStatus >= 0 && c[iStatus]) || "").trim() || "Unknown",
      created_at: toIsoDate(iCreated >= 0 ? c[iCreated] : ""),
      updated_at: String((iUpdated >= 0 && c[iUpdated]) || "").trim(),
    });
  }
  return { rows, headers };
}

/**
 * Merge sheet statuses into the detail rows from data/orders.json.
 * Sheet-only orders are kept (details blank) so new orders appear immediately;
 * detail-only orders keep their bundled status when the sheet has none.
 */
export function mergeOrders(baseRows, sheetRows) {
  const byFid = new Map(sheetRows.map((r) => [r.fid, r]));
  const out = [];
  const used = new Set();

  for (const base of baseRows) {
    const hit = byFid.get(base.fid);
    if (hit) used.add(base.fid);
    out.push({
      ...base,
      status: hit?.status || base.status || "Unknown",
      order_date: hit?.created_at || base.order_date,
      status_updated_at: hit?.updated_at || "",
      has_details: true,
    });
  }

  for (const r of sheetRows) {
    if (used.has(r.fid)) continue;
    out.push({
      fid: r.fid,
      order_date: r.created_at,
      status: r.status,
      status_updated_at: r.updated_at,
      receiver_name: "",
      phone: "",
      address: "",
      city: "",
      amount: null,
      has_details: false,
    });
  }

  out.sort((a, b) =>
    a.order_date === b.order_date
      ? a.fid < b.fid ? -1 : 1
      : a.order_date < b.order_date ? -1 : 1,
  );

  return out;
}

/** Summary used by /api/health and the dataset payload. */
export function summarise(rows, sheetRows = []) {
  const dates = rows.map((r) => r.order_date).filter(Boolean).sort();
  const statuses = {};
  for (const r of rows) statuses[r.status] = (statuses[r.status] || 0) + 1;

  return {
    orders: rows.length,
    from_sheet: sheetRows.length,
    with_details: rows.filter((r) => r.has_details).length,
    range: { start: dates[0] || null, end: dates.at(-1) || null },
    statuses,
  };
}
