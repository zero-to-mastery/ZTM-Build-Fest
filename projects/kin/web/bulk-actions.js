// Bulk completion, reopening, and undo planning over the Rust-derived Item
// projection. Pure: no DOM, no storage. Every change is still one ordinary
// complete-item or reopen-item command that Rust validates inside its own
// append transaction; this module only decides which ids to submit, which to
// skip, and how to describe the outcome. It never derives Item status itself.

export const BULK_ACTIONS = Object.freeze({
  complete: Object.freeze({ command: "complete", from: "active", to: "completed", done: "completed", verb: "complete" }),
  reopen: Object.freeze({ command: "reopen", from: "completed", to: "active", done: "reopened", verb: "reopen" }),
});

// Lists whose Items have a completion lifecycle. Staples are replenished, not
// completed, so they never offer selection.
const SELECTABLE = new Set(["need", "today", "shopping"]);

export function isBulkEligible(record) {
  return Boolean(record) && SELECTABLE.has(record.classification) &&
    (record.status === "active" || record.status === "completed");
}

// Which selected ids an action applies to right now. Ids that are gone,
// archived, or already in the target status are reported, never submitted.
export function planBulk(action, itemIds, items) {
  const spec = BULK_ACTIONS[action];
  if (!spec) throw new Error("Unknown bulk action.");
  const byId = new Map((items ?? []).map((item) => [item.itemId, item]));
  const targets = [];
  const skipped = [];
  for (const itemId of new Set(itemIds)) {
    const record = byId.get(itemId);
    if (isBulkEligible(record) && record.status === spec.from) targets.push(itemId);
    else skipped.push(itemId);
  }
  return { action, targets, skipped };
}

// Selected ids that still belong in a list after a projection update; ids
// that were archived, removed, or moved out of the list drop out.
export function reconcileSelection(selected, items, includes = () => true) {
  const visible = new Set((items ?? []).filter((item) => isBulkEligible(item) && includes(item)).map((item) => item.itemId));
  return new Set([...selected].filter((itemId) => visible.has(itemId)));
}

// An undo entry records the Rust-derived lastChangedAt each Item had right
// after this device's change. Before compensating, the Item must still be in
// the status we left it in AND still carry that timestamp; any later change
// (another member's completion, reopening, step, or date) makes the original
// transition no longer attributable to us, so the Item is left alone.
export function undoStatus(change, items) {
  const record = (items ?? []).find((item) => item.itemId === change.itemId);
  if (!record || record.status === "archived") return "gone";
  if (record.status !== change.to || record.lastChangedAt !== change.changedAt) return "conflict";
  return "ready";
}

export function undoCommand(change) {
  return change.to === "completed" ? "reopen" : "complete";
}

const items = (count) => `${count} ${count === 1 ? "item" : "items"}`;

// Outcome wording never claims more than happened: successes, failures,
// skips, and conflicts are each counted separately. Saved locally is not
// described as synced.
export function describeBulkOutcome(action, { succeeded = 0, failed = 0, skipped = 0, conflicts = 0, undo = false } = {}) {
  const spec = BULK_ACTIONS[action];
  const parts = [];
  if (undo) {
    if (succeeded) parts.push(`Undid ${items(succeeded)}.`);
    if (conflicts) parts.push(`${items(conflicts)} changed since then, so ${conflicts === 1 ? "it was" : "they were"} left as ${conflicts === 1 ? "it is" : "they are"}.`);
    if (failed) parts.push(`${items(failed)} could not be undone.`);
    if (!parts.length) parts.push("Nothing needed undoing.");
    return parts.join(" ");
  }
  if (succeeded) parts.push(`${items(succeeded)} ${spec.done}.`);
  if (failed) parts.push(`${failed} could not be ${spec.done}.`);
  if (skipped) parts.push(`${items(skipped)} ${skipped === 1 ? "was" : "were"} already ${action === "complete" ? "done" : "open"} or no longer available.`);
  if (!parts.length) parts.push(`Nothing to ${spec.verb}.`);
  return parts.join(" ");
}
