/* Service worker: accumulates snapshots from the Hive tab and streams them to
 * every open dashboard tab. State lives in chrome.storage.local so it survives
 * service-worker restarts and page reloads.
 */

const KEY = "jitbenLive";
const MAX_ROWS = 20000;

const emptyState = () => ({ byFid: {}, updatedAt: 0, scrapes: 0, pages: [] });

async function readState() {
  const raw = await chrome.storage.local.get(KEY);
  return raw[KEY] || emptyState();
}

async function writeState(state) {
  await chrome.storage.local.set({ [KEY]: state });
}

function healthy(row) {
  return row && row.fid && (row.status || row.receiver_name || row.address || row.phone);
}

/** Newest non-empty value wins per field; nothing learned is ever lost. */
function mergeRow(prev, next) {
  if (!prev) return { ...next, first_seen: next.first_seen || Date.now(), last_seen: Date.now() };
  return {
    ...prev,
    ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== "" && v != null)),
    first_seen: prev.first_seen || Date.now(),
    last_seen: Date.now(),
  };
}

async function handleSnapshot(msg) {
  const rows = (msg.rows || []).filter(healthy);
  if (!rows.length) return;

  const state = await readState();
  for (const row of rows) state.byFid[row.fid] = mergeRow(state.byFid[row.fid], row);

  const fids = Object.keys(state.byFid);
  if (fids.length > MAX_ROWS) {
    fids.sort((a, b) => state.byFid[a].last_seen - state.byFid[b].last_seen);
    for (const fid of fids.slice(0, fids.length - MAX_ROWS)) delete state.byFid[fid];
  }

  state.updatedAt = Date.now();
  state.scrapes = (state.scrapes || 0) + 1;
  await writeState(state);

  broadcast(Object.values(state.byFid));
}

async function broadcast(rows) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs
      .sendMessage(tab.id, { type: "jitben:live", rows, updatedAt: Date.now() })
      .catch(() => {
        /* no receiver in that tab — normal */
      });
  }
}

const injectedTabs = new Set();

async function installMainWorldHook(tabId) {
  if (!tabId || injectedTabs.has(tabId)) return { ok: true, skipped: true };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["injected.js"] });
    injectedTabs.add(tabId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// A navigation throws away the MAIN-world state, so forget the tab and let the
// content script ask for a fresh injection.
chrome.tabs.onRemoved.addListener((tabId) => injectedTabs.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") injectedTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "jitben:inject-main") {
    installMainWorldHook(sender.tab?.id).then(sendResponse);
    return true;
  }

  if (msg?.type === "jitben:snapshot") {
    handleSnapshot(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }

  if (msg?.type === "jitben:get") {
    readState()
      .then((state) => sendResponse({ rows: Object.values(state.byFid), updatedAt: state.updatedAt, scrapes: state.scrapes }))
      .catch((e) => sendResponse({ rows: [], error: String(e) }));
    return true;
  }

  if (msg?.type === "jitben:clear") {
    writeState(emptyState())
      .then(() => broadcast([]))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === "jitben:dashboard-opened") {
    readState()
      .then((state) => {
        const rows = Object.values(state.byFid);
        if (rows.length) broadcast(rows);
        return sendResponse({ rows: rows.length });
      })
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  console.info("[jitben] extension installed — open hive.carrybee.com/orders and the dashboard.");
});
