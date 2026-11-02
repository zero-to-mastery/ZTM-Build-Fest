// <ob-search index="/search.json" wasm="/assets/wasm/openblog_wasm.js">
//
// Searches the build's JSON index with the same Rust ranking code the CLI
// ships, compiled to WebAssembly. If the module can't load (old browser,
// blocked WASM), a small JavaScript fallback does plain substring matching so
// search still works. Supports ?q= in the URL; add the `no-history` attribute when the
// element sits in a dialog or panel on another page, so typing never rewrites that address.

const MAX_RESULTS = 20;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function highlight(text, terms) {
  let out = escapeHtml(text);
  for (const term of terms) {
    const safe = escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(${safe})`, "gi"), "<mark>$1</mark>");
  }
  return out;
}

// Mirrors the ranking in openblog-core closely enough for a degraded mode.
function fallbackSearch(index, query, limit) {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  if (!terms.length) return [];
  const hits = [];
  for (const e of index.entries) {
    const hay = {
      title: e.title.toLowerCase(),
      tags: (e.tags || []).join(" ").toLowerCase(),
      description: (e.description || "").toLowerCase(),
      text: e.text || "",
    };
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const s =
        (hay.title.includes(t) ? 8 : 0) +
        (hay.tags.includes(t) ? 6 : 0) +
        (hay.description.includes(t) ? 3 : 0) +
        (hay.text.includes(t) ? 1 : 0);
      if (!s) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    const pos = hay.text.indexOf(terms[0]);
    const snippet = pos >= 0 ? hay.text.slice(Math.max(0, pos - 60), pos + 120) : "";
    hits.push({ ...e, score, snippet });
  }
  return hits.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, limit);
}

class ObSearch extends HTMLElement {
  async connectedCallback() {
    this.input = this.querySelector("input[type=search]");
    this.status = this.querySelector(".ob-search-status");
    this.results = this.querySelector(".ob-search-results");
    this.form = this.querySelector("form");
    this.syncUrl = !this.hasAttribute("no-history");
    if (!this.input || !this.results) return;

    this.form?.addEventListener("submit", (e) => e.preventDefault());
    this.input.addEventListener("input", () => this.#run());
    this.status.textContent = "Loading search…";

    try {
      const res = await fetch(this.getAttribute("index") || "/search.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.indexText = await res.text();
      this.index = JSON.parse(this.indexText);
    } catch (err) {
      this.status.textContent = "Search is unavailable right now.";
      console.warn("ob-search: could not load index", err);
      return;
    }

    try {
      const url = this.getAttribute("wasm") || "/assets/wasm/openblog_wasm.js";
      const mod = await import(url);
      await mod.default();
      this.engine = mod;
    } catch (err) {
      console.info("ob-search: WebAssembly unavailable, using JavaScript fallback", err);
    }

    const initial = this.syncUrl ? new URLSearchParams(location.search).get("q") : null;
    if (initial) this.input.value = initial;
    this.status.textContent = "";
    this.#run();
  }

  #run() {
    const query = this.input.value.trim();
    if (this.syncUrl) {
      const url = new URL(location.href);
      if (query) url.searchParams.set("q", query);
      else url.searchParams.delete("q");
      history.replaceState(null, "", url);
    }

    if (!query) {
      this.results.replaceChildren();
      this.status.textContent = "";
      return;
    }
    let hits;
    if (this.engine) {
      const raw = JSON.parse(this.engine.search(this.indexText, query, MAX_RESULTS));
      hits = Array.isArray(raw) ? raw : [];
    } else {
      hits = fallbackSearch(this.index, query, MAX_RESULTS);
    }
    const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
    this.status.textContent = hits.length
      ? `${hits.length} ${hits.length === 1 ? "result" : "results"}`
      : "No posts match that search.";
    this.results.innerHTML = hits
      .map(
        (h) =>
          `<li><a href="${escapeHtml(h.url)}">${highlight(h.title, terms)}</a>` +
          `<p class="ob-meta">${escapeHtml(h.date)}${h.series ? " · " + escapeHtml(h.series) : ""}</p>` +
          (h.snippet ? `<p>${highlight(h.snippet, terms)}</p>` : h.description ? `<p>${highlight(h.description, terms)}</p>` : "") +
          `</li>`,
      )
      .join("");
  }
}

if (!customElements.get("ob-search")) {
  customElements.define("ob-search", ObSearch);
}
