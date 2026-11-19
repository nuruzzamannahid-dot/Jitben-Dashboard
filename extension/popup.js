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
  } else if (!withDetails) {
    $("hint").innerHTML =
      "Statuses are flowing, but no receiver details were found. Open an order's detail panel once — the scraper will pick up name / address from there.";
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
