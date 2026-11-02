// "Import a calendar file" (#660 with #666, ADR 0022 §3): choose an .ics
// file (or arrive with one from the share sheet), see how many events it
// has and what importing would do, then import. The file is read and
// parsed on this device; the calendar controller works out the plan
// (calendar/ics-import.js) and saves it. Nothing is saved until "Import".
//
// The controller calls open({ opener, file }) and listens for
// `kin:calendar-import-file` ({ file, done(preview) }) and
// `kin:calendar-import-confirm` ({ done(outcome) }).
import { helpButton } from "../shared/help-button.js";

class KinCalendarImport extends HTMLElement {
  connectedCallback() {
    if (this.dialog) return;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "quick-add-dialog calendar-import";
    this.dialog.setAttribute("aria-labelledby", "calendar-import-heading");
    const top = document.createElement("div");
    top.className = "dialog-top";
    const heading = document.createElement("h2");
    heading.id = "calendar-import-heading";
    heading.textContent = "Import a calendar file";
    top.append(heading, helpButton("dialog:calendar-import"));
    const hint = document.createElement("p");
    hint.className = "quick-add-hint";
    hint.textContent = "Choose an .ics file exported from Google, Apple or Outlook. Kin reads it on this device; the events then belong to everyone in your household.";
    this.chooseButton = document.createElement("button");
    this.chooseButton.type = "button";
    this.chooseButton.className = "calendar-import-choose";
    this.chooseButton.textContent = "Choose a file…";
    this.chooseButton.addEventListener("click", () => this.chooseFile());
    this.fileName = document.createElement("p");
    this.fileName.className = "calendar-import-file";
    this.preview = document.createElement("p");
    this.preview.className = "calendar-import-preview";
    this.preview.setAttribute("role", "status");
    this.error = document.createElement("p");
    this.error.className = "quick-add-error";
    this.error.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "quick-add-actions";
    this.cancelButton = document.createElement("button");
    this.cancelButton.type = "button";
    this.cancelButton.textContent = "Cancel";
    this.cancelButton.addEventListener("click", () => this.close());
    this.importButton = document.createElement("button");
    this.importButton.type = "button";
    this.importButton.className = "add-button calendar-import-confirm";
    this.importButton.textContent = "Import";
    this.importButton.disabled = true;
    this.importButton.addEventListener("click", () => this.confirm());
    actions.append(this.cancelButton, this.importButton);
    this.dialog.append(top, hint, this.chooseButton, this.fileName, this.preview, this.error, actions);
    this.dialog.addEventListener("cancel", (event) => { if (this.pending) event.preventDefault(); });
    this.dialog.addEventListener("close", () => {
      const target = this.opener?.isConnected ? this.opener : null;
      this.opener = null;
      target?.focus?.();
    });
    this.append(this.dialog);
  }

  get isOpen() {
    return Boolean(this.dialog?.open);
  }

  /** Opens the dialog; with `file` (from the share sheet), reads it now. */
  open({ opener = null, file = null } = {}) {
    if (!this.dialog) this.connectedCallback();
    this.opener = opener;
    this.reset({ keepOpen: true });
    if (!this.dialog.open) this.dialog.showModal();
    if (file) void this.read(file);
    else this.chooseButton.focus();
  }

  chooseFile() {
    // A temporary input, as list import and Chat do: the app's one file
    // input belongs to attachments.
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ics,text/calendar";
    input.hidden = true;
    const done = () => input.remove();
    input.addEventListener("change", () => { const file = input.files?.[0]; done(); if (file) void this.read(file); });
    input.addEventListener("cancel", done);
    this.dialog.append(input);
    input.click();
  }

  read(file) {
    this.fileName.textContent = file.name ? `File: ${file.name}` : "";
    this.preview.textContent = "Reading the file…";
    this.error.textContent = "";
    this.importButton.disabled = true;
    this.setPending(true);
    return new Promise((resolve) => {
      this.dispatchEvent(new CustomEvent("kin:calendar-import-file", {
        bubbles: true, composed: true,
        detail: {
          file,
          done: (preview) => {
            this.setPending(false);
            if (preview?.error) {
              this.preview.textContent = "";
              this.error.textContent = preview.error;
            } else {
              this.preview.textContent = preview?.text ?? "";
              this.importButton.disabled = !preview?.changes;
              this.importButton.textContent = preview?.changes ? `Import ${preview.events === 1 ? "1 event" : `${preview.events} events`}` : "Import";
              if (preview?.changes) this.importButton.focus();
            }
            resolve(preview);
          },
        },
      }));
    });
  }

  confirm() {
    if (this.pending) return;
    this.setPending(true);
    this.preview.textContent = "Importing…";
    this.dispatchEvent(new CustomEvent("kin:calendar-import-confirm", {
      bubbles: true, composed: true,
      detail: {
        done: (outcome) => {
          this.setPending(false);
          if (outcome?.ok) { this.close(); return; }
          this.preview.textContent = "";
          this.error.textContent = outcome?.error ?? "Kin couldn't import that file.";
        },
      },
    }));
  }

  setPending(pending) {
    this.pending = pending;
    this.chooseButton.disabled = pending;
    this.cancelButton.disabled = pending;
    if (pending) this.importButton.disabled = true;
  }

  close() {
    if (this.pending) return;
    if (this.dialog?.open) this.dialog.close();
  }

  /** Locking or reopening: nothing from a file stays. */
  reset({ keepOpen = false } = {}) {
    this.pending = false;
    if (!this.dialog) return;
    this.fileName.textContent = "";
    this.preview.textContent = "";
    this.error.textContent = "";
    this.importButton.disabled = true;
    this.importButton.textContent = "Import";
    this.chooseButton.disabled = false;
    this.cancelButton.disabled = false;
    if (!keepOpen && this.dialog.open) this.dialog.close();
  }
}

if (!customElements.get("kin-calendar-import")) customElements.define("kin-calendar-import", KinCalendarImport);
