// Simple view without the DOM (#345, ADR 0013): the cards a Limited member
// sees, built from Rust's "my things today" and the household state, with
// the picture rule and this session's Done/Undo places. Nothing is counted.
//
// Picture rule: the item's emoji if set; else its first image attachment, by
// attach order, that is still attached and present on this device; else
// none. A photo not downloaded yet shows the emoji or nothing.

const IMAGE = /^image\/(?:png|jpe?g|gif|webp|avif)$/i;

/** The picture for an item: { emoji } | { attachment } | null. */
export function pictureFor(itemId, { emojis = new Map(), bindings = [], rows = [] } = {}) {
  const emoji = emojis.get(itemId);
  if (emoji) return { emoji };
  const present = new Map(rows.filter((row) => row.parentKind === "item" && row.parentId === itemId).map((row) => [row.attachmentId, row]));
  for (const binding of bindings) {
    if (binding.parentKind !== "item" || binding.parentId !== itemId || binding.removed) continue;
    const row = present.get(binding.attachmentId);
    if (row && IMAGE.test(row.type ?? "") && !["failed", "download-needed"].includes(row.state)) return { attachment: row };
  }
  return null;
}

/**
 * The cards, in Rust's order: [{ key, kind: "item" | "routine", id, text,
 * done, picture, occurrenceKey? }]. `doneThisSession` (a Map key -> true)
 * keeps an item completed here in its place, with Undo, until the session
 * ends; Rust no longer lists a completed item.
 */
export function buildCards(things, { state, emojis, rows = [], doneThisSession = new Map() }) {
  const items = new Map((state?.items ?? []).map((item) => [item.itemId, item]));
  const routines = new Map((state?.routines ?? []).map((routine) => [routine.routineId, routine]));
  const bindings = state?.attachments ?? [];
  const cards = [];
  const listed = new Set();
  for (const thing of things) {
    if (thing.kind === "item") {
      const item = items.get(thing.itemId);
      if (!item) continue;
      const key = `item:${item.itemId}`;
      listed.add(key);
      cards.push({ key, kind: "item", id: item.itemId, text: item.text, done: false, picture: pictureFor(item.itemId, { emojis, bindings, rows }) });
    } else {
      const routine = routines.get(thing.routineId);
      if (!routine) continue;
      const key = `routine:${routine.routineId}:${thing.occurrenceKey}`;
      listed.add(key);
      cards.push({ key, kind: "routine", id: routine.routineId, text: routine.text, done: thing.done, occurrenceKey: thing.occurrenceKey, picture: null });
    }
  }
  // Items marked done in this session stay where they were, with Undo.
  for (const [key, entry] of doneThisSession) {
    if (listed.has(key) || !key.startsWith("item:")) continue;
    const item = items.get(entry.id);
    if (!item || item.status !== "completed") continue;
    const card = { key, kind: "item", id: item.itemId, text: item.text, done: true, picture: pictureFor(item.itemId, { emojis, bindings, rows }) };
    const at = Math.min(entry.index ?? cards.length, cards.length);
    cards.splice(at, 0, card);
  }
  return cards;
}

/** Tonight's dinner as one line, or null (meals-view.js tonightLine). */
export function tonightCard(line) {
  return line ? { key: "tonight", kind: "tonight", text: line } : null;
}
