// The detail's sections below its heading: the checklist of Steps, files,
// planning date, responsibility, Area, reminder, quick access (pin) and
// archive, plus when the Item last changed.
// Part of <kin-item-detail>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-item-detail.js lists them).
import { localCivilDateOffset } from "../../browser-time.js";

const STEP_RULE = "Keep each step short: up to 80 characters, no line breaks.";

export function formatPlanningDate(value) {
  const year = Math.floor(value / 10000).toString().padStart(4, "0");
  const month = (Math.floor(value / 100) % 100).toString().padStart(2, "0");
  const day = (value % 100).toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class ItemDetailSections {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  group(titleText, hint = null) {
    const group = document.createElement("section");
    group.className = "item-detail-group";
    const heading = document.createElement("h3");
    heading.textContent = titleText;
    group.append(heading);
    if (hint) {
      const note = document.createElement("p");
      note.className = "item-detail-note";
      note.textContent = hint;
      group.append(note);
    }
    return group;
  }

  createChecklist(record, drafts) {
    const steps = Array.isArray(record.steps) ? record.steps : [];
    const live = steps.filter((step) => !step.archived);
    const done = live.filter((step) => step.completed).length;
    const group = this.group("Checklist", live.length ? `${done} of ${live.length} steps done.` : null);
    group.id = `checklist-${record.itemId}`;
    const list = document.createElement("ul");
    list.className = "step-list";
    for (const step of live) {
      const entry = document.createElement("li");
      entry.className = `step-row${this.host.highlightStepId === step.stepId ? " step-row-highlight" : ""}`;
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = step.completed;
      checkbox.id = `step-${record.itemId}-${step.stepId}`;
      checkbox.dataset.itemId = record.itemId;
      checkbox.dataset.stepId = step.stepId;
      checkbox.dataset.itemAction = "toggle-step";
      checkbox.dataset.focusId = `step-${step.stepId}`;
      checkbox.dataset.domainDisabled = String(record.status !== "active");
      checkbox.disabled = this.host.isDisabled || record.status !== "active";
      checkbox.addEventListener("change", () => this.host.dispatch(`${checkbox.checked ? "complete" : "reopen"}-item-step`, { itemId: record.itemId, stepId: step.stepId }));
      const text = document.createElement("span");
      text.textContent = step.text;
      label.htmlFor = checkbox.id;
      label.append(checkbox, text);
      const archive = this.host.button("Archive step", () => this.host.dispatch("archive-item-step", { itemId: record.itemId, stepId: step.stepId }), "step-archive-button");
      archive.setAttribute("aria-label", `Archive step ${step.text}`);
      archive.dataset.itemId = record.itemId;
      archive.dataset.stepId = step.stepId;
      archive.dataset.itemAction = "archive-item-step";
      archive.dataset.domainDisabled = String(record.status !== "active");
      archive.disabled = this.host.isDisabled || record.status !== "active";
      entry.append(label, archive);
      list.append(entry);
    }
    if (live.length) group.append(list);
    if (record.status !== "active") {
      const hint = document.createElement("p");
      hint.className = "step-parent-hint";
      hint.textContent = "Reopen this item before changing its steps.";
      group.append(hint);
    }
    const form = document.createElement("form");
    form.className = "step-compose";
    form.noValidate = true;
    const inputId = `add-step-${record.itemId}`;
    const label = document.createElement("label");
    label.htmlFor = inputId;
    label.textContent = live.length ? "Add another step" : "Add a step";
    const input = document.createElement("input");
    input.type = "text";
    input.id = inputId;
    input.required = true;
    input.autocomplete = "off";
    input.value = drafts.step ?? this.host.stepDrafts.get(record.itemId) ?? "";
    input.dataset.itemId = record.itemId;
    input.dataset.itemAction = "add-step";
    input.dataset.focusId = "add-step";
    input.dataset.domainDisabled = String(record.status !== "active" || steps.length >= 16);
    input.disabled = this.host.isDisabled || input.dataset.domainDisabled === "true";
    const message = document.createElement("p");
    message.className = "compose-message";
    message.id = `${inputId}-message`;
    message.setAttribute("aria-live", "polite");
    input.setAttribute("aria-describedby", message.id);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Add step";
    submit.disabled = input.disabled;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const textValue = input.value.trim();
      const invalid = !textValue || [...textValue].length > 80 || new TextEncoder().encode(textValue).length > 256 || [...textValue].some((character) => /\p{Cc}/u.test(character));
      message.textContent = invalid ? (textValue ? STEP_RULE : "Type a step first.") : "";
      if (invalid) { input.focus(); return; }
      this.host.dispatch("add-item-step", { itemId: record.itemId, text: textValue });
    });
    form.append(label, input, submit, message);
    this.host.stepInput = input;
    group.append(form);
    return group;
  }

  createAttachments(record) {
    const group = this.group("Photos & files", "Photos and PDFs are encrypted with the rest of the household record.");
    const tiles = document.createElement("kin-attachments");
    tiles.mode = "full";
    tiles.previews = this.host.previewProvider;
    tiles.parentRecord = { kind: "item", id: record.itemId, label: record.text, readonly: record.status === "archived" };
    tiles.attachments = this.host.attachmentRecords;
    group.append(tiles);
    return group;
  }

  createPlanning(record) {
    const group = this.group("Planned date", "Optional. A date puts the item on Today when the day comes.");
    const editor = document.createElement("div");
    editor.className = "item-planning-date";
    const label = document.createElement("label");
    label.className = "item-planning-date-field";
    label.textContent = "Date";
    const input = document.createElement("input");
    input.type = "date";
    input.className = "item-planning-date-input";
    input.setAttribute("aria-label", `Planned date for ${record.text}`);
    input.dataset.itemId = record.itemId;
    input.dataset.focusId = "planning-date";
    input.value = record.planningDate ? formatPlanningDate(record.planningDate) : "";
    input.addEventListener("change", () => this.host.dispatchPlanningDate(input.value ? Number(input.value.replaceAll("-", "")) : null));
    label.append(input);
    editor.append(label);
    for (const [labelText, offset] of [["Today", 0], ["Tomorrow", 1]]) {
      const shortcut = this.host.button(labelText, () => this.host.dispatchPlanningDate(localCivilDateOffset(offset)), "item-planning-date-shortcut");
      shortcut.setAttribute("aria-label", `Plan ${record.text} for ${labelText.toLowerCase()}`);
      shortcut.dataset.itemId = record.itemId;
      editor.append(shortcut);
    }
    if (record.planningDate) {
      const clear = this.host.button("Clear", () => this.host.dispatchPlanningDate(null), "item-planning-date-shortcut");
      clear.setAttribute("aria-label", `Clear planned date for ${record.text}`);
      clear.dataset.itemId = record.itemId;
      editor.append(clear);
    }
    group.append(editor);
    return group;
  }

  createResponsibility(record) {
    const group = this.group("Responsibility");
    const responsibility = document.createElement("kin-responsibility");
    responsibility.record = { targetKind: "item", targetId: record.itemId, text: record.text, ownerId: this.host.ownerContext.responsibilities?.find((entry) => entry.targetKind === "item" && entry.targetId === record.itemId)?.memberId ?? null, memberId: this.host.ownerContext.memberId ?? null, memberIds: this.host.ownerContext.memberIds ?? [], names: this.host.ownerContext.names ?? null };
    group.append(responsibility);
    return group;
  }

  /** Picture (#347): one emoji a child recognizes, shown large in Simple
   * view and small beside the text here; it never replaces the text. */
  createPicture(record) {
    const group = this.group("Picture", "An emoji shown large on a child's Simple view, beside the item's words.");
    const label = document.createElement("label");
    label.className = "item-picture-label";
    label.append(document.createTextNode("Emoji "));
    const input = document.createElement("input");
    input.type = "text";
    input.className = "item-picture-input";
    input.autocomplete = "off";
    input.maxLength = 32;
    input.value = this.host.emojiValue ?? "";
    input.setAttribute("aria-label", `Picture emoji for ${record.text}`);
    input.dataset.focusId = "picture";
    // One emoji: typing or picking another replaces it.
    input.addEventListener("input", () => {
      const value = input.value.trim();
      if (typeof Intl?.Segmenter !== "function" || !value) return;
      const last = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].at(-1)?.segment ?? "";
      if (last !== input.value) input.value = last;
    });
    label.append(input);
    const picker = document.createElement("kin-emoji-picker");
    picker.target = input;
    const save = this.host.button("Save picture", () => {
      const emoji = input.value.trim();
      if (!emoji) { input.focus(); return; }
      this.host.dispatch("set-item-emoji", { itemId: record.itemId, emoji });
    }, "item-picture-save");
    save.dataset.focusId = "picture-save";
    group.append(label, picker, save);
    if (this.host.emojiValue) {
      const clear = this.host.button("Remove picture", () => this.host.dispatch("set-item-emoji", { itemId: record.itemId, emoji: null }), "item-picture-clear");
      clear.setAttribute("aria-label", `Remove the picture from ${record.text}`);
      clear.dataset.focusId = "picture-clear";
      group.append(clear);
    }
    return group;
  }

  createArea(record) {
    const group = this.group("Area");
    const label = document.createElement("label");
    label.className = "item-area-label";
    label.append(document.createTextNode("Area"));
    const select = document.createElement("select");
    select.className = "item-area-select";
    select.setAttribute("aria-label", `Area for ${record.text}`);
    select.dataset.itemId = record.itemId;
    select.dataset.focusId = "area";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No area";
    select.append(none);
    for (const area of this.host.areas) {
      if (area.archived && area.areaId !== record.areaId) continue;
      const option = document.createElement("option");
      option.value = area.areaId;
      const duplicates = this.host.areas.filter((candidate) => candidate.name.toLowerCase() === area.name.toLowerCase());
      option.textContent = `${area.name}${duplicates.length > 1 ? ` · ${area.areaId.slice(-4)}` : ""}${area.archived ? " (archived)" : ""}`;
      select.append(option);
    }
    select.value = record.areaId ?? "";
    select.addEventListener("change", () => this.host.dispatch("change-item-area", { itemId: record.itemId, areaId: select.value || null }));
    label.append(select);
    group.append(label);
    return group;
  }

  createReminder(record) {
    // Synced reminders (#522) are the member's on every device.
    const group = this.group(customElements.get("kin-reminder")?.scope === "devices" ? "Reminder" : "Reminder on this device");
    // The control is kept across re-renders of the same item so an open
    // reminder editor (and its typed date/time) survives a background refresh.
    const id = `item:${record.itemId}`;
    const reminder = this.host.reminderControl?.targetRecord?.id === id ? this.host.reminderControl : document.createElement("kin-reminder");
    reminder.target = { id, title: record.text };
    if (this.host.reminderDrafts.has(record.itemId)) reminder.restoreDraftState(this.host.reminderDrafts.get(record.itemId));
    reminder.reminder = this.host.reminderRecord;
    if (reminder.hasDraft) this.host.reminderDrafts.set(record.itemId, reminder.getDraftState());
    reminder.disabled = this.host.isDisabled || record.status !== "active";
    this.host.reminderControl = reminder;
    group.append(reminder);
    return group;
  }

  createQuickAccess(record) {
    const group = this.group("Quick access", "Pinned items appear at the top of Today. A pin is a shortcut, not a deadline.");
    const pin = this.host.button(this.host.isPinned ? "Unpin" : "Pin to Today", () => this.host.dispatch("pin-intent", { targetKind: "item", targetId: record.itemId, pinned: !this.host.isPinned }), "pin-button");
    pin.setAttribute("aria-pressed", String(this.host.isPinned));
    pin.setAttribute("aria-label", `${this.host.isPinned ? "Unpin" : "Pin"} ${record.text}${!this.host.isPinned && this.host.pinLimitReached ? "; pin limit reached" : ""}`);
    pin.dataset.itemId = record.itemId;
    pin.dataset.itemAction = this.host.isPinned ? "unpin" : "pin";
    pin.dataset.focusId = "pin";
    pin.dataset.domainDisabled = String(!this.host.isPinned && this.host.pinLimitReached);
    pin.disabled = this.host.isDisabled || pin.dataset.domainDisabled === "true";
    group.append(pin);
    return group;
  }

  createArchive(record) {
    const group = this.group("History");
    group.append(this.lastChanged(record));
    const archive = this.host.button("Archive", () => this.host.dispatch("archive-item", { itemId: record.itemId }), "archive-button");
    archive.setAttribute("aria-label", `Archive ${record.text}`);
    archive.dataset.itemId = record.itemId;
    archive.dataset.itemAction = "archive";
    archive.dataset.focusId = "archive";
    const note = document.createElement("p");
    note.className = "item-detail-note";
    note.textContent = "Archiving keeps the record in household history but removes it from every list.";
    group.append(archive, note);
    // Just for me (#517): something this member added can move into their
    // private list; the household sees it archived, and Undo brings it back.
    if (this.host.makePrivateAllowed && record.status !== "archived") {
      const makePrivate = this.host.button("Make private", () => this.host.dispatch("make-item-private", { itemId: record.itemId }), "make-private-button");
      makePrivate.setAttribute("aria-label", `Make ${record.text} private`);
      makePrivate.dataset.itemId = record.itemId;
      makePrivate.dataset.itemAction = "make-private";
      makePrivate.dataset.focusId = "make-private";
      const privateNote = document.createElement("p");
      privateNote.className = "item-detail-note";
      privateNote.textContent = "Moves it to your Just for me list, where only you can see it. Your household sees it archived.";
      group.append(makePrivate, privateNote);
    }
    return group;
  }

  lastChanged(record) {
    const line = document.createElement("p");
    line.className = "item-last-changed";
    if (Number.isSafeInteger(record.lastChangedAt) && Number.isFinite(new Date(record.lastChangedAt).getTime())) {
      line.textContent = `Last changed ${new Date(record.lastChangedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
    } else line.textContent = "";
    return line;
  }
}
