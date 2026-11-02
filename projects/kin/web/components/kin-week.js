// This week (#416, #421, #425): the next seven days in one calm list. Each
// day is a headed section with its planned items, routine occurrences,
// meals (#679: every slot) and maintenance due. The days and what falls on them come from Rust
// (`kin_week`); this component only names and draws them. Items complete and
// reopen with the ordinary commands (Undo applies) and move to another day
// with "Move to…"; routines complete for the current period only.
// In the Calendar (#661, ADR 0022 §2) this list is the Week view: each day
// starts with its calendar events (from `kin_calendar_range`, placed in the
// viewer's time by the calendar controller), in each person's colour with
// their names.
import { assigneeLabel } from "./shared/assignee-label.js";
import { describePlanningDate, formatCivilDate, nextCivilDate } from "../today-view.js";
import { mergePrivateIntoWeek } from "../private-items.js";
import { privateItemRow } from "./shared/private-marker.js";
import { SLOT_LABELS } from "../meals/meals-view.js";
import { eventChip } from "./calendar/event-chip.js";

const CADENCE = { daily: "Every day", weekdays: "Weekdays", weekly: "Every week", biweekly: "Every two weeks", monthly: "Every month" };

function dayName(date, today) {
  if (date === today) return "Today";
  if (date === nextCivilDate(today)) return "Tomorrow";
  return formatCivilDate(date);
}

/** The next seven civil dates from `start`. */
function weekDates(start) {
  const dates = [start];
  while (dates.length < 7) dates.push(nextCivilDate(dates.at(-1)));
  return dates;
}

class KinWeek extends HTMLElement {
  constructor() {
    super();
    this.days = [];
    this.today = null;
    this.state = null;
    this.context = {};
    this.isDisabled = false;
    this.events = new Map();
    this.people = null;
  }

  connectedCallback() {
    if (!this.list) {
      this.list = document.createElement("div");
      this.list.className = "week-days";
      this.replaceChildren(this.list);
    }
    this.render();
  }

  /** `{ days, today, state, context, privateItems }`: the week from Rust,
   * today's civil date, the projection (for text), the responsibility
   * context and this member's private items for This week (#514; none in
   * Simple view or with their setting off). */
  update({ days, today, state, context, privateItems = [], events = null, people = null }) {
    this.days = mergePrivateIntoWeek(days ?? [], privateItems);
    // The calendar's events by date (#661): Map date → { allDay, timed }.
    this.events = events ?? new Map();
    this.people = people;
    this.today = today;
    this.state = state;
    this.context = context ?? {};
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button, input, select")) control.disabled = this.isDisabled;
  }

  render() {
    if (!this.list) return;
    const focusKey = this.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    const items = new Map((this.state?.items ?? []).map((item) => [item.itemId, item]));
    const routines = new Map((this.state?.routines ?? []).map((routine) => [routine.routineId, routine]));
    const maintenance = new Map((this.state?.maintenanceEvents ?? []).map((entry) => [entry.maintenanceId, entry]));
    const records = new Map((this.state?.referenceRecords ?? []).map((record) => [record.recordId, record]));
    if (!this.days.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Loading the week…";
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...this.days.map((day) => {
      const section = document.createElement("section");
      section.className = "week-day";
      section.dataset.date = String(day.date);
      const heading = document.createElement("h2");
      heading.id = `week-${day.date}`;
      heading.textContent = dayName(day.date, this.today);
      if (heading.textContent === "Today" || heading.textContent === "Tomorrow") {
        const date = document.createElement("span");
        date.className = "week-date";
        date.textContent = ` · ${formatCivilDate(day.date, undefined, { month: "long", day: "numeric" })}`;
        heading.append(date);
      }
      section.setAttribute("aria-labelledby", heading.id);
      section.append(heading);
      const list = document.createElement("ul");
      list.className = "week-list";
      // Calendar events first (#661): all-day, then by time.
      const events = this.events.get(day.date);
      if (events && this.people) {
        for (const placed of [...events.allDay, ...events.timed.map((segment) => segment.placed)]) {
          const row = document.createElement("li");
          row.className = "week-row week-event";
          const chip = eventChip(placed, day.date, this.people);
          chip.disabled = this.isDisabled;
          row.append(chip);
          list.append(row);
        }
      }
      // Every meal of the day (#679), in planner order; Rust's own week has
      // the dinner only, so a meal without a slot is dinner.
      for (const meal of day.meals) list.append(this.line("week-meal", `${SLOT_LABELS[meal.slot] ?? "Dinner"}: ${meal.name}`));
      for (const entry of day.items) {
        const item = items.get(entry.itemId);
        if (item) list.append(this.itemRow(item, entry, day.date));
      }
      // Just for me (#514): only this member's, marked "Private".
      for (const item of day.privateItems ?? []) {
        list.append(privateItemRow(item, {
          className: "week-row week-private",
          disabled: this.isDisabled,
          meta: item.date < day.date ? describePlanningDate(item.date, this.today) : null,
          onToggle: (itemId, completed) => this.emit("kin:toggle-private-item", { itemId, completed }),
        }));
      }
      for (const entry of day.routines) {
        const routine = routines.get(entry.routineId);
        if (routine) list.append(this.routineRow(routine, entry));
      }
      for (const entry of day.maintenance) {
        const event = maintenance.get(entry.maintenanceId);
        const record = records.get(entry.recordId);
        if (event) list.append(this.line("week-maintenance", `Maintenance due: ${record?.title ? `${record.title} — ` : ""}${event.summary}`));
      }
      if (day.omitted) list.append(this.line("week-more", day.omitted === 1 ? "1 more not shown" : `${day.omitted} more not shown`));
      if (list.children.length) section.append(list);
      else {
        const empty = document.createElement("p");
        empty.className = "week-empty";
        empty.textContent = "Nothing planned.";
        section.append(empty);
      }
      return section;
    }));
    if (focusKey) [...this.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  }

  line(className, text) {
    const row = document.createElement("li");
    row.className = `week-row ${className}`;
    const label = document.createElement("span");
    label.className = "week-text";
    label.textContent = text;
    row.append(label);
    return row;
  }

  owner(ownerId) {
    return ownerId ? assigneeLabel(ownerId, this.context) : "";
  }

  itemRow(item, entry, date) {
    const row = document.createElement("li");
    row.className = "week-row week-item";
    row.dataset.itemId = item.itemId;
    const label = document.createElement("label");
    label.className = "week-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = item.status === "completed";
    box.disabled = this.isDisabled;
    box.dataset.focusKey = `item:${item.itemId}:done`;
    box.addEventListener("change", () => this.emit(box.checked ? "kin:complete-item" : "kin:reopen-item", { itemId: item.itemId }));
    const text = document.createElement("span");
    text.className = "week-text";
    text.textContent = item.text;
    label.append(box, text);
    const meta = document.createElement("span");
    meta.className = "week-meta";
    meta.textContent = [item.classification === "shopping" ? "Shopping" : item.classification === "staple" ? "Staple" : "To do", this.owner(entry.ownerId)].filter(Boolean).join(" · ");
    const move = document.createElement("select");
    move.className = "week-move";
    move.disabled = this.isDisabled;
    move.dataset.focusKey = `item:${item.itemId}:move`;
    move.setAttribute("aria-label", `Move ${item.text} to another day`);
    move.append(new Option("Move to…", ""));
    for (const option of weekDates(this.today ?? date)) if (option !== date) move.append(new Option(dayName(option, this.today), String(option)));
    move.append(new Option("No date", "none"));
    move.addEventListener("change", () => {
      if (!move.value) return;
      this.emit("kin:set-item-planning-date", { itemId: item.itemId, planningDate: move.value === "none" ? null : Number(move.value) });
    });
    const open = document.createElement("button");
    open.type = "button";
    open.className = "week-open";
    open.textContent = "Details";
    open.disabled = this.isDisabled;
    open.dataset.focusKey = `item:${item.itemId}:open`;
    open.setAttribute("aria-label", `Details for ${item.text}`);
    open.addEventListener("click", () => this.emit("kin:open-item", { itemId: item.itemId, opener: open }));
    const tools = document.createElement("div");
    tools.className = "week-tools";
    tools.append(move, open);
    row.append(label, meta, tools);
    return row;
  }

  routineRow(routine, entry) {
    const row = document.createElement("li");
    row.className = "week-row week-routine";
    row.dataset.routineId = routine.routineId;
    const meta = document.createElement("span");
    meta.className = "week-meta";
    meta.textContent = [CADENCE[entry.cadence] ?? "Repeats", this.owner(entry.ownerId)].filter(Boolean).join(" · ");
    if (entry.current) {
      const label = document.createElement("label");
      label.className = "week-check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = entry.done;
      box.disabled = this.isDisabled;
      box.dataset.focusKey = `routine:${routine.routineId}`;
      box.addEventListener("change", () => this.emit(box.checked ? "kin:complete-routine-occurrence" : "kin:reopen-routine-occurrence", { routineId: routine.routineId, occurrenceKey: entry.occurrenceKey }));
      const text = document.createElement("span");
      text.className = "week-text";
      text.textContent = routine.text;
      label.append(box, text);
      row.append(label, meta);
    } else {
      const text = document.createElement("span");
      text.className = "week-text week-later";
      text.textContent = routine.text;
      row.append(text, meta);
    }
    return row;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
  }
}

if (!customElements.get("kin-week")) customElements.define("kin-week", KinWeek);
