// "This week" codecs (#417): KWKQ and KWKD, matching rust/src/week.rs. The
// bytes mirror week_tests.rs `the_export_speaks_kwkq_and_kwkd`.
import assert from "node:assert/strict";
import test from "node:test";
import { KinEngineError } from "./wire.js";
import { WeekFormatError, decodeWeek, encodeWeekQuery } from "./kin-week.js";

const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const raw = (byte) => Array.from({ length: 16 }, () => byte);
const le16 = (value) => [value & 0xff, value >> 8];
const le32 = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const day = (date, items, routines, meals, maintenance, omitted = 0) => [...le32(date), ...le16(items), ...le16(routines), meals, maintenance, ...le16(omitted)];

function week({ flags = 0 } = {}) {
  const soup = new TextEncoder().encode("Soup");
  return [
    ...ascii("KWKD"), 1, 0, 0, 0, ...le32(20261005), 7, flags, 0, 0,
    ...day(20261005, 1, 1, 0, 0),
    ...raw(1), 0, 1, 0, 0, ...raw(2), // a Today item owned by member 02…
    ...raw(10), ...le32(20261005), 1, 0b110, 0, 0, ...raw(0), // weekly, current, done
    ...day(20261006, 0, 0, 1, 0, 3),
    0b10, 0, 0, 0, ...raw(0), ...raw(2), ...le16(soup.length), ...soup,
    ...day(20261007, 0, 0, 0, 0),
    ...day(20261008, 0, 0, 0, 0),
    ...day(20261009, 0, 0, 0, 0),
    ...day(20261010, 0, 0, 0, 0),
    ...day(20261011, 0, 0, 0, 1),
    ...raw(0x60), ...raw(0x50), ...le32(20260901),
  ];
}

test("KWKQ carries the start date", () => {
  const query = encodeWeekQuery(20261229);
  assert.deepEqual([...query], [...ascii("KWKQ"), 1, 0, 0, 0, ...le32(20261229), 0, 0, 0, 0]);
  for (const bad of [0, 20261301, 20260230, "20261229", null])
    assert.throws(() => encodeWeekQuery(bad), KinEngineError, String(bad));
});

test("KWKD decodes to seven days with hex IDs", () => {
  const days = decodeWeek(Uint8Array.from(week()));
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((entry) => entry.date), [20261005, 20261006, 20261007, 20261008, 20261009, 20261010, 20261011]);
  assert.deepEqual(days[0], {
    date: 20261005,
    items: [{ itemId: id(1), classification: "today", ownerId: id(2) }],
    routines: [{ routineId: id(10), occurrenceKey: 20261005, cadence: "weekly", current: true, done: true, ownerId: null }],
    meals: [],
    maintenance: [],
    omitted: 0,
  });
  assert.deepEqual(days[1].meals, [{ recipeId: null, cookId: id(2), name: "Soup" }]);
  assert.equal(days[1].omitted, 3);
  assert.deepEqual(days[6].maintenance, [{ maintenanceId: id(0x60), recordId: id(0x50), performedOn: 20260901 }]);
});

test("KWKD decodes strictly", () => {
  const good = week();
  const corrupt = (offset, value) => { const bytes = good.slice(); bytes[offset] = value; return Uint8Array.from(bytes); };
  const firstDay = 16, item = firstDay + 12, routine = item + 36;
  const cases = {
    "trailing bytes": Uint8Array.from([...good, 0]),
    "truncated": Uint8Array.from(good.slice(0, -1)),
    "magic": corrupt(0, 0x58),
    "version": corrupt(4, 2),
    "reserved header": corrupt(6, 1),
    "day count": corrupt(12, 6),
    "unknown flag": corrupt(13, 2),
    "first day is not the start": corrupt(firstDay, 6),
    "unknown classification": corrupt(item + 16, 4),
    "owner flag without an owner": corrupt(item + 17, 0),
    "reserved item bytes": corrupt(item + 18, 1),
    "unknown cadence": corrupt(routine + 20, 5),
    "done without current": corrupt(routine + 21, 0b100),
    "owner bit with a zero owner": corrupt(routine + 21, 0b111),
    "invalid occurrence date": corrupt(routine + 16, 0),
  };
  for (const [name, bytes] of Object.entries(cases)) assert.throws(() => decodeWeek(bytes), WeekFormatError, name);
  // Paused routines: the flag holds only with no routine occurrences.
  assert.throws(() => decodeWeek(Uint8Array.from(week({ flags: 1 }))), WeekFormatError);
});
