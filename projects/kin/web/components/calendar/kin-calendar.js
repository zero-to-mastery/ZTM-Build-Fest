// <kin-calendar> (#661, ADR 0022 §2): the family calendar's Day, Week and
// Month views. This week grew into it: the Week view shows the This week
// list (<kin-week>, given as `weekList`) with each day's events; the Day
// view a timeline with an all-day row; the Month view a grid of six weeks.
//
// The element only draws what it is given (`update`) and asks for the rest
// with events, so it can be reused elsewhere (the kitchen display, #669,
// with the `compact` and `readonly` attributes and `views="day week"`):
// - `kin:calendar-focus` { view, focus }: the person moved to another day,
//   week or month, or another view; the host reads that range and calls
//   update() again.
// - `kin:calendar-open-event` { placed, date, opener }: open an event.
// - `kin:calendar-new-event` { date, minute, opener }: add one there.
// - `kin:calendar-import` { opener }: import a calendar file.
// - `kin:open-item` { itemId, opener }: a dated item's details.
//
// Keyboard: in the row of days and in the month grid, the arrow keys move
// between days (up and down by a week in the grid), Home and End go to the
// start and end of the week, Page Up and Page Down to the previous or next
// week (month in the Month view). Enter opens the day. One button in each
// group is in the tab order (a roving tabindex).
import { addDays, addMonths, civilParts, dateSpan, monthGrid, showsToday, startOfWeek, stepFocus, viewRange, weekAnchor } from "../../calendar/calendar-time.js";
import { dayLabel, isWeekend, layoutDay, monthLabel, shortDayLabel, timeLabel, weekdayNames } from "../../calendar/calendar-layout.js";
import { eventChip, extraLine, swatches } from "./event-chip.js";

const VIEWS = ["week", "day", "month"];
const STEP_NAMES = { day: "day", week: "week", month: "month" };
/** Pixels per hour on the Day timeline (app.css uses the same value). */
const HOUR_PX = 64;
const MONTH_CHIPS = 3;

const NO_DAY = Object.freeze({ allDay: Object.freeze([]), timed: Object.freeze([]) });

class KinCalendar extends HTMLElement {
  constructor() {
    super();
    this.view = "week";
    this.focusDate = null;
    this.today = null;
    this.days = new Map();
    this.extras = new Map();
    this.people = { labelOf: (id) => id, colourOf: () => 0 };
    this.loading = true;
    this.isDisabled = false;
    this.easy = false;
    this.weekList = null;
  }

  connectedCallback() {
    if (this.toolbar) return;
    this.classList.add("kin-calendar");
    this.toolbar = document.createElement("div");
    this.toolbar.className = "cal-toolbar";
    this.period = document.createElement("h2");
    this.period.className = "cal-period";
    this.period.id = `cal-period-${Math.random().toString(36).slice(2, 8)}`;
    this.period.setAttribute("aria-live", "polite");
    const moves = document.createElement("div");
    moves.className = "cal-moves";
    this.previous = this.button("cal-previous", "Previous", () => this.move(-1));
    this.todayButton = this.button("cal-today", "Today", () => this.go({ focus: this.today }));
    this.next = this.button("cal-next", "Next", () => this.move(1));
    moves.append(this.previous, this.todayButton, this.next);
    this.addButton = this.button("cal-add primary-action", "Add event", () => this.emit("kin:calendar-new-event", { date: this.focusDate ?? this.today, minute: null, opener: this.addButton }));
    this.addButton.setAttribute("aria-haspopup", "dialog");
    this.toolbar.append(this.period, moves, this.addButton);
    this.strip = document.createElement("div");
    this.strip.className = "cal-strip";
    this.strip.setAttribute("role", "group");
    this.strip.setAttribute("aria-label", "Days");
    this.strip.addEventListener("keydown", (event) => this.stripKey(event));
    this.body = document.createElement("div");
    this.body.className = "cal-body";
    this.footer = document.createElement("div");
    this.footer.className = "cal-footer";
    this.importButton = this.button("cal-import secondary", "Import a calendar file…", () => this.emit("kin:calendar-import", { opener: this.importButton }));
    const importHint = document.createElement("p");
    importHint.className = "section-hint";
    importHint.textContent = "An .ics file from Google, Apple or Outlook. It is read on this device; you see how many events it has before anything is saved.";
    this.footer.append(this.importButton, importHint);
    // With the household's Calendar switched off (#660), the Week view is
    // This week again: no adding or importing events.
    this.addButton.dataset.feature = "calendar";
    this.footer.dataset.feature = "calendar";
    this.append(this.toolbar, this.strip, this.body, this.footer);
    this.render();
  }

  static get observedAttributes() { return ["readonly", "compact", "views"]; }
  attributeChangedCallback() { if (this.toolbar) this.render(); }

  get readonly() { return this.hasAttribute("readonly"); }
  get compact() { return this.hasAttribute("compact"); }
  /** The views offered (default all three). */
  get views() {
    const listed = (this.getAttribute("views") ?? "").split(/\s+/).filter((view) => VIEWS.includes(view));
    return listed.length ? listed : VIEWS;
  }

  /**
   * { view, focus, today, days (Map date → { allDay, timed }), extras
   * (Map date → [{ kind, text, meta, itemId }]), people ({ labelOf,
   * colourOf }), loading, easy }. Anything left out stays as it was.
   */
  update(next = {}) {
    // `focus` is kept as `focusDate`: an element's own focus() stays a method.
    if (next.focus !== undefined) this.focusDate = next.focus;
    for (const key of ["view", "today", "days", "extras", "people", "loading", "easy"]) if (next[key] !== undefined) this[key] = next[key];
    if (!this.views.includes(this.view)) this.view = this.views[0];
    this.focusDate ??= this.today;
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll(".cal-toolbar button, .cal-footer button")) control.disabled = this.isDisabled;
    if (this.weekList) this.weekList.disabled = this.isDisabled;
  }

  /** The civil dates this view shows: { from, to }. */
  range() {
    return viewRange(this.view, this.focusDate ?? this.today, this.today);
  }

  /** The first day of the week the Week and Day views show. */
  weekStart() {
    return weekAnchor(this.focusDate ?? this.today, this.today);
  }

  button(className, text, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
  }

  move(direction) {
    this.go({ focus: stepFocus(this.view, this.focusDate ?? this.today, direction) });
  }

  /** Changes the view or focus, draws what is known and asks for the data. */
  go({ view = this.view, focus = this.focusDate, keyboard = null } = {}) {
    const changed = view !== this.view || focus !== this.focusDate;
    this.view = view;
    this.focusDate = focus;
    this.pendingFocus = keyboard;
    this.render();
    if (changed) this.emit("kin:calendar-focus", { view: this.view, focus: this.focusDate });
  }

  render() {
    if (!this.toolbar || this.today == null) return;
    const focus = this.focusDate ?? this.today;
    // Redrawing replaces the day buttons and cells: keyboard focus on one
    // moves to the new one for the same place (the roving day).
    const active = document.activeElement;
    const had = active?.closest?.(".cal-strip-day") && this.strip?.contains(active) ? "strip"
      : active?.closest?.(".cal-month-cell") && this.body?.contains(active) ? "grid" : null;
    this.dataset.view = this.view;
    this.toolbar.hidden = false;
    this.addButton.hidden = this.readonly;
    this.footer.hidden = this.readonly || this.compact;
    const step = STEP_NAMES[this.view];
    this.previous.setAttribute("aria-label", `Previous ${step}`);
    this.next.setAttribute("aria-label", `Next ${step}`);
    this.previous.textContent = "‹ Previous";
    this.next.textContent = "Next ›";
    const { from, to } = this.range();
    this.todayButton.disabled = this.isDisabled || showsToday(this.view, focus, this.today);
    if (this.view === "month") this.period.textContent = monthLabel(focus);
    else if (this.view === "day") this.period.textContent = dayLabel(focus, { year: civilParts(focus).year !== civilParts(this.today).year });
    else this.period.textContent = from === this.today ? "This week" : `Week of ${dayLabel(from)}`;
    this.strip.hidden = this.view === "month";
    if (!this.strip.hidden) this.renderStrip(from);
    if (this.view === "week") this.renderWeek(from);
    else if (this.view === "day") this.renderDay(focus);
    else this.renderMonth(focus);
    this.restoreKeyboardFocus(had);
  }

  dayCount(date) {
    const day = this.days.get(date) ?? NO_DAY;
    return day.allDay.length + day.timed.length;
  }

  countText(count) {
    return count === 0 ? "nothing planned" : count === 1 ? "1 event" : `${count} events`;
  }

  // ---- The row of days -----------------------------------------------------

  renderStrip(from) {
    const focus = this.focusDate ?? this.today;
    const buttons = dateSpan(from, 7).map((date) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cal-strip-day";
      button.dataset.date = String(date);
      button.tabIndex = date === focus ? 0 : -1;
      if (date === this.today) button.classList.add("cal-is-today");
      if (this.view === "day" && date === focus) button.setAttribute("aria-pressed", "true");
      else if (this.view === "day") button.setAttribute("aria-pressed", "false");
      if (date === this.today) button.setAttribute("aria-current", "date");
      const name = document.createElement("span");
      name.className = "cal-strip-name";
      name.textContent = shortDayLabel(date);
      const count = this.dayCount(date);
      const marks = document.createElement("span");
      marks.className = "cal-strip-count";
      marks.textContent = count ? String(count) : "";
      button.append(name, marks);
      button.setAttribute("aria-label", `${dayLabel(date)}${date === this.today ? ", today" : ""}, ${this.countText(count)}`);
      button.addEventListener("click", () => this.chooseDay(date, false));
      return button;
    });
    this.strip.replaceChildren(...buttons);
  }

  /** A day chosen in the row: the Day view shows it; the Week view brings
   * that day's list into sight. */
  chooseDay(date, keyboard) {
    if (this.view === "day") { this.go({ focus: date, keyboard: keyboard ? "strip" : null }); return; }
    this.focusDate = date;
    for (const button of this.strip.querySelectorAll(".cal-strip-day")) button.tabIndex = Number(button.dataset.date) === date ? 0 : -1;
    if (keyboard) return;
    const section = this.weekList?.querySelector(`.week-day[data-date="${date}"]`) ?? this.body.querySelector(`[data-date="${date}"]`);
    const heading = section?.querySelector("h2, h3");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      section.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }

  stripKey(event) {
    const button = event.target.closest?.(".cal-strip-day");
    if (!button) return;
    const date = Number(button.dataset.date);
    const start = this.weekStart();
    let target = null;
    switch (event.key) {
      case "ArrowLeft": target = addDays(date, -1); break;
      case "ArrowRight": target = addDays(date, 1); break;
      case "ArrowUp": case "PageUp": target = addDays(date, -7); break;
      case "ArrowDown": case "PageDown": target = addDays(date, 7); break;
      case "Home": target = start; break;
      case "End": target = addDays(start, 6); break;
      default: return;
    }
    event.preventDefault();
    if (target >= start && target <= addDays(start, 6) && this.view === "week") {
      this.chooseDay(target, true);
      this.strip.querySelector(`[data-date="${target}"]`)?.focus();
      return;
    }
    this.go({ focus: target, keyboard: "strip" });
  }

  restoreKeyboardFocus(had = null) {
    const where = this.pendingFocus ?? had;
    this.pendingFocus = null;
    if (where === "strip") this.strip.querySelector('.cal-strip-day[tabindex="0"]')?.focus();
    if (where === "grid") this.body.querySelector('.cal-month-cell[tabindex="0"]')?.focus();
  }

  // ---- Week ----------------------------------------------------------------

  renderWeek(from) {
    if (this.weekList) {
      if (this.weekList.parentElement !== this.body) this.body.replaceChildren(this.weekList);
      return;
    }
    // Without the This week list (the kitchen display): a plain agenda.
    const list = document.createElement("div");
    list.className = "cal-agenda";
    list.append(...dateSpan(from, 7).map((date) => this.agendaDay(date, "h3")));
    this.body.replaceChildren(list);
  }

  agendaDay(date, level = "h3") {
    const section = document.createElement("section");
    section.className = "cal-agenda-day";
    section.dataset.date = String(date);
    if (date === this.today) section.classList.add("cal-is-today");
    const heading = document.createElement(level);
    heading.textContent = date === this.today ? `Today · ${dayLabel(date)}` : dayLabel(date);
    section.append(heading);
    const day = this.days.get(date) ?? NO_DAY;
    const list = document.createElement("ul");
    list.className = "cal-agenda-list";
    for (const placed of day.allDay) list.append(this.listed(placed, date));
    for (const segment of day.timed) list.append(this.listed(segment.placed, date));
    for (const extra of this.extras.get(date) ?? []) list.append(extraLine(extra));
    if (list.children.length) section.append(list);
    else {
      const empty = document.createElement("p");
      empty.className = "cal-empty";
      empty.textContent = this.loading ? "Loading…" : "Nothing planned.";
      section.append(empty);
    }
    return section;
  }

  listed(placed, date) {
    const item = document.createElement("li");
    item.append(eventChip(placed, date, this.people, { open: !this.readonly, compact: this.compact }));
    return item;
  }

  // ---- Day -----------------------------------------------------------------

  renderDay(date) {
    const day = this.days.get(date) ?? NO_DAY;
    const extras = this.extras.get(date) ?? [];
    const wrap = document.createElement("section");
    wrap.className = "cal-day";
    wrap.dataset.date = String(date);
    wrap.setAttribute("aria-labelledby", this.period.id);
    // All day: all-day events, then meals, dated items and routines.
    const allDay = document.createElement("section");
    allDay.className = "cal-allday";
    const allHeading = document.createElement("h3");
    allHeading.textContent = "All day";
    allDay.append(allHeading);
    const allList = document.createElement("ul");
    allList.className = "cal-agenda-list";
    for (const placed of day.allDay) allList.append(this.listed(placed, date));
    for (const extra of extras) allList.append(extraLine(extra));
    if (allList.children.length) allDay.append(allList);
    else {
      const none = document.createElement("p");
      none.className = "cal-empty";
      none.textContent = this.loading ? "Loading…" : "Nothing all day.";
      allDay.append(none);
    }
    wrap.append(allDay);
    // Easy mode and the compact view: the timed events as a list, in time
    // order. Otherwise a timeline of the day's hours.
    if (this.easy || this.compact) {
      const timed = document.createElement("section");
      timed.className = "cal-timed-list";
      const heading = document.createElement("h3");
      heading.textContent = "At set times";
      const list = document.createElement("ul");
      list.className = "cal-agenda-list";
      for (const segment of day.timed) list.append(this.listed(segment.placed, date));
      timed.append(heading);
      if (list.children.length) timed.append(list);
      else timed.append(this.emptyDay(date));
      wrap.append(timed);
    } else {
      wrap.append(this.timeline(date, day.timed));
    }
    this.body.replaceChildren(wrap);
  }

  emptyDay(date) {
    const empty = document.createElement("p");
    empty.className = "cal-empty";
    empty.textContent = this.loading ? "Loading…" : "Nothing at a set time.";
    if (!this.readonly && !this.loading) {
      const add = this.button("cal-empty-add", "Add an event", () => this.emit("kin:calendar-new-event", { date, minute: 9 * 60, opener: add }));
      empty.append(" ", add);
    }
    return empty;
  }

  timeline(date, segments) {
    const section = document.createElement("section");
    section.className = "cal-timeline";
    const heading = document.createElement("h3");
    heading.className = "visually-hidden";
    heading.textContent = "At set times";
    section.append(heading);
    const laid = layoutDay(segments);
    // Hours from the earliest event (or 7:00) to the latest (or 21:00).
    const first = Math.min(7 * 60, ...laid.map((entry) => entry.start));
    const last = Math.max(21 * 60, ...laid.map((entry) => Math.max(entry.end, entry.start + 30)));
    const startHour = Math.floor(first / 60), endHour = Math.min(24, Math.ceil(last / 60));
    const grid = document.createElement("div");
    grid.className = "cal-hours";
    grid.style.setProperty("--cal-hours", String(endHour - startHour));
    for (let hour = startHour; hour < endHour; hour += 1) {
      const row = document.createElement("div");
      row.className = "cal-hour";
      const label = document.createElement("span");
      label.className = "cal-hour-label";
      label.textContent = timeLabel(hour * 60);
      row.append(label);
      if (!this.readonly) {
        // An empty hour adds an event there: a real button, named, so it
        // works by touch, mouse and keyboard alike.
        const add = document.createElement("button");
        add.type = "button";
        add.className = "cal-hour-add";
        add.setAttribute("aria-label", `Add an event at ${timeLabel(hour * 60)}`);
        add.tabIndex = -1;
        add.addEventListener("click", () => this.emit("kin:calendar-new-event", { date, minute: hour * 60, opener: add }));
        row.append(add);
      }
      grid.append(row);
    }
    const lane = document.createElement("ol");
    lane.className = "cal-lane";
    lane.setAttribute("aria-label", "Events at set times");
    for (const entry of laid) {
      const item = document.createElement("li");
      item.className = "cal-lane-item";
      const top = ((entry.start - startHour * 60) / 60) * HOUR_PX;
      const height = Math.max(((Math.max(entry.end, entry.start + 30) - entry.start) / 60) * HOUR_PX - 2, 26);
      // Layout numbers only; never household text.
      item.style.top = `${top}px`;
      item.style.height = `${height}px`;
      item.style.left = `calc(var(--cal-gutter) + (100% - var(--cal-gutter)) * ${entry.column} / ${entry.columns})`;
      item.style.width = `calc((100% - var(--cal-gutter)) / ${entry.columns} - 4px)`;
      const chip = eventChip(entry.placed, date, this.people, { open: !this.readonly, compact: true });
      if (entry.continuesBefore) chip.classList.add("cal-continues-before");
      if (entry.continuesAfter) chip.classList.add("cal-continues-after");
      item.append(chip);
      lane.append(item);
    }
    if (date === this.today) {
      const now = new Date();
      const minute = now.getHours() * 60 + now.getMinutes();
      if (minute >= startHour * 60 && minute < endHour * 60) {
        const line = document.createElement("div");
        line.className = "cal-now";
        line.setAttribute("aria-hidden", "true");
        line.style.top = `${((minute - startHour * 60) / 60) * HOUR_PX}px`;
        grid.append(line);
      }
    }
    grid.append(lane);
    section.append(grid);
    if (!laid.length) section.append(this.emptyDay(date));
    return section;
  }

  // ---- Month ---------------------------------------------------------------

  renderMonth(focus) {
    const grid = monthGrid(focus);
    const month = civilParts(focus).month;
    const table = document.createElement("table");
    table.className = "cal-month";
    table.setAttribute("role", "grid");
    table.setAttribute("aria-labelledby", this.period.id);
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    const long = weekdayNames("long"), short = weekdayNames("narrow");
    for (let index = 0; index < 7; index += 1) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.abbr = long[index];
      cell.textContent = this.compact ? short[index] : weekdayNames("short")[index];
      headRow.append(cell);
    }
    head.append(headRow);
    const body = document.createElement("tbody");
    body.addEventListener("keydown", (event) => this.gridKey(event));
    for (let week = 0; week < 6; week += 1) {
      const row = document.createElement("tr");
      for (const date of grid.slice(week * 7, week * 7 + 7)) row.append(this.monthCell(date, focus, month));
      body.append(row);
    }
    table.append(head, body);
    this.body.replaceChildren(table);
  }

  monthCell(date, focus, month) {
    const cell = document.createElement("td");
    cell.className = "cal-month-cell";
    cell.dataset.date = String(date);
    cell.tabIndex = date === focus ? 0 : -1;
    if (civilParts(date).month !== month) cell.classList.add("cal-other-month");
    if (isWeekend(date)) cell.classList.add("cal-weekend");
    if (date === this.today) { cell.classList.add("cal-is-today"); cell.setAttribute("aria-current", "date"); }
    cell.setAttribute("aria-selected", String(date === focus));
    const day = this.days.get(date) ?? NO_DAY;
    const entries = [...day.allDay, ...day.timed.map((segment) => segment.placed)];
    const extras = this.extras.get(date) ?? [];
    const number = document.createElement("span");
    number.className = "cal-month-number";
    number.textContent = String(civilParts(date).day);
    number.setAttribute("aria-hidden", "true");
    cell.append(number);
    const list = document.createElement("ul");
    list.className = "cal-month-events";
    list.setAttribute("aria-hidden", "true");
    for (const placed of entries.slice(0, MONTH_CHIPS)) {
      const item = document.createElement("li");
      item.className = "cal-month-event";
      item.append(swatches(placed.occurrence.attendees, this.people));
      const title = document.createElement("span");
      title.className = "cal-month-title";
      title.textContent = placed.occurrence.title;
      item.append(title);
      list.append(item);
    }
    if (entries.length > MONTH_CHIPS) {
      const more = document.createElement("li");
      more.className = "cal-month-more";
      more.textContent = `+${entries.length - MONTH_CHIPS} more`;
      list.append(more);
    }
    if (extras.length) {
      const note = document.createElement("li");
      note.className = "cal-month-extras";
      note.textContent = extras.length === 1 ? "1 other thing" : `${extras.length} other things`;
      list.append(note);
    }
    cell.append(list);
    // What a screen reader hears for the cell: the date, then what is on.
    const names = entries.map((placed) => placed.occurrence.title);
    const parts = [dayLabel(date), ...(date === this.today ? ["today"] : []), this.countText(entries.length)];
    if (names.length) parts.push(names.join("; "));
    if (extras.length) parts.push(extras.length === 1 ? "and 1 other thing" : `and ${extras.length} other things`);
    cell.setAttribute("aria-label", parts.join(", "));
    cell.addEventListener("click", () => this.openDay(date));
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.openDay(date); }
    });
    return cell;
  }

  openDay(date) {
    this.go(this.views.includes("day") ? { view: "day", focus: date } : { focus: date });
  }

  gridKey(event) {
    const cell = event.target.closest?.(".cal-month-cell");
    if (!cell) return;
    const date = Number(cell.dataset.date);
    const weekStart = startOfWeek(date);
    let target = null;
    switch (event.key) {
      case "ArrowLeft": target = addDays(date, -1); break;
      case "ArrowRight": target = addDays(date, 1); break;
      case "ArrowUp": target = addDays(date, -7); break;
      case "ArrowDown": target = addDays(date, 7); break;
      case "Home": target = weekStart; break;
      case "End": target = addDays(weekStart, 6); break;
      case "PageUp": target = addMonths(date, -1); break;
      case "PageDown": target = addMonths(date, 1); break;
      default: return;
    }
    event.preventDefault();
    const shown = this.body.querySelector(`.cal-month-cell[data-date="${target}"]`);
    if (shown && civilParts(target).month === civilParts(this.focusDate ?? this.today).month) {
      for (const other of this.body.querySelectorAll(".cal-month-cell")) {
        other.tabIndex = other === shown ? 0 : -1;
        other.setAttribute("aria-selected", String(other === shown));
      }
      this.focusDate = target;
      shown.focus();
      return;
    }
    this.go({ focus: target, keyboard: "grid" });
  }
}

if (!customElements.get("kin-calendar")) customElements.define("kin-calendar", KinCalendar);

