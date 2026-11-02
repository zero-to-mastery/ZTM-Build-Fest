// Personal display and reminder preferences kept on this device (#524):
// text size, a reduced-motion override, whether reminders alert and easy
// mode (#617, ADR 0021), plus
// the "Use different settings on this device" switch. Each is a short
// non-sensitive value in localStorage, so the lock screen opens at the same
// size and motion; with private storage on, the synced copy
// (app/private-prefs.js) is written here as it arrives. Unreadable storage
// falls back to the default and the choice applies until Kin closes.

export const TEXT_SIZE_KEY = "kin.text-size";
export const MOTION_KEY = "kin.motion";
export const REMINDER_ALERTS_KEY = "kin.reminder-alerts";
export const DEVICE_ONLY_KEY = "kin.settings-this-device";
export const EASY_MODE_KEY = "kin.easy-mode";

export const TEXT_SIZES = Object.freeze([
  Object.freeze({ value: "standard", label: "Standard" }),
  Object.freeze({ value: "large", label: "Large" }),
  Object.freeze({ value: "larger", label: "Larger" }),
]);
const CHOICES = Object.freeze({
  [TEXT_SIZE_KEY]: Object.freeze({ values: new Set(TEXT_SIZES.map((size) => size.value)), fallback: "standard" }),
  [MOTION_KEY]: Object.freeze({ values: new Set(["system", "reduce"]), fallback: "system" }),
  [REMINDER_ALERTS_KEY]: Object.freeze({ values: new Set(["on", "off"]), fallback: "on" }),
  [DEVICE_ONLY_KEY]: Object.freeze({ values: new Set(["on", "off"]), fallback: "off" }),
  [EASY_MODE_KEY]: Object.freeze({ values: new Set(["on", "off"]), fallback: "off" }),
});

/** The setting each key stores (kin-prefs.js SETTING_KEYS names). */
export const DISPLAY_SETTING_KEYS = Object.freeze({ "text-size": TEXT_SIZE_KEY, motion: MOTION_KEY, "reminder-alerts": REMINDER_ALERTS_KEY, "easy-mode": EASY_MODE_KEY });

/** This device's value for `key`; the default when unset or unreadable. */
export function readDisplayPref(key, storage = globalThis.localStorage) {
  const choice = CHOICES[key];
  if (!choice) throw new RangeError("Unknown display preference.");
  try {
    const value = storage?.getItem(key);
    return choice.values.has(value) ? value : choice.fallback;
  } catch {
    return choice.fallback;
  }
}

/** Keeps `value` for `key` on this device (the default is stored as
 * nothing). Returns false if it couldn't be kept. */
export function writeDisplayPref(key, value, storage = globalThis.localStorage) {
  const choice = CHOICES[key];
  if (!choice?.values.has(value)) throw new RangeError("Unknown display preference value.");
  try {
    if (value === choice.fallback) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Puts text size, motion and easy mode on the document root, where
 * app.css reads them (`data-kin-text-size`, `data-kin-motion`,
 * `data-kin-easy`). Simple view wins over easy mode (ADR 0021): while the
 * root carries `data-kin-simple`, easy mode stays off. */
export function applyDisplayPrefs({ textSize, motion, easyMode }, root = globalThis.document?.documentElement) {
  if (!root) return;
  if (textSize === "large" || textSize === "larger") root.dataset.kinTextSize = textSize;
  else delete root.dataset.kinTextSize;
  if (motion === "reduce") root.dataset.kinMotion = "reduce";
  else delete root.dataset.kinMotion;
  if (easyMode === "on" && root.dataset.kinSimple !== "on") root.dataset.kinEasy = "on";
  else delete root.dataset.kinEasy;
}

/** Applies what this device keeps (at start, before unlock). */
export function applyStoredDisplayPrefs(storage = globalThis.localStorage, root = globalThis.document?.documentElement) {
  applyDisplayPrefs({ textSize: readDisplayPref(TEXT_SIZE_KEY, storage), motion: readDisplayPref(MOTION_KEY, storage), easyMode: readDisplayPref(EASY_MODE_KEY, storage) }, root);
}

/** Whether motion should be reduced: Kin's own override or the system's. */
export function prefersReducedMotion(view = globalThis) {
  return view.document?.documentElement?.dataset.kinMotion === "reduce" ||
    Boolean(view.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}
