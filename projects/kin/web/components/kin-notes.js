import "./kin-attachments.js";
import { NotesSection } from "./notes/notes.js";
import { ReferenceSection } from "./notes/references.js";

// The notes element's parts (./notes/), built once per element with one shared
// context { host, ...parts }; each part reaches the element as `this.host`.
const PARTS = {
  notes: NotesSection,
  references: ReferenceSection,
};

class KinNotes extends HTMLElement {
  constructor() {
    super();
    this.ctx = { host: this };
    for (const [key, Part] of Object.entries(PARTS)) this.ctx[key] = new Part(this.ctx);
    this.records = [];
    this.referenceRecords = [];
    this.areaRecords = [];
    this.maintenanceEvents = [];
    this.attachmentRecords = [];
    this.routineRecords = [];
    this.disabledState = false;
    this.editor = { noteId: null, title: "", body: "", areaId: "" };
    this.referenceEditor = null;
    this.maintenanceDrafts = new Map();
    this.pendingFocus = null;
    this.instanceId = `notes-${++KinNotes.instances}`;
  }

  // Stores `value` in `field` and renders, unless it is the current value:
  // the projection reuses unchanged sections, so most refreshes change none.
  assign(field, value) {
    if (this[field] === value) return;
    this[field] = value;
    this.render();
  }

  set notes(value) { this.assign("records", Array.isArray(value) ? value : []); }

  set references(value) { this.assign("referenceRecords", Array.isArray(value) ? value : []); }

  set areas(value) { this.assign("areaRecords", Array.isArray(value) ? value : []); }

  set maintenance(value) { this.assign("maintenanceEvents", Array.isArray(value) ? value : []); }

  set attachments(value) { this.assign("attachmentRecords", Array.isArray(value) ? value : []); }

  set previews(provider) { this.assign("previewProvider", typeof provider === "function" ? provider : null); }

  set routines(value) { this.assign("routineRecords", Array.isArray(value) ? value : []); }

  set disabled(value) { this.disabledState = Boolean(value); this.render(); }

  render() {
    const focused = this.pendingFocus ?? (this.contains(document.activeElement)
      ? document.activeElement.dataset.focusId
      : null);
    this.pendingFocus = null;
    const id = (name) => `${this.instanceId}-${name}`;
    const section = document.createElement("section");
    section.className = "notes-section card";
    const heading = document.createElement("h2");
    heading.textContent = "Notes";
    heading.tabIndex = -1;
    heading.dataset.focusId = "heading";
    section.append(heading);

    this.ctx.notes.renderNotes(section, id);
    section.append(this.ctx.references.renderReferences(id));
    this.replaceChildren(section);
    for (const control of this.querySelectorAll("button,input,textarea,select")) control.disabled = this.disabledState;
    const candidate = focused && [...this.querySelectorAll("[data-focus-id]")]
      .find((node) => node.dataset.focusId === focused);
    if (candidate?.matches(":disabled")) this.pendingFocus = focused;
    else candidate?.focus();
  }

  settleDeferredFocus() {
    if (!this.pendingFocus) return;
    const candidate = [...this.querySelectorAll("[data-focus-id]")]
      .find((node) => node.dataset.focusId === this.pendingFocus);
    if (candidate && !candidate.matches(":disabled")) {
      this.pendingFocus = null;
      const active = document.activeElement;
      const focusWasLost = !active || active === document.body || active.isConnected === false;
      if (focusWasLost) candidate.focus();
    }
  }

  showFieldError(control, error, message) {
    if (message) {
      error.textContent = message;
      error.hidden = false;
      control.setAttribute("aria-invalid", "true");
    } else {
      error.textContent = "";
      error.hidden = true;
      control.removeAttribute("aria-invalid");
    }
  }

  makeAttachmentControl(kind, parentId, label) {
    const control = document.createElement("kin-attachments");
    control.previews = this.previewProvider ?? null;
    control.parentRecord = { kind, id: parentId, label };
    control.attachments = this.attachmentRecords;
    return control;
  }

  clearEditor() {
    this.editor = { noteId: null, title: "", body: "", areaId: "" };
  }

  clearReferenceEditor() {
    this.referenceEditor = null;
  }

  maintenanceDraft(recordId) {
    return this.maintenanceDrafts.get(recordId) ?? {
      summary: "",
      performed: "",
      nextOn: "",
      routineId: "",
    };
  }

  updateMaintenanceDraft(recordId, value) {
    this.maintenanceDrafts.set(recordId, { ...value });
  }

  clearMaintenanceDraft(detail) {
    const draft = this.maintenanceDrafts.get(detail.recordId);
    if (!draft) return;
    const numericDate = (value) => value ? Number(value.replaceAll("-", "")) : null;
    if (draft.summary.trim() !== detail.summary
      || numericDate(draft.performed) !== detail.performedOn
      || numericDate(draft.nextOn) !== detail.nextOn
      || (draft.routineId || null) !== detail.routineId) return;
    this.maintenanceDrafts.delete(detail.recordId);
  }

  dispatch(action, detail) {
    this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true }));
  }

  makeError(id) {
    const error = document.createElement("small");
    error.id = id;
    error.setAttribute("role", "alert");
    error.hidden = true;
    return error;
  }

  static validateText(rawTitle, body) {
    const title = rawTitle.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");
    const bytes = (value) => new TextEncoder().encode(value).length;
    if (!title) return { title, body, field: "title", error: "Enter a title." };
    if (Array.from(title).some((character) => /\p{Cc}/u.test(character))) return { title, body, field: "title", error: "Titles can't contain control characters." };
    if (Array.from(title).length > 80) return { title, body, field: "title", error: "Titles can be up to 80 characters." };
    if (bytes(title) > 256) return { title, body, field: "title", error: "That title is too long. Shorten it a little." };
    if (bytes(body) > 4096) return { title, body, field: "body", error: "That note is too long. Roughly 4,000 characters fit." };
    if (Array.from(body).some((character) => /\p{Cc}/u.test(character) && !"\n\r\t".includes(character))) return { title, body, field: "body", error: "Note bodies can contain line breaks and tabs, but no other control characters." };
    return { title, body, field: null, error: null };
  }
}
KinNotes.instances = 0;
customElements.define("kin-notes", KinNotes);
