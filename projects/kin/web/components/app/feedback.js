// Plain, truthful feedback after an item action (#261, #267). It names what
// changed and how far the change has gone: saved on this device, waiting to
// sync, or (later, once the relay accepts everything waiting) sent. It never
// says another member has received or read anything.

const MAX_NAME_CHARS = 40;

const DONE = {
  complete: (name) => `Marked “${name}” done.`,
  reopen: (name) => `Reopened “${name}”.`,
  archive: (name) => `Archived “${name}”.`,
};

const FALLBACK = { complete: "Marked complete.", reopen: "Reopened.", archive: "Archived." };

/** An item's text as a short quote: first line, trimmed, at most 40
 * characters (by code point, so emoji are never split). */
export function quotedName(text) {
  const line = String(text ?? "").split(/\r?\n/, 1)[0].trim();
  const chars = [...line];
  return chars.length > MAX_NAME_CHARS ? `${chars.slice(0, MAX_NAME_CHARS - 1).join("").trimEnd()}…` : line;
}

/** How far a just-saved change has gone, as a trailing sentence or "". */
export function syncProgress({ syncing = false, offline = false } = {}) {
  if (!syncing) return "";
  return offline ? " It will sync when you're connected." : " Waiting to sync.";
}

/** The status line after completing, reopening or archiving an item. */
export function itemActionFeedback({ type, text = "", syncing = false, offline = false } = {}) {
  const name = quotedName(text);
  const done = name && DONE[type] ? DONE[type](name) : FALLBACK[type] ?? "Saved.";
  return `${done}${syncProgress({ syncing, offline })}`;
}

/** A pending-share marker for an action with no inline line of its own: when
 * the outbox empties it just lets the app announce "Sent to your household."
 * once (app/sync.js settlePendingShares). */
export function pendingActionShare() {
  let settled = false;
  return { markShared() { if (settled) return false; settled = true; return true; } };
}
