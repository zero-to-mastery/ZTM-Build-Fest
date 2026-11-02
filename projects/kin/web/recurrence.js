// Presentation and command planning for repeating tasks (canonically
// Routines). Rust owns every recurrence rule: which cadences are valid, each
// occurrence's key, when the next occurrence opens (`nextOn`), and whether a
// completion or reopening is allowed. This module only names those values and
// decides which existing commands a request still needs. It never derives a
// date, period or status itself.

import { formatCivilDate, nextCivilDate } from "./today-view.js";

// Order is the order shown to people, not the wire order.
export const REPEAT_OPTIONS = Object.freeze([
  Object.freeze({ value: "", label: "Does not repeat" }),
  Object.freeze({ value: "daily", label: "Every day" }),
  Object.freeze({ value: "weekdays", label: "Every weekday" }),
  Object.freeze({ value: "weekly", label: "Every week" }),
  Object.freeze({ value: "biweekly", label: "Every two weeks" }),
  Object.freeze({ value: "monthly", label: "Every month" }),
]);

// What each schedule means, in the words of the Rust contract (see
// docs/WORKSPACE-UX.md §3.7).
export const REPEAT_HINTS = Object.freeze({
  daily: "A new one each day.",
  weekdays: "Monday to Friday. Nothing is due on weekends.",
  weekly: "Once each week, Monday to Sunday.",
  biweekly: "Once every two weeks, counted from the day it starts.",
  monthly: "Once each calendar month, even in shorter months.",
});

const LABELS = new Map(REPEAT_OPTIONS.map((option) => [option.value, option.label]));

export function isCadence(value) {
  return typeof value === "string" && value !== "" && LABELS.has(value);
}

export function repeatLabel(cadence) {
  return LABELS.get(cadence) ?? "Repeats";
}

// "Repeats every weekday" — the sentence form used in row metadata.
export function describeRepeat(cadence) {
  return isCadence(cadence) ? `Repeats ${repeatLabel(cadence).toLowerCase()}` : "Repeats";
}

// Formats the Rust-derived next occurrence date. Comparing it with tomorrow
// only picks a friendlier label; it schedules nothing.
export function describeNextOccurrence(nextOn, civilDate) {
  if (!Number.isSafeInteger(nextOn) || !Number.isSafeInteger(civilDate)) return null;
  if (nextOn === nextCivilDate(civilDate)) return "Next: tomorrow";
  return `Next: ${formatCivilDate(nextOn, undefined, { weekday: "short", month: "short", day: "numeric" })}`;
}

// After a capture: say whether the new repeating task is already on Today or
// when its first occurrence opens, from the projected record.
export function describeRecurringCapture(routine, civilDate) {
  const repeat = describeRepeat(routine?.cadence);
  if (routine?.occurrenceStatus === "open") return `Added. ${repeat}; it's on Today now.`;
  const next = describeNextOccurrence(routine?.nextOn ?? null, civilDate);
  return next ? `Added. ${repeat}. First one ${next.replace(/^Next: /, "")}.` : `Added. ${repeat}.`;
}

// Quick add may create a repeating task instead of an Item. The client id
// makes a retry resume against the same Routine instead of creating another.
export function remainingRecurringSteps(state, draft) {
  if (!draft?.id) throw new TypeError("A capture draft needs a client-generated id.");
  if (!isCadence(draft.cadence)) throw new TypeError("A repeating capture needs a valid schedule.");
  return state?.routines?.some((routine) => routine.routineId === draft.id)
    ? []
    : [{ type: "create-routine", routineId: draft.id, text: draft.text, cadence: draft.cadence }];
}

// Routines have no schedule-change event, and history is never rewritten.
// A new schedule is therefore a new Routine that starts today, carrying the
// title and owner, after which the old one stops repeating. Its completed
// occurrences stay in history under the old schedule. `replacementId` is a
// client id, so a retry after a partial save resumes instead of duplicating.
export function planScheduleChange(state, { routineId, replacementId, cadence } = {}, pending = null) {
  if (!isCadence(cadence)) return { status: "invalid", steps: [] };
  const routines = state?.routines ?? [];
  const current = routines.find((routine) => routine.routineId === routineId);
  // A half-finished change to another schedule must finish first; starting a
  // second one would leave two replacements repeating.
  if (pending && pending.routineId === routineId && pending.cadence !== cadence && current?.status !== "archived" &&
    routines.some((routine) => routine.routineId === pending.replacementId))
    return { status: "pending", steps: [] };
  const replacement = routines.find((routine) => routine.routineId === replacementId);
  if (!current) return { status: "gone", steps: [] };
  if (!replacement && current.status === "archived") return { status: "stopped", steps: [] };
  if (!replacement && current.cadence === cadence) return { status: "unchanged", steps: [] };
  const owner = (targetId) => state?.responsibilities?.find((entry) => entry.targetKind === "routine" && entry.targetId === targetId)?.memberId ?? null;
  const steps = [];
  if (!replacement) steps.push({ type: "create-routine", routineId: replacementId, text: current.text, cadence });
  const currentOwner = owner(routineId);
  if (currentOwner && owner(replacementId) !== currentOwner)
    steps.push({ type: "change-responsibility", targetKind: "routine", targetId: replacementId, memberId: currentOwner });
  if (current.status !== "archived") steps.push({ type: "archive-routine", routineId });
  return { status: "ready", steps };
}

export const SCHEDULE_MESSAGES = Object.freeze({
  invalid: "Choose how often it repeats.",
  gone: "That repeating task is no longer here. Review the current list.",
  stopped: "That task already stopped repeating, maybe on another device. Nothing was changed.",
  unchanged: "It already repeats on that schedule.",
  partial: "The new schedule was saved, but the old one is still repeating. Try again to finish.",
  pending: "An earlier schedule change is only partly saved. Use Try again to finish it before choosing another schedule.",
});

export function describeScheduleChanged(cadence) {
  return `Schedule changed: ${describeRepeat(cadence).toLowerCase()}, starting today. Past completions are kept.`;
}
