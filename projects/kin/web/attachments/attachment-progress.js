// Session-only capture progress for attachments, keyed by parent record.
//
// Item rows are rebuilt on every state refresh (and every sync tick), so a
// status node handed to an event handler is detached before the save finishes.
// Keeping the phase here lets a freshly rendered <kin-attachments> show the
// current "Saving…" / "Saved" / error text for its parent, and lets the app
// update that text without re-rendering the whole list. Nothing is persisted.

const PHASES = new Set(["preparing", "saving", "saved", "error"]);
const entries = new Map();
const listeners = new Set();

export function attachmentProgressKey(parentKind, parentId) {
  return `${parentKind}:${parentId}`;
}

export function setAttachmentProgress(parentKind, parentId, progress) {
  if (!PHASES.has(progress?.phase) || typeof progress.message !== "string" || !progress.message)
    throw new Error("Attachment progress needs a known phase and a message.");
  const key = attachmentProgressKey(parentKind, parentId);
  entries.set(key, { phase: progress.phase, message: progress.message });
  notify(key);
}

export function getAttachmentProgress(parentKind, parentId) {
  return entries.get(attachmentProgressKey(parentKind, parentId)) ?? null;
}

export function clearAttachmentProgress(parentKind, parentId) {
  if (parentKind === undefined) {
    const keys = [...entries.keys()];
    entries.clear();
    for (const key of keys) notify(key);
    return;
  }
  const key = attachmentProgressKey(parentKind, parentId);
  if (entries.delete(key)) notify(key);
}

export function subscribeAttachmentProgress(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(key) {
  for (const listener of [...listeners]) {
    try { listener(key, entries.get(key) ?? null); }
    catch { /* One listener must not stop the others from updating. */ }
  }
}
