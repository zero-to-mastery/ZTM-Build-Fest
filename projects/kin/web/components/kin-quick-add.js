import { CLASSIFICATION_LABELS, TOO_LONG } from "./kin-compose.js";
import { projectionContext } from "../browser-time.js";
import { REPEAT_HINTS, REPEAT_OPTIONS, isCadence, repeatLabel } from "../recurrence.js";
import { helpButton } from "./shared/help-button.js";

const MAX_ITEM_TEXT_BYTES = 4096;
const textEncoder = new TextEncoder();

function captureDefaults() {
  const [page, segment] = location.hash.replace(/^#/, "").split("/");
  if (page === "today" || !page) {
    return { classification: "need", planningDate: "today", destination: "Today" };
  }
  if (page === "lists") {
    const classification = { todo: "need", shopping: "shopping", staples: "staple" }[segment] ?? "need";
    return { classification, planningDate: null, destination: CLASSIFICATION_LABELS[classification] };
  }
  return { classification: "need", planningDate: null, destination: "To do" };
}

class KinQuickAdd extends HTMLElement {
  constructor() {
    super();
    this.isDisabled = true;
    this.pending = false;
    this.composing = false;
    this.draftRevision = 0;
  }

  connectedCallback() {
    if (this.dialog) return;
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "quick-add-trigger";
    this.trigger.textContent = "Quick add";
    this.trigger.setAttribute("aria-haspopup", "dialog");
    this.trigger.setAttribute("aria-keyshortcuts", "N");

    this.dialog = document.createElement("dialog");
    this.dialog.className = "quick-add-dialog";
    this.dialog.setAttribute("aria-labelledby", "quick-add-title");
    const heading = document.createElement("h2");
    heading.id = "quick-add-title";
    heading.textContent = "Quick add";
    const hint = document.createElement("p");
    hint.className = "quick-add-hint";
    hint.textContent = "Add a household task now. You can add dates and details later.";
    this.form = document.createElement("form");
    this.form.method = "dialog";
    this.form.className = "quick-add-form";
    this.label = document.createElement("label");
    this.label.htmlFor = "quick-add-title-input";
    this.label.textContent = "Task title";
    this.input = document.createElement("input");
    this.input.id = "quick-add-title-input";
    this.input.name = "title";
    this.input.type = "text";
    this.input.required = true;
    this.input.autocomplete = "off";
    this.input.maxLength = MAX_ITEM_TEXT_BYTES;
    this.input.setAttribute("aria-describedby", "quick-add-destination quick-add-error");
    this.destination = document.createElement("p");
    this.destination.id = "quick-add-destination";
    this.destination.className = "quick-add-destination";
    // Repeating is optional and collapsed, so a plain capture stays title +
    // Enter. Only task destinations offer it; shopping and staples don't repeat.
    this.repeat = document.createElement("details");
    this.repeat.className = "quick-add-repeat";
    this.repeatSummary = document.createElement("summary");
    this.repeatSummary.id = "quick-add-repeat-summary";
    this.repeatLabel = document.createElement("label");
    this.repeatLabel.htmlFor = "quick-add-repeat-select";
    this.repeatLabel.textContent = "How often";
    this.repeatSelect = document.createElement("select");
    this.repeatSelect.id = "quick-add-repeat-select";
    this.repeatSelect.name = "repeat";
    for (const { value, label } of REPEAT_OPTIONS) this.repeatSelect.append(new Option(label, value));
    this.repeatHint = document.createElement("p");
    this.repeatHint.id = "quick-add-repeat-hint";
    this.repeatHint.className = "quick-add-repeat-hint";
    this.repeatSelect.setAttribute("aria-describedby", this.repeatHint.id);
    this.repeat.append(this.repeatSummary, this.repeatLabel, this.repeatSelect, this.repeatHint);
    this.repeatSelect.addEventListener("change", () => {
      this.draftRevision++;
      if (!this.recoveryVisible) this.clearResult();
      this.renderRepeat();
    });
    this.error = document.createElement("p");
    this.error.id = "quick-add-error";
    this.error.className = "quick-add-error";
    this.error.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "quick-add-actions";
    this.cancelButton = document.createElement("button");
    this.cancelButton.type = "button";
    this.cancelButton.textContent = "Cancel";
    this.addButton = document.createElement("button");
    this.addButton.type = "submit";
    this.addButton.className = "add-button";
    this.addButton.textContent = "Add";
    actions.append(this.cancelButton, this.addButton);
    this.form.append(this.label, this.input, this.destination, this.repeat, this.error, actions);
    // Help for Quick add (#621), beside its heading.
    const top = document.createElement("div");
    top.className = "dialog-top";
    top.append(heading, helpButton("dialog:quick-add"));
    this.dialog.append(top, hint, this.form);
    this.append(this.trigger, this.dialog);

    this.trigger.addEventListener("click", () => this.open());
    this.cancelButton.addEventListener("click", () => {
      if (this.pending) return;
      this.clearDraft();
      this.dialog.close();
      this.restoreFocus();
    });
    this.form.addEventListener("submit", (event) => this.submit(event));
    this.input.addEventListener("input", () => {
      this.draftRevision++;
      if (!this.recoveryVisible) this.clearResult();
    });
    this.input.addEventListener("invalid", () => {
      this.error.textContent = "Enter a task title.";
      this.input.focus();
    });
    this.input.addEventListener("compositionstart", () => { this.composing = true; });
    this.input.addEventListener("compositionend", () => { this.composing = false; });
    this.dialog.addEventListener("cancel", (event) => {
      if (this.pending) {
        event.preventDefault();
        this.error.textContent = "Please wait for this task to finish saving.";
      } else {
        this.clearDraft();
      }
    });
    // Escape and other native closes restore focus here. Our own close calls
    // restore it at once instead (see restoreFocus).
    this.dialog.addEventListener("close", () => this.restoreFocus());
    this.disabled = this.isDisabled;
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    if (!this.trigger) return;
    this.trigger.disabled = this.isDisabled;
    const saving = this.pending;
    this.input.disabled = this.isDisabled || saving;
    this.repeatSelect.disabled = this.isDisabled || saving;
    this.addButton.disabled = this.isDisabled || saving;
    this.cancelButton.disabled = saving;
  }

  open({ opener = null, fallback = null } = {}) {
    if (this.isDisabled || this.dialog.open) return;
    this.clearDraft();
    this.defaults = captureDefaults();
    // Repeating tasks are Routines: offered only while Routines is on (#625).
    this.repeat.hidden = this.defaults.classification !== "need" || this.repeatAllowed === false;
    this.renderRepeat();
    this.opener = opener?.isConnected ? opener : this.trigger;
    this.fallback = typeof fallback === "function" ? fallback : null;
    this.dialog.showModal();
    this.input.focus();
  }

  // Focus goes back once per dialog session. The close event is queued, so
  // when the dialog was reopened and closed before it ran, a late event
  // used to take the newer session's opener and fallback, and the next
  // close then fell back to the trigger. Every close we make calls this
  // straight away; a late event then finds the dialog open again or the
  // opener already cleared, and does nothing.
  restoreFocus() {
    if (this.dialog.open || !this.opener) return;
    // An opener inside a list can be replaced by the save's re-render.
    const target = this.opener.isConnected ? this.opener : this.fallback?.() ?? this.trigger;
    if (target?.isConnected) target.focus();
    this.opener = null;
    this.fallback = null;
  }

  submit(event) {
    event.preventDefault();
    if (this.pending || this.isDisabled || this.composing || event.isComposing) return;
    const text = this.input.value;
    if (!text.trim()) {
      this.input.setCustomValidity("Enter a task title.");
      this.input.reportValidity();
      this.error.textContent = "Enter a task title.";
      this.input.setCustomValidity("");
      return;
    }
    if (textEncoder.encode(text).length > MAX_ITEM_TEXT_BYTES) {
      this.error.textContent = TOO_LONG;
      this.input.focus();
      return;
    }
    const cadence = this.cadence;
    if (this.repeatSelect.value && !cadence) {
      this.error.textContent = "Choose how often it repeats.";
      this.repeatSelect.focus();
      return;
    }
    this.error.textContent = "";
    this.pending = true;
    this.disabled = this.isDisabled;
    this.addButton.textContent = "Saving…";
    // A repeating task is scheduled by Rust from today; it takes no planning date.
    const planningDate = cadence || this.defaults.planningDate !== "today" ? null : projectionContext().civilDate;
    this.dispatchEvent(new CustomEvent("kin:add-item", {
      detail: { text, classification: this.defaults.classification, planningDate, pinned: false, cadence, composer: this, revision: this.draftRevision },
      bubbles: true,
      composed: true,
    }));
  }

  clearIfMatches(draft) {
    if (this.input.value !== draft.text || this.draftRevision !== draft.revision) return;
    this.pending = false;
    this.addButton.textContent = "Add";
    this.clearDraft();
    this.dialog.close("saved");
    this.restoreFocus();
  }

  showResult(text, { kind = "saved" } = {}) {
    if (kind === "saved" && !this.dialog.open) return;
    this.pending = false;
    this.addButton.textContent = "Add";
    const finishingPrevious = kind === "saved" && this.recoveryVisible;
    this.clearResult();
    this.error.setAttribute("role", kind === "error" ? "alert" : "status");
    this.error.textContent = finishingPrevious ? "Previous task finished. Your new title is still here." : text;
    this.disabled = this.isDisabled;
    this.input.focus();
  }

  showPendingCapture({ finish, startNew }) {
    this.pending = false;
    this.addButton.textContent = "Add";
    this.clearResult();
    this.recoveryVisible = true;
    this.error.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = "Previous task needs attention";
    const explanation = document.createElement("span");
    explanation.textContent = " The task was created, but its remaining details could not be saved.";
    const actions = document.createElement("span");
    actions.className = "quick-add-recovery-actions";
    const finishButton = document.createElement("button");
    finishButton.type = "button";
    finishButton.textContent = "Finish previous task";
    const startButton = document.createElement("button");
    startButton.type = "button";
    startButton.textContent = "Start new task";
    const run = (action) => {
      if (this.pending || this.isDisabled) return;
      this.pending = true;
      this.disabled = this.isDisabled;
      action();
    };
    finishButton.addEventListener("click", () => run(finish));
    startButton.addEventListener("click", () => run(startNew));
    actions.append(finishButton, startButton);
    this.error.append(title, explanation, actions);
    this.disabled = this.isDisabled;
    finishButton.focus();
  }

  clearResult() {
    this.recoveryVisible = false;
    this.error?.replaceChildren();
    this.error?.setAttribute("role", "alert");
  }

  focusInput() { if (this.dialog.open) this.input.focus(); }

  // The chosen schedule, or null for a one-off task (also when the
  // destination cannot repeat).
  get cadence() {
    const value = this.repeatSelect?.value;
    return !this.repeat?.hidden && isCadence(value) ? value : null;
  }

  // The selection is always visible before saving: in the collapsed summary
  // and in the destination line the title field is described by.
  renderRepeat() {
    if (!this.defaults) return;
    const cadence = this.cadence;
    this.repeatSummary.textContent = `Repeat: ${cadence ? repeatLabel(cadence) : "Does not repeat"}`;
    this.repeatHint.textContent = cadence ? REPEAT_HINTS[cadence] : "Adds a one-time task.";
    this.destination.textContent = cadence
      ? `Adds a repeating task (${repeatLabel(cadence).toLowerCase()}). It shows on Today whenever it's due.`
      : `Adds to ${this.defaults.destination}.`;
  }

  clearDraft() {
    this.input.value = "";
    if (this.repeatSelect) {
      this.repeatSelect.value = "";
      this.repeat.open = false;
      this.renderRepeat();
    }
    this.clearResult();
  }

  reset() {
    this.pending = false;
    this.draftRevision++;
    if (this.dialog?.open) {
      this.dialog.close();
      this.restoreFocus();
    }
    if (this.input) this.clearDraft();
    if (this.addButton) this.addButton.textContent = "Add";
  }
}

customElements.define("kin-quick-add", KinQuickAdd);
