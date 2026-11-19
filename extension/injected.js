/* MAIN-world hook: records JSON responses the Hive page itself requests, so the
 * extension can read order payloads (which include receiver fields) instead of
 * depending on what the list view happens to render.
 *
 * Injected with chrome.scripting.executeScript({ world: "MAIN" }) — page CSP
 * cannot block that, and it sees the same fetch/XHR the app uses.
 */
(() => {
  if (window.__jitbenHooked) return;
  window.__jitbenHooked = true;

  const MAX = 200_000; // ignore huge payloads

  let payloads = 0;

  const emit = (url, data) => {
    payloads++;
    window.__jitbenStats = { payloads, lastUrl: String(url || ""), at: Date.now() };
    try {
      window.postMessage({ __jitben: "json", url: String(url || ""), data }, "*");
    } catch {
      /* unserialisable payload — ignore */
    }
  };

  // Tells the content script the hook is alive (it re-requests if this never
  // arrives) and lets the popup show hook status instead of guessing.
  const hello = () => {
    try {
      window.postMessage({ __jitben: "hello", href: location.href }, "*");
    } catch {
      /* ignore */
    }
  };
  hello();
  setTimeout(hello, 1500);

  const looksJson = (ct) => !!ct && /json/i.test(ct);
  // Some servers send JSON with no content-type (or text/plain); a leading brace
  // is a cheap tell, so those responses are read too instead of being skipped.
  const maybeJson = (ct) => !ct || /json|text\/plain/i.test(ct);
  const sizeOk = (text) => typeof text === "string" && text.length < MAX;

  // ---- fetch ---------------------------------------------------------------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
      const promise = origFetch.apply(this, args);
      promise
        .then((res) => {
          try {
            const ct = res.headers.get("content-type");
            if (!looksJson(ct) && !maybeJson(ct)) return;
            res
              .clone()
              .text()
              .then((text) => {
                if (!sizeOk(text)) return;
                if (!looksJson(ct) && !/^\s*[{[]/.test(text)) return;
                try {
                  emit(url, JSON.parse(text));
                } catch {
                  /* not json after all */
                }
              })
              .catch(() => {});
          } catch {
            /* opaque response */
          }
        })
        .catch(() => {});
      return promise;
    };
  }

  // ---- XMLHttpRequest ------------------------------------------------------
  if (typeof XMLHttpRequest !== "undefined" && XMLHttpRequest.prototype) {
    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__jitbenUrl = url;
      return XO.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", () => {
        try {
          const ct = this.getResponseHeader("content-type");
          if (!looksJson(ct) && !maybeJson(ct)) return;
          const text = this.responseType === "" || this.responseType === "text" ? this.responseText : "";
          if (!sizeOk(text)) return;
          if (!looksJson(ct) && !/^\s*[{[]/.test(text)) return;
          emit(this.__jitbenUrl, JSON.parse(text));
        } catch {
          /* ignore */
        }
      });
      return XS.apply(this, args);
    };
  }

  // ---- SSR state blobs ------------------------------------------------------
  // A server-rendered list never fires an XHR, so the order data lives in the
  // markup instead: Next.js/Remix/Inertia script blobs, `data-page` attributes,
  // or any JSON-looking data-* attribute. All of it is handed to the miner.
  const INLINE_SELECTORS = [
    "script#__NEXT_DATA__",
    'script[type="application/json"]',
    'script[type="application/ld+json"]',
    "[data-page]",
    "[data-json]",
    "[data-state]",
    "[data-props]",
    "[data-payload]",
    "[data-orders]",
    "[data-order]",
  ];

  const seenInline = new Set();
  const textLooksLikeOrderData = (text) => typeof text === "string" && /F\d{4}[A-Z0-9]{6}/.test(text);

  const sweepSsrData = () => {
    for (const el of document.querySelectorAll(INLINE_SELECTORS.join(","))) {
      try {
        const raw = el.tagName === "SCRIPT" ? el.textContent : el.getAttribute("data-page") || el.getAttribute("data-json") || el.getAttribute("data-state") || el.getAttribute("data-props") || el.getAttribute("data-payload") || el.getAttribute("data-orders") || el.getAttribute("data-order");
        if (!raw || raw.length > MAX || !textLooksLikeOrderData(raw)) continue;

        const key = el.id || el.tagName + ":" + raw.length + ":" + raw.slice(0, 40);
        if (seenInline.has(key)) continue;
        seenInline.add(key);

        let data;
        try {
          data = el.dataset && el.dataset.page ? el.dataset.page : JSON.parse(raw);
          if (typeof data === "string") data = JSON.parse(data);
        } catch {
          continue; // escaped/HTML-encoded blob — the DOM scraper still sees the text
        }
        emit("inline:" + key, data);
      } catch {
        /* ignore one bad node */
      }
    }
  };

  const startSsrSweep = () => {
    sweepSsrData();
    // The list is often re-rendered client-side; re-check for a while, cheaply.
    let rounds = 0;
    const timer = setInterval(() => {
      sweepSsrData();
      if (++rounds > 20) clearInterval(timer);
    }, 3000);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startSsrSweep, { once: true });
  } else {
    startSsrSweep();
  }

  console.debug("[jitben] main-world hook installed");
})();
