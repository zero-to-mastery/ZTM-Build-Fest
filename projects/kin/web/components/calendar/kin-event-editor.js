// Adding and changing a calendar event (#662, ADR 0022 §2): a dialog whose
// first fields are all a quick add needs (title, when, who); place, notes,
// repeats and the countdown wait under "More details". Editing a repeating
// event asks whether the change is for this one or all of them; Cancel
// offers the same choice. Nothing is saved here: the dialog hands a draft
// to the calendar controller (`kin:calendar-save`, `kin:calendar-cancel`)
// with a `done(outcome)` callback, and shows what came back:
// - { ok: true }: closes; Undo is offered on the page.
// - { conflict: true, message }: the event changed on another device while
//   the dialog was open; the person can see the latest or keep theirs.
// - { error }: a plain message, beside the form.
import { fromIsoDate, fromTimeText, isoDate, timeText, viewerZone, weekday } from "../../calendar/calendar-time.js";
import { FREQUENCY_CHOICES, choicesFromRepeat, describeRepeat, monthlyChoices, repeatFromChoices } from "../../calendar/repeat.js";
import { weekdayNames } from "../../calendar/calendar-layout.js";
import { colourClass } from "../../calendar/member-colours.js";
import { helpButton } from "../shared/help-button.js";

let unique = 0;
const MAX_TITLE = 200;

class KinEventEditor extends HTMLElement {
  connectedCallback() {
    if (this.dialog) return;
    const id = (name) => `event-${name}`;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "quick-add-dialog event-editor";
    this.dialog.setAttribute("aria-labelledby", id("heading"));
    const top = document.createElement("div");
    top.className = "dialog-top";
    this.heading = document.createElement("h2");
    this.heading.id = id("heading");
    top.append(this.heading, helpButton("dialog:event-editor"));
    this.form = document.createElement("form");
    this.form.className = "event-form";
    this.form.noValidate = true;
    this.form.addEventListener("submit", (event) => { event.preventDefault(); this.save(); });

    // Which occurrences a change is for (repeating events only).
    this.scope = this.radios("scope", "Change", [["one", "Just this one"], ["all", "All of them"]]);
    this.scope.classList.add("event-scope");

    this.titleField = this.field("title", "What", "input", { type: "text", required: true, autocomplete: "off", maxLength: MAX_TITLE });
    this.date = this.field("date", "Day", "input", { type: "date", required: true });
    this.allDay = this.check("all-day", "All day");
    this.start = this.field("start", "Starts", "input", { type: "time", step: 300 });
    this.end = this.field("end", "Ends", "input", { type: "time", step: 300 });
    const times = document.createElement("div");
    times.className = "event-times";
    times.append(this.start.wrap, this.end.wrap);
    this.timesRow = times;
    this.allDay.input.addEventListener("change", () => this.renderTimes());
    this.date.input.addEventListener("change", () => this.dateChanged());

    this.who = document.createElement("fieldset");
    this.who.className = "event-who";
    const whoLegend = document.createElement("legend");
    whoLegend.textContent = "Who";
    this.whoList = document.createElement("div");
    this.whoList.className = "event-who-list";
    const whoHint = document.createElement("p");
    whoHint.className = "section-hint";
    whoHint.textContent = "Choose nobody for something for everyone.";
    this.who.append(whoLegend, this.whoList, whoHint);

    // More details.
    this.details = document.createElement("details");
    this.details.className = "event-more";
    const summary = document.createElement("summary");
    summary.textContent = "More details";
    this.endDate = this.field("end-date", "Last day", "input", { type: "date" });
    this.place = this.field("place", "Where", "input", { type: "text", autocomplete: "off", maxLength: 200 });
    this.notes = this.field("notes", "Notes", "textarea", { rows: 3 });
    this.zoneNote = document.createElement("p");
    this.zoneNote.className = "section-hint event-zone";
    this.repeat = this.repeatEditor();
    this.countdown = this.check("countdown", "Count down to this on Today");
    this.details.append(summary, this.endDate.wrap, this.place.wrap, this.notes.wrap, this.repeat, this.countdown.wrap, this.zoneNote);

    this.error = document.createElement("p");
    this.error.className = "quick-add-error event-error";
    this.error.id = id("error");
    this.error.setAttribute("role", "alert");
    this.titleField.input.setAttribute("aria-describedby", this.error.id);
    // Changed on another device while open.
    this.conflict = document.createElement("div");
    this.conflict.className = "event-conflict";
    this.conflict.hidden = true;
    this.conflictText = document.createElement("p");
    this.conflictText.setAttribute("role", "alert");
    const latest = this.button("secondary", "Show the latest", () => this.showLatest());
    const keep = this.button("", "Keep my changes", () => this.save({ force: true }));
    this.conflict.append(this.conflictText, latest, keep);

    // Cancelling an existing event.
    this.cancelArea = document.createElement("div");
    this.cancelArea.className = "event-cancel";
    this.cancelButton = this.button("event-cancel-open danger-quiet", "Cancel this event…", () => this.askCancel());
    this.cancelChoices = document.createElement("div");
    this.cancelChoices.className = "event-cancel-choices";
    this.cancelChoices.setAttribute("role", "group");
    this.cancelChoices.hidden = true;
    const cancelQuestion = document.createElement("p");
    cancelQuestion.className = "event-cancel-question";
    cancelQuestion.id = id("cancel-question");
    this.cancelChoices.setAttribute("aria-labelledby", cancelQuestion.id);
    this.cancelQuestion = cancelQuestion;
    this.cancelOne = this.button("event-cancel-one", "Just this one", () => this.cancel("one"));
    this.cancelAll = this.button("event-cancel-all", "All of them", () => this.cancel("all"));
    this.cancelBack = this.button("secondary", "Keep it", () => { this.cancelChoices.hidden = true; this.cancelButton.focus(); });
    this.cancelChoices.append(cancelQuestion, this.cancelOne, this.cancelAll, this.cancelBack);
    this.cancelArea.append(this.cancelButton, this.cancelChoices);

    const actions = document.createElement("div");
    actions.className = "quick-add-actions";
    this.closeButton = this.button("", "Close", () => this.close());
    this.saveButton = document.createElement("button");
    this.saveButton.type = "submit";
    this.saveButton.className = "add-button event-save";
    this.saveButton.textContent = "Save";
    actions.append(this.closeButton, this.saveButton);

    this.form.append(this.scope, this.titleField.wrap, this.date.wrap, this.allDay.wrap, times, this.who, this.details, this.error, this.conflict, this.cancelArea, actions);
    this.dialog.append(top, this.form);
    this.dialog.addEventListener("cancel", (event) => { if (this.pending) event.preventDefault(); });
    this.dialog.addEventListener("close", () => {
      const target = this.opener?.isConnected ? this.opener : this.fallback?.();
      this.opener = null;
      this.fallback = null;
      target?.focus?.();
    });
    this.append(this.dialog);
  }

  // ---- Building ------------------------------------------------------------

  button(className, text, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    if (className) button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  field(name, label, tag, attributes = {}) {
    const wrap = document.createElement("div");
    wrap.className = `event-field event-field-${name}`;
    const labelNode = document.createElement("label");
    labelNode.htmlFor = `event-${name}`;
    labelNode.textContent = label;
    const input = document.createElement(tag);
    input.id = `event-${name}`;
    input.name = name;
    Object.assign(input, attributes);
    wrap.append(labelNode, input);
    return { wrap, input, label: labelNode };
  }

  check(name, label) {
    const wrap = document.createElement("label");
    wrap.className = `event-check event-check-${name}`;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `event-${name}`;
    input.name = name;
    wrap.append(input, document.createTextNode(` ${label}`));
    return { wrap, input };
  }

  radios(name, legendText, options) {
    const set = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = legendText;
    set.append(legend);
    for (const [value, label] of options) {
      const wrap = document.createElement("label");
      wrap.className = "event-radio";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `event-${name}`;
      input.value = value;
      wrap.append(input, document.createTextNode(` ${label}`));
      set.append(wrap);
    }
    return set;
  }

  repeatEditor() {
    const set = document.createElement("fieldset");
    set.className = "event-repeat";
    const legend = document.createElement("legend");
    legend.textContent = "Repeat";
    this.frequency = this.field("repeat", "How often", "select");
    for (const { value, label } of FREQUENCY_CHOICES) this.frequency.input.append(new Option(label, value));
    this.interval = this.field("interval", "Every", "input", { type: "number", min: 1, max: 1000, step: 1, value: 1, inputMode: "numeric" });
    this.intervalUnit = document.createElement("span");
    this.intervalUnit.className = "event-interval-unit";
    this.interval.wrap.append(this.intervalUnit);
    this.weekdays = document.createElement("fieldset");
    this.weekdays.className = "event-weekdays";
    const daysLegend = document.createElement("legend");
    daysLegend.textContent = "On";
    this.weekdays.append(daysLegend);
    const names = weekdayNames("long"), shorts = weekdayNames("short");
    this.weekdayBoxes = names.map((name, index) => {
      const wrap = document.createElement("label");
      wrap.className = "event-weekday";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = String(index);
      input.setAttribute("aria-label", name);
      const text = document.createElement("span");
      text.textContent = shorts[index];
      text.setAttribute("aria-hidden", "true");
      wrap.append(input, text);
      this.weekdays.append(wrap);
      return input;
    });
    this.monthly = this.field("monthly", "Which day", "select");
    this.repeatEnd = this.field("repeat-end", "Ends", "select");
    for (const [value, label] of [["never", "Never"], ["count", "After a number of times"], ["until", "On a date"]]) this.repeatEnd.input.append(new Option(label, value));
    this.count = this.field("count", "Times", "input", { type: "number", min: 1, max: 1000, step: 1, value: 10, inputMode: "numeric" });
    this.until = this.field("until", "Last date", "input", { type: "date" });
    this.repeatSummary = document.createElement("p");
    this.repeatSummary.className = "section-hint event-repeat-summary";
    this.repeatSummary.setAttribute("aria-live", "polite");
    for (const control of [this.frequency.input, this.interval.input, this.monthly.input, this.repeatEnd.input, this.count.input, this.until.input, ...this.weekdayBoxes])
      control.addEventListener("change", () => this.renderRepeat());
    set.append(legend, this.frequency.wrap, this.interval.wrap, this.weekdays, this.monthly.wrap, this.repeatEnd.wrap, this.count.wrap, this.until.wrap, this.repeatSummary);
    return set;
  }

  // ---- Opening -------------------------------------------------------------

  get isOpen() {
    return Boolean(this.dialog?.open);
  }

  /**
   * Opens for a new event on `date` (at `minute`, or all day when null), or
   * for an existing occurrence (`placed`, with its full `event`). `people`
   * is [{ memberId, label, colour }]; `me` is this member's ID (chosen by
   * default for a new event).
   */
  open({ placed = null, date, minute = null, people = [], me = null, opener = null, fallback = null } = {}) {
    if (!this.dialog) this.connectedCallback();
    this.opener = opener;
    this.fallback = fallback;
    this.placed = placed;
    this.people = people;
    this.pending = false;
    this.base = placed ? placed.occurrence.event : null;
    this.instance = unique += 1;
    this.error.textContent = "";
    this.conflict.hidden = true;
    this.cancelChoices.hidden = true;
    const event = this.base;
    const repeating = Boolean(event?.repeat);
    this.heading.textContent = event ? "Change event" : "Add an event";
    this.scope.hidden = !repeating;
    for (const input of this.scope.querySelectorAll("input")) input.checked = input.value === "one";
    this.cancelArea.hidden = !event;
    this.cancelButton.textContent = repeating || event?.series ? "Cancel…" : "Cancel this event…";
    this.fill(event, placed, date, minute, me);
    this.details.open = Boolean(event && (event.place || event.notes || event.repeat || event.countdown || event.end.date !== event.start.date));
    if (!this.dialog.open) this.dialog.showModal();
    this.titleField.input.focus();
  }

  /** Puts an event (or a new one's defaults) into the fields. For a
   * repeating event, the dates are this occurrence's. */
  fill(event, placed, date, minute, me) {
    const occurrence = placed?.occurrence;
    const start = occurrence ? occurrence.start : { date, minute: minute ?? 9 * 60 };
    const end = occurrence ? occurrence.end : { date, minute: Math.min((minute ?? 9 * 60) + 60, 1439) };
    this.zone = event ? event.zone : viewerZone();
    this.titleField.input.value = event?.title ?? "";
    this.date.input.value = isoDate(start.date);
    this.allDay.input.checked = event ? event.allDay : minute == null;
    this.start.input.value = timeText(event?.allDay || (!event && minute == null) ? 9 * 60 : start.minute);
    this.end.input.value = timeText(event?.allDay || (!event && minute == null) ? 10 * 60 : end.minute);
    this.endDate.input.value = isoDate(end.date);
    this.previousDate = start.date;
    this.place.input.value = event?.place ?? "";
    this.notes.input.value = event?.notes ?? "";
    this.countdown.input.checked = event?.countdown === true;
    const attendees = new Set(event ? event.attendees : me ? [me] : []);
    this.whoList.replaceChildren(...this.people.map((person) => {
      const wrap = document.createElement("label");
      wrap.className = "event-person";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = person.memberId;
      input.checked = attendees.has(person.memberId);
      const swatch = document.createElement("span");
      swatch.className = `cal-swatch ${colourClass(person.colour)}`;
      swatch.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.textContent = person.label;
      wrap.append(input, swatch, name);
      return wrap;
    }));
    // Someone listed who has since left still shows, so saving keeps them.
    for (const memberId of attendees) {
      if (this.people.some((person) => person.memberId === memberId)) continue;
      const wrap = document.createElement("label");
      wrap.className = "event-person";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = memberId;
      input.checked = true;
      wrap.append(input, document.createTextNode(" A former household member"));
      this.whoList.append(wrap);
    }
    const choices = choicesFromRepeat(event?.repeat ?? null, event?.start.date ?? start.date);
    this.frequency.input.value = choices.frequency;
    this.interval.input.value = String(choices.interval);
    for (const box of this.weekdayBoxes) box.checked = choices.weekdays.includes(Number(box.value));
    this.monthlyChoice = choices.monthly;
    this.repeatEnd.input.value = choices.end;
    this.count.input.value = String(choices.count);
    this.until.input.value = choices.until ? isoDate(choices.until) : "";
    const zone = this.zone;
    this.zoneNote.textContent = event && !event.allDay
      ? (!zone ? "Times are as written, wherever you are." : zone !== viewerZone() ? `Times are in ${zone}; the calendar shows them in your own time.` : "")
      : "";
    this.zoneNote.hidden = !this.zoneNote.textContent;
    this.renderTimes();
    this.renderRepeat();
  }

  /** A new start day moves an end on the old start day (or before the new
   * one) along with it. */
  dateChanged() {
    const date = fromIsoDate(this.date.input.value);
    const end = fromIsoDate(this.endDate.input.value);
    if (date && (end == null || end === this.previousDate || end < date)) this.endDate.input.value = isoDate(date);
    if (date) this.previousDate = date;
    this.renderRepeat();
  }

  renderTimes() {
    const allDay = this.allDay.input.checked;
    this.timesRow.hidden = allDay;
    this.endDate.label.textContent = allDay ? "Last day" : "Ends on";
  }

  /** The date the repeat follows: the series' own start when changing all
   * of a repeating event, else the date in the form. */
  repeatStart() {
    const scopeAll = this.scope.querySelector('input[value="all"]')?.checked;
    if (this.base?.repeat && scopeAll) return this.base.start.date;
    return fromIsoDate(this.date.input.value) ?? this.base?.start.date ?? 20000101;
  }

  renderRepeat() {
    const start = this.repeatStart();
    const frequency = this.frequency.input.value;
    const choices = monthlyChoices(start);
    const keep = this.monthly.input.value || this.monthlyChoice;
    this.monthly.input.replaceChildren(...choices.map((choice) => new Option(choice.label, choice.id)));
    this.monthly.input.value = choices.some((choice) => choice.id === keep) ? keep : "day";
    this.monthlyChoice = null;
    const units = { daily: "days", weekly: "weeks", monthly: "months", yearly: "years" };
    this.intervalUnit.textContent = ` ${units[frequency] ?? ""}`;
    this.interval.wrap.hidden = !frequency;
    this.weekdays.hidden = frequency !== "weekly";
    if (frequency === "weekly" && !this.weekdayBoxes.some((box) => box.checked)) this.weekdayBoxes[weekday(start)].checked = true;
    this.monthly.wrap.hidden = frequency !== "monthly" && frequency !== "yearly";
    this.repeatEnd.wrap.hidden = !frequency;
    this.count.wrap.hidden = !frequency || this.repeatEnd.input.value !== "count";
    this.until.wrap.hidden = !frequency || this.repeatEnd.input.value !== "until";
    this.repeatSummary.textContent = describeRepeat(this.repeatValue(start), start);
  }

  repeatValue(start = this.repeatStart()) {
    return repeatFromChoices({
      frequency: this.frequency.input.value,
      interval: this.interval.input.value,
      weekdays: this.weekdayBoxes.filter((box) => box.checked).map((box) => Number(box.value)),
      monthly: this.monthly.input.value,
      end: this.repeatEnd.input.value,
      count: this.count.input.value,
      until: fromIsoDate(this.until.input.value),
    }, start);
  }

  // ---- Saving --------------------------------------------------------------

  /** The draft from the fields, or null with a message shown. */
  draft() {
    const title = this.titleField.input.value.trim();
    if (!title) return this.invalid(this.titleField.input, "Write what the event is.");
    const date = fromIsoDate(this.date.input.value);
    if (!date) return this.invalid(this.date.input, "Choose the day.");
    const allDay = this.allDay.input.checked;
    let endDate = fromIsoDate(this.endDate.input.value) ?? date;
    if (endDate < date) endDate = date;
    let start = { date, minute: 0 }, end = { date: endDate, minute: 0 };
    if (!allDay) {
      const startMinute = fromTimeText(this.start.input.value), endMinute = fromTimeText(this.end.input.value);
      if (startMinute == null) return this.invalid(this.start.input, "Choose when it starts.");
      if (endMinute == null) return this.invalid(this.end.input, "Choose when it ends.");
      start = { date, minute: startMinute };
      // Ending earlier on the same day means the next morning.
      end = { date: endDate, minute: endMinute };
      if (endDate === date && endMinute < startMinute) return this.invalid(this.end.input, "It can't end before it starts. To end the next day, change \"Ends on\" under More details.");
    }
    const repeat = this.repeatValue();
    if (repeat?.until && repeat.until < date) return this.invalid(this.until.input, "The repeat can't end before the event starts.");
    const attendees = [...this.whoList.querySelectorAll("input:checked")].map((input) => input.value);
    if (attendees.length > 16) return this.invalid(this.whoList.querySelector("input"), "Choose at most 16 people.");
    return {
      title, allDay, start, end, zone: allDay ? "" : this.zone ?? viewerZone(),
      attendees, place: this.place.input.value, notes: this.notes.input.value,
      repeat, countdown: this.countdown.input.checked,
    };
  }

  invalid(control, message) {
    this.error.textContent = message;
    if (control?.closest("details") && !control.closest("details").open) control.closest("details").open = true;
    control?.focus();
    return null;
  }

  scopeValue() {
    return this.scope.hidden ? "all" : (this.scope.querySelector("input:checked")?.value ?? "one");
  }

  setPending(pending) {
    this.pending = pending;
    for (const control of this.form.querySelectorAll("button, input, select, textarea")) control.disabled = pending;
  }

  /** Hands the draft to the controller and shows the outcome. */
  save({ force = false } = {}) {
    if (this.pending) return;
    const draft = this.draft();
    if (!draft) return;
    this.error.textContent = "";
    this.conflict.hidden = true;
    const instance = this.instance;
    this.setPending(true);
    this.dispatchEvent(new CustomEvent("kin:calendar-save", {
      bubbles: true, composed: true,
      detail: { draft, placed: this.placed, base: this.base, scope: this.scopeValue(), force, done: (outcome) => this.finish(instance, outcome) },
    }));
  }

  askCancel() {
    const repeating = Boolean(this.base?.repeat);
    this.cancelQuestion.textContent = repeating ? "Cancel just this one, or every time it repeats?" : "Cancel this event?";
    this.cancelOne.hidden = !repeating;
    this.cancelAll.textContent = repeating ? "All of them" : "Cancel it";
    this.cancelChoices.hidden = false;
    (repeating ? this.cancelOne : this.cancelAll).focus();
  }

  cancel(scope) {
    if (this.pending) return;
    const instance = this.instance;
    this.setPending(true);
    this.dispatchEvent(new CustomEvent("kin:calendar-cancel", {
      bubbles: true, composed: true,
      detail: { placed: this.placed, base: this.base, scope: this.base?.repeat ? scope : "all", done: (outcome) => this.finish(instance, outcome) },
    }));
  }

  finish(instance, outcome = {}) {
    if (instance !== this.instance || !this.dialog.open) return;
    this.setPending(false);
    if (outcome.ok) { this.close(); return; }
    if (outcome.conflict) {
      this.latest = outcome.latest ?? null;
      this.conflictText.textContent = outcome.message ?? "This event changed on another device while you were editing it. Nothing was saved yet.";
      this.conflict.hidden = false;
      this.conflict.querySelector("button")?.focus();
      return;
    }
    this.error.textContent = outcome.error ?? "Kin couldn't save that. Try again.";
  }

  /** Puts the latest version (from a conflict) into the fields. */
  showLatest() {
    const latest = this.latest;
    this.conflict.hidden = true;
    if (!latest) { this.close(); return; }
    this.base = latest.occurrence.event;
    this.placed = latest;
    this.fill(this.base, latest, latest.occurrence.start.date, null, null);
    this.titleField.input.focus();
  }

  close() {
    if (this.pending) return;
    if (this.dialog?.open) this.dialog.close();
  }

  /** Locking: the dialog and anything typed into it go. */
  reset() {
    this.pending = false;
    this.instance = unique += 1;
    if (this.dialog?.open) this.dialog.close();
    if (this.form) this.form.reset();
    this.placed = null;
    this.base = null;
    this.latest = null;
  }
}

if (!customElements.get("kin-event-editor")) customElements.define("kin-event-editor", KinEventEditor);
