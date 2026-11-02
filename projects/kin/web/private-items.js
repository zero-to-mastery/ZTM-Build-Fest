// "Just for me" (#510): pure helpers over the member's private list as Rust
// replayed it (KPRV section 11, web/wasm/kin-private.js). No DOM, no storage.
//
// - Where dated private items show on the member's own Today and This week
//   (#514). Dates are the integer civil dates (YYYYMMDD) the browser already
//   passes to Rust, so placing an item is an integer comparison.
// - Moving an item between private and the household (#517) is two steps in
//   two logs. Each move's new ID is derived from the old one, so a retry
//   after a partial failure finds the copy it already made instead of making
//   a second one; `nextShareStep` and `nextMakePrivateStep` say what is left.

/** The accessible name of a private item wherever it shows beside
 * household things. */
export function privateLabel(text) {
  return `Private: ${text}`;
}

/**
 * Whether dated private items may show on Today and This week here: the
 * member's setting is on and this isn't Simple view, the layout an admin
 * sets for a shared kitchen screen (ADR 0013).
 */
export function showPrivateOnToday({ onToday = true, simpleView = false } = {}) {
  return onToday === true && simpleView !== true;
}

const dated = (items) => (items ?? []).filter((item) => Number.isSafeInteger(item?.date));
const byDate = (left, right) => left.date - right.date || left.text.localeCompare(right.text);

/**
 * Today's private part, using Today's own rules (today-view.js): open items
 * dated today; open items from earlier days ("Earlier plans", still open);
 * later ones, soonest first ("Coming up"); and items dated today that are
 * done. Undated items stay in the Just for me list only.
 */
export function composePrivateToday(items, civilDate) {
  if (!Number.isSafeInteger(civilDate)) throw new TypeError("composePrivateToday needs the current civil date.");
  const withDate = dated(items);
  const open = withDate.filter((item) => !item.completed);
  return {
    earlier: open.filter((item) => item.date < civilDate).sort(byDate),
    today: open.filter((item) => item.date === civilDate).sort(byDate),
    upcoming: open.filter((item) => item.date > civilDate).sort(byDate),
    completed: withDate.filter((item) => item.completed && item.date === civilDate).sort(byDate),
  };
}

/**
 * This week with the member's private items: each day from Rust's week
 * (`{ date, ... }`) gains `privateItems`, the private items dated that day,
 * open first. Open items from before the first day join it, like Today's
 * earlier plans. Returns new day objects; the input is not changed.
 */
export function mergePrivateIntoWeek(days, items) {
  if (!Array.isArray(days) || !days.length) return days ?? [];
  const withDate = dated(items);
  const first = days[0].date;
  return days.map((day, index) => {
    const here = withDate.filter((item) => item.date === day.date || (index === 0 && item.date < first && !item.completed));
    here.sort((left, right) => Number(left.completed) - Number(right.completed) || byDate(left, right));
    return { ...day, privateItems: here };
  });
}

const ID = /^[a-f0-9]{32}$/;
const encoder = new TextEncoder();

/** The first 16 bytes of SHA-256(domain || id), as hex. */
async function derive(domain, id) {
  if (!ID.test(id ?? "")) throw new TypeError("A Kin ID is 32 hex digits.");
  const input = new Uint8Array([...encoder.encode(domain), 0, ...id.match(/../g).map((pair) => Number.parseInt(pair, 16))]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The household item a private item becomes when shared (#517). It
 * reveals nothing about the private ID: the hash runs one way. */
export const sharedItemId = (privateItemId) => derive("kin.just-for-me.share.v1", privateItemId);

/** The private item a household item becomes with "Make private" (#517). */
export const privateCopyId = (householdItemId) => derive("kin.just-for-me.make-private.v1", householdItemId);

const householdItem = (state, itemId) => state?.items?.find((item) => item.itemId === itemId) ?? null;

/**
 * The next step of sharing `item` (the private item as it was when the
 * member confirmed) as household item `targetId`, given the household
 * `state` and the private `items` now, or null when it is done:
 * add it to To do, give it the same planned date, then delete the private
 * one. A household item that already exists (made by an earlier try, or
 * since archived by someone) counts as added.
 */
export function nextShareStep(item, targetId, state, items) {
  const existing = householdItem(state, targetId);
  if (!existing) return { log: "household", command: { type: "add", id: targetId, text: item.text, classification: "need" } };
  if (existing.status === "active" && item.date != null && (existing.planningDate ?? null) !== item.date)
    return { log: "household", command: { type: "set-item-planning-date", itemId: targetId, planningDate: item.date } };
  if ((items ?? []).some((entry) => entry.id === item.id))
    return { log: "private", command: { type: "delete-private-item", itemId: item.id } };
  return null;
}

/**
 * The next step of "Make private" for household `record` (as it was when
 * the member chose it) as private item `targetId`, or null when it is done:
 * copy it into Just for me (with its planned date, and done if it was
 * done), then archive the household item. `known` says whether the private
 * list ever held `targetId` (deleted items are left out of `items`, so a
 * copy deleted since is never made again).
 */
export function nextMakePrivateStep(record, targetId, state, items, known = false) {
  const copy = (items ?? []).find((entry) => entry.id === targetId) ?? null;
  if (!copy && !known)
    return { log: "private", command: { type: "add-private-item", itemId: targetId, text: record.text, date: record.planningDate ?? null } };
  if (copy && record.status === "completed" && !copy.completed)
    return { log: "private", command: { type: "complete-private-item", itemId: targetId } };
  const current = householdItem(state, record.itemId);
  if (current && current.status !== "archived") return { log: "household", command: { type: "archive", itemId: record.itemId } };
  return null;
}

/** Whether this member may make household `record` private: they added it
 * and it is still in a list. */
export function canMakePrivate(record, memberId) {
  return Boolean(record && memberId && record.createdBy === memberId && record.status !== "archived");
}

/** The people a shared item reaches, for the confirmation: the other
 * members' names, or null when no one else is here yet. */
export function shareAudience(names) {
  const others = [...new Set((names ?? []).filter(Boolean))];
  if (!others.length) return null;
  if (others.length === 1) return others[0];
  return `${others.slice(0, -1).join(", ")} and ${others.at(-1)}`;
}
