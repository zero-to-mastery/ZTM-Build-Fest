// The Today composition: the day's summary, agenda sections (overdue, today,
// coming up, completed), routines due now, updates waiting, quick access and
// the empty states. composeToday() (today-view.js) decides what goes where.
// Part of <kin-today>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-today.js lists them).
import { assigneeLabel } from "../shared/assignee-label.js";
import { composeToday, describePlanningDate, ROUTINE_PERIOD_LABELS } from "../../today-view.js";
import { composePrivateToday } from "../../private-items.js";
import { privateItemRow } from "../shared/private-marker.js";
import { describeNextOccurrence, describeRepeat } from "../../recurrence.js";

const MODE_LABELS = { normal: "Normal", vacation: "Vacation", guests: "Guests", rest: "Rest" };

export class TodaySections {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  renderToday() {
    if (this.host.civilDate == null) {
      // Before the first local projection there is nothing to compose; say so
      // without implying anything was removed.
      const pending = document.createElement("section");
      pending.className = "today-list today-unavailable";
      pending.dataset.section = "today";
      const heading = document.createElement("h2");
      heading.textContent = "Today";
      heading.tabIndex = -1;
      const note = document.createElement("p");
      note.className = "empty-state";
      note.textContent = "Today's tasks aren't available yet. They appear as soon as Kin finishes opening this household on this device.";
      pending.append(heading, note);
      return [pending];
    }
    const view = composeToday({ items: this.host.records, routines: this.host.routineRecords, pins: this.host.pinRecords, handoffs: this.host.handoffRecords, mode: this.host.householdMode, civilDate: this.host.civilDate });
    // Just for me (#514): this member's dated private items, by Today's own
    // rules, beside the household's and marked "Private". The app gives none
    // in Simple view or with the member's setting off.
    const mine = composePrivateToday(this.host.privateRecords, this.host.civilDate);
    const counts = {
      earlier: view.counts.earlier + mine.earlier.length,
      today: view.counts.today + mine.today.length,
      upcoming: view.counts.upcoming + mine.upcoming.length,
      completed: view.counts.completed + mine.completed.length,
    };
    const hasMine = Object.values(mine).some((list) => list.length > 0);
    const sections = [];
    if (view.hasItems || hasMine) sections.push(this.createSummary(counts));

    // Most time-sensitive first: plans still open from earlier days, today's
    // plans, then later plans. The copy stays calm on purpose (no "overdue").
    if (view.earlier.length || mine.earlier.length) {
      sections.push(this.createAgendaSection("earlier", "Earlier plans", view.earlier, "Still open from earlier. They stay in their lists too.", mine.earlier));
    }

    const today = this.createAgendaSection("today", "Today", view.today, null, mine.today);
    today.className = "today-list";
    if (!view.today.length && !mine.today.length) today.append(this.createTodayEmpty(view));
    sections.push(today);

    if (view.hasItems || hasMine) {
      const upcoming = this.createAgendaSection("upcoming", "Coming up", view.upcoming, view.upcoming.length || mine.upcoming.length ? "Planned for the coming days, soonest first." : null, mine.upcoming);
      if (!view.upcoming.length && !mine.upcoming.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "Nothing is planned for the coming days.";
        upcoming.append(empty);
      }
      sections.push(upcoming);
    }

    // Keep the shortcut area visible when it's empty so first-time users can
    // discover how pins work instead of having the whole feature disappear.
    sections.push(this.createQuickAccess(view.quickAccess));
    sections.push(this.createRoutines(view));
    if (view.waitingHandoffs) sections.push(this.createUpdatesContext(view.waitingHandoffs));
    if (view.completed.length || view.completedRoutines.length || mine.completed.length) {
      const body = document.createDocumentFragment();
      if (view.completed.length) body.append(this.host.createList(view.completed, { kindVisible: true }));
      if (mine.completed.length) body.append(this.createPrivateList(mine.completed));
      if (view.completedRoutines.length) body.append(this.createRoutineList(view.completedRoutines, "done"));
      sections.push(this.host.disclosure("completed", `Completed (${view.completed.length + mine.completed.length + view.completedRoutines.length})`, body));
    }
    return sections;
  }

  /** This member's private items (#514): named "Private: …", marked, and
   * completed or reopened right here. */
  createPrivateList(items, kind = "today") {
    const list = document.createElement("ul");
    list.className = "item-list private-list today-private-list";
    list.setAttribute("aria-label", "Private, only you can see these");
    for (const item of items) {
      const meta = kind === "today" || item.date == null ? null : describePlanningDate(item.date, this.host.civilDate);
      list.append(privateItemRow(item, {
        disabled: this.host.isDisabled,
        meta,
        onToggle: (itemId, completed) => this.host.dispatchEvent(new CustomEvent("kin:toggle-private-item", {
          detail: { itemId, completed }, bubbles: true, composed: true,
        })),
      }));
    }
    return list;
  }

  createAgendaSection(kind, title, records, hint = null, privateItems = []) {
    const section = document.createElement("section");
    section.className = `today-agenda today-${kind}`;
    section.dataset.section = kind;
    const heading = document.createElement("h2");
    heading.textContent = title;
    heading.tabIndex = -1;
    section.append(heading);
    if (hint) {
      const note = document.createElement("p");
      note.className = "section-hint";
      note.textContent = hint;
      section.append(note);
    }
    if (records.length) section.append(this.host.createList(records, { kindVisible: true }));
    if (privateItems.length) section.append(this.createPrivateList(privateItems, kind));
    return section;
  }

  // Item counts (tasks and shopping items) from the same composition that renders the sections below,
  // so they can never drift from what is listed. Each non-zero count is a
  // native button that moves focus to its section; like every other control
  // here it is disabled while a change is saving.
  createSummary(counts) {
    const section = document.createElement("section");
    section.className = "today-summary";
    section.dataset.section = "summary";
    const heading = document.createElement("h2");
    heading.className = "visually-hidden";
    heading.textContent = "Item summary";
    const list = document.createElement("ul");
    list.className = "today-summary-list";
    const entries = [
      ["earlier", counts.earlier, "still open from earlier"],
      ["today", counts.today, "planned for today"],
      ["upcoming", counts.upcoming, "coming up"],
      ["completed", counts.completed, "completed from today's plans"],
    ].filter(([kind, count]) => kind !== "earlier" || count > 0);
    for (const [kind, count, label] of entries) {
      const entry = document.createElement("li");
      entry.dataset.count = kind;
      const content = count > 0 ? document.createElement("button") : document.createElement("span");
      content.className = "today-summary-entry";
      if (count > 0) {
        content.type = "button";
        content.dataset.summary = kind;
        content.disabled = this.host.isDisabled;
        content.addEventListener("click", () => this.revealSection(kind));
      }
      const number = document.createElement("span");
      number.className = "today-summary-count";
      number.textContent = String(count);
      content.append(number, document.createTextNode(` ${count === 1 ? "item" : "items"} ${label}`));
      entry.append(content);
      list.append(entry);
    }
    section.append(heading, list);
    return section;
  }

  revealSection(kind) {
    const section = this.host.querySelector(`[data-section="${kind}"]`);
    if (!section) return;
    if (section.tagName === "DETAILS") section.open = true;
    const target = section.tagName === "DETAILS" ? section.querySelector("summary") : section.querySelector("h2");
    target?.scrollIntoView?.({ block: "start" });
    target?.focus({ preventScroll: true });
  }

  createTodayEmpty(view) {
    const empty = document.createElement("div");
    empty.className = "empty-state today-empty";
    const message = document.createElement("p");
    if (view.allDone) {
      message.textContent = "Everything planned for today is done. Completed tasks are listed below.";
      empty.append(message);
      return empty;
    }
    if (!view.hasItems) {
      message.textContent = "Nothing to do yet. Add your first task, or start a shopping list.";
    } else {
      message.append(document.createTextNode("Nothing planned for today. Browse "));
      const todoLink = document.createElement("a");
      todoLink.href = "#lists/todo";
      todoLink.textContent = "To do";
      const shoppingLink = document.createElement("a");
      shoppingLink.href = "#lists/shopping";
      shoppingLink.textContent = "Shopping";
      message.append(todoLink, document.createTextNode(" or "), shoppingLink, document.createTextNode(" to see what's there."));
    }
    // Reuses the universal Quick add (and its partial-capture recovery); this
    // button only asks <kin-app> to open it from here.
    const add = document.createElement("button");
    add.type = "button";
    add.className = "today-quick-add";
    add.textContent = "Add a task for today";
    add.dataset.action = "open-quick-add";
    add.disabled = this.host.isDisabled;
    add.addEventListener("click", () => this.host.dispatchEvent(new CustomEvent("kin:open-quick-add", { detail: { opener: add }, bubbles: true, composed: true })));
    empty.append(message, add);
    // The populated empty state already links to Shopping in its explanation.
    // On a brand-new household, give Shopping an equally visible first step.
    if (!view.hasItems) {
      const shopping = document.createElement("a");
      shopping.className = "today-shopping-link";
      shopping.href = "#lists/shopping";
      shopping.textContent = "Open shopping list";
      empty.append(shopping);
    }
    return empty;
  }

  // "Your turn" or "Sam's turn" on a routine people take turns at (#437).
  turnLabel(routineId) {
    const current = this.host.turnMap?.get(routineId)?.current;
    if (!current) return null;
    const context = this.host.ownerContext ?? {};
    return current === context.memberId ? "Your turn" : `${assigneeLabel(current, context)}'s turn`;
  }

  createRoutines(view) {
    const section = document.createElement("section");
    section.className = "today-routines";
    section.dataset.section = "routines";
    section.dataset.feature = "routines";
    const heading = document.createElement("h2");
    heading.textContent = "Routines";
    heading.tabIndex = -1;
    section.append(heading);
    if (view.routinesPaused) {
      const paused = document.createElement("p");
      paused.className = "section-hint";
      paused.textContent = `Routines are paused during ${MODE_LABELS[this.host.householdMode] ?? "this"} mode. Change the mode under Household › Areas & status.`;
      section.append(paused);
      return section;
    }
    if (!view.hasRoutines) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.append(document.createTextNode("No repeating tasks yet. Choose Repeat in Quick add, or set one up in "));
      const link = document.createElement("a");
      link.href = "#routines";
      link.textContent = "Routines";
      empty.append(link, document.createTextNode("."));
      section.append(empty);
      return section;
    }
    if (!view.routineGroups.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      // Done for now, or nothing due today (an every-weekday task at the weekend).
      empty.textContent = view.completedRoutines.length ? "Every routine for this period is done." : "Nothing repeating is due today.";
      section.append(empty);
      return section;
    }
    for (const group of view.routineGroups) {
      const label = document.createElement("h3");
      label.className = "routine-period";
      label.textContent = group.label;
      section.append(label, this.createRoutineList(group.routines, "open"));
    }
    return section;
  }

  createRoutineList(routines, state) {
    const list = document.createElement("ul");
    list.className = "item-list routine-list";
    for (const routine of routines) {
      const entry = document.createElement("li");
      const row = document.createElement("div");
      row.className = `item-row routine-row item-${state === "done" ? "completed" : "active"}`;
      row.dataset.routineId = routine.routineId;
      const control = document.createElement("div");
      control.className = "item-control";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = `complete-control ${state === "done" ? "reopen-button" : "complete-button"}`;
      toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 12.5 4 4 8-9"/></svg>';
      const period = ROUTINE_PERIOD_LABELS[routine.cadence] ?? "this period";
      toggle.setAttribute("aria-label", `${state === "done" ? "Reopen" : "Complete"} ${routine.text} (${period.toLowerCase()})`);
      toggle.setAttribute("aria-pressed", String(state === "done"));
      toggle.dataset.routineId = routine.routineId;
      toggle.dataset.action = state === "done" ? "reopen-routine-occurrence" : "complete-routine-occurrence";
      toggle.disabled = this.host.isDisabled;
      toggle.addEventListener("click", () => this.host.dispatchEvent(new CustomEvent(`kin:${toggle.dataset.action}`, {
        detail: { routineId: routine.routineId, occurrenceKey: routine.occurrenceKey }, bubbles: true, composed: true,
      })));
      control.append(toggle);
      const body = document.createElement("div");
      body.className = "item-body";
      const text = document.createElement("p");
      text.className = "item-text";
      text.textContent = routine.text;
      const meta = document.createElement("p");
      meta.className = "item-meta";
      // Rust supplies the next occurrence; only one row per task, never one
      // per future occurrence.
      const next = describeNextOccurrence(routine.nextOn, this.host.civilDate);
      meta.textContent = [state === "done" ? `Done ${period.toLowerCase()}` : describeRepeat(routine.cadence), next, this.turnLabel(routine.routineId)].filter(Boolean).join(" · ");
      body.append(text, meta);
      const actions = document.createElement("div");
      actions.className = "item-row-actions";
      const schedule = document.createElement("button");
      schedule.type = "button";
      schedule.className = "routine-schedule-button";
      schedule.textContent = "Schedule";
      schedule.setAttribute("aria-label", `Schedule for ${routine.text}`);
      schedule.dataset.routineId = routine.routineId;
      schedule.dataset.action = "open-routine-schedule";
      schedule.disabled = this.host.isDisabled;
      schedule.addEventListener("click", () => this.host.dispatchEvent(new CustomEvent("kin:open-routine-schedule", {
        detail: { routineId: routine.routineId }, bubbles: true, composed: true,
      })));
      actions.append(schedule);
      row.append(control, body, actions);
      entry.append(row);
      list.append(entry);
    }
    return list;
  }

  createUpdatesContext(count) {
    const section = document.createElement("section");
    section.className = "today-updates";
    section.dataset.section = "updates";
    const line = document.createElement("p");
    const link = document.createElement("a");
    link.href = "#updates/handoffs";
    link.className = "today-updates-link";
    link.textContent = count === 1 ? "1 handoff is waiting for a Got it" : `${count} handoffs are waiting for a Got it`;
    line.append(link);
    section.append(line);
    return section;
  }

  createQuickAccess(targets) {
    const section = document.createElement("section");
    section.className = "quick-access";
    section.dataset.section = "quick-access";
    const heading = document.createElement("h2");
    heading.textContent = "Quick access";
    heading.tabIndex = -1;
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = "Pinned shortcuts. A pin is not a deadline.";
    section.append(heading, hint);
    const list = document.createElement("ul");
    list.className = "item-list quick-access-list";
    if (!targets.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state quick-access-empty";
      empty.textContent = "Pin a task from its details to keep it close.";
      section.append(empty);
    }
    for (const item of targets) {
      const row = document.createElement("li");
      const entry = document.createElement("div");
      entry.className = "quick-access-row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "quick-access-open";
      open.textContent = item.text;
      open.setAttribute("aria-label", `Open ${item.text}`);
      open.dataset.itemId = item.itemId;
      open.dataset.itemAction = "open-pin";
      open.disabled = this.host.isDisabled;
      open.addEventListener("click", () => this.host.dispatchEvent(new CustomEvent("kin:open-pin", { detail: { itemId: item.itemId, opener: open }, bubbles: true, composed: true })));
      const unpin = document.createElement("button");
      unpin.type = "button";
      unpin.textContent = "Unpin";
      unpin.setAttribute("aria-label", `Unpin ${item.text}`);
      unpin.dataset.itemId = item.itemId;
      unpin.dataset.itemAction = "unpin";
      unpin.disabled = this.host.isDisabled;
      unpin.addEventListener("click", () => this.host.dispatchEvent(new CustomEvent("kin:pin-intent", {
        detail: { targetKind: "item", targetId: item.itemId, pinned: false }, bubbles: true, composed: true,
      })));
      entry.append(open, unpin);
      row.append(entry);
      list.append(row);
    }
    if (targets.length) section.append(list);
    return section;
  }
}
