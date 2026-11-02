import assert from "node:assert/strict";
import test from "node:test";
import { describeReminderTime, localDateValue, localTimeValue, reminderShortcut, resolveReminderTime } from "./reminder-time.js";

const NOW = new Date(2026, 9, 13, 8, 30).getTime();

test("empty or partial inputs explain what is missing", () => {
  assert.equal(resolveReminderTime({ now: NOW }).error, "Choose a date and a time.");
  assert.equal(resolveReminderTime({ date: "2026-10-14", now: NOW }).error, "Choose a time.");
  assert.equal(resolveReminderTime({ time: "09:00", now: NOW }).error, "Choose a date.");
  assert.equal(resolveReminderTime({ date: "2026-10", time: "09:00", now: NOW }).error, "That date or time isn't complete yet.");
});

test("impossible dates and times are refused", () => {
  assert.equal(resolveReminderTime({ date: "2026-02-30", time: "09:00", now: NOW }).error, "That date or time doesn't exist.");
  assert.equal(resolveReminderTime({ date: "2026-10-14", time: "24:00", now: NOW }).error, "That date or time doesn't exist.");
});

test("a past or present time is refused with plain language", () => {
  assert.equal(resolveReminderTime({ date: "2026-10-13", time: "08:30", now: NOW }).error, "Choose a time that hasn't passed yet.");
  assert.equal(resolveReminderTime({ date: "2026-10-12", time: "23:59", now: NOW }).error, "Choose a time that hasn't passed yet.");
});

test("a future local time resolves to a timestamp, with or without seconds", () => {
  const expected = new Date(2026, 9, 14, 9, 0).getTime();
  assert.equal(resolveReminderTime({ date: "2026-10-14", time: "09:00", now: NOW }).at, expected);
  assert.equal(resolveReminderTime({ date: "2026-10-14", time: "09:00:00", now: NOW }).at, expected);
  assert.equal(localDateValue(expected), "2026-10-14");
  assert.equal(localTimeValue(expected), "09:00");
  assert.match(describeReminderTime(expected, "en-US"), /Oct 14/);
  assert.match(describeReminderTime(expected, "en-US"), /9:00/);
});

test("shortcuts fill both inputs so the resolved time remains visible and valid", () => {
  const hour = reminderShortcut("in-1-hour", NOW);
  assert.deepEqual(hour, { date: "2026-10-13", time: "09:30" });
  assert.ok(resolveReminderTime({ ...hour, now: NOW }).at > NOW);
  assert.deepEqual(reminderShortcut("this-evening", NOW), { date: "2026-10-13", time: "18:00" });
  assert.deepEqual(reminderShortcut("this-evening", new Date(2026, 9, 13, 19, 0).getTime()), { date: "2026-10-14", time: "18:00" });
  assert.deepEqual(reminderShortcut("tomorrow-morning", NOW), { date: "2026-10-14", time: "09:00" });
  assert.throws(() => reminderShortcut("never", NOW), RangeError);
});
