// Civil dates, wall times and time zones for the family calendar (#660,
// ADR 0022 §1). Pure: no DOM, no storage.
//
// Rust keeps an event as a local wall time ({ date, minute }) plus an IANA
// zone and expands repeats in that local time, so a 9:00 weekly event stays
// at 9:00 across daylight saving time. Rust has no zone database; the
// browser does (`Intl`). Here a wall time in the event's zone becomes an
// instant, and the instant becomes the viewer's own wall time, so two
// members in different zones see the same moment at their own local times.
// A floating time (zone "") and an all-day date are shown as written.
//
// Civil dates are numbers YYYYMMDD, as everywhere in Kin. Date arithmetic
// goes through UTC milliseconds with setUTCFullYear, which (unlike Date.UTC)
// keeps years 1–99 as written.

export const MINUTES_PER_DAY = 1440;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** { year, month, day } of a civil date number. */
export function civilParts(date) {
  return { year: Math.floor(date / 10_000), month: Math.floor(date / 100) % 100, day: date % 100 };
}

export function civilDate(year, month, day) {
  return year * 10_000 + month * 100 + day;
}

/** UTC milliseconds of a civil date at `minute` past midnight (as if UTC). */
export function utcMs(date, minute = 0) {
  const { year, month, day } = civilParts(date);
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  return value.getTime() + minute * MINUTE_MS;
}

/** The civil date and minute of UTC milliseconds read as a wall clock. */
export function fromUtcMs(ms) {
  const value = new Date(ms);
  const date = civilDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  return { date, minute: value.getUTCHours() * 60 + value.getUTCMinutes() };
}

export function addDays(date, days) {
  return fromUtcMs(utcMs(date) + days * DAY_MS).date;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from, to) {
  return Math.round((utcMs(to) - utcMs(from)) / DAY_MS);
}

/** 0 Monday … 6 Sunday, as Rust and RRULE weekdays in Kin. */
export function weekday(date) {
  return (new Date(utcMs(date)).getUTCDay() + 6) % 7;
}

export function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The Monday (or `weekStart` day) on or before `date`. */
export function startOfWeek(date, weekStart = 0) {
  return addDays(date, -((weekday(date) - weekStart + 7) % 7));
}

export function startOfMonth(date) {
  const { year, month } = civilParts(date);
  return civilDate(year, month, 1);
}

/** The same day `months` months on, kept inside the month (31 Jan + 1 is
 * 28 or 29 Feb). */
export function addMonths(date, months) {
  const { year, month, day } = civilParts(date);
  const index = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(index / 12), nextMonth = (index % 12) + 1;
  return civilDate(nextYear, nextMonth, Math.min(day, daysInMonth(nextYear, nextMonth)));
}

/** `count` consecutive dates from `start`. */
export function dateSpan(start, count) {
  const dates = [];
  for (let index = 0; index < count; index += 1) dates.push(addDays(start, index));
  return dates;
}

/** The 42 dates (six weeks, Monday first) a month view shows for the
 * month of `date`. */
export function monthGrid(date, weekStart = 0) {
  return dateSpan(startOfWeek(startOfMonth(date), weekStart), 42);
}

/**
 * The seven days a Week or Day view shows around `date`: weeks run from
 * `today` in steps of seven, so the current week starts today ("today
 * first", as This week always has).
 */
export function weekAnchor(date, today) {
  return addDays(today, 7 * Math.floor(daysBetween(today, date) / 7));
}

/** The civil dates a view shows: { from, to } inclusive. */
export function viewRange(view, focus, today) {
  if (view === "day") return { from: focus, to: focus };
  if (view === "month") {
    const grid = monthGrid(focus);
    return { from: grid[0], to: grid.at(-1) };
  }
  const start = weekAnchor(focus, today);
  return { from: start, to: addDays(start, 6) };
}

/** Whether a view is on today's own day, week or month, so Today has
 * nowhere to go. A month's grid also shows days of the months either side;
 * those don't count. */
export function showsToday(view, focus, today) {
  if (view === "month") {
    const shown = civilParts(focus);
    const now = civilParts(today);
    return shown.year === now.year && shown.month === now.month;
  }
  const { from, to } = viewRange(view, focus, today);
  return today >= from && today <= to;
}

/** Moves the focus one view's step: a day, a week or a month. */
export function stepFocus(view, focus, direction) {
  if (view === "day") return addDays(focus, direction);
  if (view === "month") return addMonths(focus, direction);
  return addDays(focus, 7 * direction);
}

/** "YYYY-MM-DD" for a date input. */
export function isoDate(date) {
  const { year, month, day } = civilParts(date);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A date input's "YYYY-MM-DD" as a civil date, or null. */
export function fromIsoDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ""));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return civilDate(year, month, day);
}

/** "HH:MM" for a time input. */
export function timeText(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** A time input's "HH:MM" as minutes after midnight, or null. */
export function fromTimeText(text) {
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(text ?? ""));
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

// ---------------------------------------------------------------------------
// Zones.

const formatters = new Map();

function zoneFormatter(zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", era: "short",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The browser's own zone (the viewer's). */
export function viewerZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** Whether the browser knows `zone` (an IANA name). */
export function knownZone(zone) {
  if (!zone) return false;
  try { zoneFormatter(zone); return true; } catch { return false; }
}

/** The wall clock in `zone` at instant `ms`: { date, minute }. */
export function instantToWall(ms, zone) {
  const parts = {};
  for (const part of zoneFormatter(zone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  let year = Number(parts.year);
  // Years before 1 CE never reach here in practice; keep the arithmetic sane.
  if (parts.era === "BC" || parts.era === "B") year = 1 - year;
  const hour = Number(parts.hour) % 24;
  return { date: civilDate(year, Number(parts.month), Number(parts.day)), minute: hour * 60 + Number(parts.minute) };
}

/** Minutes `zone` is ahead of UTC at instant `ms`. */
export function zoneOffsetMinutes(zone, ms) {
  const wall = instantToWall(ms, zone);
  return Math.round((utcMs(wall.date, wall.minute) - Math.floor(ms / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

/**
 * The instant of wall time `{ date, minute }` in `zone`. Across a change of
 * offset:
 * - a time that happens twice (clocks go back) is the first of the two;
 * - a time that doesn't exist (clocks go forward) uses the offset from
 *   before the change, as RFC 5545 says, so 02:30 on the morning clocks
 *   jump from 02:00 to 03:00 is 03:30.
 */
export function wallToInstant({ date, minute }, zone) {
  const guess = utcMs(date, minute);
  const before = zoneOffsetMinutes(zone, guess - DAY_MS);
  const after = zoneOffsetMinutes(zone, guess + DAY_MS);
  const candidates = [...new Set([before, after])].map((offset) => guess - offset * MINUTE_MS)
    .filter((ms) => {
      const wall = instantToWall(ms, zone);
      return wall.date === date && wall.minute === minute;
    });
  if (candidates.length) return Math.min(...candidates);
  return guess - before * MINUTE_MS;
}

/**
 * A wall time of an event in `zone` as the viewer's wall time in `viewer`.
 * Floating times (zone "") and zones the browser doesn't know are shown as
 * written: { date, minute, shifted: false, known }.
 */
export function toViewerWall(time, zone, viewer = viewerZone()) {
  if (!zone || !knownZone(zone)) return { date: time.date, minute: time.minute, shifted: false, known: !zone };
  if (zone === viewer) return { date: time.date, minute: time.minute, shifted: false, known: true };
  const wall = instantToWall(wallToInstant(time, zone), viewer);
  return { ...wall, shifted: wall.date !== time.date || wall.minute !== time.minute, known: true };
}

/** The viewer's current wall time: { date, minute }. */
export function nowWall(viewer = viewerZone(), now = Date.now()) {
  return instantToWall(now, viewer);
}
