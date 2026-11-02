// The repeat editor's choices and the engine's RRULE subset (#662).
import test from "node:test";
import assert from "node:assert/strict";
import { choicesFromRepeat, describeRepeat, monthlyChoices, repeatFromChoices } from "./repeat.js";
import { encodeCalendarEventPayload, decodeCalendarEventPayload } from "../wasm/kin-calendar.js";

const event = (repeat, date = 20261013) => ({
  eventId: "11".repeat(16), title: "Swim", allDay: true, start: { date }, end: { date }, repeat,
});

test("monthly choices follow the start date", () => {
  // Tuesday 13 October 2026: day 13, the second Tuesday.
  assert.deepEqual(monthlyChoices(20261013).map((choice) => choice.id), ["day", "nth"]);
  assert.match(monthlyChoices(20261013)[1].label, /^On the second Tuesday$/);
  // Saturday 31 October: day 31, the fifth Saturday is the last one, and the last day.
  assert.deepEqual(monthlyChoices(20261031).map((choice) => choice.id), ["day", "last-weekday", "last-day"]);
  // Tuesday 27 October: the fourth and the last Tuesday.
  assert.deepEqual(monthlyChoices(20261027).map((choice) => choice.id), ["day", "nth", "last-weekday"]);
});

test("every choice makes a repeat the engine encodes, and reads back the same", () => {
  const start = 20261013;
  const cases = [
    { frequency: "daily", interval: 2, end: "count", count: 5 },
    { frequency: "weekly", interval: 1, weekdays: [1, 3], end: "until", until: 20261231 },
    { frequency: "weekly", interval: 2, weekdays: [], end: "never" },
    { frequency: "monthly", interval: 1, monthly: "day", end: "never" },
    { frequency: "monthly", interval: 3, monthly: "nth", end: "count", count: 4 },
    { frequency: "yearly", interval: 1, monthly: "day", end: "never" },
  ];
  for (const choices of cases) {
    const repeat = repeatFromChoices(choices, start);
    const decoded = decodeCalendarEventPayload(encodeCalendarEventPayload(event(repeat, start)));
    assert.deepEqual(decoded.repeat.frequency, choices.frequency);
    const back = choicesFromRepeat(decoded.repeat, start);
    assert.equal(back.frequency, choices.frequency);
    assert.equal(back.end, choices.end);
    if (choices.monthly) assert.equal(back.monthly, choices.monthly);
  }
  assert.deepEqual(repeatFromChoices({ frequency: "weekly", weekdays: [] }, start).weekdays, [1], "a weekly repeat without days uses the start's");
  assert.deepEqual(repeatFromChoices({ frequency: "monthly", monthly: "last-day" }, 20261031), { frequency: "monthly", interval: 1, monthDay: -1 });
  assert.equal(repeatFromChoices({ frequency: "" }, start), null);
});

test("repeats in words", () => {
  assert.equal(describeRepeat(null, 20261013), "Doesn't repeat");
  assert.equal(describeRepeat({ frequency: "weekly", interval: 1, weekdays: [0, 2] }, 20261013), "Every week on Monday and Wednesday");
  assert.equal(describeRepeat({ frequency: "daily", interval: 2, count: 10 }, 20261013), "Every 2 days, 10 times");
  assert.equal(describeRepeat({ frequency: "monthly", interval: 1, nth: 2, weekday: 1 }, 20261013), "Every month on the second Tuesday");
  assert.equal(describeRepeat({ frequency: "monthly", interval: 1, monthDay: -1 }, 20261031), "Every month on the last day");
  assert.match(describeRepeat({ frequency: "yearly", interval: 1, monthDay: 13, until: 20301013 }, 20261013), /^Every year in October, until .*2030$/);
});
