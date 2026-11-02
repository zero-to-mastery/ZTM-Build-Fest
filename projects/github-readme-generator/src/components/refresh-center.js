import { sourceDiffMarkup, fillSourceDiff } from "./source-diff.js";
import { generatedRegistry, refreshedAge } from "../generated/registry.js";
import {
  fetchRefresh,
  refreshPreview,
  applyRefresh,
} from "../github/refresh.js";
import { html as h } from "../markdown/serialize.js";
export class RefreshCenter extends HTMLElement {
  configure(draft) {
    this.draft = structuredClone(draft);
    this.snapshot = JSON.stringify(draft);
    this.units = generatedRegistry(draft);
    this.draw();
  }
  disconnectedCallback() {
    this.controller?.abort();
  }
  cancel() {
    this.controller?.abort();
  }
  draw() {
    this.innerHTML = `<h1>Refresh GitHub data</h1><p>Explicitly fetch public metadata, review changes, then apply selected sources in one undo step. Manual fields are preserved. Fetch age is informational, not a claim that content is stale. README import versions are separate.</p>${this.units.map((u, i) => `<article><label class="check"><input type="checkbox" data-unit="${i}" ${u.ownership === "detached" ? "" : "checked"}>${h(u.label)}</label><p>${h(u.source?.toString())} · ${h(refreshedAge(u.lastFetched))} · ${h(u.ownership)}</p>${u.ownership === "detached" ? `<p>This section was manually edited and is no longer refreshable.</p><label class="check"><input type="checkbox" data-recreate="${i}">Recreate generated version (append, preserve current Markdown)</label>` : ""}${u.manual ? `<p>${u.manual} manually edited values will be preserved.</p>` : ""}</article>`).join("") || "<p>No generated sources. Use GitHub Autofill or repository authoring first.</p>"}<button data-selected ${this.units.length ? "" : "disabled"}>Refresh selected</button><button data-all ${this.units.length ? "" : "disabled"}>Refresh all owned sources</button><button data-cancel disabled>Cancel fetch</button><p role="status"></p><div data-review></div>`;
    this.querySelector("[data-selected]").onclick = () =>
      this.fetchSelected(false);
    this.querySelector("[data-all]").onclick = () => this.fetchSelected(true);
    this.querySelector("[data-cancel]").onclick = () => this.cancel();
    this.querySelectorAll("[data-unit],[data-recreate]").forEach(
      (i) =>
        (i.onchange = () =>
          this.querySelector("[data-review]").replaceChildren()),
    );
  }
  async fetchSelected(all) {
    if (this.busy) return;
    const selected = all
      ? this.units.filter((u) => u.ownership !== "detached").map((u) => u.id)
      : [...this.querySelectorAll("[data-unit]:checked")].map(
          (i) => this.units[Number(i.dataset.unit)].id,
        );
    const recreate = [...this.querySelectorAll("[data-recreate]:checked")].map(
      (i) => this.units[Number(i.dataset.recreate)].id,
    );
    this.ids = [...new Set([...selected, ...recreate])];
    this.recreate = recreate;
    const status = this.querySelector("[role=status]");
    if (!this.ids.length) {
      status.textContent = "Select sources to refresh.";
      return;
    }
    this.busy = true;
    this.controller = new AbortController();
    this.querySelector("[data-review]").replaceChildren();
    this.querySelectorAll("input,[data-selected],[data-all]").forEach(
      (i) => (i.disabled = true),
    );
    this.querySelector("[data-cancel]").disabled = false;
    status.textContent = "Fetching selected public sources…";
    try {
      this.data = await fetchRefresh(this.draft, this.ids, {
        signal: this.controller.signal,
      });
      if (!this.isConnected || this.controller.signal.aborted) return;
      this.review();
      status.textContent = this.data.errors.length
        ? `Partial result: ${this.data.errors.join(" ")}`
        : "Fetch complete. Review before applying.";
    } catch (e) {
      status.textContent = this.controller.signal.aborted
        ? "Refresh cancelled. Existing content unchanged."
        : e.message;
    } finally {
      this.busy = false;
      if (this.isConnected) {
        this.querySelectorAll("input,[data-selected],[data-all]").forEach(
          (i) => (i.disabled = false),
        );
        this.querySelector("[data-cancel]").disabled = true;
      }
    }
  }
  review() {
    const rows = refreshPreview(this.draft, this.data, this.ids, this.recreate);
    this.rows = rows;
    const el = this.querySelector("[data-review]");
    el.innerHTML = `<h2 tabindex="-1">Review refresh changes</h2>${rows
      .map(
        (r, i) =>
          `<article><h3>${h(r.unit.label)}</h3>${
            r.error
              ? `<p>Failed: ${h(r.error)}</p>`
              : `<label class="check"><input type="checkbox" data-accept="${i}" ${r.changed ? "checked" : ""}>Apply this source${r.unit.ownership === "detached" ? " — append recreated content" : ""}</label><p>${h(r.skipped.join("; "))}</p><p>${r.diff.added.length || r.diff.removed.length ? "Source changes below." : "No Markdown change; accepted sources may update fetch metadata."}</p><pre>${h(
                  r.diff.removed
                    .map((s) => "- " + s)
                    .concat(r.diff.added.map((s) => "+ " + s))
                    .join("\n"),
                )}</pre><details data-full-diff="${i}"><summary>Current Markdown / Generated Markdown</summary><div></div></details>`
          }</article>`,
      )
      .join(
        "",
      )}<button data-apply-refresh>Apply reviewed refresh</button><button data-skip>Skip all changes</button>`;
    el.querySelectorAll("[data-full-diff]").forEach(
      (detail) =>
        (detail.ontoggle = () => {
          const container = detail.querySelector("div");
          if (!detail.open || container.childElementCount) return;
          const row = rows[Number(detail.dataset.fullDiff)];
          container.innerHTML = sourceDiffMarkup();
          fillSourceDiff(container, row.before, row.after);
        }),
    );
    el.querySelector("[data-skip]").onclick = () => {
      el.replaceChildren();
      this.querySelector("[role=status]").textContent =
        "Changes skipped. README unchanged.";
      this.querySelector("[data-selected]").focus();
    };
    el.querySelector("[data-apply-refresh]").onclick = () => {
      const ids = [...el.querySelectorAll("[data-accept]:checked")].map(
        (i) => rows[Number(i.dataset.accept)].unit.id,
      );
      if (!ids.length) {
        this.querySelector("[role=status]").textContent =
          "Select a successful source to apply, or skip changes.";
        return;
      }
      this.dispatchEvent(
        new CustomEvent("refresh-apply", {
          bubbles: true,
          detail: {
            snapshot: this.snapshot,
            result: applyRefresh(this.draft, this.data, ids, this.recreate),
          },
        }),
      );
    };
    el.querySelector("h2").focus();
  }
}
customElements.define("refresh-center", RefreshCenter);
