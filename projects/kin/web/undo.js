// Undo and redo your own recent changes (#315). Pure: no DOM, no storage.
//
// An entry describes one change this device just made. Undoing it never
// rewrites history: it appends ordinary household commands that reverse the
// change, which Rust validates and every device syncs like any other change.
// Redo does the same in the other direction.
//
// - Completing and reopening, a planned date and a pin are reversed by the
//   opposite command.
// - Archive is terminal in Rust (an archived Item or Routine never comes
//   back), so undoing a delete creates the thing again under a new id: an
//   Item with its text, list, date, area, pin, owner and steps; a Routine
//   with its text, schedule, owner and today's completion. The original stays
//   archived in history. Attachments, an item's picture (emoji) and local
//   reminders stay with the original.
// - Before running, the entry is checked against the current projection. If
//   the thing changed since (another member completed it, moved its date…),
//   undo is refused with a plain explanation instead of overwriting.
//
// Only changes a handler records are undoable. Chat, membership and
// security actions are never recorded, and text edits are left to the
// field's own undo.

import { quotedName } from "./components/app/feedback.js";

/** Most entries kept per direction. Older ones fall off the bottom. */
export const UNDO_LIMIT = 20;

/** Session-scoped history: two stacks, nothing persisted or synced. */
export class UndoHistory {
  constructor(limit = UNDO_LIMIT) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }
  /** A new change: it can be undone, and anything undone before it can no
   * longer be redone. */
  record(entry) {
    push(this.undoStack, entry, this.limit);
    this.redoStack.length = 0;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  take(direction) { return (direction === "redo" ? this.redoStack : this.undoStack).pop() ?? null; }
  /** Puts an entry back on the stack it came from (a failed run). */
  restore(direction, entry) { push(direction === "redo" ? this.redoStack : this.undoStack, entry, this.limit); }
  /** After a run: its reverse goes on the other stack. */
  settle(direction, inverse) { push(direction === "redo" ? this.undoStack : this.redoStack, inverse, this.limit); }
  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

function push(stack, entry, limit) {
  stack.push(entry);
  if (stack.length > limit) stack.splice(0, stack.length - limit);
}

const newId = () => crypto.randomUUID().replaceAll("-", "");
const itemIn = (state, itemId) => state?.items?.find((item) => item.itemId === itemId) ?? null;
const routineIn = (state, routineId) => state?.routines?.find((routine) => routine.routineId === routineId) ?? null;
const pinnedIn = (state, itemId) => Boolean(state?.pins?.some((pin) => pin.targetKind === "item" && pin.targetId === itemId));
const ownerIn = (state, targetKind, targetId) =>
  state?.responsibilities?.find((entry) => entry.targetKind === targetKind && entry.targetId === targetId)?.memberId ?? null;
const name = (text) => `“${quotedName(text)}”`;

/** What an Item looked like, enough to create it again. */
export function itemSnapshot(state, itemId) {
  const item = itemIn(state, itemId);
  if (!item) return null;
  return Object.freeze({
    text: item.text,
    classification: item.classification,
    planningDate: item.planningDate ?? null,
    areaId: item.areaId ?? null,
    pinned: pinnedIn(state, itemId),
    ownerId: ownerIn(state, "item", itemId),
    completed: item.status === "completed",
    // Each step gets its new id now, so a retry resumes the same steps.
    steps: Object.freeze((item.steps ?? []).filter((step) => !step.archived)
      .map((step) => Object.freeze({ stepId: newId(), text: step.text, completed: step.completed }))),
  });
}

/** What a Routine looked like, enough to create it again. */
export function routineSnapshot(state, routineId) {
  const routine = routineIn(state, routineId);
  if (!routine) return null;
  return Object.freeze({
    text: routine.text,
    cadence: routine.cadence,
    ownerId: ownerIn(state, "routine", routineId),
    completed: routine.occurrenceStatus === "completed",
  });
}

// ---- Recording ----------------------------------------------------------
// Each takes the projection before and after the change, so an entry
// records exactly what this device's change left behind.

export function itemStatusEntry(type, itemId, after) {
  const item = itemIn(after, itemId);
  if (!item) return null;
  const to = type === "complete" ? "completed" : "active";
  return Object.freeze({
    kind: "item-status", itemId, to, changedAt: item.lastChangedAt,
    label: `${type === "complete" ? "mark" : "reopen"} ${name(item.text)}${type === "complete" ? " done" : ""}`,
  });
}

export function itemAddedEntry(itemId, after) {
  const item = itemIn(after, itemId);
  if (!item) return null;
  return Object.freeze({ kind: "item-added", itemId, changedAt: item.lastChangedAt, label: `add ${name(item.text)}` });
}

export function itemArchivedEntry(itemId, before) {
  const snapshot = itemSnapshot(before, itemId);
  if (!snapshot) return null;
  return Object.freeze({ kind: "item-archived", itemId, snapshot, replacementId: newId(), label: `archive ${name(snapshot.text)}` });
}

export function itemDateEntry(itemId, before, after) {
  const was = itemIn(before, itemId);
  const now = itemIn(after, itemId);
  if (!was || !now) return null;
  return Object.freeze({
    kind: "item-date", itemId, from: was.planningDate ?? null, to: now.planningDate ?? null, changedAt: now.lastChangedAt,
    label: `${now.planningDate ? "plan" : "clear the date of"} ${name(now.text)}`,
  });
}

export function pinEntry(itemId, pinned, after) {
  const item = itemIn(after, itemId);
  if (!item) return null;
  return Object.freeze({ kind: "pin", itemId, pinned, label: `${pinned ? "pin" : "unpin"} ${name(item.text)}` });
}

export function routineArchivedEntry(routineId, before) {
  const snapshot = routineSnapshot(before, routineId);
  if (!snapshot) return null;
  return Object.freeze({ kind: "routine-archived", routineId, snapshot, replacementId: newId(), label: `delete ${name(snapshot.text)}` });
}

/** What a routine looked like right after this device's change, to tell
 * whether anyone changed it since (routines carry no change time). */
const routineMark = (state, routineId) => {
  const routine = routineIn(state, routineId);
  return routine ? [routine.text, routine.cadence, routine.status, routine.occurrenceKey ?? 0, routine.occurrenceStatus, ownerIn(state, "routine", routineId) ?? ""].join("\u0000") : null;
};

export function routineCreatedEntry(routineId, after) {
  const routine = routineIn(after, routineId);
  if (!routine) return null;
  return Object.freeze({ kind: "routine-created", routineId, mark: routineMark(after, routineId), label: `add ${name(routine.text)}` });
}

export function routineOccurrenceEntry(type, routineId, after) {
  const routine = routineIn(after, routineId);
  if (!routine?.occurrenceKey) return null;
  const done = type === "complete-routine-occurrence";
  return Object.freeze({
    kind: "routine-occurrence", routineId, occurrenceKey: routine.occurrenceKey, to: done ? "completed" : "open",
    label: `${done ? "mark" : "reopen"} ${name(routine.text)}${done ? " done" : ""}`,
  });
}

// ---- The family album (#673) ---------------------------------------------
// The album isn't part of the projection: for these entries the undo
// controller passes the state with `album` (store.album()) and `albumKeep`
// (the attachments still kept, album-blobs.js albumKeep). Removing a photo
// is undone by adding its image again under a new photo ID; once the Undo
// grace has passed and its blob is gone, it can't be.

const albumPhotoIn = (state, photoId) => state?.album?.photos?.find((photo) => photo.photoId === photoId) ?? null;
const albumLabel = (caption) => (caption ? `remove the photo ${name(caption)}` : "remove a photo");

export function albumRemovedEntry(photo) {
  if (!photo?.photoId || !photo.attachmentId) return null;
  const caption = photo.caption ?? "";
  return Object.freeze({ kind: "album-removed", photoId: photo.photoId, attachmentId: photo.attachmentId, caption, replacementId: newId(), label: albumLabel(caption) });
}

// ---- Chore rewards (#676, #699) ------------------------------------------
// Rewards aren't in the projection either: Rust works them out in the chore
// chart query. For these entries the undo controller passes the state with
// `choreRewards`, a Map of the charted members' IDs to their reward
// ({ goal, text }, or null for none); a member no longer on the chart is
// missing from it. Undo sets the reward back with the same kind 78 command
// (goal 0 and no text removes it), and only while the reward is still what
// this device set.

const rewardFrom = (value) => (value && Number.isInteger(value.goal) && value.goal > 0 && typeof value.text === "string"
  ? Object.freeze({ goal: value.goal, text: value.text }) : null);
const sameReward = (a, b) => (a === null || b === null ? a === b : a.goal === b.goal && a.text === b.text);
const rewardCommand = (memberId, reward) => ({ type: "set-chore-reward", memberId, goal: reward?.goal ?? 0, text: reward?.text ?? "" });

/** A child's reward changed from `from` to `to` (each { goal, text } or
 * null). `name` is how the chart names the child. Null when nothing
 * changed. */
export function choreRewardEntry({ memberId, name: who, from = null, to = null }) {
  const was = rewardFrom(from), now = rewardFrom(to);
  if (typeof memberId !== "string" || !memberId || sameReward(was, now)) return null;
  const label = `${now ? (was ? "change" : "set") : "remove"} the reward for ${who || "a child"}`;
  return Object.freeze({ kind: "chore-reward", memberId, from: was, to: now, label });
}

// ---- Running ------------------------------------------------------------

/**
 * Whether `entry` can be reversed against `state`:
 * - "ready": go ahead;
 * - "conflict": it changed since, so it is left alone;
 * - "gone": it is no longer there.
 */
export function reversalStatus(entry, state) {
  switch (entry?.kind) {
    case "item-status": {
      const item = itemIn(state, entry.itemId);
      if (!item || item.status === "archived") return "gone";
      return item.status === entry.to && item.lastChangedAt === entry.changedAt ? "ready" : "conflict";
    }
    case "item-added": {
      const item = itemIn(state, entry.itemId);
      if (!item || item.status === "archived") return "gone";
      return item.lastChangedAt === entry.changedAt ? "ready" : "conflict";
    }
    case "item-date": {
      const item = itemIn(state, entry.itemId);
      if (!item || item.status === "archived") return "gone";
      return (item.planningDate ?? null) === entry.to && item.lastChangedAt === entry.changedAt ? "ready" : "conflict";
    }
    case "pin": {
      const item = itemIn(state, entry.itemId);
      if (!item || item.status === "archived") return "gone";
      return pinnedIn(state, entry.itemId) === entry.pinned ? "ready" : "conflict";
    }
    case "routine-created": {
      const routine = routineIn(state, entry.routineId);
      if (!routine || routine.status === "archived") return "gone";
      // Someone assigned, completed or reopened it since: leave it alone.
      return entry.mark == null || routineMark(state, entry.routineId) === entry.mark ? "ready" : "conflict";
    }
    case "routine-occurrence": {
      const routine = routineIn(state, entry.routineId);
      if (!routine || routine.status === "archived") return "gone";
      return routine.occurrenceKey === entry.occurrenceKey && routine.occurrenceStatus === entry.to ? "ready" : "conflict";
    }
    // "Make private" (#517) archived it after copying it into Just for me;
    // its Undo creates it again like an archive's, then the app removes the
    // private copy (components/app/undo.js).
    case "item-made-private":
    case "item-archived": {
      // Creating it again is always possible; a replacement someone has since
      // archived means it was deleted again elsewhere.
      const replacement = itemIn(state, entry.replacementId);
      return replacement?.status === "archived" ? "gone" : "ready";
    }
    case "routine-archived": {
      const replacement = routineIn(state, entry.replacementId);
      return replacement?.status === "archived" ? "gone" : "ready";
    }
    case "album-removed": {
      if (albumPhotoIn(state, entry.replacementId)) return "ready";
      if (state?.album?.removed?.some((removed) => removed.photoId === entry.replacementId)) return "gone";
      // Someone else put the image back meanwhile, or its blob is gone.
      if (state?.album?.photos?.some((photo) => photo.attachmentId === entry.attachmentId)) return "conflict";
      return state?.albumKeep?.has(entry.attachmentId) ? "ready" : "gone";
    }
    case "album-added":
      return albumPhotoIn(state, entry.photoId) ? "ready" : "gone";
    case "chore-reward": {
      const rewards = state?.choreRewards;
      if (!(rewards instanceof Map) || !rewards.has(entry.memberId)) return "gone";
      return sameReward(rewardFrom(rewards.get(entry.memberId)), entry.to) ? "ready" : "conflict";
    }
    default:
      return "gone";
  }
}

/**
 * The next command that reversing `entry` still needs against `state`, or
 * null once it is fully reversed. The caller appends it, takes the new
 * projection and asks again, so a run that stopped partway resumes where it
 * left off. `memberIds` (when known) keeps a removed member from being made
 * the owner again.
 */
export function nextReversalStep(entry, state, { memberIds = null, skip = null } = {}) {
  switch (entry.kind) {
    case "item-status": {
      const item = itemIn(state, entry.itemId);
      if (!item || item.status !== entry.to) return null;
      return { type: entry.to === "completed" ? "reopen" : "complete", itemId: entry.itemId };
    }
    case "item-added": {
      const item = itemIn(state, entry.itemId);
      return item && item.status !== "archived" ? { type: "archive", itemId: entry.itemId } : null;
    }
    case "item-date": {
      const item = itemIn(state, entry.itemId);
      return item && (item.planningDate ?? null) !== entry.from
        ? { type: "set-item-planning-date", itemId: entry.itemId, planningDate: entry.from } : null;
    }
    case "pin":
      return pinnedIn(state, entry.itemId) === entry.pinned
        ? { type: entry.pinned ? "unpin" : "pin", targetKind: "item", targetId: entry.itemId } : null;
    case "routine-created": {
      const routine = routineIn(state, entry.routineId);
      return routine && routine.status !== "archived" ? { type: "archive-routine", routineId: entry.routineId } : null;
    }
    case "routine-occurrence": {
      const routine = routineIn(state, entry.routineId);
      if (!routine || routine.occurrenceKey !== entry.occurrenceKey || routine.occurrenceStatus !== entry.to) return null;
      return {
        type: entry.to === "completed" ? "reopen-routine-occurrence" : "complete-routine-occurrence",
        routineId: entry.routineId, occurrenceKey: entry.occurrenceKey,
      };
    }
    case "item-archived":
    case "item-made-private":
      return recreateItemStep(entry, state, memberIds, skip);
    case "routine-archived":
      return recreateRoutineStep(entry, state, memberIds, skip);
    case "album-removed":
      return albumPhotoIn(state, entry.replacementId) ? null
        : { type: "add-album-photo", photoId: entry.replacementId, attachmentId: entry.attachmentId, caption: entry.caption };
    case "album-added":
      return albumPhotoIn(state, entry.photoId) ? { type: "remove-album-photo", photoId: entry.photoId } : null;
    case "chore-reward": {
      const rewards = state?.choreRewards;
      if (!(rewards instanceof Map) || !rewards.has(entry.memberId)) return null;
      return sameReward(rewardFrom(rewards.get(entry.memberId)), entry.from) ? null : rewardCommand(entry.memberId, entry.from);
    }
    default:
      return null;
  }
}

/** Steps of re-creating something that are restored when they can be: a
 * refusal (ten pins already, say) skips them, not the whole undo. The caller
 * passes their types back in `skip`. */
export function isOptionalStep(entry, command) {
  return (entry?.kind === "item-archived" || entry?.kind === "item-made-private" || entry?.kind === "routine-archived") &&
    ["pin", "change-responsibility", "change-item-area"].includes(command?.type);
}

function recreateItemStep({ snapshot, replacementId: id }, state, memberIds, skip) {
  const skipped = (type) => Boolean(skip?.has(type));
  const item = itemIn(state, id);
  if (!item) return { type: "add", id, text: snapshot.text, classification: snapshot.classification };
  if (item.status === "archived") return null;
  if (snapshot.planningDate != null && (item.planningDate ?? null) !== snapshot.planningDate)
    return { type: "set-item-planning-date", itemId: id, planningDate: snapshot.planningDate };
  const area = snapshot.areaId ? state?.areas?.find((record) => record.areaId === snapshot.areaId && !record.archived) : null;
  if (area && item.areaId !== snapshot.areaId && !skipped("change-item-area")) return { type: "change-item-area", itemId: id, areaId: snapshot.areaId };
  if (snapshot.pinned && !pinnedIn(state, id) && !skipped("pin")) return { type: "pin", targetKind: "item", targetId: id };
  if (snapshot.ownerId && ownerIn(state, "item", id) !== snapshot.ownerId && (!memberIds || memberIds.includes(snapshot.ownerId)) && !skipped("change-responsibility"))
    return { type: "change-responsibility", targetKind: "item", targetId: id, memberId: snapshot.ownerId };
  for (const step of snapshot.steps) {
    const current = item.steps?.find((record) => record.stepId === step.stepId);
    if (!current) return { type: "add-item-step", itemId: id, stepId: step.stepId, text: step.text };
    if (step.completed && !current.completed && !current.archived) return { type: "complete-item-step", itemId: id, stepId: step.stepId };
  }
  if (snapshot.completed && item.status !== "completed") return { type: "complete", itemId: id };
  return null;
}

function recreateRoutineStep({ snapshot, replacementId: id }, state, memberIds, skip) {
  const routine = routineIn(state, id);
  if (!routine) return { type: "create-routine", routineId: id, text: snapshot.text, cadence: snapshot.cadence };
  if (routine.status === "archived") return null;
  if (snapshot.ownerId && ownerIn(state, "routine", id) !== snapshot.ownerId && (!memberIds || memberIds.includes(snapshot.ownerId)) && !skip?.has("change-responsibility"))
    return { type: "change-responsibility", targetKind: "routine", targetId: id, memberId: snapshot.ownerId };
  if (snapshot.completed && routine.occurrenceStatus === "open" && routine.occurrenceKey)
    return { type: "complete-routine-occurrence", routineId: id, occurrenceKey: routine.occurrenceKey };
  return null;
}

/** The entry that reverses a finished run, for the other stack. `before` is
 * the projection before the run, `after` after it. It keeps the original
 * label, so Undo and Redo name the same change. */
export function inverseEntry(entry, before, after) {
  const keep = (value) => (value ? Object.freeze({ ...value, label: entry.label }) : null);
  switch (entry.kind) {
    case "item-status":
      return keep({ kind: "item-status", itemId: entry.itemId, to: entry.to === "completed" ? "active" : "completed",
        changedAt: itemIn(after, entry.itemId)?.lastChangedAt ?? null });
    case "item-added": {
      const snapshot = itemSnapshot(before, entry.itemId);
      return snapshot ? keep({ kind: "item-archived", itemId: entry.itemId, snapshot, replacementId: newId() }) : null;
    }
    case "item-archived":
      return keep({ kind: "item-added", itemId: entry.replacementId, changedAt: itemIn(after, entry.replacementId)?.lastChangedAt ?? null });
    case "item-date":
      return keep({ kind: "item-date", itemId: entry.itemId, from: entry.to, to: entry.from,
        changedAt: itemIn(after, entry.itemId)?.lastChangedAt ?? null });
    case "pin":
      return keep({ kind: "pin", itemId: entry.itemId, pinned: !entry.pinned });
    case "routine-created": {
      const snapshot = routineSnapshot(before, entry.routineId);
      return snapshot ? keep({ kind: "routine-archived", routineId: entry.routineId, snapshot, replacementId: newId() }) : null;
    }
    case "routine-archived":
      return keep({ kind: "routine-created", routineId: entry.replacementId, mark: routineMark(after, entry.replacementId) });
    case "routine-occurrence":
      return keep({ ...entry, to: entry.to === "completed" ? "open" : "completed" });
    case "album-removed":
      return keep({ kind: "album-added", photoId: entry.replacementId, attachmentId: entry.attachmentId, caption: entry.caption });
    case "album-added":
      return keep({ kind: "album-removed", photoId: entry.photoId, attachmentId: entry.attachmentId, caption: entry.caption, replacementId: newId() });
    case "chore-reward":
      return keep({ kind: "chore-reward", memberId: entry.memberId, from: entry.to, to: entry.from });
    default:
      return null;
  }
}

// ---- The family calendar (#660) -----------------------------------------
// Calendar events aren't in the projection: the calendar controller reads
// them from KCAL. A calendar entry carries the steps that reverse it and
// the steps that redo it ({ command, optional }), worked out when the
// change was made, and a mark of each event (or colour) it touched as the
// change left it. Undo runs only while every mark still matches; otherwise
// someone changed it since and it is left alone. `next` counts the steps
// already run, so a run that stopped part-way resumes where it left off.

/** What an event looks like now, as a comparable string: its canonical
 * fields and what is cancelled of it. Null when there is no such event. */
export function calendarEventMark(event) {
  if (!event) return null;
  const { cancelled = false, cancelledThroughSeries = false, cancelledStarts = [], ...saved } = event;
  const starts = cancelledStarts.map((start) => `${start.date}:${start.minute}`).sort().join(",");
  return `${JSON.stringify(saved)}|${cancelled ? 1 : 0}${cancelledThroughSeries ? 1 : 0}|${starts}`;
}

/** The marks of every event and member colour in a KCAL read (allEvents):
 * Map key → mark, keyed by event ID or "colour:<memberId>". */
export function calendarMarks(range) {
  const marks = new Map();
  for (const event of range?.events ?? []) marks.set(event.eventId, calendarEventMark(event));
  for (const [memberId, colour] of range?.colours ?? []) marks.set(`colour:${memberId}`, String(colour));
  return marks;
}

/** A calendar change that can be undone: `undo` and `redo` are step lists,
 * `keys` the events (or "colour:<id>") it touched, `marks` their marks
 * after the change. */
export function calendarEntry({ label, undo, redo, keys, marks }) {
  return {
    kind: "calendar", label, steps: undo, back: redo, next: 0,
    expect: keys.map((key) => [key, marks.get(key) ?? null]),
  };
}

/** "ready", "conflict" (changed since) or "gone" (no longer there). A
 * colour back at the default has no mark, which matches null. */
export function calendarReversalStatus(entry, marks) {
  if (entry.next > 0) return "ready";
  for (const [key, mark] of entry.expect) {
    const now = marks.get(key) ?? null;
    if (now === mark) continue;
    return now === null && !key.startsWith("colour:") ? "gone" : "conflict";
  }
  return "ready";
}

/** The entry for the other stack after a finished run. */
export function calendarInverse(entry, marks) {
  return {
    kind: "calendar", label: entry.label, steps: entry.back, back: entry.steps, next: 0,
    expect: entry.expect.map(([key]) => [key, marks.get(key) ?? null]),
  };
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** Plain words for the outcome of an undo or redo. */
export function describeReversal(entry, direction, outcome) {
  const verb = direction === "redo" ? "redo" : "undo";
  if (outcome === "done") return `${direction === "redo" ? "Redone" : "Undone"}: ${entry.label}.`;
  if (outcome === "conflict") return `Couldn't ${verb} that (${entry.label}): it changed since, maybe on another device, so it was left as it is.`;
  if (outcome === "gone") return `Couldn't ${verb} that (${entry.label}): it's no longer here.`;
  return capitalize(`nothing to ${verb}.`);
}
