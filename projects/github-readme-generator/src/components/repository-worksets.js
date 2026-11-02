import { html } from "../markdown/serialize.js";
import { documentTarget } from "../workspace/documents.js";
import {
  createWorksetPack,
  resolveWorkset,
  validateWorksetPack,
} from "../workspace/repository-worksets.js";

export class RepositoryWorksets extends HTMLElement {
  configure({ library, drafts }) {
    this.fileGeneration = (this.fileGeneration || 0) + 1;
    this.library = library;
    this.drafts = drafts;
    this.selected = library.items[0]?.id || null;
    this.innerHTML = `<h1>Repository worksets</h1>
      <p>Save an opt-in set of repositories for focused maintenance. Worksets are local metadata only: they never fetch, publish, or retain GitHub credentials.</p>
      <section aria-labelledby="workset-create"><h2 id="workset-create">New workset</h2>
        <label>Workset name<input data-name maxlength="80"></label>
        <fieldset><legend>Repositories in this workspace</legend><div data-repositories></div></fieldset>
        <label>Additional repositories <textarea data-additional rows="3" placeholder="owner/repository, one per line"></textarea></label>
        <p class="hint">Additional entries remain visible as missing locally until a matching document is added.</p>
        <button data-save class="primary">Save workset</button></section>
      <section aria-labelledby="workset-saved"><h2 id="workset-saved">Saved worksets</h2><div data-saved></div></section>
      <details><summary>Portable backup</summary>
        <p>Exports contain workset names and repository identifiers only. Review an imported file before adding it to this browser.</p>
        <button data-export>Download selected workset</button>
        <label>Workset file<input data-file type="file" accept="application/json,.json"></label>
        <label>Workset JSON<textarea data-json rows="5"></textarea></label>
        <button data-review>Review import</button><div data-import-review></div>
      </details><p data-status role="status"></p>`;
    this.drawRepositories();
    this.drawSaved();
    this.querySelector("[data-save]").onclick = () => this.save();
    this.querySelector("[data-export]").onclick = () => this.exportSelected();
    this.querySelector("[data-review]").onclick = () => this.reviewImport();
    this.querySelector("[data-json]").oninput = () => {
      this.fileGeneration++;
      this.querySelector("[data-import-review]").replaceChildren();
    };
    this.querySelector("[data-file]").onchange = async (event) => {
      const generation = ++this.fileGeneration;
      this.querySelector("[data-import-review]").replaceChildren();
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 250_000)
        return this.status("Workset file exceeds 250 KB.");
      try {
        const source = await file.text();
        if (generation !== this.fileGeneration || !this.isConnected) return;
        this.querySelector("[data-json]").value = source;
        this.reviewImport();
      } catch {
        if (generation !== this.fileGeneration || !this.isConnected) return;
        this.status("Could not read the workset file. Choose it again.");
      }
    };
  }
  status(message) {
    this.querySelector("[data-status]").textContent = message;
  }
  repositories() {
    return [
      ...new Set(
        this.drafts
          .map((draft) => documentTarget(draft)?.repository?.toLowerCase())
          .filter(Boolean),
      ),
    ].sort();
  }
  drawRepositories() {
    const repositories = this.repositories();
    this.querySelector("[data-repositories]").innerHTML = repositories.length
      ? repositories
          .map(
            (repository) =>
              `<label class="check"><input type="checkbox" data-repository value="${html(repository)}"> ${html(repository)}</label>`,
          )
          .join("")
      : "<p>No local document has a GitHub repository target yet.</p>";
  }
  save() {
    const selected = [
      ...this.querySelectorAll("[data-repository]:checked"),
    ].map((input) => input.value);
    const additional = this.querySelector("[data-additional]")
      .value.split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    this.send("workset-save", {
      name: this.querySelector("[data-name]").value,
      repositories: [...selected, ...additional],
    });
  }
  drawSaved() {
    const area = this.querySelector("[data-saved]");
    if (!this.library.items.length) {
      area.innerHTML = "<p>No saved worksets.</p>";
      this.querySelector("[data-export]").disabled = true;
      return;
    }
    if (!this.library.items.some((item) => item.id === this.selected))
      this.selected = this.library.items[0].id;
    const item = this.library.items.find(
      (candidate) => candidate.id === this.selected,
    );
    const resolved = resolveWorkset(item, this.drafts);
    area.innerHTML = `<label>Selected workset<select data-selected>${this.library.items
      .map(
        (candidate) =>
          `<option value="${html(candidate.id)}" ${candidate.id === item.id ? "selected" : ""}>${html(candidate.name)}</option>`,
      )
      .join("")}</select></label>
      <ul>${resolved
        .map(
          ({ repository, documents }) =>
            `<li><strong>${html(repository)}</strong>${
              documents.length
                ? `<ul>${documents
                    .map(
                      (draft) =>
                        `<li><button data-open="${html(draft.id)}">${html(draft.name)}</button></li>`,
                    )
                    .join("")}</ul>`
                : '<p class="issue">Missing locally — add or target a matching workspace document.</p>'
            }</li>`,
        )
        .join("")}</ul><button data-delete>Delete selected workset</button>`;
    this.querySelector("[data-selected]").onchange = (event) => {
      this.selected = event.target.value;
      this.drawSaved();
    };
    this.querySelectorAll("[data-open]").forEach(
      (button) =>
        (button.onclick = () => this.send("workset-open", button.dataset.open)),
    );
    this.querySelector("[data-delete]").onclick = (event) => {
      const button = event.currentTarget;
      const confirmation = document.createElement("div");
      confirmation.dataset.deleteConfirm = "";
      confirmation.innerHTML = `<p>Delete ${html(item.name)}? This removes only the saved workset; documents and Markdown stay unchanged.</p><button data-confirm-delete class="danger">Delete ${html(item.name)}</button><button data-cancel-delete>Keep workset</button>`;
      button.disabled = true;
      button.after(confirmation);
      const cancel = confirmation.querySelector("[data-cancel-delete]");
      cancel.onclick = () => {
        confirmation.remove();
        button.disabled = false;
        button.focus();
      };
      confirmation.querySelector("[data-confirm-delete]").onclick = () =>
        this.send("workset-delete", item.id);
      cancel.focus();
    };
    this.querySelector("[data-export]").disabled = false;
  }
  exportSelected() {
    try {
      const pack = createWorksetPack(this.library, [this.selected]);
      this.send("workset-export", pack);
    } catch (error) {
      this.status(error.message);
    }
  }
  reviewImport() {
    const review = this.querySelector("[data-import-review]");
    review.replaceChildren();
    try {
      const raw = this.querySelector("[data-json]").value;
      if (new TextEncoder().encode(raw).length > 250_000)
        throw Error("Workset file exceeds 250 KB.");
      const pack = JSON.parse(raw);
      const incoming = validateWorksetPack(pack);
      review.innerHTML = `<h3 tabindex="-1">Import review</h3><p>${incoming.items.length} workset(s), ${incoming.items.reduce((sum, item) => sum + item.repositories.length, 0)} repository references. Existing worksets will be kept; duplicate names receive a suffix.</p><ul>${incoming.items.map((item) => `<li>${html(item.name)} — ${html(item.repositories.join(", "))}</li>`).join("")}</ul><label class="check"><input data-confirm type="checkbox"> I reviewed these repository identifiers</label><button data-import class="primary">Import reviewed worksets</button>`;
      review.querySelector("h3").focus();
      review.querySelector("[data-import]").onclick = () => {
        if (!review.querySelector("[data-confirm]").checked)
          return this.status(
            "Confirm the reviewed repository identifiers first.",
          );
        this.send("workset-import", pack);
      };
      this.status("Import parsed. Review it before saving.");
    } catch (error) {
      this.status(`Could not review worksets: ${error.message}`);
    }
  }
  send(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }
}

customElements.define("repository-worksets", RepositoryWorksets);
