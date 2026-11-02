// Chore chart codecs (#676): the kind 77–79 payloads, their KCMD packets,
// KCCQ, KCCD and the week's day boundaries, matching rust/src/chores.rs.
// The bytes are TEST-VECTORS 085 and 089, written out by hand.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ChoreFormatError, canSendChoreCommand, choreWeek, decodeChoreChart, encodeChartQuery, encodeChoreIntent,
  encodeChorePayload, normalizeRewardText,
} from "./kin-chores.js";

const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const bytes = (byte) => new Array(16).fill(byte);
const magic = (value) => [...value].map((c) => c.charCodeAt(0));
const u16 = (value) => [value & 0xff, value >> 8];
const u32 = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
const identity = { eventId: id(1), householdId: id(2), actorId: id(3), deviceId: id(4), timestamp: 1_791_475_200_000, logicalTime: 5n };
const MIA = 0x02, PARENT = 0x01, CAT = 0x30;

test("the payloads are canonical (085)", () => {
  assert.deepEqual([...encodeChorePayload({ type: "set-chore-points", routineId: id(CAT), points: 3 })], [...bytes(CAT), 3, 0, 0, 0]);
  assert.deepEqual([...encodeChorePayload({ type: "set-chore-reward", memberId: id(MIA), goal: 20, text: "  Movie night " })],
    [...bytes(MIA), 20, 0, 0, 0, 11, 0, ...magic("Movie night")]);
  assert.deepEqual([...encodeChorePayload({ type: "set-chore-reward", memberId: id(MIA), goal: 0, text: "" })], [...bytes(MIA), 0, 0, 0, 0, 0, 0], "clearing");
  assert.deepEqual([...encodeChorePayload({ type: "set-chore-chart-joined", memberId: id(PARENT), joined: true })], [...bytes(PARENT), 1, 0, 0, 0]);
  for (const bad of [
    { type: "set-chore-points", routineId: id(CAT), points: 11 },
    { type: "set-chore-points", routineId: id(CAT), points: 1.5 },
    { type: "set-chore-points", routineId: id(0), points: 1 },
    { type: "set-chore-reward", memberId: id(MIA), goal: 1001, text: "x" },
    { type: "set-chore-reward", memberId: id(MIA), goal: 5, text: "  " },
    { type: "set-chore-reward", memberId: id(MIA), goal: 0, text: "Movie night" },
    { type: "set-chore-reward", memberId: id(MIA), goal: 5, text: "x".repeat(121) },
    { type: "set-chore-reward", memberId: id(MIA), goal: 5, text: "two\nlines" },
    { type: "set-chore-chart-joined", memberId: id(PARENT), joined: "yes" },
    { type: "set-item-emoji" },
  ]) assert.throws(() => encodeChorePayload(bad), ChoreFormatError, JSON.stringify(bad));
  assert.equal(normalizeRewardText(" Ice cream　"), "Ice cream", "trimmed like Rust's str::trim");
  assert.equal(encodeChorePayload({ type: "set-chore-reward", memberId: id(MIA), goal: 1000, text: "é".repeat(60) }).length, 22 + 120);
});

test("commands are KCMD 77, 78 and 79 with the payload as text", () => {
  for (const [command, kind, length] of [
    [{ type: "set-chore-points", routineId: id(CAT), points: 0 }, 77, 20],
    [{ type: "set-chore-reward", memberId: id(MIA), goal: 10, text: "Ice cream" }, 78, 31],
    [{ type: "set-chore-chart-joined", memberId: id(PARENT), joined: false }, 79, 20],
  ]) {
    const packet = encodeChoreIntent(command, identity);
    const view = new DataView(packet.buffer);
    assert.equal(String.fromCharCode(...packet.subarray(0, 4)), "KCMD");
    assert.equal(view.getUint16(8, true), kind);
    assert.ok(packet.subarray(92, 124).every((byte) => byte === 0), "no entity, date, option or expiry");
    assert.equal(view.getUint32(124, true), length);
    assert.equal(packet.length, 128 + length);
  }
  assert.throws(() => encodeChoreIntent({ type: "set-sitter-page" }, identity), ChoreFormatError);
});

test("who may send what: Adults set points and rewards; adults join only when allowed, and can always leave", () => {
  for (const type of ["set-chore-points", "set-chore-reward"]) {
    assert.equal(canSendChoreCommand(type, { memberKind: "adult" }), true);
    for (const memberKind of ["limited", "temporary", null, undefined]) assert.equal(canSendChoreCommand(type, { memberKind }), false);
  }
  const join = "set-chore-chart-joined";
  assert.equal(canSendChoreCommand(join, { memberKind: "adult", adultsAllowed: false }), false);
  assert.equal(canSendChoreCommand(join, { memberKind: "adult", adultsAllowed: true }), true);
  assert.equal(canSendChoreCommand(join, { memberKind: "adult", adultsAllowed: false, joined: true }), true, "leaving");
  assert.equal(canSendChoreCommand(join, { memberKind: "limited", adultsAllowed: true }), false, "children are always on it");
  assert.equal(canSendChoreCommand("set-item-emoji", { memberKind: "adult" }), false);
});

test("the week is Monday to Sunday in local time, with local midnights", () => {
  const saturday = choreWeek(20261003);
  assert.equal(saturday.start, 20260928);
  assert.equal(saturday.bounds.length, 8);
  assert.equal(saturday.bounds[0], new Date(2026, 8, 28).getTime());
  assert.equal(saturday.bounds[7], new Date(2026, 9, 5).getTime());
  assert.equal(choreWeek(20260928).start, 20260928, "a Monday is its own week's start");
  assert.equal(choreWeek(20261004).start, 20260928, "Sunday ends the week");
  assert.equal(choreWeek(20270101).start, 20261228, "across a new year");
  for (let index = 0; index < 7; index += 1) {
    const span = saturday.bounds[index + 1] - saturday.bounds[index];
    assert.ok(span >= 23 * 3600_000 && span <= 25 * 3600_000);
  }
});

test("KCCQ carries the week, the setting and the members", () => {
  const week = choreWeek(20261003);
  const query = encodeChartQuery({ ...week, adultsAllowed: true, members: [{ memberId: id(MIA), kind: "child" }, { memberId: id(PARENT), kind: "adult" }] });
  const view = new DataView(query.buffer);
  assert.deepEqual([...query.subarray(0, 8)], [...magic("KCCQ"), 1, 0, 0, 0]);
  assert.equal(view.getUint32(8, true), 20260928);
  assert.equal(query[12], 1);
  assert.equal(Number(view.getBigInt64(16, true)), week.bounds[0]);
  assert.equal(Number(view.getBigInt64(72, true)), week.bounds[7]);
  assert.equal(view.getUint16(80, true), 2);
  assert.deepEqual([...query.subarray(84)], [...bytes(MIA), 1, 0, 0, 0, ...bytes(PARENT), 2, 0, 0, 0]);
  assert.throws(() => encodeChartQuery({ ...week, members: [{ memberId: id(MIA), kind: "temporary" }] }), ChoreFormatError);
  assert.throws(() => encodeChartQuery({ ...week, members: Array.from({ length: 33 }, (_, n) => ({ memberId: id(n + 1), kind: "child" })) }), ChoreFormatError);
  assert.throws(() => encodeChartQuery({ start: 20260928, bounds: [1, 2] }), ChoreFormatError);
});

test("KCCD decodes the chart strictly (089)", () => {
  const chore = (kind, flags, points, idByte, date, key) => [kind, flags, points, 0, ...bytes(idByte), ...u32(date), ...u32(key)];
  const kccd = Uint8Array.from([
    ...magic("KCCD"), 1, 0, 0, 0, ...u32(20260928), ...u32(20260929), 0, 0, 0, 0, ...u16(1), ...u16(1),
    ...bytes(CAT), 2, 0, 0, 0,
    ...bytes(MIA), 2, 0, ...u16(2), ...u16(10), ...u16(2), ...u16(9), ...magic("Ice cream"),
    ...chore(2, 1, 2, CAT, 20260928, 20260928),
    ...chore(1, 2, 1, 0x40, 20260929, 0),
  ]);
  assert.deepEqual(decodeChoreChart(kccd), {
    start: 20260928, today: 20260929, routinesPaused: false, points: new Map([[id(CAT), 2]]),
    members: [{
      memberId: id(MIA), adult: false, points: 2, reward: { goal: 10, text: "Ice cream" },
      chores: [
        { kind: "routine", id: id(CAT), date: 20260928, occurrenceKey: 20260928, done: true, today: false, points: 2 },
        { kind: "item", id: id(0x40), date: 20260929, occurrenceKey: null, done: false, today: true, points: 1 },
      ],
    }],
  });
  const broken = (mutate) => { const copy = kccd.slice(); mutate(copy); return copy; };
  for (const bad of [
    kccd.slice(0, -1),
    Uint8Array.of(...kccd, 0),
    broken((copy) => { copy[4] = 2; }),
    broken((copy) => { copy[16] = 2; }),
    broken((copy) => { copy[44 + 16] = 4; }),
    broken((copy) => { copy[44 + 20] = 0; copy[44 + 21] = 0; }),
    broken((copy) => { copy[44 + 26 + 9] = 9; }),
    broken((copy) => { copy[44 + 26 + 9 + 28 + 24] = 1; }),
  ]) assert.throws(() => decodeChoreChart(bad), ChoreFormatError);
});
