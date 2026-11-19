const DASHBOARD_FALLBACK = "https://jitben-dashboard.jitben-746a2b.workers.dev";

const $ = (id) => document.getElementById(id);
const fmt = (ts) => (ts ? new Date(ts).toLocaleTimeString() : "—");

async function render() {
  const [state, { paused = false, dashboardUrl = DASHBOARD_FALLBACK } = {}] = await Promise.all([
    chrome.runtime.sendMessage({ type: "jitben:get" }),
    chrome.storage.local.get(["paused", "dashboardUrl"]),
  ]);

  const rows = state?.rows || [];
  const withDetails = rows.filter((r) => r.receiver_name || r.address || r.phone).length;

  $("count").textContent = rows.length.toLocaleString();
  $("details").textContent = withDetails.toLocaleString();
  $("last").textContent = fmt(state?.updatedAt);
  $("scrapes").textContent = String(state?.scrapes || 0);

  const meta = state?.meta || {};
  $("hook").textContent = meta.hook === "on" ? "on" : meta.hook === "off" ? "off" : "—";
  $("api").textContent = String(meta.api || 0);
  $("sub").textContent = "v" + (chrome.runtime.getManifest?.().version || "?") + " · Hive → Dashboard, every second";

  const dot = $("dot");
  dot.className = "dot " + (paused ? "off" : rows.length ? "on" : "");

  if (paused) $("state").textContent = "paused";
  else if (!rows.length) $("state").textContent = "waiting for Hive tab";
  else $("state").textContent = "live";

  $("toggle").textContent = paused ? "Resume scraping" : "Pause scraping";
  $("dashboardUrl").value = dashboardUrl;

  if (!rows.length) {
    $("hint").innerHTML =
      'Open <code>hive.carrybee.com/orders</code> in a tab — rows are captured on their own, then streamed here and to the dashboard.';
  } else if (!meta.hook) {
    $("hint").innerHTML =
      "The Hive tab is still running the previous script, so receiver details cannot be read yet. Opening this popup re-injects it — give it a couple of seconds, then check <b>Payload hook</b>.";
  } else if (meta.hook === "off") {
    $("hint").innerHTML =
      "Statuses are flowing, but the payload hook is off, so receiver details cannot be read. Reload the Hive tab once (the hook installs at page start).";
  } else if (!withDetails) {
    $("hint").innerHTML =
      "Statuses are flowing, but no receiver details were found yet. Scroll or paginate the Hive list once so the page loads its order payloads.";
  } else {
    $("hint").innerHTML =
      'Streaming to the dashboard. Keep this tab (or the Hive tab) open; clearing data only resets the extension cache.';
  }
}

$("toggle").addEventListener("click", async () => {
  const { paused = false } = await chrome.storage.local.get("paused");
  const next = !paused;
  await chrome.storage.local.set({ paused: next });
  const tabs = await chrome.tabs.query({ url: "https://hive.carrybee.com/*" });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "jitben:pause", value: next }).catch(() => {});
  render();
});

$("open").addEventListener("click", async () => {
  const { dashboardUrl = DASHBOARD_FALLBACK } = await chrome.storage.local.get("dashboardUrl");
  await chrome.tabs.create({ url: $("dashboardUrl").value || dashboardUrl });
});

$("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "jitben:clear" });
  render();
});

$("dashboardUrl").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ dashboardUrl: e.target.value.trim() || DASHBOARD_FALLBACK });
});

render();
setInterval(render, 1000);

// Ask the worker to push fresh scripts into already-open tabs. This is the one
// moment we know the user is looking, so a stale Hive/dashboard tab gets
// repaired here instead of silently streaming half the data.
chrome.runtime.sendMessage({ type: "jitben:resync" }).catch(() => {});
