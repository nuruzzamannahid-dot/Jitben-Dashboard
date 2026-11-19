/* Runs inside the dashboard tab. Relays the accumulated Hive rows from the
 * extension into the page, which merges + re-renders instantly.
 */
(() => {
  "use strict";

  function push(rows, updatedAt) {
    if (!Array.isArray(rows) || !rows.length) return;
    // postMessage crosses the isolated world → page world boundary reliably.
    window.postMessage({ type: "jitben:live", rows, updatedAt: updatedAt || Date.now(), ext: true }, "*");
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "jitben:live") push(msg.rows, msg.updatedAt);
  });

  chrome.runtime
    .sendMessage({ type: "jitben:dashboard-opened" })
    .then(async () => {
      const state = await chrome.runtime.sendMessage({ type: "jitben:get" });
      if (state?.rows?.length) push(state.rows, state.updatedAt);
    })
    .catch(() => {
      /* extension reloaded; the next live message will still arrive */
    });
})();
