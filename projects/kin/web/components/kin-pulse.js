const VALUES = [
  ["good", "Good"], ["okay", "Okay"], ["drained", "Drained"],
  ["rough-day", "Rough day"], ["need-quiet", "Need quiet"],
];

class KinPulse extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    const section = document.createElement("section");
    section.className = "pulse-section today-section";
    const heading = document.createElement("h2");
    heading.textContent = "Pulse";
    this.current = document.createElement("p");
    this.current.className = "pulse-current";
    this.until = document.createElement("p");
    this.until.className = "pulse-until";
    this.form = document.createElement("form");
    this.form.className = "pulse-form";
    const valueLabel = document.createElement("label");
    valueLabel.textContent = "Current capacity";
    this.valueSelect = document.createElement("select");
    this.valueSelect.name = "capacity";
    for (const [value, label] of VALUES) this.valueSelect.add(new Option(label, value));
    valueLabel.append(this.valueSelect);
    const durationLabel = document.createElement("label");
    durationLabel.textContent = "For";
    this.durationSelect = document.createElement("select");
    this.durationSelect.name = "duration";
    for (const hours of [1, 4, 8]) this.durationSelect.add(new Option(`${hours} ${hours === 1 ? "hour" : "hours"}`, String(hours)));
    this.durationSelect.value = "4";
    durationLabel.append(this.durationSelect);
    this.setButton = document.createElement("button");
    this.setButton.type = "submit";
    this.setButton.className = "complete-button";
    this.setButton.textContent = "Set pulse";
    this.form.append(valueLabel, durationLabel, this.setButton);
    this.actions = document.createElement("div");
    this.actions.className = "pulse-actions";
    this.changeButton = document.createElement("button");
    this.changeButton.type = "button";
    this.changeButton.className = "complete-button";
    this.changeButton.textContent = "Change";
    this.clearButton = document.createElement("button");
    this.clearButton.type = "button";
    this.clearButton.className = "reopen-button";
    this.clearButton.textContent = "Clear";
    this.actions.append(this.changeButton, this.clearButton);
    section.append(heading, this.current, this.until, this.form, this.actions);
    this.append(section);
    this.form.addEventListener("submit", event => {
      event.preventDefault();
      if (this.isDisabled) return;
      this.dispatchEvent(new CustomEvent("kin:set-pulse", {
        bubbles: true, composed: true,
        detail: { value: this.valueSelect.value, hours: Number(this.durationSelect.value) },
      }));
    });
    this.changeButton.addEventListener("click", () => {
      this.valueSelect.value = this.record.value;
      this.editing = true;
      this.render();
      this.valueSelect.focus();
    });
    this.clearButton.addEventListener("click", () => {
      if (!this.isDisabled) this.dispatchEvent(new CustomEvent("kin:clear-pulse", { bubbles: true, composed: true }));
    });
    this.render();
  }

  set pulse(value) { this.record = value; this.render(); }
  set disabled(value) {
    this.isDisabled = value;
    for (const control of this.querySelectorAll("button, select")) control.disabled = value;
  }
  saved() { this.editing = false; this.render(); }
  focusInput() { (this.form.hidden ? this.changeButton : this.valueSelect).focus(); }

  render() {
    if (!this.initialized) return;
    const hadFocus = this.contains(document.activeElement);
    const active = this.record?.status === "active";
    this.current.textContent = active ? VALUES.find(([value]) => value === this.record.value)[1] : "No current pulse.";
    this.until.textContent = active ? `Until ${new Date(this.record.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
    this.until.hidden = !active;
    this.form.hidden = active && !this.editing;
    this.actions.hidden = !active;
    this.changeButton.hidden = this.editing;
    this.disabled = this.isDisabled;
    if (hadFocus && document.activeElement.closest("[hidden]")) this.focusInput();
  }
}

customElements.define("kin-pulse", KinPulse);
