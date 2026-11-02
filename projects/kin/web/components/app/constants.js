// Shared messages and preferences for the application shell.
export const START_ERROR =
  "Kin could not start its household engine or local storage. Your saved information was not intentionally deleted.";
export const SAVE_ERROR =
  "Kin could not save that change locally. Your existing information was not intentionally deleted.";
export const ATTACHMENT_OPEN_ERROR =
  "We couldn't open this attachment. Your existing household information hasn't been deleted.";
export const AUTO_LOCK_KEY = "kin.auto-lock-minutes";
// One plain-language line under each destination's heading (#261, #266), so
// a new member learns what lives where without learning Kin's vocabulary
// first. The five destinations keep their names, order and routes; Today's
// line is its date. Easy mode shows these lines too, so they keep to plain
// words (#618); help/help-content.test.mjs checks that any harder word is
// explained in that page's Help.
export const DESTINATION_DESCRIPTIONS = Object.freeze({
  lists: "Things to do, your shopping list, and staples: things you buy again and again.",
  routines: "Things that come round again, like bin night, plus checklists you reuse.",
  updates: "Leave a note for someone in Handoffs, talk with your household in Chat, and save bigger topics in To talk about for a calm moment.",
  // When the household's chat policy leaves this member without Chat (#123).
  updatesWithoutChat: "Leave a note for someone in Handoffs, and save bigger topics in To talk about for a calm moment.",
  household: "Notes, people and devices, privacy and recovery, and how Kin looks for you.",
  // The Calendar (#661): This week grown into Day, Week and Month views.
  week: "Family events in each person's colour, with things planned, routines and meals, by week, day or month.",
});
// The Household overview's links (#266), with one plain line each.
export const HOUSEHOLD_HUB_LINKS = Object.freeze([
  Object.freeze(["fridge", "A shared board to draw on together."]),
  Object.freeze(["photos", "Photos for the whole family, and a slideshow."]),
  Object.freeze(["notes", "Notes and useful details, like when the boiler was last serviced."]),
  Object.freeze(["areas", "Parts of your home, the household's mode, and how everyone is doing."]),
  Object.freeze(["people", "Who is in your household, and adding a phone or computer."]),
  Object.freeze(["privacy", "Locking Kin, ways to sign in, and keeping a safe copy of everything."]),
  Object.freeze(["appearance", "Your colors, text size and easy mode."]),
  Object.freeze(["features", "Which parts of Kin your household uses."]),
]);
export const INLINE_SAVE_FAILED = "Couldn't save. Your text is still here.";

// Plain-language explanations for sync pauses. The code is kept on the state
// object for debugging and tests; only the wording changes here.
export const SYNC_PAUSE_MESSAGES = {
  device_not_trusted: "This device no longer has access to household updates. Everything already saved here stays on this device.",
  membership_removed: "This device no longer has access to household updates. Everything already saved here stays on this device.",
  authentication_required: "Sign in to your household again to keep syncing. Your changes are saved on this device until then.",
  connection_unavailable: "Your changes are saved on this device and will sync when you're connected.",
};

export function readAutoLockPreference() {
  try {
    const value = Number(localStorage.getItem(AUTO_LOCK_KEY));
    return [0, 5, 15, 60].includes(value) ? value : 0;
  } catch { return 0; }
}

export const BULK_UNDO_WINDOW_MS = 10 * 60_000;
export const BULK_UNDO_UNVERIFIED = "Unable to verify the latest item state. No changes were undone. Try again.";
