
class KinHandoffList extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.isDisabled = false;
  }

  connectedCallback() {
    if (this.input) return;
    const section = document.createElement("section");
    section.className = "today-section handoff-section";
    const heading = document.createElement("h2");
    heading.textContent = "Handoff";
    const hint = document.createElement("p");
    hint.className = "handoff-hint";
    hint.textContent = "A little context for picking things up.";
    const form = document.createElement("form");
    form.className = "compose-form handoff-form";
    const label = document.createElement("label");
    label.htmlFor = "handoff-text";
    label.textContent = "What would help to know?";
    this.input = document.createElement("input");
    this.input.id = "handoff-text";
    this.input.type = "text";
    this.input.required = true;
    this.input.maxLength = 4096;
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-describedby", "handoff-message");
    this.button = document.createElement("button");
    this.button.type = "submit";
    this.button.className = "add-button";
    this.button.textContent = "Add handoff";
    this.message = document.createElement("p");
    this.message.id = "handoff-message";
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

  set handoffs(value) {
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
    this.dispatchEvent(new CustomEvent(`kin:${action}-handoff`, {
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
      empty.textContent = "No handoffs yet. Leave a few words for later.";
      this.lists.append(empty);
    }
    for (const [status, title] of [["unacknowledged", "Needs attention"], ["acknowledged", "Recent — acknowledged"]]) {
      const records = visible.filter(record => record.status === status).reverse();
      if (!records.length) continue;
      const heading = document.createElement("h3");
      heading.className = "completed-heading";
      heading.textContent = title;
      const list = document.createElement("ul");
      list.className = "item-list";
      for (const record of records) {
        const row = document.createElement("li");
        row.className = "item-row handoff-row";
        const text = document.createElement("p");
        text.className = "item-text";
        text.textContent = record.text;
        const actions = document.createElement("div");
        actions.className = "item-action";
        if (status === "acknowledged") {
          const label = document.createElement("span");
          label.className = "completed-label";
          label.textContent = "Acknowledged";
          actions.append(label);
        } else {
          actions.append(this.actionButton("Acknowledge", "acknowledge", record));
        }
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
    button.addEventListener("click", () => this.dispatchCommand(action, { handoffId: record.handoffId }));
    return button;
  }
}

customElements.define("kin-handoff-list", KinHandoffList);
