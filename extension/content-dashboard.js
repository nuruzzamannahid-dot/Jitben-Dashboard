/* Runs inside the dashboard tab. Relays the accumulated Hive rows from the
 * extension into the page, which merges + re-renders instantly.
 *
 * Two paths on purpose:
 *   1. pushed  — the service worker broadcasts every snapshot (instant)
 *   2. polled  — every 1.5s we ask for the stored rows ourselves
 * The poll is what makes this converge: if the extension is reloaded while this
 * tab is open, or the broadcast lands while the page is still booting, the tab
 * used to keep a stale snapshot forever (statuses yes, receiver info no). Now it
 * catches up within a second and a half without anyone reloading anything.
 */
(() => {
  "use strict";

  let lastPush = "";

  function push(rows, updatedAt) {
    if (!Array.isArray(rows) || !rows.length) return;

    // Skip identical repeats so the page is not re-rendered every 1.5s.
    const signature = rows.length + "|" + (updatedAt || 0);
    if (signature === lastPush) return;
    lastPush = signature;

    // postMessage crosses the isolated world → page world boundary reliably.
    window.postMessage({ type: "jitben:live", rows, updatedAt: updatedAt || Date.now(), ext: true }, "*");
  }

  async function pull() {
    try {
      const state = await chrome.runtime.sendMessage({ type: "jitben:get" });
      const rows = state?.rows || [];
      if (rows.length) push(rows, state.updatedAt);
    } catch {
      /* extension reloaded — the next tick retries */
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "jitben:live") push(msg.rows, msg.updatedAt);
  });

  chrome.runtime
    .sendMessage({ type: "jitben:dashboard-opened" })
    .catch(() => {
      /* extension reloaded; polling below recovers */
    })
    .then(pull);

  setInterval(pull, 1500);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pull();
  });
  window.addEventListener("focus", pull);
})();
