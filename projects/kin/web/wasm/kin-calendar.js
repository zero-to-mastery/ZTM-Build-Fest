// The family calendar (#656, ADR 0022 §1) and iCalendar import (#666, §3)
// codecs, matching rust/src/calendar.rs, calendar_range.rs and ical.rs:
// - "save-calendar-event" (KCMD action 71, CALENDAR_EVENT_SAVED): { event },
//   the whole event, replacing any earlier version with its ID.
// - "cancel-calendar-event" (72) and "restore-calendar-event" (73):
//   { eventId, occurrence } where occurrence is { date, minute }, the
//   occurrence's original start, or null for the whole series.
// - "set-member-colour" (74): { colour }, 0–11 or null for the default; it
//   always colours the member sending it.
// - KCAQ v1 / KCAL v1: the calendar between two civil dates
//   (`calendarRange`), merged with dated items, routines and meals.
// - KICS v1: an .ics file as Kin events (`parseICalendar`), each with a zero
//   event ID for the host to fill before saving it.
//
// An event as the host passes it: { eventId (hex), title, place, notes,
// attendees (member IDs, hex; any order), countdown, sourceUid, allDay,
// start: { date, minute }, end: { date, minute } (an all-day end is its last
// date; minutes are ignored), zone (IANA name, or "" for a floating time;
// ignored when all-day), repeat, series }.
// - repeat: null, or { frequency: "daily" | "weekly" | "monthly" |
//   "yearly", interval (1–1,000), weekdays ([0 Monday … 6 Sunday], weekly),
//   weekStart (weekly, default 0), monthDay (1–31 or -1, monthly or
//   yearly) or nth (1–5 or -1) with weekday (0–6), and count (1–1,000) or
//   until (a civil date) or neither }.
// - series: null, or { seriesId (hex), original: { date, minute } } for an
//   event standing in for one changed occurrence of a series.
//
// Commands carry the event's exact canonical payload, so text is trimmed
// here exactly as Rust's `str::trim` does (Unicode White_Space) and notes
// get "\n" line breaks. Rust decides the rest (code 4): the event exists,
// an occurrence is real, nothing is cancelled twice, and so on. Rust expands
// repeats in local civil time; the browser turns { date, minute } and the
// zone into an instant with Intl when it draws them.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX_ID = /^[a-f0-9]{32}$/;
const ZERO_ID = "00".repeat(16);
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGE_SPACE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");
const TRAILING_SPACE = new RegExp(`[${SPACE}]+$`, "u");
const CONTROL = /\p{Cc}/u;
const CONTROL_BUT_NEWLINE = /[\0-\t\v-\x1f\x7f-\x9f]/u;
const ZONE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/;

export const CALENDAR_COMMANDS = Object.freeze([
  "save-calendar-event",
  "cancel-calendar-event",
  "restore-calendar-event",
  "set-member-colour",
]);
export const CALENDAR_EVENT_KINDS = Object.freeze([
  "CALENDAR_EVENT_SAVED",
  "CALENDAR_EVENT_CANCELLED",
  "CALENDAR_EVENT_RESTORED",
  "MEMBER_COLOUR_SET",
]);
export const FIRST_CALENDAR_KIND = 71;
export const MAX_CALENDAR_EVENTS = 2_000;
export const MAX_CALENDAR_TITLE_BYTES = 200;
export const MAX_CALENDAR_PLACE_BYTES = 200;
export const MAX_CALENDAR_NOTES_BYTES = 2_000;
export const MAX_CALENDAR_ATTENDEES = 16;
export const MAX_ZONE_BYTES = 64;
export const MAX_SOURCE_UID_BYTES = 255;
export const MAX_SPAN_DAYS = 366;
export const MAX_RULE_INTERVAL = 1_000;
export const MAX_RULE_COUNT = 1_000;
export const MAX_CANCELLED_OCCURRENCES = 1_000;
/** Days a range read spans at most, both ends included. */
export const MAX_RANGE_DAYS = 400;
export const MAX_RANGE_OCCURRENCES = 5_000;
export const MAX_ICAL_BYTES = 2 * 1024 * 1024;
export const MAX_ICAL_EVENTS = 5_000;
/** The palette's size; members without a choice use `defaultMemberColour`. */
export const MEMBER_COLOURS = 12;
const MINUTES_PER_DAY = 1440;
const FREQUENCIES = Object.freeze([null, "daily", "weekly", "monthly", "yearly"]);
const MEAL_SLOTS = Object.freeze([null, "breakfast", "lunch", "snack", "dinner"]);
const CLASSIFICATIONS = Object.freeze(["today", "need", "shopping", "staple"]);
const CADENCES = Object.freeze(["daily", "weekly", "biweekly", "monthly", "weekdays"]);
/** KICS record flags, by bit. */
export const IMPORT_FLAGS = Object.freeze([
  "ruleUnsupported",
  "zoneUnknown",
  "cancelled",
  "override",
  "textShortened",
  "spanShortened",
  "exdatesDropped",
  "noTitle",
]);

export class CalendarFormatError extends Error {
  constructor(message = "Kin received invalid calendar data.") {
    super(message);
    this.name = "CalendarFormatError";
  }
}

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const idBytes = (value, what, allowZero = false) => {
  if (value instanceof Uint8Array && value.length === 16 && (allowZero || value.some(Boolean))) return value;
  if (typeof value !== "string" || !HEX_ID.test(value) || (!allowZero && value === ZERO_ID)) throw new CalendarFormatError(`Kin received an invalid ${what}.`);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
};

/** Whether `value` is a real Gregorian date YYYYMMDD from 0001 to 9999. */
export function isCalendarDate(value) {
  if (!Number.isInteger(value)) return false;
  const year = Math.floor(value / 10000), month = Math.floor(value / 100) % 100, day = value % 100;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Days since 0001-01-01, as Rust's `CivilDate::day_number`. */
export function dayNumber(value) {
  const year = Math.floor(value / 10000), month = Math.floor(value / 100) % 100, day = value % 100;
  const previous = year - 1;
  let days = 365 * previous + Math.floor(previous / 4) - Math.floor(previous / 100) + Math.floor(previous / 400);
  for (let m = 1; m < month; m += 1) days += daysInMonth(year, m);
  return days + day - 1;
}

const checkDate = (value, what) => {
  if (!isCalendarDate(value)) throw new CalendarFormatError(`Kin received an invalid ${what}.`);
  return value;
};
const checkMinute = (value, what) => {
  if (!Number.isInteger(value) || value < 0 || value >= MINUTES_PER_DAY) throw new CalendarFormatError(`Kin received an invalid ${what}.`);
  return value;
};

// ---------------------------------------------------------------------------
// Text, as Rust keeps it.

/** A title: trimmed, one line, 1–200 UTF-8 bytes. */
export function normalizeCalendarTitle(title) {
  const value = String(title ?? "").replace(EDGE_SPACE, "");
  if (!value) throw new CalendarFormatError("An event needs a title.");
  if (CONTROL.test(value)) throw new CalendarFormatError("A title can only hold one line of plain text.");
  if (encoder.encode(value).length > MAX_CALENDAR_TITLE_BYTES) throw new CalendarFormatError("That title is too long.");
  return value;
}

/** A place: as a title, but may be empty. */
export function normalizeCalendarPlace(place) {
  const value = String(place ?? "").replace(EDGE_SPACE, "");
  if (CONTROL.test(value)) throw new CalendarFormatError("A place can only hold one line of plain text.");
  if (encoder.encode(value).length > MAX_CALENDAR_PLACE_BYTES) throw new CalendarFormatError("That place is too long.");
  return value;
}

/** Notes: line breaks as "\n", each line's trailing space gone, trimmed,
 * at most 2,000 bytes, no control characters but newline. */
export function normalizeCalendarNotes(notes) {
  const value = String(notes ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(TRAILING_SPACE, ""))
    .join("\n")
    .replace(EDGE_SPACE, "");
  if (CONTROL_BUT_NEWLINE.test(value)) throw new CalendarFormatError("Notes can only hold plain text.");
  if (encoder.encode(value).length > MAX_CALENDAR_NOTES_BYTES) throw new CalendarFormatError("Those notes are too long.");
  return value;
}

/** An IANA zone name, checked as text only (as Rust does). */
export function isZoneName(zone) {
  return typeof zone === "string" && zone.length > 0 && zone.length <= MAX_ZONE_BYTES && ZONE.test(zone);
}

function checkSourceUid(uid) {
  const value = String(uid ?? "");
  if (value.replace(EDGE_SPACE, "") !== value || CONTROL.test(value) || encoder.encode(value).length > MAX_SOURCE_UID_BYTES)
    throw new CalendarFormatError("Kin received an invalid calendar source.");
  return value;
}

// ---------------------------------------------------------------------------
// Kind 71.

function ruleBytes(repeat, startDate) {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  const frequency = FREQUENCIES.indexOf(repeat?.frequency);
  if (frequency < 1) throw new CalendarFormatError("Kin received an invalid repeat.");
  out[0] = frequency;
  const interval = repeat.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_RULE_INTERVAL) throw new CalendarFormatError("A repeat's interval must be 1 to 1,000.");
  view.setUint16(4, interval, true);
  if (repeat.frequency === "weekly") {
    const days = repeat.weekdays ?? [];
    if (!Array.isArray(days) || days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
      throw new CalendarFormatError("A weekly repeat needs at least one weekday.");
    out[2] = days.reduce((mask, day) => mask | (1 << day), 0);
    const weekStart = repeat.weekStart ?? 0;
    if (!Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6) throw new CalendarFormatError("Kin received an invalid repeat.");
    out[3] = weekStart;
  } else if (repeat.frequency === "monthly" || repeat.frequency === "yearly") {
    if (repeat.monthDay != null) {
      const day = repeat.monthDay;
      if (!Number.isInteger(day) || !(day === -1 || (day >= 1 && day <= 31)) || repeat.nth != null) throw new CalendarFormatError("Kin received an invalid repeat.");
      out[1] = 1;
      out[12] = day & 0xff;
    } else {
      const { nth, weekday } = repeat;
      if (!Number.isInteger(nth) || !(nth === -1 || (nth >= 1 && nth <= 5)) || !Number.isInteger(weekday) || weekday < 0 || weekday > 6)
        throw new CalendarFormatError("A monthly or yearly repeat needs a day of the month or a weekday.");
      out[1] = 2;
      out[13] = nth & 0xff;
      out[14] = weekday;
    }
  }
  if (repeat.count != null && repeat.until != null) throw new CalendarFormatError("A repeat ends by a count or a date, not both.");
  if (repeat.count != null) {
    if (!Number.isInteger(repeat.count) || repeat.count < 1 || repeat.count > MAX_RULE_COUNT) throw new CalendarFormatError("A repeat's count must be 1 to 1,000.");
    view.setUint16(6, repeat.count, true);
  }
  if (repeat.until != null) {
    checkDate(repeat.until, "repeat end");
    if (repeat.until < startDate) throw new CalendarFormatError("A repeat can't end before it starts.");
    view.setUint32(8, repeat.until, true);
  }
  return out;
}

function pushText(parts, value) {
  const bytes = encoder.encode(value);
  const length = new Uint8Array(2);
  new DataView(length.buffer).setUint16(0, bytes.length, true);
  parts.push(length, bytes);
}

/** The canonical kind-71 payload for an event (layout in
 * rust/src/calendar.rs `encode_event_payload`). `allowZeroId` is for
 * events straight from an import. */
export function encodeCalendarEventPayload(event, { allowZeroId = false } = {}) {
  if (!event || typeof event !== "object") throw new CalendarFormatError("Kin received an invalid event.");
  const id = idBytes(event.eventId, "event", allowZeroId);
  const title = normalizeCalendarTitle(event.title);
  const place = normalizeCalendarPlace(event.place);
  const notes = normalizeCalendarNotes(event.notes);
  const sourceUid = checkSourceUid(event.sourceUid);
  const attendees = [...new Set((event.attendees ?? []).map((member) => typeof member === "string" ? member : toHex(idBytes(member, "member"))))].sort();
  if (attendees.length !== (event.attendees ?? []).length) throw new CalendarFormatError("Someone is listed twice.");
  if (attendees.length > MAX_CALENDAR_ATTENDEES) throw new CalendarFormatError(`An event can have at most ${MAX_CALENDAR_ATTENDEES} people.`);
  const allDay = event.allDay === true;
  const startDate = checkDate(event.start?.date, "start date");
  const endDate = checkDate(event.end?.date ?? startDate, "end date");
  const startMinute = allDay ? 0 : checkMinute(event.start?.minute, "start time");
  const endMinute = allDay ? 0 : checkMinute(event.end?.minute ?? startMinute, "end time");
  const zone = allDay ? "" : String(event.zone ?? "");
  if (zone && !isZoneName(zone)) throw new CalendarFormatError("Kin received an invalid time zone.");
  if (endDate < startDate || (endDate === startDate && endMinute < startMinute)) throw new CalendarFormatError("An event can't end before it starts.");
  if (dayNumber(endDate) - dayNumber(startDate) > MAX_SPAN_DAYS) throw new CalendarFormatError("An event can last at most a year.");
  const series = event.series ?? null;
  const fixed = new Uint8Array(72);
  const view = new DataView(fixed.buffer);
  fixed.set(id, 0);
  fixed[16] = (allDay ? 1 : 0) | (event.countdown === true ? 2 : 0) | (event.repeat ? 4 : 0) | (series ? 8 : 0);
  fixed[17] = attendees.length;
  view.setUint32(20, startDate, true);
  view.setUint16(24, startMinute, true);
  view.setUint16(26, endMinute, true);
  view.setUint32(28, endDate, true);
  if (event.repeat) fixed.set(ruleBytes(event.repeat, startDate), 32);
  if (series) {
    const seriesId = idBytes(series.seriesId, "series");
    if (toHex(seriesId) === toHex(id)) throw new CalendarFormatError("An event can't stand in for itself.");
    fixed.set(seriesId, 48);
    view.setUint32(64, checkDate(series.original?.date, "occurrence"), true);
    view.setUint16(68, checkMinute(series.original?.minute, "occurrence"), true);
  }
  const parts = [fixed, ...attendees.map((member) => idBytes(member, "member"))];
  for (const text of [title, place, notes, zone, sourceUid]) pushText(parts, text);
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** A kind-71 payload as an event object; strict: it must re-encode to the
 * same bytes. */
export function decodeCalendarEventPayload(bytes, { allowZeroId = false } = {}) {
  const invalid = () => new CalendarFormatError();
  if (!(bytes instanceof Uint8Array) || bytes.length < 72) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[16], attendeeCount = bytes[17];
  if (flags > 0x0f || attendeeCount > MAX_CALENDAR_ATTENDEES) throw invalid();
  const allDay = (flags & 1) !== 0;
  const start = { date: view.getUint32(20, true), minute: view.getUint16(24, true) };
  const end = { date: view.getUint32(28, true), minute: view.getUint16(26, true) };
  let repeat = null;
  if (flags & 4) {
    const frequency = FREQUENCIES[bytes[32]];
    if (!frequency) throw invalid();
    repeat = { frequency, interval: view.getUint16(36, true) };
    if (frequency === "weekly") {
      repeat.weekdays = [0, 1, 2, 3, 4, 5, 6].filter((day) => bytes[34] & (1 << day));
      repeat.weekStart = bytes[35];
    }
    if (bytes[33] === 1) repeat.monthDay = view.getInt8(44);
    if (bytes[33] === 2) { repeat.nth = view.getInt8(45); repeat.weekday = bytes[46]; }
    const count = view.getUint16(38, true), until = view.getUint32(40, true);
    if (count) repeat.count = count;
    if (until) repeat.until = until;
  }
  const series = flags & 8
    ? { seriesId: toHex(bytes.subarray(48, 64)), original: { date: view.getUint32(64, true), minute: view.getUint16(68, true) } }
    : null;
  let at = 72;
  const attendees = [];
  for (let index = 0; index < attendeeCount; index += 1, at += 16) {
    if (at + 16 > bytes.length) throw invalid();
    attendees.push(toHex(bytes.subarray(at, at + 16)));
  }
  const texts = [];
  for (let index = 0; index < 5; index += 1) {
    if (at + 2 > bytes.length) throw invalid();
    const length = view.getUint16(at, true);
    if (at + 2 + length > bytes.length) throw invalid();
    try { texts.push(decoder.decode(bytes.subarray(at + 2, at + 2 + length))); } catch { throw invalid(); }
    at += 2 + length;
  }
  if (at !== bytes.length) throw invalid();
  const [title, place, notes, zone, sourceUid] = texts;
  const event = {
    eventId: toHex(bytes.subarray(0, 16)), title, place, notes, attendees, countdown: (flags & 2) !== 0, sourceUid,
    allDay, start: allDay ? { date: start.date, minute: 0 } : start, end: allDay ? { date: end.date, minute: 0 } : end,
    zone: allDay ? "" : zone, repeat, series,
  };
  let again;
  try { again = encodeCalendarEventPayload(event, { allowZeroId }); } catch { throw invalid(); }
  if (again.length !== bytes.length || again.some((byte, index) => byte !== bytes[index])) throw invalid();
  return event;
}

// ---------------------------------------------------------------------------
// Kinds 72–74 and KCMD.

/** The kind-72/73 payload: event ID, scope (1 one occurrence, 2 the
 * series), the occurrence's original start. */
export function encodeCancelPayload(eventId, occurrence) {
  const out = new Uint8Array(28);
  const view = new DataView(out.buffer);
  out.set(idBytes(eventId, "event"), 0);
  if (occurrence == null) {
    out[16] = 2;
  } else {
    out[16] = 1;
    view.setUint32(20, checkDate(occurrence.date, "occurrence"), true);
    view.setUint16(24, checkMinute(occurrence.minute ?? 0, "occurrence"), true);
  }
  return out;
}

/** The kind-74 payload: colour 0–11, or 255 for the default. */
export function encodeColourPayload(colour) {
  if (colour != null && (!Number.isInteger(colour) || colour < 0 || colour >= MEMBER_COLOURS))
    throw new CalendarFormatError("Choose one of the 12 colours.");
  return Uint8Array.of(colour ?? 255, 0, 0, 0);
}

/** A KCMD packet for a calendar command (actions 71–74): the 128-byte
 * header with the payload as its text. */
export function encodeCalendarIntent(command, identity) {
  const kind = FIRST_CALENDAR_KIND + CALENDAR_COMMANDS.indexOf(command?.type);
  let payload;
  switch (command?.type) {
    case "save-calendar-event": payload = encodeCalendarEventPayload(command.event); break;
    case "cancel-calendar-event":
    case "restore-calendar-event": payload = encodeCancelPayload(command.eventId, command.occurrence ?? null); break;
    case "set-member-colour": payload = encodeColourPayload(command.colour ?? null); break;
    default: throw new CalendarFormatError("Kin received an invalid calendar change.");
  }
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, kind, true);
  packet.set(idBytes(identity.eventId, "event"), 12);
  packet.set(idBytes(identity.householdId, "household"), 28);
  packet.set(idBytes(identity.actorId, "member"), 44);
  packet.set(idBytes(identity.deviceId, "device"), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new CalendarFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new CalendarFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

/** A member's colour: their choice, else the default by join order. */
export function memberColour(memberId, colours, joinIndex = 0) {
  return colours?.get?.(memberId) ?? defaultMemberColour(joinIndex);
}

/** The default colour of the member who joined `joinIndex`-th (from 0). */
export function defaultMemberColour(joinIndex) {
  return ((Number.isInteger(joinIndex) ? joinIndex : 0) % MEMBER_COLOURS + MEMBER_COLOURS) % MEMBER_COLOURS;
}

// ---------------------------------------------------------------------------
// KCAQ / KCAL.

/** KCAQ v1: 20 bytes; the KINE context follows it. */
export function encodeCalendarRangeQuery(from, to, { allEvents = false, includeCancelled = false } = {}) {
  checkDate(from, "first date");
  checkDate(to, "last date");
  if (to < from || dayNumber(to) - dayNumber(from) >= MAX_RANGE_DAYS)
    throw new CalendarFormatError(`A calendar read covers 1 to ${MAX_RANGE_DAYS} days.`);
  const out = new Uint8Array(20);
  const view = new DataView(out.buffer);
  out.set([75, 67, 65, 81, 1, 0, 0, 0]);
  view.setUint32(8, from, true);
  view.setUint32(12, to, true);
  view.setUint32(16, (allEvents ? 1 : 0) | (includeCancelled ? 2 : 0), true);
  return out;
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }
  need(count) { if (this.at + count > this.bytes.length) throw new CalendarFormatError(); }
  u8() { this.need(1); return this.bytes[this.at++]; }
  u16() { this.need(2); const value = this.view.getUint16(this.at, true); this.at += 2; return value; }
  u32() { this.need(4); const value = this.view.getUint32(this.at, true); this.at += 4; return value; }
  date() { const value = this.u32(); if (!isCalendarDate(value)) throw new CalendarFormatError(); return value; }
  time() {
    const date = this.date(), minute = this.u16();
    if (minute >= MINUTES_PER_DAY) throw new CalendarFormatError();
    this.zero(2);
    return { date, minute };
  }
  bytesOf(count) { this.need(count); const value = this.bytes.subarray(this.at, this.at + count); this.at += count; return value; }
  id() { return toHex(this.bytesOf(16)); }
  zero(count) { for (let index = 0; index < count; index += 1) if (this.u8() !== 0) throw new CalendarFormatError(); }
  optionalId(present) {
    const value = this.id();
    if (present ? value === ZERO_ID : value !== ZERO_ID) throw new CalendarFormatError();
    return present ? value : null;
  }
  text() { const length = this.u16(); try { return decoder.decode(this.bytesOf(length)); } catch { throw new CalendarFormatError(); } }
  magic(value) { if (String.fromCharCode(...this.bytesOf(4)) !== value) throw new CalendarFormatError(); }
}

function readOccurrence(read, events) {
  const index = read.u32();
  const start = { date: read.date(), minute: read.u16() };
  const flags = read.u8();
  read.zero(1);
  const end = { date: read.date(), minute: read.u16() };
  read.zero(2);
  const event = events[index];
  if (!event || flags > 15 || start.minute >= MINUTES_PER_DAY || end.minute >= MINUTES_PER_DAY) throw new CalendarFormatError();
  return {
    eventId: event.eventId, event, start, end,
    allDay: (flags & 1) !== 0, countdown: (flags & 2) !== 0, cancelled: (flags & 4) !== 0, linked: (flags & 8) !== 0,
    title: event.title, place: event.place, zone: event.zone, attendees: event.attendees,
  };
}

/** KCAL v1 as { from, to, today, occurrencesTruncated, itemsTruncated,
 * routinesTruncated, routinesPaused, colours: Map memberId -> 0–11,
 * events: [event & { cancelled, cancelledThroughSeries, cancelledStarts }],
 * occurrences: [{ eventId, event, start, end, allDay, countdown, cancelled,
 * linked, title, place, zone, attendees }] (earliest first), nextCountdown
 * (one such occurrence, or null), items: [{ itemId, date, classification,
 * ownerId }], routines: [{ routineId, opens, occurrenceKey, cadence,
 * current, done, ownerId }], meals: [{ date, slot, recipeId, cookId,
 * name }] }. */
export function decodeCalendarRange(bytes) {
  const read = new Reader(bytes);
  read.magic("KCAL");
  if (read.u16() !== 1) throw new CalendarFormatError();
  read.zero(2);
  const from = read.date(), to = read.date(), today = read.date();
  const flags = read.u32();
  if (flags > 31) throw new CalendarFormatError();
  const [colourCount, eventCount, occurrenceCount, itemCount, routineCount, mealCount] = [0, 0, 0, 0, 0, 0].map(() => read.u32());
  if (occurrenceCount > MAX_RANGE_OCCURRENCES || eventCount > MAX_CALENDAR_EVENTS) throw new CalendarFormatError();
  const countdownAt = read.at;
  read.bytesOf(20);
  const colours = new Map();
  for (let index = 0; index < colourCount; index += 1) {
    const member = read.id();
    const colour = read.u8();
    read.zero(3);
    if (colour >= MEMBER_COLOURS || colours.has(member)) throw new CalendarFormatError();
    colours.set(member, colour);
  }
  const events = [];
  for (let index = 0; index < eventCount; index += 1) {
    const eventFlags = read.u8();
    read.zero(1);
    const cancelledCount = read.u16(), length = read.u32();
    if (eventFlags > 3 || eventFlags === 3) throw new CalendarFormatError();
    const cancelledStarts = [];
    for (let start = 0; start < cancelledCount; start += 1) cancelledStarts.push(read.time());
    const event = decodeCalendarEventPayload(read.bytesOf(length));
    if (events.length && events.at(-1).eventId >= event.eventId) throw new CalendarFormatError();
    events.push({ ...event, cancelled: (eventFlags & 1) !== 0, cancelledThroughSeries: (eventFlags & 2) !== 0, cancelledStarts });
  }
  const occurrences = [];
  for (let index = 0; index < occurrenceCount; index += 1) occurrences.push(readOccurrence(read, events));
  const items = [];
  for (let index = 0; index < itemCount; index += 1) {
    const itemId = read.id(), date = read.date();
    const classification = CLASSIFICATIONS[read.u8()], owner = read.u8();
    if (!classification || owner > 1) throw new CalendarFormatError();
    read.zero(2);
    items.push({ itemId, date, classification, ownerId: read.optionalId(owner === 1) });
  }
  const routines = [];
  for (let index = 0; index < routineCount; index += 1) {
    const routineId = read.id(), opens = read.date(), occurrenceKey = read.date();
    const cadence = CADENCES[read.u8()], bits = read.u8();
    if (!cadence || bits > 7 || (bits & 4 && !(bits & 2))) throw new CalendarFormatError();
    read.zero(2);
    routines.push({ routineId, opens, occurrenceKey, cadence, current: (bits & 2) !== 0, done: (bits & 4) !== 0, ownerId: read.optionalId((bits & 1) !== 0) });
  }
  const meals = [];
  for (let index = 0; index < mealCount; index += 1) {
    const date = read.date();
    const slot = MEAL_SLOTS[read.u8()], bits = read.u8();
    if (!slot || bits > 3) throw new CalendarFormatError();
    read.zero(2);
    const recipeId = read.optionalId((bits & 1) !== 0), cookId = read.optionalId((bits & 2) !== 0);
    meals.push({ date, slot, recipeId, cookId, name: read.text() });
  }
  if (read.at !== bytes.length) throw new CalendarFormatError();
  let nextCountdown = null;
  const countdown = new Reader(bytes.subarray(countdownAt, countdownAt + 20));
  if (flags & 16) nextCountdown = readOccurrence(countdown, events);
  else countdown.zero(20);
  return {
    from, to, today,
    occurrencesTruncated: (flags & 1) !== 0, itemsTruncated: (flags & 2) !== 0, routinesTruncated: (flags & 4) !== 0, routinesPaused: (flags & 8) !== 0,
    colours, events, occurrences, nextCountdown, items, routines, meals,
  };
}

// ---------------------------------------------------------------------------
// KICS.

/** KICS v1 as { name, skipped, truncated, events: [{ flags: { ruleUnsupported,
 * zoneUnknown, cancelled, override, textShortened, spanShortened,
 * exdatesDropped, noTitle }, master (index into events, or null), original
 * ({ date, minute } the occurrence an override replaces, or null), exdates
 * ([{ date, minute }] to cancel after saving), event (eventId all zero) }] }.
 *
 * To import, the host gives each event an ID (an earlier import's ID when
 * KCAL lists an event with the same sourceUid, else a new one) and saves it;
 * then cancels its exdates; then saves each override with series { seriesId:
 * its master's ID, original } and cancels that occurrence of the master.
 * A cancelled event (flags.cancelled) is best skipped. */
export function decodeICalendar(bytes) {
  const read = new Reader(bytes);
  read.magic("KICS");
  if (read.u16() !== 1) throw new CalendarFormatError();
  read.zero(2);
  const count = read.u32(), skipped = read.u32(), resultFlags = read.u32();
  if (count > MAX_ICAL_EVENTS || resultFlags > 1) throw new CalendarFormatError();
  const name = read.text();
  const events = [];
  for (let index = 0; index < count; index += 1) {
    const bits = read.u32(), master = read.u32();
    const original = { date: read.u32(), minute: read.u16() };
    read.zero(2);
    const exdateCount = read.u16();
    read.zero(2);
    const length = read.u32();
    if (bits > 0xff || exdateCount > MAX_CANCELLED_OCCURRENCES) throw new CalendarFormatError();
    const hasMaster = master !== 0xffff_ffff;
    if (hasMaster ? master >= count || master === index || !isCalendarDate(original.date) || original.minute >= MINUTES_PER_DAY : original.date || original.minute)
      throw new CalendarFormatError();
    const exdates = [];
    for (let entry = 0; entry < exdateCount; entry += 1) exdates.push(read.time());
    const event = decodeCalendarEventPayload(read.bytesOf(length), { allowZeroId: true });
    if (event.eventId !== ZERO_ID || event.series) throw new CalendarFormatError();
    const flags = Object.fromEntries(IMPORT_FLAGS.map((flag, bit) => [flag, (bits & (1 << bit)) !== 0]));
    events.push({ flags, master: hasMaster ? master : null, original: hasMaster ? original : null, exdates, event });
  }
  if (read.at !== bytes.length) throw new CalendarFormatError();
  return { name, skipped, truncated: resultFlags === 1, events };
}
