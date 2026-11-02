// Local reminder time handling for the in-app date/time control. Pure helpers:
// the browser supplies `now`; nothing here schedules or persists anything.

const pad = (value) => String(value).padStart(2, "0");

export function localDateValue(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localTimeValue(timestamp) {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Resolves labelled date and time inputs to a local timestamp, or a reason
// the person can act on. A past or present time is refused so a reminder can
// never fire the moment it is set.
export function resolveReminderTime({ date, time, now = Date.now() } = {}) {
  if (!date && !time) return { error: "Choose a date and a time." };
  if (!date) return { error: "Choose a date." };
  if (!time) return { error: "Choose a time." };
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(time);
  if (!dateMatch || !timeMatch) return { error: "That date or time isn't complete yet." };
  const [year, month, day] = dateMatch.slice(1).map(Number);
  const [hours, minutes] = timeMatch.slice(1).map(Number);
  const resolved = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (
    resolved.getFullYear() !== year || resolved.getMonth() !== month - 1 || resolved.getDate() !== day ||
    resolved.getHours() !== hours || resolved.getMinutes() !== minutes ||
    hours > 23 || minutes > 59
  ) return { error: "That date or time doesn't exist." };
  const at = resolved.getTime();
  if (!Number.isFinite(at)) return { error: "That date or time doesn't exist." };
  if (at <= now) return { error: "Choose a time that hasn't passed yet." };
  return { at };
}

export function describeReminderTime(at, locale = undefined) {
  return new Date(at).toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Shortcuts only fill the inputs; the resolved time stays visible for review.
export function reminderShortcut(kind, now = Date.now()) {
  const date = new Date(now);
  if (kind === "in-1-hour") {
    const soon = new Date(now + 3_600_000);
    soon.setSeconds(0, 0);
    return { date: localDateValue(soon.getTime()), time: localTimeValue(soon.getTime()) };
  }
  if (kind === "this-evening") {
    date.setHours(18, 0, 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    return { date: localDateValue(date.getTime()), time: "18:00" };
  }
  if (kind === "tomorrow-morning") {
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    return { date: localDateValue(date.getTime()), time: "09:00" };
  }
  throw new RangeError(`Unknown reminder shortcut: ${kind}`);
}
