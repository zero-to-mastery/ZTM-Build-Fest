import { html as h } from "../markdown/serialize.js";
import { auditSession } from "../repository-audit/github.js";
import {
  contextKinds,
  contextSeeds,
  repositoryChoices,
  stackContext,
} from "../writing/context.js";
export class WritingContext extends HTMLElement {
  configure(draft, ranges, range) {
    this.draft = draft;
    this.ranges = ranges.filter((r) => r.id.startsWith("section:"));
    this.repositories = repositoryChoices(draft, auditSession.repositories);
    this.innerHTML = `<fieldset><legend>Optional reviewed context — nothing selected by default</legend>
      <p>Use only facts you trust. No new GitHub fetch occurs. Loaded data may be outdated; inspect and edit it before selecting. Project type and metadata below describe this draft independently of the repository choice. Style guidance is not factual evidence.</p>
      <label>Context repository<select data-context-repo><option value="">Choose an already loaded repository</option>${this.repositories.map((r, i) => `<option value="${i}">${h(r.name)}</option>`).join("")}</select></label>
      <label>Context section<select data-context-section>${this.ranges.map((r, i) => `<option value="${i}">${h(r.label)}</option>`).join("")}</select></label>
      ${Object.entries(contextKinds)
        .map(
          ([id, label]) =>
            `<section><label><input type="checkbox" data-context-choice="${id}"> Include ${h(label)}</label><label>${h(label)} context<textarea data-context-value="${id}" rows="3" maxlength="12000" placeholder="No saved context available. Paste only facts you want to share, then select Include."></textarea></label></section>`,
        )
        .join("")}
      <p>Only checked sources are sent. Up to 12,000 characters per source and 16,000 total context characters. Larger sources are shown intact and must be shortened explicitly.</p></fieldset>`;
    const seeds = contextSeeds(draft);
    for (const id of Object.keys(contextKinds))
      this.value(id).value = seeds[id];
    this.setSection(range);
    this.querySelector("[data-context-repo]").onchange = () => {
      const index = this.querySelector("[data-context-repo]").value;
      const repo = index === "" ? null : this.repositories[Number(index)];
      this.value("repository").value = repo?.content || "";
      const record =
        repo &&
        [...(auditSession.stackResults?.values() || [])].find(
          (r) => r.repository.toLowerCase() === repo.name.toLowerCase(),
        );
      this.value("stack").value = stackContext(record);
      for (const id of ["repository", "stack"])
        this.querySelector(`[data-context-choice="${id}"]`).checked = false;
      this.changed();
    };
    this.querySelector("[data-context-section]").onchange = () => {
      this.sectionValue();
      this.changed();
    };
    this.addEventListener("input", () => this.changed());
    this.querySelectorAll("[data-context-choice]").forEach(
      (el) => (el.onchange = () => this.changed()),
    );
  }
  value(id) {
    return this.querySelector(`[data-context-value="${id}"]`);
  }
  entries() {
    return [...this.querySelectorAll("[data-context-choice]:checked")].map(
      (el) => ({
        id: el.dataset.contextChoice,
        content: this.value(el.dataset.contextChoice).value,
      }),
    );
  }
  setSection(range) {
    const i = this.ranges.findIndex(
      (r) =>
        r.start <= range.start &&
        (r.end > range.start || r.end === this.draft.markdown.length),
    );
    this.querySelector("[data-context-section]").value = String(Math.max(0, i));
    this.sectionValue();
  }
  sectionValue() {
    const range =
      this.ranges[Number(this.querySelector("[data-context-section]").value)];
    this.value("section").value = range
      ? this.draft.markdown.slice(range.start, range.end)
      : "";
    this.querySelector('[data-context-choice="section"]').checked = false;
  }
  changed() {
    this.dispatchEvent(
      new CustomEvent("writing-context-change", { bubbles: true }),
    );
  }
}
customElements.define("writing-context", WritingContext);
