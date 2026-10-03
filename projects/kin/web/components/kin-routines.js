
class KinRoutines extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.isDisabled = false;
  }

  connectedCallback() {
    if (this.input) return;
    const section = document.createElement("section");
    section.className = "today-section";
    const heading = document.createElement("h2");
    heading.textContent = "Routines";
    const hint = document.createElement("p");
    hint.textContent = "Once today, or once this week. Weeks start Monday.";
    const form = document.createElement("form");
    form.className = "compose-form routine-form";
    const label = document.createElement("label");
    label.htmlFor = "routine-text";
    label.textContent = "What needs doing regularly?";
    this.input = document.createElement("input");
    this.input.id = "routine-text";
    this.input.required = true;
    this.input.maxLength = 4096;
    this.input.autocomplete = "off";
    const cadenceLabel = document.createElement("label");
    cadenceLabel.htmlFor = "routine-cadence";
    cadenceLabel.textContent = "Repeat";
    this.cadence = document.createElement("select");
    this.cadence.id = "routine-cadence";
    for (const [value, text] of [["daily", "Daily"], ["weekly", "Weekly"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.cadence.append(option);
    }
    this.button = document.createElement("button");
    this.button.type = "submit";
    this.button.className = "add-button";
    this.button.textContent = "Add routine";
    this.message = document.createElement("p");
    this.message.id = "routine-message";
    this.message.setAttribute("role", "alert");
    this.input.setAttribute("aria-describedby", this.message.id);
    this.input.addEventListener("input", () => this.saveDraft());
    this.cadence.addEventListener("change", () => this.saveDraft());
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
      this.dispatch("create-routine", { text, cadence: this.cadence.value });
    });
    form.append(label, this.input, cadenceLabel, this.cadence, this.button, this.message);
    this.list = document.createElement("ul");
    this.list.className = "item-list";
    this.empty = document.createElement("p");
    this.empty.className = "empty-state";
    this.empty.textContent = "No routines yet. Add a small household rhythm.";
    section.append(heading, hint, form, this.empty, this.list);
    this.append(section);
    this.render();
    this.disabled = this.isDisabled;
  }

  set routines(value) { this.records = value; this.render(); }
  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("input, select, button")) control.disabled = this.isDisabled;
  }
  focusInput() { this.input.focus(); }
  saveDraft() {
    // Keep drafts only in the unlocked input.
  }
  clearIfMatches({ text, cadence }) {
    if (this.input.value !== text || this.cadence.value !== cadence) return;
    this.input.value = "";
    this.saveDraft();
  }
  dispatch(action, detail) {
    if (!this.isDisabled) this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true }));
  }
  captureFocus() {
    const control = document.activeElement;
    return this.contains(control) ? { control, id: control.dataset.routineId, action: control.dataset.action } : null;
  }
  restoreFocus(focus) {
    if (!focus) return;
    if (focus.control.isConnected) { focus.control.focus(); return; }
    const sameRow = [...this.querySelectorAll("button[data-routine-id]")].filter(button => button.dataset.routineId === focus.id);
    (sameRow.find(button => button.dataset.action === focus.action) ?? sameRow[0] ?? this.input).focus();
  }
  render() {
    if (!this.list) return;
    const focus = this.captureFocus();
    this.list.replaceChildren();
    const visible = this.records.filter(record => record.status !== "archived");
    this.empty.hidden = visible.length !== 0;
    for (const record of visible) {
      const row = document.createElement("li");
      row.className = "item-row routine-row";
      const content = document.createElement("div");
      const text = document.createElement("p");
      text.className = "item-text";
      text.textContent = record.text;
      const status = document.createElement("p");
      status.className = "routine-status";
      const period = record.cadence === "daily" ? "today" : "this week";
      status.textContent = `${record.cadence === "daily" ? "Daily" : "Weekly"} · ${record.occurrenceStatus === "unavailable" ? "Not available for the current date" : record.occurrenceStatus === "completed" ? `Done ${period}` : `Open ${period}`}`;
      content.append(text, status);
      const actions = document.createElement("div");
      actions.className = "item-action";
      const addAction = (label, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.className = action === "archive-routine" ? "archive-button" : "complete-button";
        button.setAttribute("aria-label", `${label} ${record.text}${action === "archive-routine" ? "" : ` ${period}`}`);
        button.dataset.routineId = record.routineId;
        button.dataset.action = action;
        button.disabled = this.isDisabled;
        button.addEventListener("click", () => this.dispatch(action, { routineId: record.routineId, ...(action === "archive-routine" ? {} : { occurrenceKey: record.occurrenceKey }) }));
        actions.append(button);
      };
      if (record.occurrenceStatus !== "unavailable") addAction(record.occurrenceStatus === "completed" ? "Reopen" : "Complete", record.occurrenceStatus === "completed" ? "reopen-routine-occurrence" : "complete-routine-occurrence");
      addAction("Archive", "archive-routine");
      row.append(content, actions);
      this.list.append(row);
    }
    this.restoreFocus(focus);
  }
}
customElements.define("kin-routines", KinRoutines);
