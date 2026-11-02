// The count on the installed app's icon (#476, #477): a per-device choice,
// Off unless the member turns it on. The number is worked out on this device
// from what it has decrypted; it is never sent anywhere and never says what
// is waiting, only how many. The Badging API itself is chat/chat-badge.js.
import { composeToday } from "./today-view.js";

export const APP_BADGE_KEY = "kin.app-badge";

/** The choices, in the order the setting shows them. */
export const APP_BADGE_CHOICES = Object.freeze([
  Object.freeze({ value: "off", label: "Off" }),
  Object.freeze({ value: "messages", label: "Unread messages" }),
  Object.freeze({ value: "messages-and-mine", label: "Unread messages and my things today" }),
]);
const VALUES = new Set(APP_BADGE_CHOICES.map((choice) => choice.value));

/** Whether this browser can put a number on the app icon. */
export function appBadgeSupported(nav = globalThis.navigator) {
  return typeof nav?.setAppBadge === "function" && typeof nav?.clearAppBadge === "function";
}

/** This device's choice; "off" when unset, unknown or unreadable. */
export function readAppBadgeChoice(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(APP_BADGE_KEY);
    return VALUES.has(value) ? value : "off";
  } catch {
    return "off";
  }
}

/** Saves this device's choice. Returns false if it couldn't be kept (the
 * choice still applies until Kin is closed). */
export function writeAppBadgeChoice(value, storage = globalThis.localStorage) {
  if (!VALUES.has(value)) throw new RangeError("Unknown app badge choice.");
  try {
    if (value === "off") storage.removeItem(APP_BADGE_KEY);
    else storage.setItem(APP_BADGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

/** Things for this member today (pure): Today's items planned for today, and
 * open routines due today ("every day" and "every weekday"), that this member
 * is responsible for (a routine taken in turns belongs to whoever's turn it
 * is). Unassigned things and everyone else's are not counted. Routines don't
 * count while the household is paused (Vacation, Guests, Rest), as on Today. */
export function myThingsToday({ items = [], routines = [], responsibilities = [], memberId = null, civilDate, mode = "normal" } = {}) {
  if (!memberId || !Number.isSafeInteger(civilDate)) return 0;
  const mine = new Set(responsibilities
    .filter((entry) => entry.memberId === memberId)
    .map((entry) => `${entry.targetKind}:${entry.targetId}`));
  const today = composeToday({ items, routines, mode, civilDate });
  const dueToday = today.routineGroups.find((group) => group.label === "Today")?.routines ?? [];
  return today.today.filter((item) => mine.has(`item:${item.itemId}`)).length +
    dueToday.filter((routine) => mine.has(`routine:${routine.routineId}`)).length;
}

/** The number for the icon (pure); 0 means no badge. `unread` is the chat's
 * unread count; `state`, `memberId` and `civilDate` are only read for "my
 * things today". */
export function appBadgeCount({ choice = "off", unread = 0, state = null, memberId = null, civilDate = null } = {}) {
  if (choice === "off" || !VALUES.has(choice)) return 0;
  const messages = Number.isSafeInteger(unread) && unread > 0 ? unread : 0;
  if (choice === "messages" || !state) return messages;
  return messages + myThingsToday({
    items: state.items ?? [],
    routines: state.routines ?? [],
    responsibilities: state.responsibilities ?? [],
    memberId,
    civilDate,
    mode: state.mode ?? "normal",
  });
}
