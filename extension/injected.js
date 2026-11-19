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
            if (!looksJson(res.headers.get("content-type"))) return;
            res
              .clone()
              .text()
              .then((text) => {
                if (!sizeOk(text)) return;
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
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__jitbenUrl = url;
    return XO.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        if (!looksJson(this.getResponseHeader("content-type"))) return;
        const text = this.responseType === "" || this.responseType === "text" ? this.responseText : "";
        if (!sizeOk(text)) return;
        emit(this.__jitbenUrl, JSON.parse(text));
      } catch {
        /* ignore */
      }
    });
    return XS.apply(this, args);
  };

  // ---- Next.js/embedded state (SSR pages ship data in a script tag) --------
  const sweepSsrData = () => {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el || !el.textContent) return;
    try {
      emit("__NEXT_DATA__", JSON.parse(el.textContent));
    } catch {
      /* ignore */
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sweepSsrData, { once: true });
  } else {
    sweepSsrData();
  }

  console.debug("[jitben] main-world hook installed");
})();
