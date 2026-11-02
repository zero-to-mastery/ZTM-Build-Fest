// For the sitter (#441, #445, ADR 0017): where an Adult builds the page a
// Temporary member lands on. A short intro, then a choice of existing notes,
// reference records and routines, in an order that can be changed. Save sends
// the whole page (`kin:save-sitter-page`); nothing is copied, so editing a
// note later updates the page.
import "./kin-sitter-page.js";

const KINDS = [["note", "Notes"], ["reference-record", "Contacts and reference"], ["routine", "Routines"]];
const MAX_ENTRIES = 30;

class KinSitterEditor extends HTMLElement {
  constructor() {
    super();
    this.page = null;
    this.state = null;
    this.drafts = null;
    this.canEdit = true;
    this.isDisabled = false;
  }

  connectedCallback() {
    if (this.form) return;
    const heading = document.createElement("h2");
    heading.textContent = "For the sitter";
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = "Choose what a babysitter, carer or guest sees first when they open Kin: emergency contacts, the children's routines, house notes. It shows the live records, and it ends when their access does. It isn't a lock: while their access lasts, their device can read the household.";
    this.form = document.createElement("div");
    this.form.className = "sitter-editor";
    const introLabel = document.createElement("label");
    introLabel.htmlFor = "sitter-intro";
    introLabel.textContent = "A short welcome (optional)";
    this.intro = document.createElement("textarea");
    this.intro.id = "sitter-intro";
    this.intro.rows = 3;
    this.intro.maxLength = 500;
    this.intro.addEventListener("input", () => { this.drafts.intro = this.intro.value; });
    this.chosenHeading = document.createElement("h3");
    this.chosenHeading.textContent = "On the page";
    this.chosen = document.createElement("ol");
    this.chosen.className = "sitter-chosen";
    this.chosen.setAttribute("aria-labelledby", "sitter-chosen-heading");
    this.chosenHeading.id = "sitter-chosen-heading";
    this.available = document.createElement("div");
    this.available.className = "sitter-available";
    this.message = document.createElement("p");
    this.message.className = "compose-message";
    this.message.setAttribute("role", "alert");
    this.save = document.createElement("button");
    this.save.type = "button";
    this.save.className = "primary-action";
    this.save.textContent = "Save the sitter page";
    this.save.addEventListener("click", () => this.submit());
    this.previewLink = document.createElement("a");
    this.previewLink.href = "#foryou";
    this.previewLink.className = "sitter-preview-link";
    this.previewLink.textContent = "See it as the sitter does";
    this.readOnly = document.createElement("p");
    this.readOnly.className = "section-hint";
    this.readOnly.textContent = "Only Adults can change the sitter page.";
    this.form.append(introLabel, this.intro, this.chosenHeading, this.chosen, this.available, this.message, this.save, this.previewLink);
    this.append(heading, hint, this.readOnly, this.form);
    this.render();
  }

  /** `{ page, state, canEdit }`. Drafts are kept while the member edits. */
  update({ page, state, canEdit = true }) {
    const reset = !this.drafts || (!this.dirty && JSON.stringify(page) !== JSON.stringify(this.page));
    this.page = page;
    this.state = state;
    this.canEdit = canEdit;
    if (reset && page) this.resetDrafts();
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button, input, textarea")) control.disabled = this.isDisabled || !this.canEdit;
  }

  resetDrafts() {
    this.drafts = { intro: this.page?.intro ?? "", entries: (this.page?.entries ?? []).map((entry) => ({ ...entry })) };
    this.dirty = false;
  }

  candidates() {
    const state = this.state ?? {};
    return {
      note: (state.notes ?? []).filter((note) => !note.archived).map((note) => ({ id: note.noteId, label: note.title })),
      "reference-record": (state.referenceRecords ?? []).filter((record) => !record.archived).map((record) => ({ id: record.recordId, label: record.title })),
      routine: (state.routines ?? []).filter((routine) => routine.status !== "archived").map((routine) => ({ id: routine.routineId, label: routine.text })),
    };
  }

  labelFor(entry) {
    return this.candidates()[entry.kind]?.find((candidate) => candidate.id === entry.id)?.label ?? null;
  }

  render() {
    if (!this.form) return;
    this.readOnly.hidden = this.canEdit;
    this.form.hidden = !this.canEdit;
    if (!this.drafts) return;
    if (document.activeElement !== this.intro) this.intro.value = this.drafts.intro;
    const focusKey = this.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const entries = this.drafts.entries.filter((entry) => this.labelFor(entry));
    this.chosen.replaceChildren(...entries.map((entry, index) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.className = "sitter-chosen-label";
      label.textContent = this.labelFor(entry);
      const button = (text, aria, key, onClick, disabled = false) => {
        const control = document.createElement("button");
        control.type = "button";
        control.textContent = text;
        control.setAttribute("aria-label", aria);
        control.dataset.key = `${key}:${entry.kind}:${entry.id}`;
        control.disabled = disabled || this.isDisabled;
        control.addEventListener("click", onClick);
        return control;
      };
      const move = (by) => () => {
        const at = this.drafts.entries.indexOf(entry);
        this.drafts.entries.splice(at, 1);
        this.drafts.entries.splice(at + by, 0, entry);
        this.dirty = true;
        this.render();
      };
      row.append(label,
        button("↑", `Move up: ${label.textContent}`, "up", move(-1), index === 0),
        button("↓", `Move down: ${label.textContent}`, "down", move(1), index === entries.length - 1),
        button("Remove", `Remove from the sitter page: ${label.textContent}`, "remove", () => {
          this.drafts.entries.splice(this.drafts.entries.indexOf(entry), 1);
          this.dirty = true;
          this.render();
        }));
      return row;
    }));
    if (!entries.length) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "Nothing yet. Add notes, contacts or routines below.";
      this.chosen.append(empty);
    }
    const candidates = this.candidates();
    this.available.replaceChildren(...KINDS.map(([kind, title]) => {
      const group = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = title;
      group.append(legend);
      if (!candidates[kind].length) {
        const none = document.createElement("p");
        none.className = "section-hint";
        none.textContent = kind === "routine" ? "No routines yet." : kind === "note" ? "No notes yet. Add them under Notes & reference." : "No reference records yet. Add contacts under Notes & reference.";
        group.append(none);
      }
      for (const candidate of candidates[kind]) {
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.key = `pick:${kind}:${candidate.id}`;
        box.checked = this.drafts.entries.some((entry) => entry.kind === kind && entry.id === candidate.id);
        box.disabled = this.isDisabled || (!box.checked && this.drafts.entries.length >= MAX_ENTRIES);
        box.addEventListener("change", () => {
          if (box.checked) this.drafts.entries.push({ kind, id: candidate.id });
          else this.drafts.entries = this.drafts.entries.filter((entry) => !(entry.kind === kind && entry.id === candidate.id));
          this.dirty = true;
          this.render();
        });
        label.append(box, ` ${candidate.label}`);
        group.append(label);
      }
      return group;
    }));
    if (focusKey) [...this.querySelectorAll("[data-key]")].find((node) => node.dataset.key === focusKey && !node.disabled)?.focus({ preventScroll: true });
  }

  submit() {
    const entries = this.drafts.entries.filter((entry) => this.labelFor(entry)).map(({ kind, id }) => ({ kind, id }));
    this.message.textContent = "";
    this.save.disabled = true;
    this.dispatchEvent(new CustomEvent("kin:save-sitter-page", {
      bubbles: true, composed: true,
      detail: {
        intro: this.drafts.intro.trim(),
        entries,
        done: (outcome) => {
          this.save.disabled = this.isDisabled;
          if (outcome?.ok) { this.dirty = false; this.message.textContent = ""; }
          else this.message.textContent = outcome?.message ?? "Kin couldn't save the sitter page. Try again.";
        },
      },
    }));
  }
}

if (!customElements.get("kin-sitter-editor")) customElements.define("kin-sitter-editor", KinSitterEditor);
