// Calendar dates, range math and zone conversion with Intl (#660), daylight
// saving time included.
import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays, addMonths, daysBetween, fromIsoDate, fromTimeText, instantToWall, isoDate, monthGrid, showsToday, startOfWeek, stepFocus,
  timeText, toViewerWall, viewRange, wallToInstant, weekAnchor, weekday, zoneOffsetMinutes,
} from "./calendar-time.js";

const at = (iso) => Date.parse(iso);

test("civil date arithmetic across months, years and leap days", () => {
  assert.equal(addDays(20261031, 1), 20261101);
  assert.equal(addDays(20261231, 1), 20270101);
  assert.equal(addDays(20280228, 1), 20280229);
  assert.equal(addDays(20270301, -1), 20270228);
  assert.equal(addDays(991231, 1), 1000101, "years below 100 stay as written");
  assert.equal(daysBetween(20261005, 20261012), 7);
  assert.equal(daysBetween(20261012, 20261005), -7);
  assert.equal(weekday(20261005), 0, "2026-10-05 is a Monday");
  assert.equal(weekday(20261011), 6);
  assert.equal(startOfWeek(20261008), 20261005);
  assert.equal(addMonths(20260131, 1), 20260228);
  assert.equal(addMonths(20280131, 1), 20280229);
  assert.equal(addMonths(20261215, 1), 20270115);
  assert.equal(addMonths(20260115, -1), 20251215);
});

test("view ranges: a week from today, a day, six weeks for a month", () => {
  const today = 20261007;
  assert.deepEqual(viewRange("week", today, today), { from: 20261007, to: 20261013 }, "today first");
  assert.deepEqual(viewRange("week", 20261015, today), { from: 20261014, to: 20261020 });
  assert.deepEqual(viewRange("week", 20261006, today), { from: 20260930, to: 20261006 });
  assert.equal(weekAnchor(20261013, today), 20261007);
  assert.deepEqual(viewRange("day", 20261009, today), { from: 20261009, to: 20261009 });
  const grid = monthGrid(20261015);
  assert.equal(grid.length, 42);
  assert.equal(grid[0], 20260928, "the Monday before 1 October");
  assert.equal(grid.at(-1), 20261108);
  assert.deepEqual(viewRange("month", 20261015, today), { from: 20260928, to: 20261108 });
  assert.equal(stepFocus("week", 20261007, 1), 20261014);
  assert.equal(stepFocus("month", 20261031, 1), 20261130);
  assert.equal(stepFocus("day", 20261007, -1), 20261006);
});

test("Today goes back to today's own month, even when the month shown has today in its grid", () => {
  const today = 20261026;
  assert.equal(viewRange("month", 20261126, today).from, today, "November's grid starts on Monday 26 October");
  assert.equal(showsToday("month", 20261126, today), false);
  assert.equal(showsToday("month", 20261003, today), true);
  assert.equal(showsToday("month", 20251026, today), false, "the same month a year earlier");
  assert.equal(showsToday("week", 20261030, today), true);
  assert.equal(showsToday("week", 20261102, today), false);
  assert.equal(showsToday("day", today, today), true);
  assert.equal(showsToday("day", 20261027, today), false);
});

test("form values", () => {
  assert.equal(isoDate(20261005), "2026-10-05");
  assert.equal(fromIsoDate("2026-10-05"), 20261005);
  assert.equal(fromIsoDate("2026-02-30"), null);
  assert.equal(fromIsoDate(""), null);
  assert.equal(timeText(1050), "17:30");
  assert.equal(fromTimeText("17:30"), 1050);
  assert.equal(fromTimeText("17:30:00"), 1050);
  assert.equal(fromTimeText("24:00"), null);
});

test("zone offsets follow daylight saving time", () => {
  assert.equal(zoneOffsetMinutes("Europe/London", at("2026-07-01T12:00:00Z")), 60);
  assert.equal(zoneOffsetMinutes("Europe/London", at("2026-12-01T12:00:00Z")), 0);
  assert.equal(zoneOffsetMinutes("America/New_York", at("2026-07-01T12:00:00Z")), -240);
  assert.equal(zoneOffsetMinutes("America/New_York", at("2026-12-01T12:00:00Z")), -300);
  assert.equal(zoneOffsetMinutes("Asia/Kolkata", at("2026-12-01T12:00:00Z")), 330);
});

test("a 9:00 wall time stays 9:00 in its zone on both sides of a change", () => {
  // London: clocks go back on 25 October 2026.
  assert.equal(wallToInstant({ date: 20261024, minute: 540 }, "Europe/London"), at("2026-10-24T08:00:00Z"));
  assert.equal(wallToInstant({ date: 20261026, minute: 540 }, "Europe/London"), at("2026-10-26T09:00:00Z"));
  assert.deepEqual(instantToWall(at("2026-10-26T09:00:00Z"), "Europe/London"), { date: 20261026, minute: 540 });
});

test("a time that happens twice is the first; one that doesn't exist moves forward", () => {
  // New York, 1 November 2026: 01:30 happens twice (EDT then EST).
  assert.equal(wallToInstant({ date: 20261101, minute: 90 }, "America/New_York"), at("2026-11-01T05:30:00Z"));
  // New York, 8 March 2026: 02:30 doesn't exist; it is read with the
  // offset before the change (EST), so it is 03:30 EDT.
  const gap = wallToInstant({ date: 20260308, minute: 150 }, "America/New_York");
  assert.equal(gap, at("2026-03-08T07:30:00Z"));
  assert.deepEqual(instantToWall(gap, "America/New_York"), { date: 20260308, minute: 210 });
});

test("the viewer sees another zone's time as their own; floating times as written", () => {
  // 9:00 in London in summer is 4:00 in New York.
  assert.deepEqual(toViewerWall({ date: 20260706, minute: 540 }, "Europe/London", "America/New_York"),
    { date: 20260706, minute: 240, shifted: true, known: true });
  // Across midnight: 1:00 in London is 20:00 the day before in New York.
  assert.deepEqual(toViewerWall({ date: 20260706, minute: 60 }, "Europe/London", "America/New_York"),
    { date: 20260705, minute: 1200, shifted: true, known: true });
  // The two weeks a year the US and Europe change on different dates.
  assert.equal(toViewerWall({ date: 20261028, minute: 540 }, "Europe/London", "America/New_York").minute, 300);
  assert.equal(toViewerWall({ date: 20261021, minute: 540 }, "Europe/London", "America/New_York").minute, 240);
  assert.deepEqual(toViewerWall({ date: 20260706, minute: 540 }, "", "America/New_York"), { date: 20260706, minute: 540, shifted: false, known: true });
  assert.deepEqual(toViewerWall({ date: 20260706, minute: 540 }, "Europe/London", "Europe/London"), { date: 20260706, minute: 540, shifted: false, known: true });
  assert.deepEqual(toViewerWall({ date: 20260706, minute: 540 }, "Not/AZone", "Europe/London"), { date: 20260706, minute: 540, shifted: false, known: false }, "an unknown zone shows as written");
});
