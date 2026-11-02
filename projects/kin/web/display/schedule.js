// The kitchen display's settings and night schedule (#670, ADR 0022 §4).
// Pure apart from the storage passed in: no DOM, no network.
//
// Display mode is a choice for this device, so it is kept here, in
// localStorage, unencrypted, like the display preferences: whether this
// device is a kitchen display (for which household vault), when it dims at
// night, and after how many quiet minutes the photo frame shows. None of it
// is household content. It applies only to the vault it was set for, so a
// device that starts again with another household isn't a display.
//
// Times are minutes after midnight in the device's own time. A night that
// starts later than it ends (21:00 to 06:30) runs over midnight.

export const DISPLAY_KEY = "kin.kitchen-display";
export const DEFAULT_NIGHT = Object.freeze({ from: 21 * 60, to: 6 * 60 + 30 });
export const IDLE_CHOICES = Object.freeze([1, 2, 5, 10, 15, 30]);
export const DEFAULT_IDLE_MINUTES = 5;
const DAY = 24 * 60;

/** "HH:MM" → minutes after midnight, or null. */
export function parseClock(text) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Minutes after midnight → "HH:MM". */
export function clockText(minutes) {
  const value = ((Math.trunc(minutes) % DAY) + DAY) % DAY;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

const minuteOk = (value) => Number.isSafeInteger(value) && value >= 0 && value < DAY;

/** Settings as kept, checked: `{ vaultId, on, night: { from, to }, idleMinutes }`. */
export function normalizeSettings(value) {
  const night = value?.night;
  const from = minuteOk(night?.from) ? night.from : DEFAULT_NIGHT.from;
  const to = minuteOk(night?.to) ? night.to : DEFAULT_NIGHT.to;
  return {
    vaultId: typeof value?.vaultId === "string" && /^[a-f0-9]{32}$/.test(value.vaultId) ? value.vaultId : null,
    on: value?.on === true,
    night: { from, to },
    idleMinutes: IDLE_CHOICES.includes(value?.idleMinutes) ? value.idleMinutes : DEFAULT_IDLE_MINUTES,
  };
}

/** This device's display settings (defaults when nothing valid is kept). */
export function readDisplaySettings(storage = globalThis.localStorage) {
  let value = null;
  try { value = JSON.parse(storage?.getItem(DISPLAY_KEY) ?? "null"); } catch { value = null; }
  return normalizeSettings(value);
}

/** Keeps the settings; best effort (a private window may refuse). */
export function writeDisplaySettings(settings, storage = globalThis.localStorage) {
  const value = normalizeSettings(settings);
  try {
    storage?.setItem(DISPLAY_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Whether display mode applies to the vault `vaultId` on this device. */
export function displayOnFor(settings, vaultId) {
  return Boolean(settings?.on && vaultId && settings.vaultId === vaultId);
}

/** Minutes after midnight for a Date, in the device's own time. */
export function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Whether `minute` (after midnight) is in the night `{ from, to }`. From
 * equal to to means no night at all. */
export function isNight(minute, { from, to } = DEFAULT_NIGHT) {
  if (from === to) return false;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/**
 * Milliseconds from `now` (a Date) until the night starts or ends next, so
 * one timer can follow the schedule; null with no night. At least one
 * second, at most a day.
 */
export function msUntilNextChange(now, night = DEFAULT_NIGHT) {
  if (night.from === night.to) return null;
  const minute = minuteOfDay(now);
  const into = now.getSeconds() * 1000 + now.getMilliseconds();
  const ahead = (target) => {
    let minutes = (target - minute + DAY) % DAY;
    if (minutes === 0) minutes = DAY;
    return minutes * 60_000 - into;
  };
  return Math.max(1000, Math.min(ahead(night.from), ahead(night.to)));
}

/** "Dims from 21:00 to 06:30", or that it never dims. */
export function nightText({ from, to } = DEFAULT_NIGHT) {
  return from === to ? "The screen doesn't dim at night." : `The screen dims from ${clockText(from)} to ${clockText(to)}.`;
}
