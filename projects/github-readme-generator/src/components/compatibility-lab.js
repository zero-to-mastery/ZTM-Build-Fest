import { ReadmeHealth } from "./readme-health.js";
import { html } from "../markdown/serialize.js";
import { compatibilityViews } from "../compatibility/registry.js";
export class CompatibilityLab extends ReadmeHealth {
  display(a) {
    this.analysis = a;
    const focused = this.contains(document.activeElement),
      activeId = document.activeElement?.dataset?.finding;
    const all = (a.detail?.compatibility || []).filter(
        (f) =>
          !this.filter ||
          this.filter === "All" ||
          f.githubBehavior === this.filter,
      ),
      findings = all.slice(0, this.limit || 100);
    this.innerHTML = `<h1>GitHub Compatibility</h1><p>Guidance, not a GitHub rendering guarantee. Analysis stays local; your Markdown is unchanged.</p><button data-action="refactors">Safe refactors</button><label>Compatibility view<select data-filter>${compatibilityViews.map((v) => `<option ${v === (this.filter || "All") ? "selected" : ""}>${v}</option>`).join("")}</select></label><p>${all.length} findings in this view. Mobile layout and preview security are identified separately.</p>${findings.map((f, i) => `<section class="health-group"><h2>${html(f.what)}</h2><p><strong>${html(f.githubBehavior)}</strong> · ${html(f.category)}</p><p>${html(f.explanation)}</p><p><strong>Alternative:</strong> ${html(f.suggestedAlternative)}</p><button data-finding="${html(f.id)}" data-index="${i}">Go to ${f.sourceRange.approximate ? "approximate " : ""}line ${f.sourceRange.line}, column ${f.sourceRange.column}</button></section>`).join("") || "<p>No findings in this view.</p>"}${all.length > findings.length ? "<button data-more>Show more compatibility findings</button>" : ""}`;
    this.closest("dialog")?.setAttribute("aria-label", "GitHub Compatibility");
    this.querySelector("[data-filter]").onchange = (e) => {
      this.filter = e.target.value;
      this.limit = 100;
      this.display(a);
      this.querySelector("[data-filter]").focus();
    };
    this.querySelectorAll("[data-finding]").forEach(
      (b) =>
        (b.onclick = () =>
          this.dispatchEvent(
            new CustomEvent("analysis-jump", {
              bubbles: true,
              detail: {
                source: this.analyzedSource,
                sourceRange: findings[Number(b.dataset.index)].sourceRange,
              },
            }),
          )),
    );
    const more = this.querySelector("[data-more]");
    if (more)
      more.onclick = () => {
        this.limit = (this.limit || 100) + 100;
        this.display(a);
        this.querySelector("[data-more]")?.focus();
      };
    if (focused)
      (
        [...this.querySelectorAll("[data-finding]")].find(
          (b) => b.dataset.finding === activeId,
        ) || this.querySelector("[data-filter]")
      ).focus();
  }
  failure() {
    this.innerHTML =
      '<h1>GitHub Compatibility</h1><p role="status">Compatibility analysis is unavailable. Your source and export remain available.</p>';
  }
}
customElements.define("compatibility-lab", CompatibilityLab);
