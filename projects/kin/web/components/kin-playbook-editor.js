import { validatePlaybook } from "../household-validation.js";

// The form that creates or edits a reusable checklist (Playbook): a name and
// one step per line, validated in place with an error per field.
//
// <kin-routines> owns one, opens and closes it, and fills it to edit an
// existing checklist. A valid submit dispatches the household command
// `kin:save-playbook` ({ playbookId, title, entries }; playbookId is null
// for a new checklist). Cancel is reported to <kin-routines> as a
// non-bubbling "playbook-editor-cancel" event.
//
// Its controls are public fields (`editor.titleInput`, `editor.entriesInput`,
// ...; `title` would shadow HTMLElement's own property);
// <kin-routines> re-exposes them under their older names for the scripts.

class KinPlaybookEditor extends HTMLElement {
  constructor() {
    super();
    this.isDisabled = false;
    // The checklist being edited, or null for a new one.
    this.editingId = null;
  }

  // Builds the form once (an element may not add children in its
  // constructor). `idPrefix` keeps ids unique per <kin-routines>.
  setup(idPrefix) {
    const form = document.createElement("form");
    form.className = "compose-form playbook-form";
    form.id = `${idPrefix}-playbook-editor`;
    form.noValidate = true;
    form.hidden = true;
    this.form = form;
    const titleId = `${idPrefix}-playbook-title`;
    const titleLabel = document.createElement("label"); titleLabel.htmlFor = titleId; titleLabel.textContent = "Checklist name";
    this.titleInput = document.createElement("input"); this.titleInput.id = titleId; this.titleInput.placeholder = "For example: Leaving for a trip";
    this.titleError = document.createElement("small"); this.titleError.id = `${idPrefix}-playbook-title-error`; this.titleError.setAttribute("role", "alert"); this.titleError.hidden = true; this.titleInput.setAttribute("aria-describedby", this.titleError.id);
    const entriesId = `${idPrefix}-playbook-entries`;
    const entriesLabel = document.createElement("label"); entriesLabel.htmlFor = entriesId; entriesLabel.textContent = "Steps (one per line)";
    this.entriesInput = document.createElement("textarea"); this.entriesInput.id = entriesId; this.entriesInput.rows = 4; this.entriesInput.placeholder = "One step per line";
    this.countError = document.createElement("small"); this.countError.id = `${idPrefix}-playbook-count-error`; this.countError.setAttribute("role", "alert"); this.countError.hidden = true;
    this.entryErrors = document.createElement("div"); this.entryErrors.className = "field-errors";
    this.entriesInput.setAttribute("aria-describedby", this.countError.id);
    this.save = document.createElement("button"); this.save.type = "submit"; this.save.className = "add-button"; this.save.textContent = "Save checklist";
    this.cancel = document.createElement("button"); this.cancel.type = "button"; this.cancel.textContent = "Cancel";
    this.cancel.addEventListener("click", () => this.dispatchEvent(new CustomEvent("playbook-editor-cancel")));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit(idPrefix);
    });
    const actions = document.createElement("div");
    actions.className = "form-actions";
    actions.append(this.save, this.cancel);
    form.append(titleLabel, this.titleInput, this.titleError, entriesLabel, this.entriesInput, this.countError, this.entryErrors, actions);
    this.append(form);
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of [this.titleInput, this.entriesInput, this.save, this.cancel]) if (control) control.disabled = this.isDisabled;
  }

  get hasDraft() {
    return Boolean(this.titleInput?.value.trim() || this.entriesInput?.value.trim());
  }

  // Fills the form to edit `record` (a projection Playbook).
  edit(record) {
    this.editingId = record.playbookId;
    this.titleInput.value = record.title;
    this.entriesInput.value = record.entries.join("\n");
    this.save.textContent = "Save changes";
  }

  // Empties the form and its errors, back to a new checklist.
  clear() {
    this.editingId = null;
    this.titleInput.value = "";
    this.entriesInput.value = "";
    this.save.textContent = "Save checklist";
    this.showError(this.titleInput, this.titleError, "");
    this.showError(this.entriesInput, this.countError, "");
    this.entryErrors.replaceChildren();
  }

  submit(idPrefix) {
    if (this.isDisabled) return;
    const result = validatePlaybook(this.titleInput.value, this.entriesInput.value.split(/\r?\n/));
    this.showError(this.titleInput, this.titleError, result.errors.title);
    this.showError(this.entriesInput, this.countError, result.errors.count);
    this.entryErrors.replaceChildren();
    const entryErrorIds = [];
    result.errors.entries.forEach((message, index) => {
      if (!message) return;
      const error = document.createElement("small");
      error.id = `${idPrefix}-playbook-entry-error-${index}`;
      error.setAttribute("role", "alert");
      error.textContent = `Step ${index + 1}: ${message}`;
      entryErrorIds.push(error.id);
      this.entryErrors.append(error);
    });
    this.entriesInput.setAttribute("aria-describedby", [this.countError.id, ...entryErrorIds].join(" "));
    if (entryErrorIds.length && !this.entriesInput.hasAttribute("aria-invalid")) this.entriesInput.setAttribute("aria-invalid", "true");
    if (!entryErrorIds.length && !result.errors.count) this.entriesInput.removeAttribute("aria-invalid");
    if (!result.valid) { (result.errors.title ? this.titleInput : this.entriesInput).focus(); return; }
    this.dispatchEvent(new CustomEvent("kin:save-playbook", {
      detail: { playbookId: this.editingId, title: result.title, entries: result.entries },
      bubbles: true, composed: true,
    }));
  }

  showError(control, messageNode, message) {
    messageNode.textContent = message;
    messageNode.hidden = !message;
    if (message) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
  }
}

customElements.define("kin-playbook-editor", KinPlaybookEditor);
