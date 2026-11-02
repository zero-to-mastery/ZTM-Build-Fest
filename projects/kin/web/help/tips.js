// The first week's calm tips on Today (#617, #622, ADR 0021): at most one at
// a time, each dismissible and never shown again once dismissed or used.
// First the offer of easy mode, then a pointer to Help. Pure apart from the
// small read and write helpers, which take the storage to use.
//
// Kept in this browser's local storage, unencrypted, like text size: when
// this browser first opened Kin unlocked (`kin.first-seen`, a time) and the
// tips already dealt with (`kin.tips-done`, their ids). Neither says
// anything about the household.

export const FIRST_SEEN_KEY = "kin.first-seen";
export const TIPS_DONE_KEY = "kin.tips-done";
/** Tips show only in the first week after this browser first opened Kin. */
export const FIRST_WEEK_MS = 7 * 24 * 60 * 60_000;

/** The words each tip uses (checked for plain language by
 * help-content.test.mjs). */
export const TIP_COPY = Object.freeze({
  "easy-mode": Object.freeze({
    heading: "Would bigger text help?",
    text: "Easy mode makes the words and buttons bigger and shows fewer things at once. You can change it any time under Household, Identity & appearance.",
    action: "Turn on easy mode",
    dismiss: "No thanks",
  }),
  help: Object.freeze({
    heading: "Help is on every page",
    text: "Not sure what something does? Press Help at the top of any page for a short explanation.",
    action: "Show me",
    dismiss: "Got it",
  }),
});

const TIP_IDS = Object.freeze(Object.keys(TIP_COPY));

/**
 * The tip to show now, or null: only within the first week, never one
 * already done, the easy mode offer only while easy mode and Simple view
 * are off, and nothing at all in Simple view.
 */
export function nextTip({ firstSeen, now, done = new Set(), easyMode = false, simpleView = false }) {
  if (simpleView || !Number.isSafeInteger(firstSeen) || now - firstSeen >= FIRST_WEEK_MS || now < firstSeen) return null;
  for (const id of TIP_IDS) {
    if (done.has(id)) continue;
    if (id === "easy-mode" && easyMode) continue;
    return id;
  }
  return null;
}

/** When this browser first opened Kin unlocked, recording `now` if never. */
export function firstSeen(now, storage = globalThis.localStorage) {
  try {
    const stored = Number(storage.getItem(FIRST_SEEN_KEY));
    if (Number.isSafeInteger(stored) && stored > 0) return stored;
    storage.setItem(FIRST_SEEN_KEY, String(now));
    return now;
  } catch {
    // Unreadable storage: no tips rather than the same tip every time.
    return null;
  }
}

/** The tips already dismissed or used. */
export function readTipsDone(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(TIPS_DONE_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => TIP_IDS.includes(id)) : []);
  } catch {
    return new Set();
  }
}

/** Marks tip `id` done for good; false if this browser couldn't keep it. */
export function markTipDone(id, storage = globalThis.localStorage) {
  const done = readTipsDone(storage);
  done.add(id);
  try {
    storage.setItem(TIPS_DONE_KEY, JSON.stringify([...done]));
    return true;
  } catch {
    return false;
  }
}
