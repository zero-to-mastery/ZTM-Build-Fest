// Placing occurrences in days and laying out overlaps (#661).
import test from "node:test";
import assert from "node:assert/strict";
import { countdownText, layoutDay, occurrenceLabel, occurrencesByDay, peopleText, placeOccurrence, sourceText, whenText } from "./calendar-layout.js";

const occurrence = (title, start, end, extra = {}) => ({
  eventId: `${title}`.padEnd(32, "0").slice(0, 32), title, place: "", zone: "", attendees: [], allDay: false,
  start, end, cancelled: false, linked: false, countdown: false, event: { repeat: null }, ...extra,
});
const at = (date, hour, minute = 0) => ({ date, minute: hour * 60 + minute });
const names = { a: "Alex", b: "Sam", c: "Jo" };
const labelOf = (id) => names[id] ?? id;

test("all-day events show on every day they cover; timed ones in each day they touch", () => {
  const placed = [
    placeOccurrence(occurrence("Trip", { date: 20261006, minute: 0 }, { date: 20261008, minute: 0 }, { allDay: true }), "UTC"),
    placeOccurrence(occurrence("Dentist", at(20261006, 10), at(20261006, 10, 30)), "UTC"),
    placeOccurrence(occurrence("Night shift", at(20261006, 22), at(20261007, 6)), "UTC"),
    placeOccurrence(occurrence("Festival", at(20261006, 12), at(20261009, 0)), "UTC"),
  ];
  const days = occurrencesByDay(placed, 20261005, 20261009);
  assert.deepEqual([...days.keys()], [20261005, 20261006, 20261007, 20261008, 20261009]);
  assert.deepEqual(days.get(20261005), { allDay: [], timed: [] });
  assert.deepEqual(days.get(20261006).allDay.map((entry) => entry.occurrence.title), ["Trip"]);
  assert.deepEqual(days.get(20261006).timed.map((entry) => [entry.placed.occurrence.title, entry.start, entry.end]), [
    ["Dentist", 600, 630], ["Festival", 720, 1440], ["Night shift", 1320, 1440],
  ]);
  assert.deepEqual(days.get(20261007).timed.map((entry) => [entry.placed.occurrence.title, entry.start, entry.end, entry.continuesBefore]), [
    ["Night shift", 0, 360, true],
  ]);
  assert.deepEqual(days.get(20261007).allDay.map((entry) => entry.occurrence.title), ["Trip", "Festival"], "a whole day of a long event is all day");
  assert.deepEqual(days.get(20261008).allDay.map((entry) => entry.occurrence.title), ["Trip", "Festival"]);
  assert.deepEqual(days.get(20261009), { allDay: [], timed: [] }, "an event ending at midnight doesn't spill into the next day");
});

test("an event in another zone lands on the viewer's day", () => {
  const late = placeOccurrence(occurrence("Call", at(20260706, 1), at(20260706, 2), { zone: "Europe/London" }), "America/New_York");
  assert.deepEqual([late.start, late.end, late.shifted], [{ date: 20260705, minute: 1200 }, { date: 20260705, minute: 1260 }, true]);
  const days = occurrencesByDay([late], 20260705, 20260706);
  assert.equal(days.get(20260705).timed.length, 1);
  assert.equal(days.get(20260706).timed.length, 0);
});

test("overlapping events share the width in stable columns", () => {
  const segment = (title, start, end) => ({ placed: placeOccurrence(occurrence(title, at(20261006, 0, start), at(20261006, 0, end)), "UTC"), start, end });
  const laid = layoutDay([
    segment("A", 540, 600), segment("B", 570, 660), segment("C", 600, 630), segment("D", 700, 760), segment("E", 705, 710),
  ]);
  const by = Object.fromEntries(laid.map((entry) => [entry.placed.occurrence.title, [entry.column, entry.columns]]));
  // A, B, C overlap (C fits in A's column once A ends); D and E overlap.
  assert.deepEqual(by, { A: [0, 2], B: [1, 2], C: [0, 2], D: [0, 2], E: [1, 2] });
  // A short event is laid out as 30 minutes, so the next one stays beside it.
  const short = layoutDay([segment("Quick", 540, 545), segment("Next", 550, 600)]);
  assert.deepEqual(short.map((entry) => [entry.column, entry.columns]), [[0, 2], [1, 2]]);
  assert.deepEqual(layoutDay([segment("Alone", 540, 600)]).map((entry) => [entry.column, entry.columns]), [[0, 1]]);
  assert.deepEqual(layoutDay([]), []);
});

test("words for people, times, screen readers and countdowns", () => {
  assert.equal(peopleText([], labelOf), "Everyone");
  assert.equal(peopleText(["a"], labelOf), "Alex");
  assert.equal(peopleText(["a", "b", "c"], labelOf), "Alex, Sam and Jo");
  const swim = placeOccurrence(occurrence("Swimming", at(20261006, 17, 30), at(20261006, 18, 15), { attendees: ["a", "b"], place: "Pool" }), "UTC");
  assert.match(whenText(swim, 20261006), /^5:30\s?PM to 6:15\s?PM$|^17:30 to 18:15$/);
  const label = occurrenceLabel(swim, 20261006, labelOf);
  assert.ok(label.startsWith("Swimming, "), "the title comes first, matching the visible text");
  assert.match(label, /For Alex and Sam, At Pool$/);
  const allDay = placeOccurrence(occurrence("Trip", { date: 20261006, minute: 0 }, { date: 20261008, minute: 0 }, { allDay: true }), "UTC");
  assert.equal(whenText(allDay, 20261007), "All day, 2 of 3 days");
  // An outside calendar's occurrence (#668) names its source.
  const outside = placeOccurrence(occurrence("School run", at(20261006, 8), at(20261006, 9), { external: true, sourceLabel: "From Google" }), "UTC");
  assert.equal(outside.readonly, true);
  assert.match(occurrenceLabel(outside, 20261006, labelOf), /, From Google$/);
  assert.equal(sourceText({ sourceLabel: "School" }), "From School");
  assert.equal(sourceText({}), "From an outside calendar");
  const next = { title: "Trip", start: { date: 20261224, minute: 0 } };
  assert.equal(countdownText(next, 20261212), "12 days until Trip");
  assert.equal(countdownText(next, 20261223), "1 day until Trip");
  assert.equal(countdownText(next, 20261224), "Trip is today");
  assert.equal(countdownText(null, 20261224), "");
});
