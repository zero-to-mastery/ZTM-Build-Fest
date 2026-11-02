// Pure helpers for reminders and settings that follow a member (#520).
// Rust (rust/src/private_prefs.rs) decides what the records say; these only
// plan what this device does with the projection: which of its own
// reminders move into the private log, which synced reminders it arms, how
// a reminder's time reads here, and how settings map to this device's
// stores. No DOM, storage or clock of their own: callers pass `now`.
import { APPEARANCE_PRESETS, KIN_DEFAULT_SEED, normalizeHex } from "../appearance/palette.js";
import { parseReminderId } from "../wasm/kin-prefs.js";

/** A synced reminder that came due less than this long ago still fires on
 * a device that opens Kin late; older ones are past and stay quiet. */
export const LATE_WINDOW_MS = 10 * 60_000;

/** The settings that follow a member, with this device's defaults. Key 7
 * ("private-on-today") is reserved: Just for me keeps its Today setting as
 * its own kind 118, which already follows the member (#510). */
export const SYNCED_SETTING_DEFAULTS = Object.freeze({
  "theme-mode": "household",
  "theme-color": "household",
  "text-size": "standard",
  motion: "system",
  "reminder-alerts": "on",
  "app-badge": "off",
  // Easy mode (#617, ADR 0021): a presentation the member chooses.
  "easy-mode": "off",
});

/** This browser's time zone and UTC offset at `at`, as a reminder keeps
 * them. An unknown or odd zone name is kept as "" (unknown). */
export function zoneSnapshot(at, { timeZone = defaultTimeZone(), offsetAt = (instant) => -new Date(instant).getTimezoneOffset() } = {}) {
  const offset = Math.round(offsetAt(at));
  return {
    timeZone: typeof timeZone === "string" && timeZone.length <= 64 && /^[A-Za-z0-9/_+-]+$/.test(timeZone) ? timeZone : "",
    utcOffsetMinutes: Number.isInteger(offset) ? Math.min(840, Math.max(-720, offset)) : 0,
  };
}

function defaultTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; } catch { return ""; }
}

/**
 * Which of this device's own reminders move into the private log, once:
 * `local` is { id → { at } } for reminders set on this device before
 * private storage was on (not ones armed from the log), `synced` the
 * projection's reminders. A thing that already has a synced reminder keeps
 * that one (no duplicates; Rust also refuses a set that changes nothing).
 * Past reminders and IDs that aren't an item or routine stay local.
 */
export function migrationPlan(local, synced, now) {
  const have = new Set(synced.map((reminder) => reminder.reminderId));
  const plan = [];
  for (const [reminderId, entry] of local) {
    if (!parseReminderId(reminderId) || have.has(reminderId)) continue;
    if (!Number.isSafeInteger(entry?.at) || entry.at <= now) continue;
    plan.push({ reminderId, at: entry.at });
  }
  return plan.sort((left, right) => (left.reminderId < right.reminderId ? -1 : left.reminderId > right.reminderId ? 1 : 0));
}

/**
 * What this device does with the synced reminders:
 * - `visible`: { id → reminder } shown beside their items and routines:
 *   upcoming ones and those due within the late window.
 * - `arm`: the visible ones to arm here (alerts on and permission granted)
 *   that aren't armed for that instant and haven't fired here.
 * - `cancel`: IDs armed from the log whose reminder is gone, past, moved
 *   (re-armed by `arm`) or no longer to alert here.
 * `armed` is { id → { at } } for timers this device armed from the log;
 * `fired` is a set of "id@at" this device already showed.
 */
export function reminderPlan(synced, { now, armed = new Map(), fired = new Set(), alerts = true, lateWindowMs = LATE_WINDOW_MS } = {}) {
  const visible = new Map();
  for (const reminder of synced) {
    if (reminder.at > now - lateWindowMs) visible.set(reminder.reminderId, reminder);
  }
  const arm = [];
  const cancel = [];
  for (const [reminderId, reminder] of visible) {
    if (!alerts || fired.has(`${reminderId}@${reminder.at}`)) continue;
    if (armed.get(reminderId)?.at !== reminder.at) arm.push(reminder);
  }
  for (const [reminderId, entry] of armed) {
    const reminder = visible.get(reminderId);
    if (!alerts || !reminder || reminder.at !== entry.at) cancel.push(reminderId);
  }
  return { visible, arm, cancel };
}

function formatAt(at, { timeZone, locale } = {}) {
  const options = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return new Date(at).toLocaleString(locale, timeZone ? { ...options, timeZone } : options);
  } catch {
    return new Date(at).toLocaleString(locale, options);
  }
}

function formatClock(at, { timeZone, locale } = {}) {
  try {
    return new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone });
  } catch {
    return null;
  }
}

/**
 * How a synced reminder reads on this device: its instant in this
 * device's zone, and — when it was set somewhere whose clock reads
 * differently at that instant — the time where it was set, so a reminder
 * set for 9:00 in New York reads "Tue, Oct 20, 3:00 PM (9:00 AM in
 * America/New_York, where it was set)" in Paris.
 */
export function describeSyncedReminder(reminder, { timeZone = defaultTimeZone(), locale } = {}) {
  const here = formatAt(reminder.at, { timeZone, locale });
  if (!reminder.timeZone || reminder.timeZone === timeZone) return { when: here, where: "" };
  const hereClock = formatClock(reminder.at, { timeZone, locale });
  const thereClock = formatClock(reminder.at, { timeZone: reminder.timeZone, locale });
  if (!thereClock || thereClock === hereClock) return { when: here, where: "" };
  return { when: here, where: `${thereClock} in ${reminder.timeZone}, where it was set` };
}

/** This device's personal appearance (appearance/store.js, version 2 or
 * 1) as the two theme settings. A color taken from this device's own
 * background picture isn't synced (null): the picture stays here. */
export function appearanceSettings(personal) {
  const mode = personal?.mode === undefined ? "household" : personal.mode;
  let color;
  if (personal?.colorSource === undefined) color = "household";
  else if (personal.colorSource === "default") color = "default";
  else if (personal.colorSource === "preset" || personal.colorSource === "custom")
    color = normalizeHex(personal.seed) ? `${personal.colorSource}-${personal.seed.slice(1).toLowerCase()}` : null;
  else color = null;
  return { "theme-mode": mode, "theme-color": color };
}

/**
 * The personal appearance with synced theme values applied, or null when
 * nothing changes. Only keys present in `settings` apply; the background
 * picture always stays this device's.
 */
export function applyAppearanceSettings(personal, settings) {
  const current = appearanceSettings(personal);
  const next = { ...personal, version: 2 };
  let changed = false;
  const mode = settings["theme-mode"];
  if (mode && mode !== current["theme-mode"] && ["household", "system", "light", "dark"].includes(mode)) {
    if (mode === "household") delete next.mode;
    else next.mode = mode;
    changed = true;
  }
  const color = settings["theme-color"];
  if (color && color !== current["theme-color"]) {
    const match = /^(preset|custom)-([a-f0-9]{6})$/.exec(color);
    if (color === "household") {
      delete next.colorSource; delete next.seed; delete next.manual;
      changed = true;
    } else if (color === "default") {
      Object.assign(next, { colorSource: "default", seed: KIN_DEFAULT_SEED, manual: null });
      changed = true;
    } else if (match) {
      const seed = `#${match[2].toUpperCase()}`;
      const preset = APPEARANCE_PRESETS.find((entry) => entry.seed === seed && entry.id !== "default");
      const source = match[1];
      Object.assign(next, {
        colorSource: source, seed,
        manual: { source, seed, name: source === "preset" ? preset?.name ?? "Custom color" : "Custom color" },
      });
      changed = true;
    }
  }
  for (const key of ["mode", "colorSource", "seed", "manual", "image"]) if (next[key] === undefined) delete next[key];
  return changed ? next : null;
}

/**
 * What to do when private storage is on and this device follows it:
 * `apply` — synced values this device doesn't have yet; `seed` — this
 * device's own non-default values for keys nothing has synced yet (the
 * first device to turn private storage on brings its settings with it).
 * `local` is { key → value } (a null value is never synced).
 */
export function settingsPlan(local, synced) {
  const apply = {};
  const seed = [];
  for (const key of Object.keys(SYNCED_SETTING_DEFAULTS)) {
    const mine = local[key];
    const theirs = synced[key]?.value;
    if (theirs) { if (theirs !== mine) apply[key] = theirs; }
    else if (mine && mine !== SYNCED_SETTING_DEFAULTS[key]) seed.push({ key, value: mine });
  }
  return { apply, seed };
}

/** The keys among `keys` whose local value differs from the synced one
 * (an unsynced key reads as its default). */
export function changedSettings(local, synced, keys) {
  return keys
    .filter((key) => Object.hasOwn(SYNCED_SETTING_DEFAULTS, key) && local[key] &&
      local[key] !== (synced[key]?.value ?? SYNCED_SETTING_DEFAULTS[key]))
    .map((key) => ({ key, value: local[key] }));
}
