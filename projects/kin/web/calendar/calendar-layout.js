// Where calendar occurrences fall and how they are laid out (#660). Pure:
// no DOM. The views (components/calendar/) draw what this works out.
//
// An occurrence comes from KCAL (kin-calendar.js decodeCalendarRange) or,
// read-only, from an outside calendar the device keeps (#665,
// `CalendarController.setExternalOccurrences`). Each is placed in the
// viewer's local time (calendar-time.js), then split into the days it
// touches: all-day ones (and timed ones that cover a whole day) go in each
// day's all-day row, timed ones in the day's timeline as a segment of
// minutes. Overlapping timed segments share the width in columns.
import { MINUTES_PER_DAY, addDays, daysBetween, toViewerWall, utcMs, viewerZone, weekday } from "./calendar-time.js";

/** The key of an occurrence: its event and original start. */
export function occurrenceKey(occurrence) {
  const source = occurrence.external ? `x:${occurrence.sourceId}:${occurrence.uid ?? occurrence.title}` : occurrence.eventId;
  return `${source}:${occurrence.start.date}:${occurrence.start.minute}`;
}

/**
 * An occurrence in the viewer's local time:
 * { key, occurrence, allDay, start: { date, minute }, end: { date, minute },
 *   shifted, zone, floating, readonly }. All-day ends are the last date,
 * inclusive; timed ends are exclusive minutes (an event that ends at
 * midnight ends at minute 0 of the next day).
 */
export function placeOccurrence(occurrence, viewer = viewerZone()) {
  const base = {
    key: occurrenceKey(occurrence), occurrence, readonly: occurrence.external === true,
    zone: occurrence.zone ?? "", floating: !occurrence.allDay && !occurrence.zone,
  };
  if (occurrence.allDay) return { ...base, allDay: true, start: { date: occurrence.start.date, minute: 0 }, end: { date: occurrence.end.date, minute: 0 }, shifted: false };
  const start = toViewerWall(occurrence.start, occurrence.zone, viewer);
  const end = toViewerWall(occurrence.end, occurrence.zone, viewer);
  return {
    ...base, allDay: false,
    start: { date: start.date, minute: start.minute }, end: { date: end.date, minute: end.minute },
    shifted: start.shifted || end.shifted, unknownZone: !start.known,
  };
}

/**
 * The placed occurrences by day, for each date from `from` to `to`:
 * Map date → { allDay: [placed], timed: [{ placed, start, end,
 * continuesBefore, continuesAfter }] }, each list in start order. A timed
 * occurrence that covers a whole day shows in that day's all-day row.
 */
export function occurrencesByDay(placed, from, to) {
  const days = new Map();
  for (let date = from; date <= to; date = addDays(date, 1)) days.set(date, { allDay: [], timed: [] });
  const sorted = [...placed].sort(compareStarts);
  for (const entry of sorted) {
    if (entry.allDay) {
      for (let date = Math.max(entry.start.date, from); date <= Math.min(entry.end.date, to); date = addDays(date, 1)) days.get(date)?.allDay.push(entry);
      continue;
    }
    // A zero-length event still shows, as a moment.
    const lastDate = entry.end.minute === 0 && entry.end.date > entry.start.date ? addDays(entry.end.date, -1) : entry.end.date;
    for (let date = Math.max(entry.start.date, from); date <= Math.min(lastDate, to); date = addDays(date, 1)) {
      const day = days.get(date);
      if (!day) continue;
      const start = date === entry.start.date ? entry.start.minute : 0;
      const end = date === entry.end.date ? entry.end.minute : MINUTES_PER_DAY;
      if (start === 0 && end === MINUTES_PER_DAY && date !== entry.start.date) { day.allDay.push(entry); continue; }
      day.timed.push({ placed: entry, start, end: Math.max(end, start), continuesBefore: date !== entry.start.date, continuesAfter: date !== lastDate });
    }
  }
  return days;
}

function compareStarts(left, right) {
  return (left.start.date - right.start.date) || (left.allDay === right.allDay ? 0 : left.allDay ? -1 : 1) ||
    (left.start.minute - right.start.minute) || (right.end.date - left.end.date) || (right.end.minute - left.end.minute) ||
    String(left.occurrence.title).localeCompare(String(right.occurrence.title)) || left.key.localeCompare(right.key);
}

/** Shortest length a segment is laid out with, so a 5-minute or zero-length
 * event still has room for its title. */
export const MIN_LAYOUT_MINUTES = 30;

/**
 * Lays out one day's timed segments side by side where they overlap:
 * each gets { column, columns } within its cluster (segments that overlap
 * one another, directly or through others). Columns are filled greedily in
 * start order, so the layout is stable for the same input.
 */
export function layoutDay(segments) {
  const ordered = [...segments].sort((a, b) => (a.start - b.start) || (b.end - a.end) || compareStarts(a.placed, b.placed));
  const out = [];
  let cluster = [], clusterEnd = -1, columnEnds = [];
  const flush = () => {
    const columns = columnEnds.length;
    for (const entry of cluster) out.push({ ...entry, columns });
    cluster = [];
    columnEnds = [];
  };
  for (const segment of ordered) {
    const end = Math.max(segment.end, segment.start + MIN_LAYOUT_MINUTES);
    if (cluster.length && segment.start >= clusterEnd) flush();
    let column = columnEnds.findIndex((columnEnd) => columnEnd <= segment.start);
    if (column < 0) { column = columnEnds.length; columnEnds.push(end); } else columnEnds[column] = end;
    cluster.push({ ...segment, column });
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length) flush();
  return out;
}

// ---------------------------------------------------------------------------
// Words.

const wallDate = (date) => new Date(utcMs(date));

/** "Tuesday 6 October" (in the browser's language). */
export function dayLabel(date, { year = false } = {}) {
  return wallDate(date).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** "Tue 6" for a narrow day button. */
export function shortDayLabel(date) {
  return wallDate(date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" });
}

/** "October 2026". */
export function monthLabel(date) {
  return wallDate(date).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "5:30 PM" (or "17:30", by the browser's language) for a wall minute. */
export function timeLabel(minute) {
  return new Date(utcMs(20000101, minute)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
}

/** Weekday names, Monday first: "Monday"… or "Mon"… */
export function weekdayNames(style = "long") {
  return [0, 1, 2, 3, 4, 5, 6].map((index) => wallDate(20261005 + index).toLocaleDateString(undefined, { weekday: style, timeZone: "UTC" }));
}

/** "Alex and Sam", "Alex, Sam and Jo", or "Everyone" with no one listed. */
export function peopleText(attendees, labelOf) {
  const names = (attendees ?? []).map((id) => labelOf(id));
  if (!names.length) return "Everyone";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** When a placed occurrence happens on `date`, in words: "All day",
 * "5:30 PM to 6:15 PM", "Until 9:00 AM", "From 10:00 PM". */
export function whenText(placed, date) {
  if (placed.allDay) {
    if (placed.start.date === placed.end.date) return "All day";
    return `All day, ${daysBetween(placed.start.date, date) + 1} of ${daysBetween(placed.start.date, placed.end.date) + 1} days`;
  }
  const starts = placed.start.date === date, ends = placed.end.date === date || (placed.end.minute === 0 && addDays(placed.end.date, -1) === date);
  if (starts && placed.start.date === placed.end.date && placed.start.minute === placed.end.minute) return timeLabel(placed.start.minute);
  if (starts && ends) return `${timeLabel(placed.start.minute)} to ${placed.end.minute === 0 && placed.end.date !== date ? timeLabel(0) : timeLabel(placed.end.minute)}`;
  if (starts) return `From ${timeLabel(placed.start.minute)}`;
  if (ends && placed.end.minute !== 0) return `Until ${timeLabel(placed.end.minute)}`;
  return "All day";
}

/**
 * What a screen reader hears for an occurrence on `date`: title, date,
 * time, who, place, and anything unusual ("cancelled", "times in
 * Europe/London", "from an outside calendar").
 */
export function occurrenceLabel(placed, date, labelOf) {
  const { occurrence } = placed;
  const parts = [occurrence.title, dayLabel(date), whenText(placed, date), `For ${peopleText(occurrence.attendees, labelOf)}`];
  if (occurrence.place) parts.push(`At ${occurrence.place}`);
  if (placed.shifted) parts.push(`Your time; set in ${occurrence.zone}`);
  if (occurrence.cancelled) parts.push("Cancelled");
  if (occurrence.event?.repeat || occurrence.linked) parts.push("Repeats");
  if (placed.readonly) parts.push(sourceText(occurrence));
  return parts.join(", ");
}

/** Where an outside calendar's occurrence comes from: its label as the
 * sync gives it ("From Google"), or "From an outside calendar". */
export function sourceText(occurrence) {
  const label = String(occurrence?.sourceLabel ?? "").trim();
  if (!label) return "From an outside calendar";
  return /^from\s/i.test(label) ? label : `From ${label}`;
}

/** "12 days until Trip", "1 day until Trip", "Trip is today", "Trip is on
 * now" (started earlier and still going). `next` is KCAL's nextCountdown. */
export function countdownText(next, today) {
  if (!next) return "";
  const days = daysBetween(today, next.start.date);
  if (days > 1) return `${days} days until ${next.title}`;
  if (days === 1) return `1 day until ${next.title}`;
  if (days === 0) return `${next.title} is today`;
  return `${next.title} is on now`;
}

/** Whether `date` is a Saturday or Sunday (for a quieter cell). */
export function isWeekend(date) {
  return weekday(date) >= 5;
}
