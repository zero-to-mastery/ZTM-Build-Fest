// Remote events this device could not apply yet (issue #153).
//
// A relay can deliver an event before one it depends on, for example a
// completion one page before the item it completes. Replay refuses it, and
// the sync cursor still moves on. Kin keeps the event's canonical bytes here,
// inside the encrypted sync state, and retries every kept event whenever a
// later sync page brings new events. An event leaves the quarantine once it
// applies or arrives again as a duplicate.
//
// The quarantine is bounded. Beyond MAX_QUARANTINED_EVENTS rows or
// MAX_QUARANTINED_BYTES, the rows already kept stay and later refusals are
// only counted (`dropped`), as every quarantined event was before. A row
// refused MAX_QUARANTINE_ATTEMPTS times is moved to the count too, so a true
// poison event can't fill the bound or cost a replay forever. Bytes that
// cannot even be decoded are never kept, since no retry can help them; they
// are counted the same way.
export const MAX_QUARANTINED_EVENTS = 100;
// The rows are re-encrypted with every sync state write, so the byte bound
// stays small; household events are typically well under 1 KiB.
export const MAX_QUARANTINED_BYTES = 64 * 1024;
export const MAX_QUARANTINE_ATTEMPTS = 20;

const REASONS = Object.freeze({
  "not-applicable": "it doesn't fit this device's household history yet",
  unreadable: "its contents couldn't be read",
  unsupported: "this version of Kin can't apply it",
});

/** Plain-language reason for a quarantine reason code. */
export function quarantineReasonText(reason) {
  return REASONS[reason] ?? REASONS["not-applicable"];
}

/**
 * Received-batch items that replay the kept events alongside a new page.
 * A kept event already in history, or arriving again in this page, is not
 * replayed from the kept copy: history or the page copy decides, so a kept
 * copy can never collide with them and stop sync. Not being refused again,
 * such a row then leaves the quarantine.
 */
export function quarantineRetryItems(quarantine = [], { isKnown = () => false } = {}) {
  return quarantine.filter((row) => !isKnown(row.eventId)).map((row) => ({ encodedEvent: row.encoded, retry: true }));
}

/**
 * The quarantine after one commit.
 * - `previous`: the stored rows.
 * - `quarantined`: what reconcileRemoteEvents refused this time,
 *   `{ eventId | null, encoded, reason }`.
 * - `retried`: whether the stored rows were replayed in this commit. If they
 *   were, a stored row that is no longer refused has applied (or arrived
 *   again) and leaves; if not, stored rows are kept unchanged.
 * Returns the rows to store, how many refusals are new, and how many new
 * refusals could not be kept.
 */
export function nextQuarantine(previous = [], quarantined = [], { now, retried }) {
  const byId = new Map(previous.map((row) => [row.eventId, row]));
  const refused = new Map();
  let dropped = 0;
  let added = 0;
  for (const item of quarantined) {
    if (!item.eventId) { dropped += 1; added += 1; continue; }
    if (refused.has(item.eventId)) continue;
    const earlier = byId.get(item.eventId);
    if (!earlier) added += 1;
    refused.set(item.eventId, earlier
      ? { ...earlier, reason: item.reason, attempts: earlier.attempts + 1 }
      : { eventId: item.eventId, encoded: item.encoded, reason: item.reason, firstSeenAt: now, attempts: 1 });
  }
  // Rows already kept come first, in their stored order, so a new refusal
  // can never push one out; then this commit's new refusals.
  const candidates = [];
  for (const row of previous) {
    const next = refused.get(row.eventId);
    if (next) candidates.push(next);
    else if (!retried) candidates.push(row);
  }
  for (const [eventId, row] of refused) if (!byId.has(eventId)) candidates.push(row);
  const kept = [];
  let bytes = 0;
  for (const row of candidates) {
    const size = row.encoded?.byteLength ?? 0;
    if (row.attempts > MAX_QUARANTINE_ATTEMPTS || kept.length >= MAX_QUARANTINED_EVENTS || bytes + size > MAX_QUARANTINED_BYTES) {
      dropped += 1;
      continue;
    }
    kept.push(row);
    bytes += size;
  }
  return { quarantine: kept, added, dropped };
}

/** One line per kept event for the "review this device" state. Plain text. */
export function describeQuarantine(quarantine = [], { limit = 5, attempts = true } = {}) {
  const lines = quarantine.slice(0, limit).map((row) =>
    `${row.eventId.slice(0, 12)}… was not applied because ${quarantineReasonText(row.reason)}${attempts ? ` (tried ${row.attempts} ${row.attempts === 1 ? "time" : "times"})` : ""}.`);
  if (quarantine.length > limit) lines.push(`…and ${quarantine.length - limit} more.`);
  return lines;
}

export const QUARANTINE_MESSAGE =
  "Some trusted-device changes could not be applied. Ask a household Adult to review this device.";

/** The "review this device" message, naming the kept events when there are any. */
export function quarantineMessage(quarantine = []) {
  // No attempt counts here: the notice is a live region, and text that
  // changes on every retry would be re-announced each time.
  const lines = describeQuarantine(quarantine, { limit: 3, attempts: false });
  if (!lines.length) return QUARANTINE_MESSAGE;
  return `Some trusted-device changes could not be applied yet. Kin will try them again as more changes arrive; if this keeps happening, ask a household Adult to review this device. ${lines.join(" ")}`;
}
