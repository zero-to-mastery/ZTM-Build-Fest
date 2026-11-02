import { localCivilDateOffset, projectionContext } from "../browser-time.js";

const MAX_ITEM_TEXT_BYTES = 4096;
const textEncoder = new TextEncoder();

// Presentation labels for the unchanged canonical classification values.
export const CLASSIFICATION_LABELS = {
  today: "Today",
  need: "To do",
  shopping: "Shopping",
  staple: "Staples",
};

export const CLASSIFICATIONS = Object.keys(CLASSIFICATION_LABELS);

// What a new item is, as offered by the Today capture. New captures never
// create a `today`-classified record; Today is a view over dated items.
const KIND_OPTIONS = [
  ["need", "Task"],
  ["shopping", "Shopping item"],
];

const PLAN_OPTIONS = [
  ["today", "Today"],
  ["tomorrow", "Tomorrow"],
  ["date", "Pick a date"],
  ["none", "No date"],
];

export const TOO_LONG = "That's too long for one item. Shorten it to roughly 4,000 characters or fewer.";

class KinCompose extends HTMLElement {
  constructor() {
    super();
    this.isDisabled = false;
    this.initialized = false;
    // "scope" keeps control ids unique when several capture forms are mounted.
    this.scope = "";
    // A fixed destination (list capture) hides every selector; the Today
    // capture ("today" mode) asks what the item is and when it matters.
    this.fixedClassification = null;
    this.mode = "list";
    this.labelText = "Add something";
  }

  static get observedAttributes() {
    return ["scope", "fixed-classification", "mode", "label"];
  }

  attributeChangedCallback(name, _old, value) {
    if (name === "scope") this.scope = value ?? "";
    else if (name === "fixed-classification") this.fixedClassification = CLASSIFICATIONS.includes(value) ? value : null;
    else if (name === "mode") this.mode = value === "today" ? "today" : "list";
    else if (name === "label" && value) this.labelText = value;
  }

  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    const suffix = this.scope ? `-${this.scope}` : "";
    this.form = document.createElement("form");
    this.form.className = this.mode === "today" ? "compose-form compose-form-today" : "compose-form compose-form-compact";
    this.form.noValidate = true;
    this.label = document.createElement("label");
    this.label.htmlFor = `item-text${suffix}`;
    this.label.textContent = this.mode === "today" ? "What would you like to remember?" : this.labelText;
    this.input = document.createElement("input");
    this.input.id = `item-text${suffix}`;
    this.input.name = "item";
    this.input.type = "text";
    this.input.autocomplete = "off";
    if (this.mode === "today") this.input.placeholder = "Buy milk, take out the recycling…";
    this.input.maxLength = MAX_ITEM_TEXT_BYTES;
    this.input.required = true;
    this.input.setAttribute("aria-describedby", `compose-message${suffix}`);
    // Pasting several lines (#453): offer to add them as separate items
    // rather than squashing them into one.
    this.input.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text.split(/\r\n|\r|\n/).filter((line) => line.trim()).length < 2) return;
      event.preventDefault();
      this.dispatchEvent(new CustomEvent("kin:import-list", { bubbles: true, composed: true, detail: { text, classification: this.classification?.value ?? "need", opener: this.input } }));
    });

    // The kind selector doubles as the classification control so existing
    // callers keep reading `classification.value`.
    this.classificationLabel = document.createElement("label");
    this.classificationLabel.htmlFor = `item-classification${suffix}`;
    this.classificationLabel.textContent = "What it is";
    this.classification = document.createElement("select");
    this.classification.id = `item-classification${suffix}`;
    this.classification.name = "classification";
    for (const [value, text] of KIND_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.classification.append(option);
    }
    this.classificationField = document.createElement("div");
    this.classificationField.className = "classification-field";
    this.classificationField.append(this.classificationLabel, this.classification);

    this.planLabel = document.createElement("label");
    this.planLabel.htmlFor = `item-plan${suffix}`;
    this.planLabel.textContent = "When it matters";
    this.plan = document.createElement("select");
    this.plan.id = `item-plan${suffix}`;
    this.plan.name = "plan";
    for (const [value, text] of PLAN_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.plan.append(option);
    }
    this.planField = document.createElement("div");
    this.planField.className = "classification-field plan-field";
    this.planField.append(this.planLabel, this.plan);
    this.planDateLabel = document.createElement("label");
    this.planDateLabel.htmlFor = `item-plan-date${suffix}`;
    this.planDateLabel.textContent = "Date";
    this.planDate = document.createElement("input");
    this.planDate.type = "date";
    this.planDate.id = `item-plan-date${suffix}`;
    this.planDate.name = "planDate";
    this.planDateField = document.createElement("div");
    this.planDateField.className = "classification-field plan-date-field";
    this.planDateField.append(this.planDateLabel, this.planDate);
    this.planDateField.hidden = true;
    this.plan.addEventListener("change", () => {
      this.planDateField.hidden = this.plan.value !== "date";
      if (this.plan.value === "date") this.planDate.focus();
    });

    this.pinLabel = document.createElement("label");
    this.pinLabel.className = "pin-field";
    this.pin = document.createElement("input");
    this.pin.type = "checkbox";
    this.pin.id = `item-pin${suffix}`;
    this.pin.name = "pin";
    this.pinLabel.append(this.pin, document.createTextNode(" Pin for quick access"));

    this.button = document.createElement("button");
    this.button.className = "add-button";
    this.button.type = "submit";
    this.button.textContent = "Add";
    this.message = document.createElement("p");
    this.message.id = `compose-message${suffix}`;
    this.message.className = "compose-message";
    this.message.setAttribute("aria-live", "polite");
    // Save results are announced once by the app's status/alert regions; this
    // line simply repeats them next to the field without a second live region.
    this.result = document.createElement("p");
    this.result.className = "compose-result";
    this.result.hidden = true;
    this.restoreDraft();
    this.draftRevision = 0;
    this.form.append(this.label, this.input);
    if (this.mode === "today") {
      const options = document.createElement("div");
      options.className = "compose-options";
      options.append(this.classificationField, this.planField, this.planDateField, this.pinLabel);
      // Where the item will go, stated before Add and read with the field
      // (#265): "Adds to Shopping, planned for today."
      this.destination = document.createElement("p");
      this.destination.id = `compose-destination${suffix}`;
      this.destination.className = "compose-destination";
      this.input.setAttribute("aria-describedby", this.destination.id);
      this.form.append(options, this.destination);
      this.renderDestination();
    } else {
      const destination = CLASSIFICATION_LABELS[this.fixedClassification] ?? "list";
      this.classification.value = this.fixedClassification ?? "need";
      this.classification.hidden = true;
      this.classificationField.hidden = true;
      this.input.placeholder = `Add to ${destination}`;
      this.input.setAttribute("aria-label", `Add to ${destination}`);
      this.label.className = "visually-hidden";
    }
    this.form.append(this.button, this.message, this.result);
    this.replaceChildren(this.form);
    this.form.addEventListener("submit", (event) => this.submit(event));
    for (const control of [this.input, this.classification, this.plan, this.planDate, this.pin]) {
      control.addEventListener("input", () => this.noteDraftChange());
      control.addEventListener("change", () => this.noteDraftChange());
    }
    for (const control of [this.classification, this.plan, this.planDate])
      control.addEventListener("change", () => this.renderDestination());
  }

  /** The destination line for the Today capture: the list it joins and when
   * it is planned, in words. Presentation only; the submit still sends the
   * same classification and planning date. */
  renderDestination() {
    if (!this.destination) return;
    const list = CLASSIFICATION_LABELS[this.currentClassification] ?? "To do";
    const when = {
      today: "planned for today",
      tomorrow: "planned for tomorrow",
      none: "with no date",
    }[this.plan.value] ?? (this.planDate.value ? `planned for ${this.planDate.value}` : "on the date you pick");
    this.destination.textContent = `Adds to ${list}, ${when}.`;
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    if (!this.input) return;
    for (const control of [this.input, this.classification, this.plan, this.planDate, this.pin, this.button]) control.disabled = this.isDisabled;
    for (const retry of this.result?.querySelectorAll("button") ?? []) retry.disabled = this.isDisabled;
  }

  get currentClassification() {
    return this.fixedClassification ?? this.classification.value;
  }

  // Resolves the chosen plan to a fixed local civil date, or null for no date.
  currentPlanningDate() {
    if (this.mode !== "today") return null;
    switch (this.plan.value) {
      case "today": return projectionContext().civilDate;
      case "tomorrow": return localCivilDateOffset(1);
      case "date": return this.planDate.value ? Number(this.planDate.value.replaceAll("-", "")) : null;
      default: return null;
    }
  }

  clearIfMatches(submittedDraft) {
    // Completion belongs to the submitted draft, not a newer edit. The chosen
    // kind and plan stay selected so a second item lands where the person expects.
    if (this.input.value !== submittedDraft.text || this.currentClassification !== submittedDraft.classification) return;
    if (submittedDraft.revision != null && submittedDraft.revision !== this.draftRevision) return;
    this.input.value = "";
    this.message.textContent = "";
    if (this.mode === "today") this.pin.checked = false;
  }

  focusInput() { this.input.focus(); }

  restoreDraft() {
    this.input.value = "";
    this.classification.value = this.fixedClassification ?? "need";
    this.plan.value = "today";
    this.planDate.value = "";
    this.pin.checked = false;
    this.renderDestination?.();
  }

  saveDraft() {
    // Drafts remain in the unlocked input only; lock replaces the component.
  }

  showResult(text, { kind = "saved", retry = null } = {}) {
    this.result.replaceChildren();
    this.result.dataset.kind = kind;
    this.result.append(document.createTextNode(text));
    if (typeof retry === "function") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "compose-retry";
      button.textContent = "Try again";
      button.disabled = this.isDisabled;
      button.addEventListener("click", retry);
      this.result.append(" ", button);
    }
    this.result.hidden = false;
    clearTimeout(this.resultTimer);
    // "pending-sync" (saved here, not yet sent) stays visible until the app
    // confirms the relay accepted it (markShared) or the next capture starts;
    // only a settled "saved" line fades on its own (#267).
    if (kind === "saved") this.resultTimer = setTimeout(() => { if (this.result.dataset.kind === "saved") this.clearResult(); }, 6_000);
  }

  /** Called once the relay has accepted everything this device had waiting,
   * so "saved here, waiting to sync" can truthfully become "sent" (#267). It
   * never says the household has seen or read it. A line that has moved on
   * (an error, a newer capture) is left alone. Returns whether it changed. */
  markShared() {
    if (this.result?.dataset.kind !== "pending-sync") return false;
    this.showResult("Saved and sent to your household.", { kind: "saved" });
    return true;
  }

  noteDraftChange() {
    this.draftRevision++;
    if (!this.result.hidden && this.result.dataset.kind === "error") this.clearResult();
  }

  showPendingCapture({ finish, startNew }) {
    this.result.replaceChildren(document.createTextNode("An earlier item is partly saved. Finish it, or intentionally start another item. "));
    const finishButton = document.createElement("button");
    finishButton.type = "button";
    finishButton.textContent = "Finish saved item";
    finishButton.addEventListener("click", finish);
    const newButton = document.createElement("button");
    newButton.type = "button";
    newButton.textContent = "Start a new item";
    newButton.addEventListener("click", startNew);
    this.result.append(finishButton, " ", newButton);
    this.result.dataset.kind = "error";
    this.result.hidden = false;
  }

  clearResult() {
    clearTimeout(this.resultTimer);
    this.result.replaceChildren();
    this.result.hidden = true;
    delete this.result.dataset.kind;
  }

  submit(event) {
    event.preventDefault();
    if (this.isDisabled) return;
    const text = this.input.value;
    const classification = this.currentClassification;
    if (!text.trim()) {
      this.message.textContent = "Add a few words first.";
      this.input.focus();
      return;
    }
    if (textEncoder.encode(text).length > MAX_ITEM_TEXT_BYTES) {
      this.message.textContent = TOO_LONG;
      this.input.focus();
      return;
    }
    if (this.mode === "today" && this.plan.value === "date" && !this.planDate.value) {
      this.message.textContent = "Pick a date, or choose No date.";
      this.planDate.focus();
      return;
    }
    this.message.textContent = "";
    this.clearResult();
    this.dispatchEvent(new CustomEvent("kin:add-item", {
      detail: {
        text,
        classification,
        planningDate: this.currentPlanningDate(),
        pinned: this.mode === "today" && this.pin.checked,
        composer: this,
        revision: this.draftRevision,
      },
      bubbles: true,
      composed: true,
      cancelable: false,
    }));
  }
}

customElements.define("kin-compose", KinCompose);
