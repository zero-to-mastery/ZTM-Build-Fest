// "Add to Kin" (#390): where something shared from another app should go.
// A small modal dialog showing what was shared (its first line, link and file
// names) and one button per destination. Choosing one hands off to the
// existing dialog for that kind (kin-chat-share) or to Chat's composer;
// nothing is saved here.

const DESTINATIONS = Object.freeze([
  ["todo", "Add to To do"],
  ["shopping", "Add to Shopping"],
  ["note", "Save as a note"],
  ["handoff", "Make a handoff"],
  ["chat", "Send in Chat"],
  // Family photos (#673): only when photos were shared.
  ["photos", "Add to family photos"],
  // A member's own journal (#508): private, never household data.
  ["journal", "Add to my journal"],
  // A calendar file (.ics, #660): its events, after a preview.
  ["calendar", "Add to the calendar"],
]);

class KinShareSheet extends HTMLElement {
  connectedCallback() {
    if (this.dialog) return;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "share-sheet quick-add-dialog";
    this.dialog.setAttribute("aria-labelledby", "share-sheet-title");
    const heading = document.createElement("h2");
    heading.id = "share-sheet-title";
    heading.textContent = "Add to Kin";
    this.preview = document.createElement("div");
    this.preview.className = "share-sheet-preview";
    this.preview.id = "share-sheet-preview";
    this.choices = document.createElement("div");
    this.choices.className = "share-sheet-choices";
    this.choices.setAttribute("role", "group");
    this.choices.setAttribute("aria-labelledby", "share-sheet-title");
    const hint = document.createElement("p");
    hint.className = "quick-add-hint";
    hint.textContent = "Nothing is saved until you choose and confirm. Everyone in your household will see what you add, except in your journal, which only you can see.";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "share-sheet-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close(null));
    this.dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close(null); });
    this.dialog.append(heading, this.preview, hint, this.choices, cancel);
    this.append(this.dialog);
  }

  get isOpen() {
    return Boolean(this.dialog?.open);
  }

  /**
   * Shows what was shared and the destinations `allowed` (a Set of kinds).
   * Resolves the chosen kind, or null when cancelled.
   */
  choose({ text = "", link = "", files = [], allowed = new Set(DESTINATIONS.map(([kind]) => kind)) } = {}) {
    if (!this.dialog) this.connectedCallback();
    if (this.dialog.open) this.close(null);
    this.preview.replaceChildren();
    const line = document.createElement("p");
    line.className = "share-sheet-text";
    line.textContent = text || (files.length ? "" : "Nothing to add.");
    if (line.textContent) this.preview.append(line);
    if (link && !text.includes(link)) {
      const url = document.createElement("p");
      url.className = "share-sheet-link";
      url.textContent = link;
      this.preview.append(url);
    }
    if (files.length) {
      const list = document.createElement("ul");
      list.className = "share-sheet-files";
      list.setAttribute("aria-label", files.length === 1 ? "1 file" : `${files.length} files`);
      for (const file of files) {
        const item = document.createElement("li");
        item.textContent = file.name || "Shared file";
        list.append(item);
      }
      this.preview.append(list);
    }
    this.choices.replaceChildren(...DESTINATIONS.filter(([kind]) => allowed.has(kind)).map(([kind, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.kind = kind;
      button.textContent = label;
      button.setAttribute("aria-describedby", "share-sheet-preview");
      button.addEventListener("click", () => this.close(kind));
      return button;
    }));
    this.dialog.showModal();
    this.choices.querySelector("button")?.focus();
    return new Promise((resolve) => { this.resolve = resolve; });
  }

  close(kind) {
    const resolve = this.resolve;
    this.resolve = null;
    if (this.dialog?.open) this.dialog.close();
    resolve?.(kind);
  }
}

if (!customElements.get("kin-share-sheet")) customElements.define("kin-share-sheet", KinShareSheet);
