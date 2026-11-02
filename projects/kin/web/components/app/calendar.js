// The family calendar (#660: #661–#664, ADR 0022 §1–2): reads the calendar
// from Rust (`kin_calendar_range`) for the view on screen and for Today,
// and carries out what the calendar's components ask for through the one
// command path, with Undo. State stays on the element (`this.app`);
// app/context.js explains the controllers.
//
// - Reads place each occurrence in the viewer's own time (calendar/
//   calendar-time.js, with Intl) and split them by day (calendar-layout.js).
//   A read covers the view plus a day either side, so an event that moves
//   across midnight in the viewer's zone still shows.
// - Outside calendars synced to this device (#668) are read from
//   calendar/external.js (`externalOccurrences`, redrawn on
//   `onExternalOccurrences`); they show read-only in every view and on
//   Today with their source label and never enter the household history.
// - Saving, cancelling, a colour and an import are ordinary household
//   commands (kinds 71–74). Each records a "calendar" undo entry
//   (web/undo.js) with the steps that reverse it. Before a change to an
//   existing event the controller checks the event is still as the editor
//   opened it; if it changed on another device, the editor says so calmly.
// - Meals in the Day and Month views come from KCAL itself: since #660
//   `meals_in` (rust/src/calendar_range.rs) lists breakfast, lunch and
//   snacks beside dinner. The Week view keeps This week's own merge.
import { assigneeLabel } from "../shared/assignee-label.js";
import { randomId, idToHex } from "../../wasm/kin-engine.js";
import { MAX_ICAL_BYTES } from "../../wasm/kin-calendar.js";
import { addDays, daysBetween, viewRange, weekAnchor, viewerZone } from "../../calendar/calendar-time.js";
import { countdownText, occurrencesByDay, placeOccurrence } from "../../calendar/calendar-layout.js";
import { calendarPeople, colourIndexFor } from "../../calendar/member-colours.js";
import { importDoneText, importSummaryText, planImport, sameEvent, savedEvent } from "../../calendar/ics-import.js";
import { calendarEntry, calendarEventMark, calendarMarks } from "../../undo.js";
import { SLOT_LABELS } from "../../meals/meals-view.js";
import { routeHash } from "../../routes.js";
import { externalOccurrences, onExternalOccurrences } from "../../calendar/external.js";
import { syncProgress } from "./feedback.js";
import { SAVE_ERROR } from "./constants.js";

const CHANGED_ELSEWHERE = "This event changed on another device while you were editing it. Nothing was saved yet.";
const REFUSED = "That event changed or was cancelled on another device, so Kin didn't save this. The calendar shows it as it is now.";
const CLASSIFICATION_WORDS = { today: "To do", need: "To do", shopping: "Shopping", staple: "Staple" };
const CADENCE_WORDS = { daily: "Every day", weekdays: "Weekdays", weekly: "Every week", biweekly: "Every two weeks", monthly: "Every month" };
const VIEWS = new Set(["week", "day", "month"]);

const newEventId = () => idToHex(randomId());
const quoted = (title) => `“${title.length > 60 ? `${title.slice(0, 59)}…` : title}”`;

export class CalendarController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.reset();
    // A synced calendar changed (#668): draw what is on screen again.
    onExternalOccurrences(() => { if (this.app.store) void this.refresh(); });
  }

  /** Locking: nothing read or typed stays. Outside calendars come back
   * from their own device cache after unlock (#665). */
  reset() {
    this.view = "week";
    this.focus = null;
    this.colours = new Map();
    this.loading = null;
    this.again = false;
    this.opened = null;
    this.importing = null;
  }

  get on() {
    return this.ctx.features.isOn("calendar");
  }

  today() {
    return this.ctx.navigation.currentCivilDate();
  }

  // ---- People ----------------------------------------------------------------

  /** { list, labelOf, colourOf, myId } for the views. */
  people() {
    const context = this.ctx.detail.responsibilityContext();
    const memberIds = context.memberIds ?? [];
    const labelOf = (id) => assigneeLabel(id, context);
    const list = calendarPeople({ memberIds, myId: context.memberId, colours: this.colours, labelOf });
    const order = list.map((person) => person.memberId);
    return { list, labelOf, colourOf: (id) => colourIndexFor(id, this.colours, order), myId: context.memberId };
  }

  // ---- Outside calendars (#668) --------------------------------------------

  /**
   * Read-only occurrences from outside calendars synced to this device
   * (calendar/external.js, filled by calendar/feed-refresh.js), a day
   * either side of `from`..`to`, as the views place them: marked external,
   * named by their source label ("From Google"), never editable here.
   */
  externalsIn(from, to) {
    return externalOccurrences(addDays(from, -1), addDays(to, 1)).map((entry) => ({
      external: true, sourceId: entry.sourceId, sourceLabel: entry.label ?? "", uid: entry.key ?? null,
      eventId: null, title: entry.title, place: entry.place ?? "", allDay: entry.allDay === true,
      start: entry.start, end: entry.end, zone: entry.allDay ? "" : entry.zone ?? "", attendees: [],
      countdown: false, cancelled: false, linked: false, event: null,
    }));
  }

  // ---- Reading ---------------------------------------------------------------

  /**
   * The calendar from `from` to `to` for the views: { range (KCAL), days
   * (Map date → { allDay, timed }), extras (Map date → lines) }. Reads a
   * day either side so events that cross midnight in the viewer's zone
   * land on the right day.
   */
  async read(from, to) {
    const session = this.ctx.session.captureSession();
    const range = await session.store.calendarRange(addDays(from, -1), addDays(to, 1));
    this.ctx.session.assertCurrentSession(session);
    this.colours = range.colours ?? new Map();
    const zone = viewerZone();
    const placed = [...range.occurrences, ...this.externalsIn(from, to)].map((occurrence) => placeOccurrence(occurrence, zone));
    return { range, days: occurrencesByDay(placed, from, to), extras: this.extrasOf(range, from, to) };
  }

  /** Meals, dated items and routines by date, as quiet lines. */
  extrasOf(range, from, to) {
    const extras = new Map();
    const add = (date, line) => {
      if (date < from || date > to) return;
      if (!extras.has(date)) extras.set(date, []);
      extras.get(date).push(line);
    };
    const context = this.ctx.detail.responsibilityContext();
    const owner = (id) => (id ? assigneeLabel(id, context) : "");
    if (this.ctx.features.isOn("meals"))
      for (const meal of range.meals ?? []) add(meal.date, { kind: "meal", text: `${SLOT_LABELS[meal.slot] ?? "Meal"}: ${meal.name}`, meta: meal.cookId ? `${owner(meal.cookId)} cooking` : "" });
    const items = new Map((this.app.state?.items ?? []).map((item) => [item.itemId, item]));
    for (const entry of range.items ?? []) {
      const item = items.get(entry.itemId);
      if (item) add(entry.date, { kind: "item", itemId: item.itemId, text: item.text, meta: [CLASSIFICATION_WORDS[item.classification] ?? "To do", owner(entry.ownerId)].filter(Boolean).join(" · ") });
    }
    if (this.ctx.features.isOn("routines")) {
      const routines = new Map((this.app.state?.routines ?? []).map((routine) => [routine.routineId, routine]));
      for (const entry of range.routines ?? []) {
        const routine = routines.get(entry.routineId);
        if (routine) add(entry.opens, { kind: "routine", text: routine.text, meta: [CADENCE_WORDS[entry.cadence] ?? "Repeats", entry.done ? "Done" : "", owner(entry.ownerId)].filter(Boolean).join(" · ") });
      }
    }
    return extras;
  }

  /** The Week view's events for the seven days from `start` (the This
   * week list draws them), or null with the Calendar switched off. */
  async weekEvents(start) {
    if (!this.on) return null;
    const { days } = await this.read(start, addDays(start, 6));
    return { events: days, people: this.people() };
  }

  /** The first day the Week view shows. */
  weekStart() {
    const today = this.today();
    return weekAnchor(this.focus ?? today, today);
  }

  /** Re-reads what is on screen: Today's events and countdown, the
   * calendar page's view, and the colour setting. Reads coalesce. */
  refresh() {
    if (this.loading) { this.again = true; return this.loading; }
    this.loading = this.load().catch(() => {}).finally(() => {
      this.loading = null;
      if (this.again) { this.again = false; void this.refresh(); }
    });
    return this.loading;
  }

  async load() {
    if (!this.app.store || !this.app.state || !this.app.vault || this.app.vault.locked) return;
    const today = this.today();
    if (!this.on) return;
    // Today's events and the next countdown (#663).
    if (this.app.calendarToday) {
      const { range, days } = await this.read(today, today);
      const day = days.get(today) ?? { allDay: [], timed: [] };
      this.app.calendarToday.update({
        date: today, events: [...day.allDay, ...day.timed.map((segment) => segment.placed)],
        countdown: countdownText(range.nextCountdown, today), people: this.people(),
      });
    }
    const calendar = this.app.calendar;
    if (calendar && this.app.route?.page === "week") {
      const view = this.view;
      const focus = this.focus ?? today;
      if (view === "week") {
        calendar.update({ view, focus, today, people: this.people(), loading: false, easy: this.easy() });
        await this.ctx.week?.refresh();
      } else {
        const { from, to } = viewRange(view, focus, today);
        calendar.update({ view, focus, today, people: this.people(), easy: this.easy() });
        const { days, extras } = await this.read(from, to);
        if (this.view !== view || (this.focus ?? today) !== focus) return;
        calendar.update({ days, extras, people: this.people(), loading: false });
      }
    }
    this.renderColour();
  }

  easy() {
    return globalThis.document?.documentElement?.dataset.kinEasy === "on";
  }

  renderColour() {
    const panel = this.app.memberColour;
    if (!panel) return;
    const people = this.people();
    panel.update({
      colour: people.colourOf(people.myId), chosen: this.colours.has(people.myId), people: people.list, myId: people.myId,
      disabled: !this.app.store,
    });
  }

  /** The calendar page was shown (`route.segment` is the view). */
  routeShown(route) {
    if (route?.page !== "week") return;
    const view = VIEWS.has(route.segment) ? route.segment : "week";
    if (view !== this.view) this.view = view;
    this.app.calendar?.update({ view, focus: this.focus ?? this.today(), today: this.today(), loading: true });
    void this.refresh();
  }

  /** <kin-calendar> moved to another view or date. */
  handleFocus({ view, focus }) {
    this.focus = focus;
    if (view && view !== this.view) {
      this.view = view;
      this.ctx.navigation.navigate(routeHash("week", view));
      return;
    }
    void this.refresh();
  }

  /** The marks undo compares (web/undo.js): every event and colour. */
  async marks() {
    const session = this.ctx.session.captureSession();
    const today = this.today();
    const range = await session.store.calendarRange(today, today, { allEvents: true });
    this.ctx.session.assertCurrentSession(session);
    return calendarMarks(range);
  }

  async allEvents() {
    const session = this.ctx.session.captureSession();
    const today = this.today();
    const range = await session.store.calendarRange(today, today, { allEvents: true });
    this.ctx.session.assertCurrentSession(session);
    return range.events;
  }

  // ---- Opening the editor ----------------------------------------------------

  openNew({ date = null, minute = null, opener = null } = {}) {
    const people = this.people();
    this.opened = null;
    this.app.eventEditor?.open({ date: date ?? this.focus ?? this.today(), minute, people: people.list, me: people.myId, opener, fallback: () => this.app.calendar?.addButton });
  }

  openEvent({ placed, opener = null }) {
    if (!placed || placed.readonly || !placed.occurrence.event) return;
    const people = this.people();
    this.opened = { key: placed.key, eventId: placed.occurrence.eventId, mark: calendarEventMark(placed.occurrence.event) };
    this.app.eventEditor?.open({ placed, people: people.list, me: people.myId, opener, fallback: () => this.app.calendar?.addButton });
  }

  // ---- Changes ---------------------------------------------------------------

  /**
   * Runs `steps` ({ command, optional }) as one change: busy guard, status
   * with sync progress, render and refresh, then an Undo entry. Resolves
   * { ok } or { error } (code 4: { refused }).
   */
  async run(steps, { label, done, undo, redo, keys }) {
    if (!this.app.store || !this.app.engine) return { error: SAVE_ERROR };
    if (this.app.busy) return { error: "Kin is still saving. Try again in a moment." };
    const session = this.ctx.session.captureSession();
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    let saved = 0;
    try {
      for (const { command, optional } of steps) {
        try {
          await this.ctx.append.appendCommand(command);
          saved += 1;
        } catch (error) {
          if (error.code === 4 && optional) continue;
          throw error;
        }
        this.ctx.session.assertCurrentSession(session);
      }
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      const marks = calendarMarks(await session.store.calendarRange(this.today(), this.today(), { allEvents: true }));
      this.ctx.session.assertCurrentSession(session);
      this.ctx.status.setStatus(`${done}${syncProgress({ syncing: Boolean(this.app.syncCoordinator), offline: navigator.onLine === false })}`);
      if (saved) this.ctx.undo.record(calendarEntry({ label, undo, redo, keys, marks }));
      void this.refresh();
      return { ok: true, saved };
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return { error: "Kin locked before this was saved." };
      if (saved) { this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange(); void this.refresh(); }
      this.ctx.status.setStatus("");
      if (error.code === 4) { void this.refresh(); return { error: REFUSED, refused: true, saved }; }
      // The engine's own words for a format problem (code 2) are plain
      // ("An event can't end before it starts.").
      if (error.code === 2 && error.message) return { error: error.message, saved };
      return { error: error.userMessage ?? SAVE_ERROR, saved };
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }

  /** Whether the event the editor opened is still as it was; if not,
   * { conflict, latest } (or { error } when it is gone). */
  async checkUnchanged(base) {
    if (!base || !this.opened || this.opened.eventId !== base.eventId) return null;
    const events = await this.allEvents();
    const now = events.find((event) => event.eventId === base.eventId) ?? null;
    if (!now || now.cancelled || now.cancelledThroughSeries) return { error: "This event was cancelled on another device, so Kin didn't save your changes." };
    if (calendarEventMark(now) === this.opened.mark) return null;
    // The latest version, as an occurrence the editor can show.
    const occurrence = this.app.eventEditor?.placed?.occurrence;
    const latest = occurrence ? placeOccurrence({ ...occurrence, event: now, title: now.title, place: now.place, zone: now.zone, attendees: now.attendees }, viewerZone()) : null;
    this.opened = { ...this.opened, mark: calendarEventMark(now) };
    return { conflict: true, message: CHANGED_ELSEWHERE, latest };
  }

  /** Saves the editor's draft: a new event, a change to one (or to all of
   * a repeating one), or a change to just one occurrence. */
  async save({ draft, placed, base, scope, force = false }) {
    if (base && !force) {
      const conflict = await this.checkUnchanged(base).catch(() => null);
      if (conflict) return conflict;
    }
    const fields = { ...draft, sourceUid: base?.sourceUid ?? "" };
    if (!base) {
      const event = { ...fields, eventId: newEventId(), series: null };
      return this.run([{ command: { type: "save-calendar-event", event } }], {
        label: `add ${quoted(event.title)}`, done: `Added ${quoted(event.title)} to the calendar.`,
        undo: [{ command: { type: "cancel-calendar-event", eventId: event.eventId, occurrence: null }, optional: true }],
        redo: [{ command: { type: "restore-calendar-event", eventId: event.eventId, occurrence: null }, optional: true }],
        keys: [event.eventId],
      });
    }
    const occurrence = placed.occurrence;
    const previous = savedEvent(base);
    // Just this one of a repeating event: cancel it there and save a
    // standalone event linked to it (the engine's "change one occurrence").
    if (base.repeat && scope === "one") {
      const linked = { ...fields, sourceUid: "", eventId: newEventId(), repeat: null, series: { seriesId: base.eventId, original: occurrence.start } };
      const cancel = { type: "cancel-calendar-event", eventId: base.eventId, occurrence: occurrence.start };
      const restore = { type: "restore-calendar-event", eventId: base.eventId, occurrence: occurrence.start };
      return this.run([{ command: cancel }, { command: { type: "save-calendar-event", event: linked } }], {
        label: `change ${quoted(linked.title)} on one day`, done: `Changed ${quoted(linked.title)} for that day only.`,
        undo: [{ command: { type: "cancel-calendar-event", eventId: linked.eventId, occurrence: null }, optional: true }, { command: restore, optional: true }],
        redo: [{ command: { type: "restore-calendar-event", eventId: linked.eventId, occurrence: null }, optional: true }, { command: cancel, optional: true }],
        keys: [base.eventId, linked.eventId],
      });
    }
    // The whole event (all of a repeating one: the series moves by as many
    // days as this occurrence did).
    let event = { ...fields, eventId: base.eventId, series: base.series ?? null };
    if (base.series) event.repeat = null;
    if (base.repeat) {
      const shift = daysBetween(occurrence.start.date, draft.start.date);
      const span = daysBetween(draft.start.date, draft.end.date);
      const startDate = addDays(base.start.date, shift);
      event = { ...event, start: { date: startDate, minute: draft.start.minute }, end: { date: addDays(startDate, span), minute: draft.end.minute } };
    }
    if (sameEvent(event, previous)) return { ok: true, unchanged: true };
    return this.run([{ command: { type: "save-calendar-event", event } }], {
      label: `change ${quoted(event.title)}`, done: base.repeat ? `Changed every ${quoted(event.title)}.` : `Changed ${quoted(event.title)}.`,
      undo: [{ command: { type: "save-calendar-event", event: previous }, optional: true }],
      redo: [{ command: { type: "save-calendar-event", event }, optional: true }],
      keys: [base.eventId],
    });
  }

  /** Cancels this one occurrence or all of a repeating event, or a single
   * event. A changed occurrence (a linked event) is cancelled by itself. */
  async cancel({ placed, base, scope }) {
    const conflict = await this.checkUnchanged(base).catch(() => null);
    if (conflict?.error) return conflict;
    const title = base.title;
    const one = base.repeat && scope === "one";
    const occurrence = one ? placed.occurrence.start : null;
    const cancel = { type: "cancel-calendar-event", eventId: base.eventId, occurrence };
    const restore = { type: "restore-calendar-event", eventId: base.eventId, occurrence };
    return this.run([{ command: cancel }], {
      label: `cancel ${quoted(title)}${one ? " on one day" : ""}`,
      done: one ? `Cancelled ${quoted(title)} on that day.` : base.repeat ? `Cancelled every ${quoted(title)}.` : `Cancelled ${quoted(title)}.`,
      undo: [{ command: restore, optional: true }], redo: [{ command: cancel, optional: true }], keys: [base.eventId],
    });
  }

  /** This member's colour (0–11, or null for Kin's choice). */
  async setColour(colour) {
    const { myId } = this.people();
    if (!myId) return { error: "Kin doesn't know who you are yet. Try again in a moment." };
    const before = this.colours.has(myId) ? this.colours.get(myId) : null;
    if (before === colour) return { ok: true };
    return this.run([{ command: { type: "set-member-colour", colour } }], {
      label: "change your calendar colour", done: "Your calendar colour is saved.",
      undo: [{ command: { type: "set-member-colour", colour: before }, optional: true }],
      redo: [{ command: { type: "set-member-colour", colour }, optional: true }],
      keys: [`colour:${myId}`],
    });
  }

  // ---- Importing a calendar file -----------------------------------------------

  openImport({ opener = null, file = null } = {}) {
    if (!this.on) return;
    this.importing = null;
    this.app.calendarImport?.open({ opener, file });
  }

  /** Reads and parses `file` on this device and works out what importing
   * it would do: { text, changes, events } or { error }. */
  async previewImport(file) {
    try {
      if (!file || file.size === 0) return { error: "That file is empty." };
      if (file.size > MAX_ICAL_BYTES) return { error: "That calendar file is too large to import (2 MB at most)." };
      const session = this.ctx.session.captureSession();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = session.store.parseICalendar(bytes);
      if (!parsed.events.length) return { error: "Kin found no events in that file. Is it a calendar (.ics) file?" };
      const existing = await this.allEvents();
      const plan = planImport(parsed, existing, { newId: newEventId });
      this.importing = { parsed, plan };
      return { text: importSummaryText(plan.summary), changes: plan.steps.length, events: plan.summary.added + plan.summary.updated + plan.summary.restored + plan.summary.cancelled };
    } catch (error) {
      return { error: error?.code === 2 || error?.code === 5 ? (error.message || "Kin couldn't read that calendar file.") : "Kin couldn't read that calendar file." };
    }
  }

  /** Saves the import worked out by previewImport. A failure part-way
   * leaves what was saved; trying again works the plan out afresh, so
   * nothing is added twice. */
  async confirmImport() {
    const importing = this.importing;
    if (!importing) return { error: "Choose a file first." };
    const { plan, parsed } = importing;
    const name = plan.summary.name ? quoted(plan.summary.name) : "the calendar file";
    const outcome = await this.run(plan.steps, {
      label: `import ${name}`,
      done: importDoneText(plan.summary),
      undo: plan.undo, redo: plan.redo, keys: plan.eventIds,
    });
    if (outcome.ok) { this.importing = null; return outcome; }
    if (outcome.saved) {
      // Some of it is in: work out the rest again against what is saved.
      try {
        const replan = planImport(parsed, await this.allEvents(), { newId: newEventId });
        this.importing = { parsed, plan: replan };
      } catch { /* keep the old plan */ }
      return { error: `Kin saved part of the file, then stopped: ${outcome.error} Import again to finish; nothing is added twice.` };
    }
    return outcome;
  }
}
