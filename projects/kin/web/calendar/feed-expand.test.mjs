// The host-side repeat walker for synced calendars (#668), checked against
// the cases rust/src/calendar_tests.rs pins for for_each_start
// (repeats_follow_the_rfc_across_month_lengths_and_leap_years), then the
// feed's own exceptions and the occurrence shape the views read.
import assert from "node:assert/strict";
import test from "node:test";
import { civilFromDay, expandFeed, forEachStart, MAX_EXTERNAL_OCCURRENCES } from "./feed-expand.js";
import { dayNumber } from "../wasm/kin-calendar.js";

const base = (start, repeat = null) => ({ allDay: true, start: { date: start, minute: 0 }, end: { date: start, minute: 0 }, repeat });
const starts = (event, low, high) => {
  const out = [];
  forEachStart(event, dayNumber(low), dayNumber(high), (day) => { out.push(civilFromDay(day)); return true; });
  return out;
};
// Rust's weekday bits: 1 << (0 Monday … 6 Sunday).
const days = (mask) => [0, 1, 2, 3, 4, 5, 6].filter((day) => mask & (1 << day));

test("civil dates round-trip through day numbers", () => {
  for (const date of [10101, 19700101, 20240229, 20261021, 99991231]) assert.equal(civilFromDay(dayNumber(date)), date);
  assert.equal(dayNumber(10101) % 7, 0, "0001-01-01 was a Monday");
});

test("repeats follow the RFC across month lengths and leap years, as Rust does", () => {
  assert.deepEqual(starts(base(20240227, { frequency: "daily", interval: 3, count: 5 }), 20240101, 20241231),
    [20240227, 20240301, 20240304, 20240307, 20240310]);
  assert.deepEqual(starts(base(20261006, { frequency: "weekly", interval: 1, weekdays: days(0b10101), until: 20261014 }), 20261001, 20261031),
    [20261006, 20261007, 20261009, 20261012, 20261014]);
  assert.deepEqual(starts(base(20261004, { frequency: "weekly", interval: 2, weekdays: days(0b1000001), weekStart: 6, count: 6 }), 20261001, 20261231),
    [20261004, 20261005, 20261018, 20261019, 20261101, 20261102]);
  assert.deepEqual(starts(base(20261004, { frequency: "weekly", interval: 2, weekdays: days(0b1000001), weekStart: 0, count: 6 }), 20261001, 20261231),
    [20261004, 20261012, 20261018, 20261026, 20261101, 20261109]);
  assert.deepEqual(starts(base(20260131, { frequency: "monthly", interval: 1, monthDay: 31 }), 20260101, 20260831),
    [20260131, 20260331, 20260531, 20260731, 20260831]);
  assert.deepEqual(starts(base(20240131, { frequency: "monthly", interval: 1, monthDay: -1, count: 4 }), 20240101, 20241231),
    [20240131, 20240229, 20240331, 20240430]);
  assert.deepEqual(starts(base(20261013, { frequency: "monthly", interval: 1, nth: 2, weekday: 1, count: 3 }), 20261001, 20271231),
    [20261013, 20261110, 20261208]);
  assert.deepEqual(starts(base(20261030, { frequency: "monthly", interval: 1, nth: -1, weekday: 4, count: 4 }), 20261001, 20271231),
    [20261030, 20261127, 20261225, 20270129]);
  assert.deepEqual(starts(base(20261130, { frequency: "monthly", interval: 1, nth: 5, weekday: 0, until: 20270630 }), 20261101, 20271231),
    [20261130, 20270329, 20270531]);
  assert.deepEqual(starts(base(20240229, { frequency: "yearly", interval: 1, monthDay: 29, count: 3 }), 20240101, 20401231),
    [20240229, 20280229, 20320229]);
  assert.deepEqual(starts(base(20261126, { frequency: "yearly", interval: 1, nth: 4, weekday: 3 }), 20261101, 20291231),
    [20261126, 20271125, 20281123, 20291122]);
  assert.deepEqual(starts(base(20261007, { frequency: "monthly", interval: 1, monthDay: 15, count: 3 }), 20261001, 20271231),
    [20261007, 20261015, 20261115]);
  assert.deepEqual(starts(base(19900101, { frequency: "daily", interval: 7 }), 20261001, 20261014), [20261005, 20261012]);
  assert.deepEqual(starts(base(99991201, { frequency: "monthly", interval: 1, monthDay: 1 }), 99991101, 99991231), [99991201]);
});

test("weekly rules match a day-by-day reading", () => {
  for (const start of [20240226, 20240229, 20241229]) {
    for (const mask of [1, 0b0010_0101, 0b111_1111, 0b100_0000]) {
      for (const interval of [1, 2, 3]) {
        for (const weekStart of [0, 6]) {
          const event = base(start, { frequency: "weekly", interval, weekdays: days(mask), weekStart });
          const weekOf = (day) => Math.floor((day - ((day % 7) + 7 - weekStart) % 7) / 7);
          const expected = [start];
          const first = dayNumber(start);
          for (let day = first + 1; day <= dayNumber(20250630); day += 1)
            if (mask & (1 << (day % 7)) && (weekOf(day) - weekOf(first)) % interval === 0) expected.push(civilFromDay(day));
          assert.deepEqual(starts(event, start, 20250630), expected, `${start} ${mask} ${interval} ${weekStart}`);
        }
      }
    }
  }
});

/** A KICS-shaped feed entry, as decodeICalendar returns it. */
const entry = (event, extra = {}) => ({
  flags: { cancelled: false }, master: null, original: null, exdates: [], ...extra,
  event: { title: "Event", place: "", notes: "", sourceUid: "uid@test", allDay: false, zone: "Europe/London", repeat: null, ...event },
});

test("a feed's occurrences: exdates and overrides applied, cancelled events left out, read-only and labelled", () => {
  const feed = {
    name: "Work",
    events: [
      entry({ title: "Stand-up", sourceUid: "standup@test", start: { date: 20261102, minute: 540 }, end: { date: 20261102, minute: 570 },
        repeat: { frequency: "weekly", interval: 1, weekdays: [0], weekStart: 0 } },
      { exdates: [{ date: 20261109, minute: 540 }] }),
      entry({ title: "Stand-up (moved)", sourceUid: "standup@test", start: { date: 20261117, minute: 600 }, end: { date: 20261117, minute: 630 } },
        { master: 0, original: { date: 20261116, minute: 540 } }),
      entry({ title: "Cancelled offsite", start: { date: 20261104, minute: 600 }, end: { date: 20261104, minute: 660 } }, { flags: { cancelled: true } }),
      entry({ title: "Conference", allDay: true, zone: "", start: { date: 20261130, minute: 0 }, end: { date: 20261202, minute: 0 } }),
      entry({ title: "Night shift", start: { date: 20261031, minute: 1380 }, end: { date: 20261101, minute: 420 } }),
    ],
  };
  const { occurrences, truncated } = expandFeed(feed, 20261101, 20261130, { sourceId: "s1", label: "From Google" });
  assert.equal(truncated, false);
  assert.deepEqual(occurrences.map((o) => [o.title, o.start.date, o.start.minute, o.end.date, o.end.minute]), [
    ["Night shift", 20261031, 1380, 20261101, 420],
    ["Stand-up", 20261102, 540, 20261102, 570],
    ["Stand-up (moved)", 20261117, 600, 20261117, 630],
    ["Stand-up", 20261123, 540, 20261123, 570],
    ["Conference", 20261130, 0, 20261202, 0],
    ["Stand-up", 20261130, 540, 20261130, 570],
  ], "all-day first on its day; the 9th is an exdate, the 16th moved to the 17th, the offsite cancelled, the night shift overlaps the window");
  for (const occurrence of occurrences) {
    assert.equal(occurrence.readOnly, true);
    assert.equal(occurrence.label, "From Google");
    assert.equal(occurrence.sourceId, "s1");
  }
  assert.equal(occurrences.find((o) => o.title === "Conference").zone, "", "all-day has no zone");
  assert.equal(new Set(occurrences.map((o) => o.key)).size, occurrences.length, "keys are unique");
});

test("expansion is bounded and rejects a bad window", () => {
  const daily = { events: Array.from({ length: 20 }, (_, index) => entry({ title: `Daily ${index}`, start: { date: 20260101, minute: index }, end: { date: 20260101, minute: index + 1 }, repeat: { frequency: "daily", interval: 1 } })) };
  const result = expandFeed(daily, 20260101, 20261231, { sourceId: "s" });
  assert.equal(result.truncated, true);
  assert.equal(result.occurrences.length, MAX_EXTERNAL_OCCURRENCES);
  assert.deepEqual(expandFeed(daily, 20261231, 20260101), { occurrences: [], truncated: false });
  assert.deepEqual(expandFeed(null, 20260101, 20260102), { occurrences: [], truncated: false });
});
