// The family calendar (#656) and iCalendar import (#666) through the real
// engine: events round-trip as kinds 71–74 and come back through
// kin_calendar_range; an .ics file parses through kin_ical_parse and its
// events import as ordinary saves, cancels and linked overrides. Needs the
// built kin_engine.wasm.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const asOf = 1_791_475_200_000;
const civilDate = 20261003;

function household() {
  const records = [];
  let sequence = 0;
  const run = (command, actor = 0xbb) => {
    sequence += 1;
    const result = engine.executeCommand(command, {
      eventId: id(sequence), householdId: id(0xaa), actorId: id(actor), deviceId: id(0xcc),
      timestamp: asOf + sequence, logicalTime: BigInt(sequence),
    }, records, asOf, null, civilDate);
    records.push(result.encodedEvent);
    return result;
  };
  const range = (from, to, options) => engine.calendarRange(from, to, records, asOf, civilDate, null, options);
  return { records, run, range };
}

const refusedWith = (code) => (error) => error.code === code;

test("calendar events, cancels, restores and colours round-trip through Rust", () => {
  const home = household();
  assert.deepEqual(home.range(20261005, 20261011).occurrences, []);
  const swimming = {
    eventId: id(0x41), title: "Swimming", place: "Leisure centre", attendees: [id(0xbb), id(0x02)],
    start: { date: 20261006, minute: 1050 }, end: { date: 20261006, minute: 1095 }, zone: "Europe/London",
    repeat: { frequency: "weekly", weekdays: [1, 3], count: 10 },
  };
  const saved = home.run({ type: "save-calendar-event", event: swimming });
  assert.equal(saved.metadata.kind, "CALENDAR_EVENT_SAVED");
  const week = home.range(20261005, 20261011);
  assert.deepEqual(week.occurrences.map((found) => [found.title, found.start, found.end, found.zone]), [
    ["Swimming", { date: 20261006, minute: 1050 }, { date: 20261006, minute: 1095 }, "Europe/London"],
    ["Swimming", { date: 20261008, minute: 1050 }, { date: 20261008, minute: 1095 }, "Europe/London"],
  ]);
  assert.deepEqual(week.occurrences[0].attendees, [id(0x02), id(0xbb)], "ascending");

  // Change one occurrence: cancel it and save a linked event.
  const thursday = { date: 20261008, minute: 1050 };
  assert.equal(home.run({ type: "cancel-calendar-event", eventId: id(0x41), occurrence: thursday }).metadata.kind, "CALENDAR_EVENT_CANCELLED");
  assert.throws(() => home.run({ type: "cancel-calendar-event", eventId: id(0x41), occurrence: thursday }), refusedWith(4), "twice");
  assert.throws(() => home.run({ type: "cancel-calendar-event", eventId: id(0x41), occurrence: { date: 20261007, minute: 1050 } }), refusedWith(4), "not an occurrence");
  home.run({ type: "save-calendar-event", event: {
    eventId: id(0x42), title: "Swimming (late)", start: { date: 20261008, minute: 1110 }, end: { date: 20261008, minute: 1155 }, zone: "Europe/London",
    series: { seriesId: id(0x41), original: thursday },
  } });
  const changed = home.range(20261005, 20261011, { includeCancelled: true });
  assert.deepEqual(changed.occurrences.map((found) => [found.title, found.cancelled, found.linked]), [
    ["Swimming", false, false], ["Swimming", true, false], ["Swimming (late)", false, true],
  ]);
  assert.equal(home.run({ type: "restore-calendar-event", eventId: id(0x41), occurrence: thursday }).metadata.kind, "CALENDAR_EVENT_RESTORED");

  // A countdown, and colours.
  home.run({ type: "save-calendar-event", event: {
    eventId: id(0x43), title: "Trip", allDay: true, countdown: true, start: { date: 20261224 }, end: { date: 20261227 },
  } });
  assert.equal(home.run({ type: "set-member-colour", colour: 4 }).metadata.kind, "MEMBER_COLOUR_SET");
  assert.throws(() => home.run({ type: "set-member-colour", colour: 4 }), refusedWith(4), "no change");
  const later = home.range(20261005, 20261011);
  assert.equal(later.nextCountdown.title, "Trip");
  assert.deepEqual([...later.colours], [[id(0xbb), 4]]);
  assert.throws(() => home.range(20261005, 20271111), refusedWith(2), "over 400 days");
});

test("an .ics file parses on the device and imports as calendar events", () => {
  const ics = new TextEncoder().encode([
    "BEGIN:VCALENDAR", "X-WR-CALNAME:Kids",
    "BEGIN:VEVENT", "UID:bins", "DTSTART;VALUE=DATE:20261005", "RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;VALUE=DATE:20261012", "SUMMARY:Bins", "END:VEVENT",
    "BEGIN:VEVENT", "UID:bins", "RECURRENCE-ID;VALUE=DATE:20261019", "DTSTART;VALUE=DATE:20261020", "SUMMARY:Bins (Tuesday)", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n"));
  const calendar = engine.parseICalendar(ics);
  assert.equal(calendar.name, "Kids");
  assert.equal(calendar.events.length, 2);
  const home = household();
  const ids = [id(0x51), id(0x52)];
  calendar.events.forEach((imported, index) => {
    const series = imported.master === null ? null : { seriesId: ids[imported.master], original: imported.original };
    home.run({ type: "save-calendar-event", event: { ...imported.event, eventId: ids[index], series } });
    for (const occurrence of imported.exdates) home.run({ type: "cancel-calendar-event", eventId: ids[index], occurrence });
    if (series) home.run({ type: "cancel-calendar-event", eventId: series.seriesId, occurrence: imported.original });
  });
  const range = home.range(20261005, 20261025, { allEvents: true });
  assert.deepEqual(range.occurrences.map((found) => [found.title, found.start.date]), [
    ["Bins", 20261005], ["Bins (Tuesday)", 20261020],
  ]);
  assert.deepEqual(range.events.map((event) => event.sourceUid), ["bins", "bins"], "re-importing finds them by source UID");
});
