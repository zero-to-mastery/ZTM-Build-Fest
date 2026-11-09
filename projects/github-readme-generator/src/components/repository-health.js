import { healthTargets, scanTargets } from "../github/health.js";
import { cachedHealth } from "../github/health-cache.js";
import { html as h } from "../markdown/serialize.js";
export class RepositoryHealth extends HTMLElement {
  configure(draft) {
    this.targets = healthTargets(draft);
    this.results = new Map(
      this.targets.flatMap((t) => {
        const r = cachedHealth(t);
        return r ? [[t.url, r]] : [];
      }),
    );
    this.innerHTML = `<h1>Repository Health</h1><p>Check links only on your explicit action. This contacts external services directly, without credentials or a proxy. Results never block export. Up to 300 unique links, four concurrent checks, ten seconds per request. Cached results expire after five minutes.</p><button data-scan>Check links</button><button data-recheck>Recheck all</button><button data-cancel disabled>Cancel scan</button><p role="status">${this.targets.length} targets ready; no requests started.</p><div data-results></div>`;
    this.querySelector("[data-scan]").onclick = () =>
      this.scan(this.targets, false);
    this.querySelector("[data-recheck]").onclick = () =>
      this.scan(this.targets, true);
    this.querySelector("[data-cancel]").onclick = () =>
      this.controller?.abort();
    this.list();
  }
  disconnectedCallback() {
    this.controller?.abort();
  }
  list() {
    this.querySelector("[data-results]").innerHTML = [
      "Repositories",
      "Images",
      "Badges",
      "Widgets",
      "External Links",
    ]
      .map((group) => {
        const targets = this.targets.filter((t) => t.category === group);
        return targets.length
          ? `<section><h2>${group}</h2>${targets
              .map((t) => {
                const r = this.results.get(t.url);
                return `<article><p>${h(t.url)}</p><strong>${h(r?.state || "Not checked")}</strong>${r ? `<p>Checked ${h(new Date(r.checkedAt).toLocaleString())}</p><p>${h(r.notes.join(" "))}</p>` : ""}<button data-item="${this.targets.indexOf(t)}" ${this.busy ? "disabled" : ""} aria-label="Recheck ${h(t.url)}">Recheck item</button></article>`;
              })
              .join("")}</section>`
          : "";
      })
      .join("");
    this.querySelectorAll("[data-item]").forEach(
      (b) =>
        (b.onclick = () =>
          this.scan([this.targets[Number(b.dataset.item)]], true)),
    );
  }
  async scan(targets, force) {
    if (this.busy) return;
    this.busy = true;
    this.controller = new AbortController();
    this.querySelector("[data-cancel]").disabled = false;
    this.querySelector("[data-scan]").disabled = true;
    this.querySelector("[data-recheck]").disabled = true;
    this.list();
    let count = 0;
    const status = this.querySelector("[role=status]");
    status.textContent = "Checking links…";
    try {
      await scanTargets(targets, {
        force,
        signal: this.controller.signal,
        onResult: (r) => {
          if (!this.isConnected) return;
          this.results.set(r.url, r);
          count++;
          status.textContent = `Checked ${count} of ${targets.length}.`;
        },
      });
    } finally {
      this.busy = false;
      if (this.isConnected) {
        status.textContent = this.controller.signal.aborted
          ? `Scan cancelled; ${count} results retained.`
          : `Link check complete: ${count} results. Ambiguous failures are not confirmed broken links.`;
        this.querySelector("[data-cancel]").disabled = true;
        this.querySelector("[data-scan]").disabled = false;
        this.querySelector("[data-recheck]").disabled = false;
        this.list();
        this.querySelector("[data-scan]").focus();
      }
    }
  }
}
customElements.define("repository-health", RepositoryHealth);
