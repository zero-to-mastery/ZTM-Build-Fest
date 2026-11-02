// "Turn a chat message into…" (#132): one dialog for the four things a message
// can become, the same records Kin keeps when they are typed in. It opens with
// the message's text, editable, says who will see the result, and saves through
// the app's normal commands (app/chat-share.js). The new record is a copy:
// nothing in it says which message or author it came from.
import { routeHash } from "../routes.js";
import { attachmentMetaProblem } from "../attachments/attachment-lifecycle.js";

const TEXT_ENCODER = new TextEncoder();
const MAX_ITEM_BYTES = 4096;
const MAX_TITLE_CHARS = 80;
const MAX_TITLE_BYTES = 256;

export const SHARE_KINDS = Object.freeze({
  shopping: { action: "Add to Shopping", heading: "Add to Shopping", field: "Item", done: "Added to Shopping.", route: routeHash("lists", "shopping"), where: "Shopping" },
  todo: { action: "Add to To do", heading: "Add to To do", field: "Task", done: "Added to To do.", route: routeHash("lists", "todo"), where: "To do" },
  handoff: { action: "Make a handoff", heading: "Make a handoff", field: "What would help to know?", done: "Handoff added.", route: routeHash("updates", "handoffs"), where: "Handoffs" },
  note: { action: "Save as a note", heading: "Save as a note", field: "Title", done: "Note saved.", route: routeHash("household", "notes"), where: "Notes" },
});

/** The text a message gives a one-line field: its lines joined by spaces. */
export function oneLine(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

/** A note title from a message: its first line, at most 80 characters. */
export function noteTitleFrom(text) {
  const first = String(text ?? "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
  let letters = Array.from(first.replace(/\p{Cc}/gu, " "));
  if (letters.length > MAX_TITLE_CHARS) letters = [...letters.slice(0, MAX_TITLE_CHARS - 1), "…"];
  // A title is also held to 256 bytes (emoji are four each).
  while (letters.length > 1 && TEXT_ENCODER.encode(letters.join("")).length > MAX_TITLE_BYTES) {
    if (letters.at(-1) === "…") letters.splice(-2, 1);
    else letters = [...letters.slice(0, -2), "…"];
  }
  return letters.join("").trim();
}

class KinChatShare extends HTMLElement {
  constructor() {
    super();
    this.pending = false;
  }

  connectedCallback() {
    if (this.dialog) return;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "chat-share-dialog quick-add-dialog";
    this.dialog.setAttribute("aria-labelledby", "chat-share-title");
    this.heading = document.createElement("h2");
    this.heading.id = "chat-share-title";
    this.form = document.createElement("form");
    this.form.method = "dialog";
    this.form.className = "quick-add-form chat-share-form";
    this.fieldLabel = document.createElement("label");
    this.fieldLabel.htmlFor = "chat-share-text";
    this.input = document.createElement("input");
    this.input.id = "chat-share-text";
    this.input.type = "text";
    this.input.autocomplete = "off";
    this.bodyLabel = document.createElement("label");
    this.bodyLabel.htmlFor = "chat-share-body";
    this.bodyLabel.textContent = "Note";
    this.body = document.createElement("textarea");
    this.body.id = "chat-share-body";
    this.body.rows = 5;
    this.audience = document.createElement("p");
    this.audience.id = "chat-share-audience";
    this.audience.className = "quick-add-hint chat-share-audience";
    this.input.setAttribute("aria-describedby", "chat-share-audience chat-share-error");
    this.files = document.createElement("fieldset");
    this.files.className = "chat-share-files";
    this.filesLegend = document.createElement("legend");
    this.filesLegend.textContent = "Include photos and files";
    this.files.append(this.filesLegend);
    this.error = document.createElement("p");
    this.error.id = "chat-share-error";
    this.error.className = "quick-add-error";
    this.error.setAttribute("role", "alert");
    this.result = document.createElement("p");
    this.result.className = "chat-share-result";
    this.result.setAttribute("role", "status");
    this.actions = document.createElement("div");
    this.actions.className = "quick-add-actions";
    this.cancel = document.createElement("button");
    this.cancel.type = "button";
    this.cancel.textContent = "Cancel";
    this.save = document.createElement("button");
    this.save.type = "submit";
    this.save.className = "add-button";
    this.actions.append(this.cancel, this.save);
    this.form.append(this.fieldLabel, this.input, this.bodyLabel, this.body, this.audience, this.files, this.error, this.result, this.actions);
    this.dialog.append(this.heading, this.form);
    this.append(this.dialog);

    this.cancel.addEventListener("click", () => { if (!this.pending) this.dialog.close(); });
    this.form.addEventListener("submit", (event) => { event.preventDefault(); void this.submit(); });
    this.dialog.addEventListener("cancel", (event) => {
      if (this.pending) { event.preventDefault(); this.error.textContent = "Please wait for this to finish saving."; }
    });
    this.dialog.addEventListener("close", () => {
      // Escape twice mid-save: stay open until the outcome can be shown.
      if (this.pending && this.state) { this.dialog.showModal(); return; }
      const target = this.opener?.isConnected ? this.opener : null;
      this.opener = null;
      this.state = null;
      target?.focus();
    });
  }

  /** Opens the dialog for `kind` with the message's text and files.
   * `files` are `{ name, size, type, load() }`; `limited` says some members
   * can't read the chat; `submit(payload)` saves and resolves
   * `{ ok, message, itemId?, kind }`. */
  open({ kind, text, files = [], limited = false, submit, opener = null, audience = null }) {
    const spec = SHARE_KINDS[kind];
    if (!spec || typeof submit !== "function" || this.dialog.open) return false;
    this.state = { kind, spec, submit, files };
    this.opener = opener;
    this.pending = false;
    for (const node of this.form.children) node.hidden = false;
    this.heading.textContent = spec.heading;
    this.fieldLabel.textContent = spec.field;
    const isNote = kind === "note";
    this.bodyLabel.hidden = this.body.hidden = !isNote;
    this.body.value = isNote ? String(text ?? "") : "";
    this.input.value = isNote ? noteTitleFrom(text) : oneLine(text);
    this.input.removeAttribute("maxlength");
    // Shared from another app (#389), there is no message to copy from.
    this.audience.textContent = audience ?? `Everyone in your household will see this${limited ? ", including members who can't read the chat" : ""}. It is a copy: changing or deleting the message won't change it.`;
    this.error.textContent = "";
    this.result.replaceChildren();
    this.renderFiles(kind === "handoff" ? [] : files);
    this.save.textContent = "Save";
    this.save.hidden = this.cancel.hidden = false;
    this.cancel.textContent = "Cancel";
    this.setBusy(false);
    this.dialog.showModal();
    this.input.focus();
    return true;
  }

  renderFiles(files) {
    for (const old of [...this.files.querySelectorAll("label")]) old.remove();
    this.files.hidden = files.length === 0;
    files.forEach((file, index) => {
      const label = document.createElement("label");
      label.className = "chat-share-file";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = String(index);
      box.checked = false;
      // Household attachments hold photos and PDFs up to 4 MB; say so here
      // rather than after the record is saved.
      const problem = attachmentMetaProblem({ type: file.type, size: file.size });
      label.append(box, ` ${file.name}`);
      if (problem) {
        box.disabled = true;
        box.dataset.unavailable = "true";
        const why = document.createElement("small");
        why.className = "chat-share-why";
        why.id = `chat-share-why-${index}`;
        why.textContent = ` Can't be copied: ${problem}`;
        box.setAttribute("aria-describedby", why.id);
        label.append(why);
      }
      this.files.append(label);
    });
  }

  setBusy(busy) {
    this.pending = busy;
    for (const control of [this.input, this.body, this.save, this.cancel]) control.disabled = busy;
    for (const box of this.files.querySelectorAll("input")) box.disabled = busy || box.dataset.unavailable === "true";
    this.form.setAttribute("aria-busy", String(busy));
    this.save.textContent = busy ? "Saving…" : "Save";
  }

  /** What was entered, or the problem with it. */
  read() {
    const { kind } = this.state;
    if (kind === "note") {
      const title = this.input.value.trim();
      if (!title) return { problem: "Enter a title.", focus: this.input };
      if (Array.from(title).length > MAX_TITLE_CHARS) return { problem: `Titles can be up to ${MAX_TITLE_CHARS} characters.`, focus: this.input };
      if (TEXT_ENCODER.encode(title).length > MAX_TITLE_BYTES) return { problem: "That title is too long. Shorten it a little.", focus: this.input };
      if (/\p{Cc}/u.test(title)) return { problem: "Titles can't contain control characters.", focus: this.input };
      if (Array.from(this.body.value).some((character) => /\p{Cc}/u.test(character) && !"\n\r\t".includes(character)))
        return { problem: "Notes can contain line breaks and tabs, but no other control characters.", focus: this.body };
      if (TEXT_ENCODER.encode(this.body.value).length > MAX_ITEM_BYTES) return { problem: "That note is too long. Roughly 4,000 characters fit.", focus: this.body };
      return { title, body: this.body.value };
    }
    const text = this.input.value.trim();
    if (!text) return { problem: "Add a few words first.", focus: this.input };
    if (TEXT_ENCODER.encode(text).length > MAX_ITEM_BYTES) return { problem: "That's too long. Shorten it to roughly 4,000 characters or fewer.", focus: this.input };
    return { text };
  }

  async submit() {
    if (this.pending || !this.state) return;
    const entry = this.read();
    if (entry.problem) { this.error.textContent = entry.problem; entry.focus.focus(); return; }
    this.error.textContent = "";
    const chosen = [...this.files.querySelectorAll("input:checked")].map((box) => this.state.files[Number(box.value)]).filter(Boolean);
    const { state } = this;
    this.setBusy(true);
    let outcome;
    try {
      outcome = await state.submit({ kind: state.kind, ...entry, files: chosen });
    } catch {
      outcome = { ok: false, message: "Kin couldn't save that. Try again." };
    }
    if (this.state !== state) return;
    this.setBusy(false);
    if (!outcome?.ok) {
      this.error.textContent = outcome?.message || "Kin couldn't save that. Try again.";
      this.input.focus();
      return;
    }
    this.showDone(outcome);
  }

  /** The confirmation, with a way to the new record. */
  showDone({ message, itemId = null, problems = [] }) {
    const { spec } = this.state;
    this.form.querySelectorAll(":scope > :not(.chat-share-result):not(.quick-add-actions)").forEach((node) => { node.hidden = true; });
    this.result.replaceChildren(message || spec.done);
    for (const problem of problems) {
      const line = document.createElement("span");
      line.className = "chat-share-problem";
      line.textContent = ` ${problem}`;
      this.result.append(line);
    }
    const link = document.createElement("a");
    link.className = "chat-share-link";
    link.href = spec.route;
    link.textContent = `Go to ${spec.where}`;
    link.addEventListener("click", () => this.dialog.close());
    const open = itemId ? document.createElement("button") : null;
    if (open) {
      open.type = "button";
      open.textContent = "Open it";
      open.addEventListener("click", () => {
        const opener = this.opener;
        this.dialog.close();
        this.dispatchEvent(new CustomEvent("kin:open-item", { detail: { itemId, opener }, bubbles: true, composed: true }));
      });
    }
    this.result.append(" ", ...(open ? [open, " "] : []), link);
    this.save.hidden = true;
    this.cancel.hidden = false;
    this.cancel.textContent = "Done";
    this.cancel.focus();
  }

  /** The app locked or the session changed: nothing stays open. */
  reset() {
    this.pending = false;
    this.state = null;
    this.opener = null;
    if (this.dialog?.open) this.dialog.close();
    // A locked Kin keeps none of the message's text.
    if (this.input) {
      this.input.value = this.body.value = "";
      this.error.textContent = "";
      this.result.replaceChildren();
      this.renderFiles([]);
      this.audience.textContent = "";
    }
  }
}

if (!customElements.get("kin-chat-share")) customElements.define("kin-chat-share", KinChatShare);
