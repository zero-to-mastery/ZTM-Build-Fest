// The family calendar codecs (#656, #666): the kind 71–74 payloads, their
// KCMD packets, KCAQ, KCAL and KICS, matching rust/src/calendar.rs,
// calendar_range.rs and ical.rs (TEST-VECTORS 140, 141, 146, 147 and 155).
import assert from "node:assert/strict";
import test from "node:test";
import {
  CalendarFormatError, MEMBER_COLOURS, dayNumber, decodeCalendarEventPayload, decodeCalendarRange, decodeICalendar,
  defaultMemberColour, encodeCalendarEventPayload, encodeCalendarIntent, encodeCalendarRangeQuery, encodeCancelPayload,
  encodeColourPayload, isZoneName, memberColour, normalizeCalendarNotes, normalizeCalendarTitle,
} from "./kin-calendar.js";

const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const numbered = (n) => { const bytes = new Uint8Array(16); new DataView(bytes.buffer).setUint32(0, n, true); return bytes; };
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const u16 = (value) => [value & 0xff, value >> 8];
const u32 = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
const text = (value) => { const encoded = new TextEncoder().encode(value); return [...u16(encoded.length), ...encoded]; };
const magic = (value) => [...value].map((c) => c.charCodeAt(0));
const identity = { eventId: id(1), householdId: id(2), actorId: id(3), deviceId: id(4), timestamp: 1_791_475_200_000, logicalTime: 5n };

/** TEST-VECTORS 140: "Swimming", Tue/Thu 17:30–18:15 Europe/London from
 * 2026-10-06, ten times, Alex (01×16) and Sam (02×16). */
const swimming = () => ({
  eventId: hex(numbered(7)), title: "Swimming", place: "Leisure centre", notes: "Bring goggles.\nTowels at the desk.",
  attendees: [id(2), id(1)], countdown: false, sourceUid: "swim-1@example.com", allDay: false,
  start: { date: 20261006, minute: 1050 }, end: { date: 20261006, minute: 1095 }, zone: "Europe/London",
  repeat: { frequency: "weekly", interval: 1, weekdays: [3, 1], weekStart: 0, count: 10 }, series: null,
});
const swimmingBytes = () => [
  ...numbered(7), 0b0100, 2, 0, 0, ...u32(20261006), ...u16(1050), ...u16(1095), ...u32(20261006),
  2, 0, 0b1010, 0, 1, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ...new Array(24).fill(0), ...new Array(16).fill(1), ...new Array(16).fill(2),
  ...text("Swimming"), ...text("Leisure centre"), ...text("Bring goggles.\nTowels at the desk."), ...text("Europe/London"), ...text("swim-1@example.com"),
];

test("the event payload is the fixed part, attendees, then five texts (140)", () => {
  const bytes = encodeCalendarEventPayload(swimming());
  assert.deepEqual([...bytes], swimmingBytes());
  const decoded = decodeCalendarEventPayload(Uint8Array.from(swimmingBytes()));
  assert.deepEqual(decoded, {
    ...swimming(), attendees: [id(1), id(2)], repeat: { frequency: "weekly", interval: 1, weekdays: [1, 3], weekStart: 0, count: 10 },
  });
  // Text is trimmed as Rust trims it; notes get "\n" line breaks.
  const loose = encodeCalendarEventPayload({ ...swimming(), title: "  Swimming　", notes: "Bring goggles.  \r\nTowels at the desk.\n\n" });
  assert.deepEqual([...loose], swimmingBytes());
  // An all-day countdown standing in for an occurrence of series 9.
  const trip = encodeCalendarEventPayload({
    eventId: hex(numbered(8)), title: "Trip to Gran's", allDay: true, countdown: true,
    start: { date: 20261224 }, end: { date: 20261227 }, zone: "Ignored", series: { seriesId: hex(numbered(9)), original: { date: 20261224, minute: 0 } },
  });
  assert.deepEqual([...trip.subarray(16, 32)], [0b1011, 0, 0, 0, ...u32(20261224), 0, 0, 0, 0, ...u32(20261227)]);
  assert.deepEqual([...trip.subarray(48, 72)], [...numbered(9), ...u32(20261224), 0, 0, 0, 0]);
  assert.equal(decodeCalendarEventPayload(trip).zone, "");

  const refused = (change, why) => assert.throws(() => encodeCalendarEventPayload({ ...swimming(), ...change }), CalendarFormatError, why);
  refused({ eventId: id(0) }, "zero ID");
  refused({ title: " " }, "empty title");
  refused({ title: "a\nb" }, "two lines");
  refused({ title: "x".repeat(201) }, "201 bytes");
  refused({ notes: "x".repeat(2001) }, "notes 2001 bytes");
  refused({ attendees: [id(1), id(1)] }, "twice");
  refused({ attendees: Array.from({ length: 17 }, (_, n) => id(n + 1)) }, "17 people");
  refused({ zone: "Europe//London" }, "zone");
  refused({ sourceUid: " x" }, "UID");
  refused({ end: { date: 20261006, minute: 1049 } }, "ends before it starts");
  refused({ end: { date: 20271008, minute: 0 } }, "367 days");
  refused({ repeat: { frequency: "weekly", weekdays: [] } }, "no weekday");
  refused({ repeat: { frequency: "monthly", monthDay: 32 } }, "day 32");
  refused({ repeat: { frequency: "monthly", nth: 6, weekday: 0 } }, "6th");
  refused({ repeat: { frequency: "daily", count: 3, until: 20261101 } }, "count and until");
  refused({ repeat: { frequency: "daily", until: 20261001 } }, "until before the start");
  refused({ repeat: { frequency: "hourly" } }, "hourly");
  refused({ series: { seriesId: hex(numbered(7)), original: { date: 20261006, minute: 1050 } } }, "itself");
  assert.doesNotThrow(() => encodeCalendarEventPayload({ ...swimming(), eventId: id(0) }, { allowZeroId: true }));

  const broken = (mutate, why) => {
    const copy = Uint8Array.from(swimmingBytes());
    mutate(copy);
    assert.throws(() => decodeCalendarEventPayload(copy), CalendarFormatError, why);
  };
  broken((b) => { b[16] = 0x14; }, "unknown flag");
  broken((b) => { b[18] = 1; }, "reserved");
  broken((b) => { b[47] = 1; }, "rule reserved");
  broken((b) => { b[48] = 1; }, "series bytes without a link");
  broken((b) => { b[16] = 0b0101; }, "minutes on an all-day event");
  assert.throws(() => decodeCalendarEventPayload(Uint8Array.from([...swimmingBytes(), 0])), CalendarFormatError, "trailing");
  assert.throws(() => decodeCalendarEventPayload(Uint8Array.from(swimmingBytes()).subarray(0, 71)), CalendarFormatError, "short");
});

test("text and zones follow Rust's rules", () => {
  assert.equal(normalizeCalendarTitle(" Dentist "), "Dentist");
  assert.equal(normalizeCalendarNotes(" a \r\n b\t\r c \n\n"), "a\n b\n c");
  assert.throws(() => normalizeCalendarNotes("a\u0007"), CalendarFormatError);
  for (const zone of ["UTC", "Europe/London", "America/Argentina/Buenos_Aires", "Etc/GMT+12"]) assert.equal(isZoneName(zone), true, zone);
  for (const zone of ["", "/UTC", "UTC/", "Europe London", "Zürich", "x".repeat(65)]) assert.equal(isZoneName(zone), false, zone);
  assert.equal(dayNumber(10101), 0);
  assert.equal(dayNumber(20240301) - dayNumber(20240228), 2);
});

test("cancel, restore and colour payloads and their KCMD packets (141, 146)", () => {
  const one = encodeCancelPayload(hex(numbered(7)), { date: 20261008, minute: 1050 });
  assert.deepEqual([...one], [...numbered(7), 1, 0, 0, 0, ...u32(20261008), ...u16(1050), 0, 0]);
  assert.deepEqual([...encodeCancelPayload(hex(numbered(7)), null)], [...numbered(7), 2, ...new Array(11).fill(0)]);
  assert.deepEqual([...encodeColourPayload(11)], [11, 0, 0, 0]);
  assert.deepEqual([...encodeColourPayload(null)], [255, 0, 0, 0]);
  assert.throws(() => encodeColourPayload(12), CalendarFormatError);
  assert.throws(() => encodeCancelPayload(id(0), null), CalendarFormatError);

  for (const [command, kind, payload] of [
    [{ type: "save-calendar-event", event: swimming() }, 71, swimmingBytes()],
    [{ type: "cancel-calendar-event", eventId: hex(numbered(7)), occurrence: { date: 20261008, minute: 1050 } }, 72, [...one]],
    [{ type: "restore-calendar-event", eventId: hex(numbered(7)), occurrence: null }, 73, [...numbered(7), 2, ...new Array(11).fill(0)]],
    [{ type: "set-member-colour", colour: 5 }, 74, [5, 0, 0, 0]],
  ]) {
    const packet = encodeCalendarIntent(command, identity);
    const view = new DataView(packet.buffer);
    assert.equal(String.fromCharCode(...packet.subarray(0, 4)), "KCMD");
    assert.equal(view.getUint16(8, true), kind);
    assert.ok(packet.subarray(92, 124).every((byte) => byte === 0), "no entity, date, option or expiry");
    assert.equal(view.getUint32(124, true), payload.length);
    assert.deepEqual([...packet.subarray(128)], payload);
  }
  assert.throws(() => encodeCalendarIntent({ type: "set-sitter-page" }, identity), CalendarFormatError);
});

test("colours default by join order", () => {
  const colours = new Map([[id(1), 4]]);
  assert.equal(memberColour(id(1), colours, 0), 4);
  assert.equal(memberColour(id(2), colours, 13), 1);
  assert.equal(defaultMemberColour(-1), MEMBER_COLOURS - 1);
});

test("KCAQ is 20 bytes and bounded to 400 days", () => {
  assert.deepEqual([...encodeCalendarRangeQuery(20261005, 20261011, { includeCancelled: true })], [...magic("KCAQ"), 1, 0, 0, 0, ...u32(20261005), ...u32(20261011), 2, 0, 0, 0]);
  assert.doesNotThrow(() => encodeCalendarRangeQuery(20260101, 20270204));
  assert.throws(() => encodeCalendarRangeQuery(20260101, 20270205), CalendarFormatError, "401 days");
  assert.throws(() => encodeCalendarRangeQuery(20261011, 20261005), CalendarFormatError, "backwards");
  assert.throws(() => encodeCalendarRangeQuery(20260230, 20260301), CalendarFormatError, "no such date");
});

const occurrence = (index, start, flags, end) => [...u32(index), ...u32(start.date), ...u16(start.minute), flags, 0, ...u32(end.date), ...u16(end.minute), 0, 0];

/** TEST-VECTORS 147, as rust/src/calendar_tests.rs builds it. */
function kcal() {
  const bins = encodeCalendarEventPayload({
    eventId: hex(numbered(1)), title: "Bins", allDay: true, start: { date: 20261005 }, end: { date: 20261005 },
    repeat: { frequency: "weekly", weekdays: [0] },
  });
  const dentist = encodeCalendarEventPayload({
    eventId: hex(numbered(2)), title: "Dentist", attendees: [id(2)], start: { date: 20261006, minute: 600 }, end: { date: 20261006, minute: 630 }, zone: "Europe/London",
  });
  const trip = encodeCalendarEventPayload({
    eventId: hex(numbered(3)), title: "Trip", allDay: true, countdown: true, start: { date: 20261224 }, end: { date: 20261227 },
  });
  const event = (payload, cancelled) => [0, 0, ...u16(cancelled.length), ...u32(payload.length), ...cancelled.flatMap((date) => [...u32(date), 0, 0, 0, 0]), ...payload];
  return Uint8Array.from([
    ...magic("KCAL"), 1, 0, 0, 0, ...u32(20261005), ...u32(20261011), ...u32(20261003), ...u32(16),
    ...[1, 3, 2, 1, 0, 1].flatMap(u32),
    ...occurrence(2, { date: 20261224, minute: 0 }, 0b011, { date: 20261227, minute: 0 }),
    ...new Array(16).fill(1), 2, 0, 0, 0,
    ...event(bins, [20261012]), ...event(dentist, []), ...event(trip, []),
    ...occurrence(0, { date: 20261005, minute: 0 }, 0b001, { date: 20261005, minute: 0 }),
    ...occurrence(1, { date: 20261006, minute: 600 }, 0, { date: 20261006, minute: 630 }),
    ...numbered(50), ...u32(20261007), 0, 0, 0, 0, ...new Array(16).fill(0),
    ...u32(20261006), 4, 0, 0, 0, ...new Array(32).fill(0), ...text("Tacos"),
  ]);
}

test("KCAL decodes into events, occurrences and household things (147)", () => {
  const range = decodeCalendarRange(kcal());
  assert.equal(range.from, 20261005);
  assert.equal(range.today, 20261003);
  assert.equal(range.occurrencesTruncated, false);
  assert.deepEqual([...range.colours], [[id(1), 2]]);
  assert.deepEqual(range.events.map((event) => [event.title, event.cancelled, event.cancelledStarts]), [
    ["Bins", false, [{ date: 20261012, minute: 0 }]], ["Dentist", false, []], ["Trip", false, []],
  ]);
  assert.deepEqual(range.occurrences.map(({ title, start, end, allDay, attendees, zone }) => ({ title, start, end, allDay, attendees, zone })), [
    { title: "Bins", start: { date: 20261005, minute: 0 }, end: { date: 20261005, minute: 0 }, allDay: true, attendees: [], zone: "" },
    { title: "Dentist", start: { date: 20261006, minute: 600 }, end: { date: 20261006, minute: 630 }, allDay: false, attendees: [id(2)], zone: "Europe/London" },
  ]);
  assert.equal(range.nextCountdown.title, "Trip");
  assert.equal(range.nextCountdown.countdown, true);
  assert.deepEqual(range.items, [{ itemId: hex(numbered(50)), date: 20261007, classification: "today", ownerId: null }]);
  assert.deepEqual(range.routines, []);
  assert.deepEqual(range.meals, [{ date: 20261006, slot: "dinner", recipeId: null, cookId: null, name: "Tacos" }]);

  const bytes = kcal();
  const broken = (mutate, why) => {
    const copy = bytes.slice();
    mutate(copy);
    assert.throws(() => decodeCalendarRange(copy), CalendarFormatError, why);
  };
  broken((b) => { b[0] = 0x58; }, "magic");
  broken((b) => { b[4] = 2; }, "version");
  broken((b) => { b[20] = 32; }, "unknown flag");
  broken((b) => { b[20] = 0; }, "a countdown without the flag");
  broken((b) => { b[48] = 9; }, "countdown names no event");
  broken((b) => { b[68 + 16] = 12; }, "colour 12");
  assert.throws(() => decodeCalendarRange(Uint8Array.of(...bytes, 0)), CalendarFormatError, "trailing");
  assert.throws(() => decodeCalendarRange(bytes.subarray(0, bytes.length - 1)), CalendarFormatError, "truncated");
  const empty = Uint8Array.from([...magic("KCAL"), 1, 0, 0, 0, ...u32(20261005), ...u32(20261011), ...u32(20261003), ...new Array(28).fill(0), ...new Array(20).fill(0)]);
  assert.deepEqual(decodeCalendarRange(empty).occurrences, []);
});

test("KICS decodes into importable events (155)", () => {
  const bins = encodeCalendarEventPayload({
    eventId: id(0), title: "Bins", sourceUid: "bins", allDay: true, start: { date: 20261005 }, end: { date: 20261005 },
    repeat: { frequency: "weekly", weekdays: [0] },
  }, { allowZeroId: true });
  const moved = encodeCalendarEventPayload({
    eventId: id(0), title: "Bins (Tuesday)", sourceUid: "bins", allDay: true, start: { date: 20261020 }, end: { date: 20261020 },
  }, { allowZeroId: true });
  const kics = Uint8Array.from([
    ...magic("KICS"), 1, 0, 0, 0, ...u32(2), ...u32(0), ...u32(0), ...text("Kids"),
    ...u32(0), ...u32(0xffffffff), 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, ...u32(bins.length), ...u32(20261012), 0, 0, 0, 0, ...bins,
    ...u32(8), ...u32(0), ...u32(20261019), 0, 0, 0, 0, 0, 0, 0, 0, ...u32(moved.length), ...moved,
  ]);
  const calendar = decodeICalendar(kics);
  assert.equal(calendar.name, "Kids");
  assert.equal(calendar.events.length, 2);
  assert.deepEqual(calendar.events[0].exdates, [{ date: 20261012, minute: 0 }]);
  assert.equal(calendar.events[0].master, null);
  assert.equal(calendar.events[0].event.eventId, id(0));
  assert.equal(calendar.events[1].flags.override, true);
  assert.equal(calendar.events[1].flags.cancelled, false);
  assert.equal(calendar.events[1].master, 0);
  assert.deepEqual(calendar.events[1].original, { date: 20261019, minute: 0 });
  const broken = (mutate, why) => {
    const copy = kics.slice();
    mutate(copy);
    assert.throws(() => decodeICalendar(copy), CalendarFormatError, why);
  };
  broken((b) => { b[8] = 3; }, "count disagrees");
  broken((b) => { b[16] = 2; }, "unknown result flag");
  const second = kics.length - moved.length - 24;
  broken((b) => { b[second + 4] = 1; }, "master points at itself");
  broken((b) => { b[second + 1] = 1; }, "unknown flag");
  assert.throws(() => decodeICalendar(Uint8Array.of(...kics, 0)), CalendarFormatError, "trailing");
  assert.deepEqual(decodeICalendar(Uint8Array.from([...magic("KICS"), 1, 0, 0, 0, ...new Array(14).fill(0)])), { name: "", skipped: 0, truncated: false, events: [] });
});
