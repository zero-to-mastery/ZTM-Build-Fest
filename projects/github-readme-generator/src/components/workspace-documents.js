import { html } from "../markdown/serialize.js";
import {
  documentGroups,
  documentGroup,
  documentTarget,
  documentSettings,
} from "../workspace/documents.js";
import {
  languages,
  localizationFor,
  localizationSettings,
} from "../localization/model.js";

export class WorkspaceDocuments extends HTMLElement {
  configure(drafts, active) {
    this.drafts = drafts;
    this.active = active;
    const current = drafts.find((draft) => draft.id === active);
    const destination = documentTarget(current);
    const localized = localizationFor(current);
    this.innerHTML = `<h1>Workspace documents</h1><p>Each document keeps its own source, GitHub target and Health analysis. Undo history survives switching within this tab, subject to memory limits. Download all drafts backup to keep recoverable sources.</p>
      <label>Find document<input data-search type="search"></label><div data-documents></div>
      <h2>Current document settings</h2><p>${html(current.name)}</p>
      <label>Document group<select data-kind>${Object.entries(documentGroups)
        .map(([id, label]) => `<option value="${id}">${label}</option>`)
        .join("")}</select></label>
      <label>Document repository<input data-repository placeholder="owner/repository"></label>
      <label>Document branch<input data-branch placeholder="main"></label>
      <label>Document README path<input data-path value="README.md"></label>
      <label>Document language<select data-locale><option value="">Not set</option>${languages.map(([id, label]) => `<option value="${id}">${html(label)}</option>`).join("")}</select></label>
      <label>Translation source<select data-source-document><option value="">This is the source edition</option>${drafts
        .filter(
          (draft) =>
            draft.id !== active && !localizationFor(draft)?.sourceDocumentId,
        )
        .map(
          (draft) =>
            `<option value="${html(draft.id)}">${html(draft.name)}</option>`,
        )
        .join("")}</select></label>
      <p>Language metadata is local and keeps an exact source-revision snapshot for manual translation review. Every GitHub edition still needs its own explicit path.</p>
      <p>Target settings are local suggestions. They do not fetch or publish anything; publishing still requires review. Local documents have no GitHub target.</p>
      <button data-save>Save document settings</button><button data-evidence>Evidence snapshots</button><button data-links>Check document links</button><button data-new>New document</button><button data-suite>Create documentation suite</button><p data-status role="status"></p>`;
    this.querySelector("[data-kind]").value = documentGroup(current);
    for (const field of ["repository", "branch", "path"])
      this.querySelector(`[data-${field}]`).value =
        destination?.[field] || (field === "path" ? "README.md" : "");
    this.querySelector("[data-locale]").value = localized?.locale || "";
    this.querySelector("[data-source-document]").value =
      localized?.sourceDocumentId || "";
    const fields = () => {
      for (const field of ["repository", "branch", "path"])
        this.querySelector(`[data-${field}]`).disabled =
          this.querySelector("[data-kind]").value === "local";
      this.querySelector("[data-source-document]").disabled =
        !this.querySelector("[data-locale]").value;
    };
    fields();
    this.querySelector("[data-kind]").onchange = fields;
    this.querySelector("[data-locale]").onchange = fields;
    this.querySelector("[data-search]").oninput = () => this.list();
    this.querySelector("[data-new]").onclick = () => this.send("document-new");
    this.querySelector("[data-suite]").onclick = () =>
      this.send("document-suite");
    this.querySelector("[data-links]").onclick = () =>
      this.send("document-links");
    this.querySelector("[data-evidence]").onclick = () =>
      this.send("document-evidence");
    this.querySelector("[data-save]").onclick = () => {
      try {
        const locale = this.querySelector("[data-locale]").value;
        const sourceDocumentId = this.querySelector(
          "[data-source-document]",
        ).value;
        const sourceDraft = sourceDocumentId
          ? drafts.find((draft) => draft.id === sourceDocumentId)
          : null;
        if (sourceDocumentId && !sourceDraft)
          throw Error("Choose an available source document.");
        const unchangedLocalization =
          localized?.locale === locale &&
          (localized?.sourceDocumentId || "") === sourceDocumentId;
        const localization = locale
          ? unchangedLocalization
            ? localized
            : localizationSettings(locale, sourceDraft, current.markdown)
          : null;
        const settings = documentSettings(
          this.querySelector("[data-kind]").value,
          Object.fromEntries(
            ["repository", "branch", "path"].map((field) => [
              field,
              this.querySelector(`[data-${field}]`).value.trim(),
            ]),
          ),
          localization,
        );
        this.send("document-settings", { id: active, settings });
      } catch (error) {
        this.querySelector("[data-status]").textContent = error.message;
      }
    };
    this.list();
  }
  send(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  }
  list() {
    const query = this.querySelector("[data-search]")
      .value.toLowerCase()
      .trim();
    this.querySelector("[data-documents]").innerHTML =
      Object.entries(documentGroups)
        .map(([group, label]) => {
          const documents = this.drafts.filter(
            (draft) =>
              documentGroup(draft) === group &&
              `${draft.name} ${JSON.stringify(documentTarget(draft))}`
                .toLowerCase()
                .includes(query),
          );
          return documents.length
            ? `<section><h2>${label}</h2><ul>${documents
                .map((draft) => {
                  const destination = documentTarget(draft);
                  const localization = localizationFor(draft);
                  return `<li><button data-document="${html(draft.id)}" ${draft.id === this.active ? 'aria-current="true"' : ""}>${html(draft.name)}${localization ? ` — ${html(localization.locale)}` : ""}${destination ? ` — ${html(destination.repository)}/${html(destination.path)} (${html(destination.branch)})` : ""}${draft.id === this.active ? " · Current" : ""}</button></li>`;
                })
                .join("")}</ul></section>`
            : "";
        })
        .join("") || "<p>No matching documents.</p>";
    this.querySelectorAll("[data-document]").forEach(
      (button) =>
        (button.onclick = () =>
          this.send("document-open", button.dataset.document)),
    );
  }
}
customElements.define("workspace-documents", WorkspaceDocuments);
