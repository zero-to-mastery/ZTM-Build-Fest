class KinAreas extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.isDisabled = false;
    this.createDraft = "";
    this.renameDraft = null;
  }

  set areas(value) {
    const records = Array.isArray(value) ? value : [];
    if (records === this.records) return; // unchanged projection section
    const renamedArea = this.renameDraft
      ? records.find((area) => area.areaId === this.renameDraft.areaId && !area.archived)
      : null;
    if (this.renameDraft && !renamedArea) this.renameDraft = null;
    else if (renamedArea && renamedArea.name === this.renameDraft.value) {
      this.renameDraft.baseName = renamedArea.name;
      this.renameDraft.conflictName = null;
    } else if (renamedArea)
      this.renameDraft.conflictName = renamedArea.name === this.renameDraft.baseName ? null : renamedArea.name;
    this.records = records;
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button, input"))
      control.disabled = this.isDisabled || control.hasAttribute("data-gated");
    if (!this.isDisabled) this.settleDeferredFocus();
  }

  settleDeferredFocus() {
    const target = this.deferredFocus;
    this.deferredFocus = null;
    const active = document.activeElement;
    const focusWasLost = !active || active === document.body || active.isConnected === false;
    if (target?.isConnected && !target.matches(":disabled") && focusWasLost) target.focus();
  }

  render(focusId = null) {
    const priorFocus = this.pendingFocus ?? (this.contains(document.activeElement)
      ? document.activeElement.dataset.focusId ?? (document.activeElement.id === "area-create-name" ? "create-area" : null)
      : focusId);
    this.pendingFocus = null;
    const section = document.createElement("section");
    section.className = "area-section card";
    const heading = document.createElement("h2");
    heading.textContent = "Areas";
    heading.tabIndex = -1;
    heading.dataset.focusId = "area-heading";
    const intro = document.createElement("p");
    intro.textContent = "Areas help keep household things together.";
    section.append(heading, intro);

    const form = document.createElement("form");
    form.className = "area-create-form";
    const label = document.createElement("label");
    label.htmlFor = "area-create-name";
    label.textContent = "New Area";
    const input = document.createElement("input");
    input.id = "area-create-name";
    input.dataset.focusId = "create-area";
    input.name = "name";
    input.maxLength = 96;
    input.autocomplete = "off";
    input.required = true;
    input.value = this.createDraft;
    input.addEventListener("input", () => { this.createDraft = input.value; });
    input.setAttribute("aria-describedby", "area-create-name-help area-create-name-error");
    const help = document.createElement("small");
    help.id = "area-create-name-help";
    help.textContent = "Up to 48 characters.";
    const error = this.makeNameError("area-create-name-error");
    const add = document.createElement("button");
    add.type = "submit";
    add.textContent = "Add Area";
    form.append(label, input, help, error, add);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submitName(input, error, "create-area", {}, help);
    });
    section.append(form);

    const active = this.records.filter((area) => !area.archived);
    const archived = this.records.filter((area) => area.archived);
    if (!this.records.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No Areas yet. You can add one whenever it helps.";
      section.append(empty);
    }
    if (active.length) section.append(this.makeList(active, false));
    if (archived.length) {
      const archivedHeading = document.createElement("h3");
      archivedHeading.textContent = "Archived Areas";
      section.append(archivedHeading, this.makeList(archived, true));
    }
    this.replaceChildren(section);
    this.disabled = this.isDisabled;
    if (priorFocus) {
      const target = [...this.querySelectorAll("[data-focus-id]")].find((node) => node.dataset.focusId === priorFocus);
      if (target?.matches(":disabled")) this.deferredFocus = target;
      else target?.focus();
    }
  }

  makeList(records, archived) {
    const list = document.createElement("ul");
    list.className = "area-list";
    for (const area of records) {
      const row = document.createElement("li");
      row.className = "area-row";
      if (!archived && this.renameDraft?.areaId === area.areaId) {
        row.append(this.makeEditForm(area));
        list.append(row);
        continue;
      }
      const name = document.createElement("span");
      name.className = "area-name";
      name.textContent = this.displayName(area);
      row.append(name);
      if (!archived) {
        const rename = document.createElement("button");
        rename.type = "button";
        rename.textContent = "Rename";
        rename.setAttribute("aria-label", `Rename ${area.name}`);
        rename.dataset.focusId = `rename-${area.areaId}`;
        rename.addEventListener("click", () => this.editName(row, area));
        const archive = document.createElement("button");
        archive.type = "button";
        archive.className = "archive-button";
        archive.textContent = "Archive";
        archive.setAttribute("aria-label", `Archive ${area.name}`);
        archive.dataset.focusId = `archive-${area.areaId}`;
        archive.addEventListener("click", () => this.confirmArchive(row, area));
        row.append(rename, archive);
      } else {
        const label = document.createElement("span");
        label.className = "area-archived-label";
        label.textContent = "Archived";
        row.append(label);
      }
      list.append(row);
    }
    return list;
  }

  displayName(area) {
    const duplicates = this.records.filter((candidate) => candidate.name.toLowerCase() === area.name.toLowerCase());
    return duplicates.length > 1 ? `${area.name} · ${area.areaId.slice(-4)}` : area.name;
  }

  editName(row, area) {
    this.renameDraft = {
      areaId: area.areaId,
      baseName: area.name,
      value: area.name,
      conflictName: null,
    };
    row.replaceChildren(this.makeEditForm(area));
    const input = row.querySelector("input");
    input.focus();
    input.select();
  }

  makeEditForm(area) {
    const form = document.createElement("form");
    form.className = "area-edit-form";
    const label = document.createElement("label");
    const inputId = `area-rename-name-${area.areaId}`;
    const helpId = `area-rename-name-help-${area.areaId}`;
    const errorId = `area-rename-name-error-${area.areaId}`;
    label.htmlFor = inputId;
    label.textContent = `Rename ${area.name}`;
    const input = document.createElement("input");
    input.id = inputId;
    input.dataset.focusId = `rename-input-${area.areaId}`;
    input.name = "name";
    input.value = this.renameDraft.value;
    input.maxLength = 96;
    input.required = true;
    input.setAttribute("aria-describedby", `${helpId} ${errorId}`);
    input.addEventListener("input", () => { this.renameDraft.value = input.value; });
    const help = document.createElement("small");
    help.id = helpId;
    help.textContent = "Up to 48 characters.";
    const error = this.makeNameError(errorId);
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save name";
    let conflict = null;
    if (this.renameDraft.conflictName) {
      conflict = document.createElement("div");
      conflict.className = "area-rename-conflict";
      conflict.setAttribute("role", "alert");
      const message = document.createElement("p");
      message.textContent = `This Area was renamed to ${this.renameDraft.conflictName} on another device.`;
      const keep = document.createElement("button");
      keep.type = "button";
      keep.textContent = "Keep my draft";
      keep.addEventListener("click", () => {
        this.renameDraft.baseName = area.name;
        this.renameDraft.conflictName = null;
        this.render(`rename-input-${area.areaId}`);
      });
      const useLatest = document.createElement("button");
      useLatest.type = "button";
      useLatest.textContent = "Use latest name";
      useLatest.addEventListener("click", () => {
        this.renameDraft.baseName = area.name;
        this.renameDraft.value = area.name;
        this.renameDraft.conflictName = null;
        this.render(`rename-input-${area.areaId}`);
      });
      conflict.append(message, keep, useLatest);
      save.setAttribute("data-gated", "");
      save.disabled = true;
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      this.renameDraft = null;
      this.render(`rename-${area.areaId}`);
    });
    form.append(label, input, help, error);
    if (conflict) form.append(conflict);
    form.append(save, cancel);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.renameDraft.value = input.value;
      if (this.renameDraft.conflictName) return;
      this.submitName(input, error, "rename-area", { areaId: area.areaId }, help);
    });
    return form;
  }

  makeNameError(id) {
    const error = document.createElement("small");
    error.id = id;
    error.className = "area-name-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    return error;
  }

  submitName(input, error, action, detail, help) {
    const result = validateAreaName(input.value);
    if (result.error) {
      error.textContent = result.error;
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", `${help.id} ${error.id}`);
      return;
    }
    input.value = result.value;
    if (action === "create-area") this.createDraft = result.value;
    if (action === "rename-area" && this.renameDraft) this.renameDraft.value = result.value;
    input.removeAttribute("aria-invalid");
    error.hidden = true;
    this.dispatch(action, { ...detail, name: result.value });
  }

  saved(action, detail) {
    if (action === "create-area") {
      this.createDraft = "";
      const input = this.querySelector("#area-create-name");
      if (input) input.value = "";
    }
    if (action === "rename-area" && this.renameDraft?.areaId === detail.areaId)
      this.renameDraft = null;
  }

  confirmArchive(row, area) {
    const prompt = document.createElement("div");
    prompt.className = "area-confirm";
    prompt.setAttribute("role", "group");
    prompt.setAttribute("aria-label", `Archive ${area.name}`);
    const text = document.createElement("span");
    text.textContent = `Keep existing links to ${area.name} for household history?`;
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "Archive Area";
    confirm.addEventListener("click", () => this.dispatch("archive-area", { areaId: area.areaId }));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.render(`archive-${area.areaId}`));
    prompt.append(text, confirm, cancel);
    row.replaceChildren(prompt);
    confirm.focus();
  }

  dispatch(action, detail) {
    this.pendingFocus = action === "rename-area" ? `rename-${detail.areaId}`
      : action === "create-area" ? "create-area" : "area-heading";
    this.dispatchEvent(new CustomEvent("kin:area-intent", {
      detail: { action, ...detail }, bubbles: true, composed: true,
    }));
  }

  focus() { this.querySelector("h2")?.focus(); }
}

function validateAreaName(raw) {
  const value = raw.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");
  if (!value) return { value, error: "Enter an Area name." };
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value))
    return { value, error: "Area names can't contain control characters." };
  if (Array.from(value).length > 48) return { value, error: "Area names can be up to 48 characters." };
  if (new TextEncoder().encode(value).length > 96) return { value, error: "This Area name is too long." };
  return { value, error: null };
}

customElements.define("kin-areas", KinAreas);
