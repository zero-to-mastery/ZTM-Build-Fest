import { html } from "../markdown/serialize.js";
import { providers, buildDynamicBadge } from "../badges/providers/index.js";
export class DynamicBadgeBuilder extends HTMLElement {
  connectedCallback() {
    this.config ||= {};
    this.selected ||= providers[0].id;
    this.draw();
  }
  draw() {
    this.innerHTML = `<h2>Dynamic badge helpers</h2><p>Generate locally, then preview on request. A loaded image does not verify a workflow or status. Custom endpoints must be public: Shields fetches their JSON.</p><label>Search badge helpers<input data-provider-search></label><label>Badge helper<select data-provider aria-label="Badge helper"></select></label><div data-provider-fields></div><label>Cache seconds (optional)<input data-cache inputmode="numeric" placeholder="3600"></label><button data-generate-dynamic>Generate dynamic badge</button><p data-provider-status role="status"></p>`;
    this.catalog("");
    this.fields();
    this.querySelector("[data-provider-search]").oninput = (e) =>
      this.catalog(e.target.value);
    this.querySelector("[data-provider]").onchange = (e) => {
      this.selected = e.target.value;
      this.fields();
    };
    this.querySelector("[data-generate-dynamic]").onclick = () => {
      try {
        const badge = buildDynamicBadge(this.selected, this.config, {
          cacheSeconds: this.querySelector("[data-cache]").value,
        });
        this.dispatchEvent(
          new CustomEvent("dynamic-badge", { detail: badge, bubbles: true }),
        );
      } catch (e) {
        this.querySelector("[data-provider-status]").textContent = e.message;
      }
    };
  }
  catalog(query) {
    const found = providers.filter((p) =>
      (p.name + " " + p.category).toLowerCase().includes(query.toLowerCase()),
    );
    this.querySelector("[data-provider]").innerHTML = found
      .map(
        (p) =>
          `<option value="${p.id}" ${p.id === this.selected ? "selected" : ""}>${p.category} · ${p.name}</option>`,
      )
      .join("");
    if (!found.some((p) => p.id === this.selected)) {
      this.selected = found[0]?.id;
      this.fields();
    }
  }
  fields() {
    const provider = providers.find((p) => p.id === this.selected);
    this.querySelector("[data-generate-dynamic]").disabled = !provider;
    this.querySelector("[data-provider-fields]").innerHTML = provider
      ? provider.fields
          .map(
            (f) =>
              `<label>${html(f.label)}<input data-provider-field="${f.key}" value="${html(this.config[f.key] || "")}"></label>`,
          )
          .join("") +
        (provider.id.startsWith("github-") && this.suggestions?.length
          ? `<label>Suggested repository (confirm your target)<select data-repo-suggestion><option value="">Choose explicitly</option>${this.suggestions.map((s) => `<option>${html(s)}</option>`).join("")}</select></label>`
          : "")
      : "No matching helpers.";
    this.querySelectorAll("[data-provider-field]").forEach(
      (i) =>
        (i.oninput = () => (this.config[i.dataset.providerField] = i.value)),
    );
    const suggestion = this.querySelector("[data-repo-suggestion]");
    if (suggestion)
      suggestion.onchange = () => {
        if (suggestion.value) {
          this.config.repository = suggestion.value;
          this.querySelector('[data-provider-field="repository"]').value =
            suggestion.value;
        }
      };
  }
}
customElements.define("dynamic-badge-builder", DynamicBadgeBuilder);
