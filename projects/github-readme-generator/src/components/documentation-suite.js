import { html as h } from "../markdown/serialize.js";
import {
  documentationSuiteProjectTypes,
  documentationSuiteTemplates,
  createDocumentationSuite,
} from "../documentation/suites.js";

const labels = {
  generic: "Generic project",
  cli: "CLI",
  api: "API",
  library: "Library or package",
  game: "Game",
  "web-app": "Web app",
};

export class DocumentationSuite extends HTMLElement {
  configure({ availableSlots, snapshot }) {
    this.availableSlots = availableSlots;
    this.snapshot = snapshot;
    this.innerHTML = `<h1>Create a documentation suite</h1>
      <p>Choose only the files this project needs. Every file starts as editable guidance, not a claim about the project. This creates local documents only; nothing is fetched or published.</p>
      <label>Suite project type<select data-project-type>${documentationSuiteProjectTypes.map((type) => `<option value="${h(type)}">${h(labels[type])}</option>`).join("")}</select></label>
      <div data-options></div>
      <button data-review disabled>Review exact suite</button>
      <section data-exact hidden aria-labelledby="suite-review-heading"><h2 id="suite-review-heading" tabindex="-1">Exact suite review</h2><div data-files></div><label><input type="checkbox" data-approve> I reviewed every selected path and its exact starting Markdown.</label><button data-create disabled>Create reviewed local documents</button></section>
      <p data-status role="status"></p>`;
    this.querySelector("[data-project-type]").onchange = () =>
      this.renderOptions();
    this.querySelector("[data-review]").onclick = () => this.preview();
    this.querySelector("[data-approve]").onchange = () => {
      this.querySelector("[data-create]").disabled = !this.canCreate();
    };
    this.querySelector("[data-create]").onclick = () => {
      if (!this.canCreate()) return;
      this.dispatchEvent(
        new CustomEvent("documentation-suite-create", {
          bubbles: true,
          detail: {
            snapshot: this.snapshot,
            plan: structuredClone(this.plan),
          },
        }),
      );
    };
    this.renderOptions();
  }
  renderOptions() {
    const type = this.querySelector("[data-project-type]").value;
    const options = documentationSuiteTemplates(type);
    this.querySelector("[data-options]").innerHTML = options
      .map(
        (item) =>
          `<section><label><input type="checkbox" data-document="${h(item.id)}"> ${h(item.title)} — <code>${h(item.path)}</code></label><p>${h(item.reason)}</p><label>${h(item.title)} starting Markdown<textarea data-source="${h(item.id)}" rows="4"></textarea></label></section>`,
      )
      .join("");
    for (const item of options)
      this.querySelector(`[data-source="${item.id}"]`).value = item.markdown;
    this.querySelectorAll("[data-document]").forEach((choice) => {
      choice.onchange = () => {
        this.invalidate();
        this.updateReviewAvailability();
      };
    });
    this.querySelectorAll("[data-source]").forEach((source) => {
      source.oninput = () => this.invalidate();
    });
    this.invalidate();
    this.updateReviewAvailability();
  }
  selection() {
    return [...this.querySelectorAll("[data-document]:checked")].map(
      (choice) => ({
        id: choice.dataset.document,
        markdown: this.querySelector(
          `[data-source="${choice.dataset.document}"]`,
        ).value,
      }),
    );
  }
  updateReviewAvailability() {
    const count = this.selection().length;
    this.querySelector("[data-review]").disabled =
      !count || count > this.availableSlots;
  }
  invalidate() {
    this.plan = null;
    this.signature = "";
    this.querySelector("[data-exact]").hidden = true;
    this.querySelector("[data-approve]").checked = false;
    this.querySelector("[data-create]").disabled = true;
  }
  preview() {
    this.invalidate();
    const selected = this.selection();
    if (!selected.length) return;
    if (selected.length > this.availableSlots) {
      this.querySelector("[data-status]").textContent =
        "The workspace does not have room for every selected document.";
      return;
    }
    if (selected.some((item) => !item.markdown.trim())) {
      this.querySelector("[data-status]").textContent =
        "Each selected document needs starting Markdown.";
      return;
    }
    const manifest = createDocumentationSuite(
      this.querySelector("[data-project-type]").value,
      selected.map((item) => item.id),
    );
    const markdown = new Map(selected.map((item) => [item.id, item.markdown]));
    manifest.documents = manifest.documents.map((item) => ({
      ...item,
      markdown: markdown.get(item.id),
    }));
    this.plan = manifest;
    this.signature = JSON.stringify(selected);
    this.querySelector("[data-files]").innerHTML = manifest.documents
      .map(
        (item) =>
          `<article><h3>${h(item.path)}</h3><pre>${h(item.markdown)}</pre></article>`,
      )
      .join("");
    this.querySelector("[data-exact]").hidden = false;
    this.querySelector("[data-status]").textContent =
      `${manifest.documents.length} local document${manifest.documents.length === 1 ? "" : "s"} ready for review. Nothing has been created.`;
    this.querySelector("#suite-review-heading").focus();
  }
  canCreate() {
    return (
      !!this.plan &&
      this.signature === JSON.stringify(this.selection()) &&
      this.querySelector("[data-approve]").checked
    );
  }
}

customElements.define("documentation-suite", DocumentationSuite);
