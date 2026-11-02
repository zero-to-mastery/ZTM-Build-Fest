// <ob-views path="/posts/slug/" endpoint=""> shows a page's view count.
//
// The build may have baked a count into the element already (from the
// analytics backup), so a static host shows something even with no live
// counter. If a counter is reachable (same origin via `openblog serve`, or the
// `endpoint` address, such as a Cloudflare Worker), this records one view per
// page per browser session and shows the live total.
//
// Nothing is sent for readers with Do Not Track or Global Privacy Control, or
// from automated browsers. What is sent: the page path and the referring site.
// No cookies, no identifiers.

class ObViews extends HTMLElement {
  async connectedCallback() {
    const path = this.getAttribute("path");
    if (!path) return;
    const base = (this.getAttribute("endpoint") || "/api").replace(/\/$/, "");
    // The server also honours the DNT and Sec-GPC headers; this just avoids the request.
    const optedOut = navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true || navigator.webdriver;
    const key = `ob-viewed:${path}`;
    let seen = false;
    try {
      seen = sessionStorage.getItem(key) === "1";
    } catch {
      // Storage blocked: we may count twice on reload, which is acceptable.
    }

    let views = null;
    try {
      if (optedOut || seen) {
        const res = await fetch(`${base}/views?path=${encodeURIComponent(path)}`, { credentials: "omit" });
        if (res.ok) views = (await res.json()).views;
      } else {
        const res = await fetch(`${base}/hit`, {
          method: "POST",
          credentials: "omit",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, referrer: document.referrer || "" }),
        });
        if (res.ok) {
          views = (await res.json()).views;
          try {
            sessionStorage.setItem(key, "1");
          } catch {
            // Fine.
          }
        }
      }
    } catch {
      // No counter reachable (static host, offline): keep whatever was baked in.
      return;
    }
    if (typeof views === "number" && views > 0) {
      this.textContent = ` · ${views.toLocaleString()} ${views === 1 ? "view" : "views"}`;
    }
  }
}

if (!customElements.get("ob-views")) {
  customElements.define("ob-views", ObViews);
}
