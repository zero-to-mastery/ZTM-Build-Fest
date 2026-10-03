
class KinTalkList extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.isDisabled = false;
  }

  connectedCallback() {
    if (this.input) return;
    const section = document.createElement("section");
    section.className = "today-section talk-section";
    const heading = document.createElement("h2");
    heading.textContent = "Talk";
    const hint = document.createElement("p");
    hint.className = "talk-hint";
    hint.textContent = "Things worth coming back to.";
    const form = document.createElement("form");
    form.className = "compose-form talk-form";
    const label = document.createElement("label");
    label.htmlFor = "talk-text";
    label.textContent = "What should we talk about?";
    this.input = document.createElement("input");
    this.input.id = "talk-text";
    this.input.type = "text";
    this.input.required = true;
    this.input.maxLength = 4096;
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-describedby", "talk-message");
    this.button = document.createElement("button");
    this.button.type = "submit";
    this.button.className = "add-button";
    this.button.textContent = "Add";
    this.message = document.createElement("p");
    this.message.id = "talk-message";
    this.message.className = "compose-message";
    this.message.setAttribute("role", "alert");
    this.input.addEventListener("input", () => this.saveDraft());
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (this.isDisabled) return;
      const text = this.input.value;
      if (!text.trim() || new TextEncoder().encode(text).length > 4096) {
        this.message.textContent = "Add a few words, up to 4096 UTF-8 bytes.";
        this.focusInput();
        return;
      }
      this.message.textContent = "";
      this.dispatchCommand("add", { text });
    });
    form.append(label, this.input, this.button, this.message);
    this.lists = document.createElement("div");
    section.append(heading, hint, form, this.lists);
    this.replaceChildren(section);
    this.render();
    this.disabled = this.isDisabled;
  }

  set talks(value) {
    this.records = value;
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("input, button")) {
      control.disabled = this.isDisabled;
    }
  }

  saveDraft() {
    // Keep drafts only in the unlocked input.
  }

  clearIfMatches({ text }) {
    if (this.input.value !== text) return;
    this.input.value = "";
    this.message.textContent = "";
    this.saveDraft();
  }

  focusInput() { this.input.focus(); }

  dispatchCommand(action, detail) {
    this.dispatchEvent(new CustomEvent(`kin:${action}-talk`, {
      detail, bubbles: true, composed: true,
    }));
  }

  render() {
    if (!this.lists) return;
    this.lists.replaceChildren();
    const visible = this.records.filter(record => record.status !== "archived");
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No topics yet. Add something worth coming back to.";
      this.lists.append(empty);
    }
    for (const [status, title] of [["open", "Open"], ["resolved", "Resolved"]]) {
      const records = visible.filter(record => record.status === status).reverse();
      if (!records.length) continue;
      const heading = document.createElement("h3");
      heading.className = "completed-heading";
      heading.textContent = title;
      const list = document.createElement("ul");
      list.className = "item-list";
      for (const record of records) {
        const row = document.createElement("li");
        row.className = "item-row talk-row";
        const text = document.createElement("p");
        text.className = "item-text";
        text.textContent = record.text;
        const actions = document.createElement("div");
        actions.className = "item-action";
        actions.append(status === "resolved"
          ? this.actionButton("Reopen", "reopen", record)
          : this.actionButton("Resolve", "resolve", record));
        actions.append(this.actionButton("Archive", "archive", record));
        row.append(text, actions);
        list.append(row);
      }
      this.lists.append(heading, list);
    }
  }

  actionButton(label, action, record) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action === "archive" ? "archive-button" : "complete-button";
    button.textContent = label;
    button.setAttribute("aria-label", `${label} ${record.text}`);
    button.disabled = this.isDisabled;
    button.addEventListener("click", () => this.dispatchCommand(action, { talkId: record.talkId }));
    return button;
  }
}

customElements.define("kin-talk-list", KinTalkList);
