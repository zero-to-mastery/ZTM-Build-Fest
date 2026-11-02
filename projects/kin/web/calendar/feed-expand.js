// Occurrences of a synced calendar (#668, ADR 0022 §3), expanded on the
// device.
//
// A synced feed is parsed by Rust (`parseICalendar`, KICS v1, the same parser
// as .ics import) into Kin events, but it never enters the household history,
// so Rust's range read (`kin_calendar_range`), which replays the history,
// can't expand it. This file walks the repeat rules here instead, as a
// line-for-line port of rust/src/calendar_recur.rs `for_each_start`: the
// same RFC 5545 subset in local civil time, the start always the first
// occurrence, a month without the chosen day skipped, UNTIL the last start
// date, COUNT walked from the start. feed-expand.test.mjs checks it against
// the cases calendar_tests.rs pins.
//
// It then applies the feed's own exceptions as an import would save them
// (kin-calendar.js decodeICalendar): EXDATEs cancel occurrences, an override
// (RECURRENCE-ID) replaces the occurrence of its master that it names, and a
// cancelled event is left out.
import { dayNumber, isCalendarDate } from "../wasm/kin-calendar.js";

export const MAX_EXTERNAL_OCCURRENCES = 5_000;
const MINUTES_PER_DAY = 1440;
const MAX_DAY = dayNumber(99991231);
const EPOCH_DAY = dayNumber(19700101);
const DAY_MS = 86_400_000;

/** YYYYMMDD for a day number (days since 0001-01-01). */
export function civilFromDay(day) {
  const date = new Date((day - EPOCH_DAY) * DAY_MS);
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

/** 0 Monday … 6 Sunday, as Rust's CivilDate::weekday (0001-01-01 was a
 * Monday). */
const weekdayOf = (day) => day % 7;
const yearOf = (date) => Math.floor(date / 10000);
const monthOf = (date) => Math.floor(date / 100) % 100;

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const weekStartOf = (day, weekStart) => Math.max(0, day - ((weekdayOf(day) + 7 - weekStart) % 7));
const monthIndex = (date) => yearOf(date) * 12 + monthOf(date) - 1;

/** The day `rule` picks in (year, month), as a day number, or null. */
function resolveDay(rule, year, month) {
  const last = daysInMonth(year, month);
  const at = (day) => dayNumber(year * 10000 + month * 100 + day);
  if (Number.isInteger(rule.monthDay)) {
    if (rule.monthDay === -1) return at(last);
    return rule.monthDay >= 1 && rule.monthDay <= last ? at(rule.monthDay) : null;
  }
  if (Number.isInteger(rule.nth) && Number.isInteger(rule.weekday)) {
    if (rule.nth === -1) {
      const lastDay = at(last);
      return lastDay - ((weekdayOf(lastDay) + 7 - rule.weekday) % 7);
    }
    const first = at(1);
    const day = 1 + ((rule.weekday + 7 - weekdayOf(first)) % 7) + (rule.nth - 1) * 7;
    return day <= last ? at(day) : null;
  }
  return null;
}

function periodMonth(rule, start, period) {
  const step = rule.interval * period * (rule.frequency === "monthly" ? 1 : 12);
  const index = monthIndex(start) + step;
  const year = Math.floor(index / 12);
  return year <= 9999 ? [year, (index % 12) + 1] : null;
}

/** The earliest day period `period` can hold, as a day number. */
function periodBase(rule, start, startDay, period) {
  switch (rule.frequency) {
    case "daily": return startDay + rule.interval * period;
    case "weekly": return weekStartOf(startDay, rule.weekStart) + 7 * rule.interval * period;
    default: {
      const month = periodMonth(rule, start, period);
      return month ? dayNumber(month[0] * 10000 + month[1] * 100 + 1) : null;
    }
  }
}

function candidates(rule, start, startDay, period) {
  const base = periodBase(rule, start, startDay, period);
  if (base === null || base > MAX_DAY) return [];
  if (rule.frequency === "daily") return [base];
  if (rule.frequency === "weekly") {
    const out = [];
    for (let offset = 0; offset < 7; offset += 1) if (rule.mask & (1 << weekdayOf(base + offset))) out.push(base + offset);
    return out;
  }
  const date = civilFromDay(base);
  const day = resolveDay(rule, yearOf(date), monthOf(date));
  return day === null ? [] : [day];
}

/** A period that starts on or before `day`: where a rule without COUNT
 * starts walking. */
function periodAt(rule, start, startDay, day) {
  if (day <= startDay) return 0;
  switch (rule.frequency) {
    case "daily": return Math.floor((day - startDay) / rule.interval);
    case "weekly": return Math.floor(Math.floor(Math.max(0, weekStartOf(day, rule.weekStart) - weekStartOf(startDay, rule.weekStart)) / 7) / rule.interval);
    case "monthly": return Math.floor((monthIndex(civilFromDay(day)) - monthIndex(start)) / rule.interval);
    default: return Math.floor((yearOf(civilFromDay(day)) - yearOf(start)) / rule.interval);
  }
}

function ruleOf(repeat) {
  if (!repeat) return null;
  return {
    frequency: repeat.frequency,
    interval: Math.max(1, repeat.interval ?? 1),
    mask: (repeat.weekdays ?? []).reduce((mask, day) => mask | (1 << day), 0),
    weekStart: repeat.weekStart ?? 0,
    monthDay: repeat.monthDay,
    nth: repeat.nth,
    weekday: repeat.weekday,
    count: repeat.count ?? null,
    untilDay: repeat.until ? dayNumber(repeat.until) : null,
  };
}

/** Calls `visit(day)` with each occurrence's start day number in
 * low..=high, ascending, until it returns false. */
export function forEachStart(event, low, high, visit) {
  const start = event.start.date;
  const startDay = dayNumber(start);
  if (high < startDay || high < low) return;
  if (startDay >= low && visit(startDay) === false) return;
  const rule = ruleOf(event.repeat);
  if (!rule) return;
  let emitted = 1;
  let period = rule.count === null ? periodAt(rule, start, startDay, low) : 0;
  for (;;) {
    const base = periodBase(rule, start, startDay, period);
    if (base === null || base > MAX_DAY || base > high || (rule.untilDay !== null && base > rule.untilDay)) return;
    for (const day of candidates(rule, start, startDay, period)) {
      if (day <= startDay) continue;
      if ((rule.untilDay !== null && day > rule.untilDay) || (rule.count !== null && emitted >= rule.count) || day > high) return;
      emitted += 1;
      if (day >= low && visit(day) === false) return;
    }
    period += 1;
  }
}

/** Minutes from an event's start to its end (timed), or days from its first
 * to its last date (all-day). */
function spanOf(event) {
  if (event.allDay) return Math.max(0, dayNumber(event.end.date) - dayNumber(event.start.date));
  const start = dayNumber(event.start.date) * MINUTES_PER_DAY + event.start.minute;
  const end = dayNumber(event.end.date) * MINUTES_PER_DAY + event.end.minute;
  return Math.max(0, end - start);
}

const key = (time) => `${time.date}:${time.minute}`;

/**
 * The read-only occurrences of a parsed feed (`parseICalendar`'s result)
 * that overlap the civil dates `from`..`to`, sorted by start. Each is
 * { sourceId, key, uid, title, place, notes, allDay, start, end, zone,
 * label, readOnly: true }. `label` is what the views show beside it
 * ("From Google"). Resolves at most MAX_EXTERNAL_OCCURRENCES and says so
 * (`truncated`).
 */
export function expandFeed(feed, from, to, { sourceId, label = "" } = {}) {
  if (!isCalendarDate(from) || !isCalendarDate(to) || to < from) return { occurrences: [], truncated: false };
  const entries = Array.isArray(feed?.events) ? feed.events : [];
  const excluded = entries.map((entry) => new Set((entry.exdates ?? []).map(key)));
  entries.forEach((entry) => {
    if (entry.master !== null && entry.master !== undefined && entry.original && excluded[entry.master]) excluded[entry.master].add(key(entry.original));
  });
  const low = dayNumber(from), high = dayNumber(to);
  const occurrences = [];
  let truncated = false;
  entries.forEach((entry, index) => {
    const event = entry.event;
    if (!event || entry.flags?.cancelled || truncated) return;
    const span = spanOf(event);
    const spanDays = event.allDay ? span : Math.ceil((event.start.minute + span) / MINUTES_PER_DAY);
    const add = (day) => {
      const date = civilFromDay(day);
      if (excluded[index].has(`${date}:${event.start.minute}`)) return true;
      let end;
      if (event.allDay) end = { date: civilFromDay(day + span), minute: 0 };
      else {
        const total = day * MINUTES_PER_DAY + event.start.minute + span;
        end = { date: civilFromDay(Math.floor(total / MINUTES_PER_DAY)), minute: total % MINUTES_PER_DAY };
      }
      if (dayNumber(end.date) < low) return true;
      if (occurrences.length >= MAX_EXTERNAL_OCCURRENCES) { truncated = true; return false; }
      occurrences.push({
        sourceId, key: `${sourceId}:${index}:${date}`, uid: event.sourceUid ?? "", title: event.title, place: event.place ?? "",
        notes: event.notes ?? "", allDay: Boolean(event.allDay), start: { date, minute: event.allDay ? 0 : event.start.minute }, end,
        zone: event.allDay ? "" : event.zone ?? "", label, readOnly: true,
      });
      return true;
    };
    // An override stands alone at its own time; its master skips the
    // occurrence it replaced (above).
    if (entry.master !== null && entry.master !== undefined) {
      const day = dayNumber(event.start.date);
      if (day <= high && day + spanDays >= low) add(day);
      return;
    }
    forEachStart(event, Math.max(0, low - spanDays), high, add);
  });
  occurrences.sort((a, b) => a.start.date - b.start.date || a.start.minute - b.start.minute || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return { occurrences, truncated };
}
