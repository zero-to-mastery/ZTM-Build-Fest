import { REPEAT_HINTS, REPEAT_OPTIONS, describeNextOccurrence, describeRepeat } from "../recurrence.js";

// One Routine's schedule editor: a "Schedule" disclosure with the current
// schedule, a Repeat select and "Change schedule".
//
// Rust has no schedule-change event and history is never rewritten, so a
// change explicitly starts a new schedule today and stops this one; stopping
// keeps every past completion. Submitting dispatches the household command
// `kin:change-routine-schedule` ({ routineId, cadence }).
//
// <kin-routines> rebuilds its rows on every render, so it keeps which editor
// is open and the unsaved choice. This element reports both as non-bubbling
// events: "schedule-toggle" ({ open }) and "schedule-draft" ({ cadence },
// null when the choice is back to the current cadence).

class KinRoutineSchedule extends HTMLElement {
  constructor() {
    super();
    this.isDisabled = false;
  }

  /**
   * Builds the editor once for `record` (a projection Routine).
   * @param idPrefix  keeps element ids unique per row
   * @param civilDate today, for the next-occurrence text
   * @param mode      household mode; the next date shows only in normal mode
   * @param open      whether the disclosure starts open
   * @param draft     an unsaved cadence to restore, or null
   * @param disabled  whether the app is busy
   */
  setup(record, { idPrefix, civilDate, mode, open, draft, disabled }) {
    this.record = record;
    this.isDisabled = Boolean(disabled);
    const details = document.createElement("details");
    details.className = "routine-schedule";
    details.open = open;
    const summary = document.createElement("summary");
    summary.textContent = "Schedule";
    summary.setAttribute("aria-label", `Schedule for ${record.text}`);
    details.append(summary);
    details.addEventListener("toggle", () => this.dispatchEvent(new CustomEvent("schedule-toggle", { detail: { open: details.open } })));
    const form = document.createElement("form");
    form.className = "routine-schedule-form";
    form.noValidate = true;
    const current = document.createElement("p");
    const next = describeNextOccurrence(record.nextOn, civilDate);
    current.textContent = `${describeRepeat(record.cadence)}.${next && mode === "normal" ? ` ${next}.` : ""}`;
    const label = document.createElement("label");
    label.htmlFor = `${idPrefix}-cadence`;
    label.textContent = "Repeat";
    this.select = document.createElement("select");
    this.select.id = `${idPrefix}-cadence`;
    this.select.dataset.routineId = record.routineId;
    for (const { value, label: text } of REPEAT_OPTIONS.slice(1)) this.select.append(new Option(text, value));
    this.select.value = draft ?? record.cadence;
    this.scope = document.createElement("p");
    this.scope.id = `${idPrefix}-scope`;
    this.select.setAttribute("aria-describedby", this.scope.id);
    this.save = document.createElement("button");
    this.save.type = "submit";
    this.save.className = "add-button";
    this.save.textContent = "Change schedule";
    this.save.dataset.routineId = record.routineId;
    this.save.dataset.action = "change-routine-schedule";
    this.select.addEventListener("change", () => {
      const cadence = this.select.value === record.cadence ? null : this.select.value;
      this.dispatchEvent(new CustomEvent("schedule-draft", { detail: { cadence } }));
      this.describeScope();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.isDisabled || this.select.value === record.cadence) return;
      this.dispatchEvent(new CustomEvent("kin:change-routine-schedule", {
        detail: { routineId: record.routineId, cadence: this.select.value },
        bubbles: true, composed: true,
      }));
    });
    const buttons = document.createElement("div");
    buttons.className = "routine-schedule-actions";
    buttons.append(this.save);
    form.append(current, label, this.select, this.scope, buttons);
    details.append(form);
    this.append(details);
    this.select.disabled = this.isDisabled;
    this.describeScope();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    if (!this.select) return;
    this.select.disabled = this.isDisabled;
    this.describeScope();
  }

  // "Change schedule" is enabled only for a different cadence; the text
  // below the select says what a change would do.
  describeScope() {
    const record = this.record;
    const changed = this.select.value !== record.cadence;
    this.save.dataset.domainDisabled = String(!changed);
    this.save.disabled = this.isDisabled || !changed;
    this.scope.textContent = changed
      ? `${REPEAT_HINTS[this.select.value]} The new schedule starts today. Past completions stay with the current schedule, and ${record.occurrenceStatus === "completed" ? "this period's done mark" : "the open occurrence"} does not carry over.`
      : "Choose a different schedule to change it, or use Delete routine to end it. Past completions are always kept.";
  }
}

customElements.define("kin-routine-schedule", KinRoutineSchedule);
