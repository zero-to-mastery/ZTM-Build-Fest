// Today is a read-only composition over the Rust projection. This module only
// filters and groups records that Rust already derived (status, planning
// date, occurrence status); it never computes recurrence, eligibility or
// validity. Dates are the integer civil date (YYYYMMDD) the browser already
// passes to Rust as explicit context, so grouping is an integer comparison of
// two Rust-facing values with no clock, time-zone or DST arithmetic here.

export const ROUTINE_PERIOD_LABELS = Object.freeze({
  daily: "Today",
  weekdays: "Today",
  weekly: "This week",
  biweekly: "This two-week period",
  monthly: "This month",
});

export const KIND_LABELS = Object.freeze({
  today: "Task",
  need: "Task",
  shopping: "Shopping item",
  staple: "Staple",
});

const actionable = (item) => item.status !== "archived" && item.classification !== "staple";

export function composeToday({ items = [], routines = [], pins = [], handoffs = [], mode = "normal", civilDate } = {}) {
  if (!Number.isSafeInteger(civilDate)) throw new TypeError("composeToday needs the current civil date.");
  const live = items.filter(actionable);
  const seen = new Set();
  const take = (record) => {
    if (seen.has(record.itemId)) return false;
    seen.add(record.itemId);
    return true;
  };

  // Rule A — planned for today, keeping task/shopping identity.
  // Rule B — legacy Today classification counts only while it carries no
  // explicit date; an explicit date always wins.
  const plannedToday = live.filter((item) => item.status === "active" && item.planningDate === civilDate).filter(take);
  const legacyToday = live.filter((item) => item.status === "active" && item.classification === "today" && item.planningDate == null).filter(take);
  const today = [...plannedToday, ...legacyToday];

  // Rule C — unfinished earlier plans stay reachable without alarm.
  const earlier = live
    .filter((item) => item.status === "active" && item.planningDate != null && item.planningDate < civilDate)
    .filter(take)
    .sort((left, right) => left.planningDate - right.planningDate);

  // Rule C2 — later plans, nearest first, so nothing planned sneaks up.
  const upcoming = live
    .filter((item) => item.status === "active" && item.planningDate != null && item.planningDate > civilDate)
    .filter(take)
    .sort((left, right) => left.planningDate - right.planningDate);

  const completed = live.filter((item) => item.status === "completed" &&
    (item.planningDate === civilDate || (item.classification === "today" && item.planningDate == null)));

  // Rule D — routines come straight from the Rust current-occurrence state.
  const paused = mode !== "normal";
  const activeRoutines = routines.filter((routine) => routine.status !== "archived");
  const openRoutines = paused ? [] : activeRoutines.filter((routine) => routine.occurrenceStatus === "open");
  const completedRoutines = paused ? [] : activeRoutines.filter((routine) => routine.occurrenceStatus === "completed");
  // Cadences sharing a period label (every day, every weekday) share a group,
  // so Today never shows two "Today" headings.
  const routineGroups = [...new Set(Object.values(ROUTINE_PERIOD_LABELS))]
    .map((label) => {
      const cadences = Object.keys(ROUTINE_PERIOD_LABELS).filter((cadence) => ROUTINE_PERIOD_LABELS[cadence] === label);
      return {
        cadence: cadences[0],
        cadences,
        label,
        routines: openRoutines.filter((routine) => cadences.includes(routine.cadence)),
      };
    })
    .filter((group) => group.routines.length > 0);

  // Rule E — household context. Pins are a separate section and may repeat
  // an item shown above; a pin is a shortcut, not a date or an obligation.
  const quickAccess = pins
    .filter((pin) => pin.targetKind === "item")
    .map((pin) => items.find((item) => item.itemId === pin.targetId && item.status !== "archived"))
    .filter(Boolean);
  const waitingHandoffs = handoffs.filter((handoff) => handoff.status === "unacknowledged").length;

  return {
    civilDate,
    today,
    earlier,
    upcoming,
    completed,
    // Counts are lengths of the lists above, never tracked separately, so a
    // completed task can only be counted as done.
    counts: { earlier: earlier.length, today: today.length, upcoming: upcoming.length, completed: completed.length },
    hasItems: live.length > 0,
    allDone: today.length === 0 && completed.length > 0,
    routineGroups,
    completedRoutines,
    routinesPaused: paused && activeRoutines.length > 0,
    hasRoutines: activeRoutines.length > 0,
    quickAccess,
    waitingHandoffs,
    isEmpty: today.length === 0 && earlier.length === 0 && upcoming.length === 0 && routineGroups.length === 0 && !paused,
  };
}

export function formatCivilDate(civilDate, locale = undefined, options = { weekday: "long", month: "long", day: "numeric" }) {
  const year = Math.floor(civilDate / 10000);
  const month = Math.floor(civilDate / 100) % 100;
  const day = civilDate % 100;
  return new Date(year, month - 1, day).toLocaleDateString(locale, options);
}

export function describePlanningDate(planningDate, civilDate) {
  if (planningDate == null) return null;
  if (planningDate === civilDate) return "Planned for today";
  if (planningDate === nextCivilDate(civilDate)) return "Planned for tomorrow";
  if (planningDate < civilDate) return `Planned for ${formatCivilDate(planningDate, undefined, { month: "short", day: "numeric" })}, still open`;
  return `Planned for ${formatCivilDate(planningDate, undefined, { month: "short", day: "numeric" })}`;
}

export function nextCivilDate(civilDate) {
  const year = Math.floor(civilDate / 10000);
  const month = Math.floor(civilDate / 100) % 100;
  const day = civilDate % 100;
  const date = new Date(year, month - 1, day + 1);
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}
