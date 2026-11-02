// Taking turns codecs (#429): the kind-68 and kind-69 payloads, their KCMD
// packets, KRRS and turnAmong, matching rust/src/rotations.rs. The bytes are
// TEST-VECTORS 051, 052 and 055, written out by hand.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ROTATION_MEMBERS, RotationFormatError, decodeRoutineRotations, encodeRotationIntent, encodeRotationPayload,
  encodeTurnPayload, turnAmong,
} from "./kin-rotations.js";

const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const bytes = (byte) => new Array(16).fill(byte);
const magic = (value) => [...value].map((c) => c.charCodeAt(0));
const identity = { eventId: id(1), householdId: id(2), actorId: id(3), deviceId: id(4), timestamp: 1_791_475_200_000, logicalTime: 5n };
const ALEX = 0x01, SAM = 0x02, JO = 0x03, BINS = 0x20;

test("the rotation payload is the routine, count, index and members", () => {
  assert.deepEqual(
    [...encodeRotationPayload({ routineId: id(BINS), memberIds: [id(ALEX), id(SAM), id(JO)], currentIndex: 1 })],
    [...bytes(BINS), 3, 1, 0, 0, ...bytes(ALEX), ...bytes(SAM), ...bytes(JO)],
  );
  assert.deepEqual([...encodeRotationPayload({ routineId: id(BINS), memberIds: [] })], [...bytes(BINS), 0, 0, 0, 0], "ending it");
  const twelve = Array.from({ length: MAX_ROTATION_MEMBERS }, (_, n) => id(n + 1));
  assert.equal(encodeRotationPayload({ routineId: id(BINS), memberIds: twelve, currentIndex: 11 }).length, 20 + 16 * 12);
  for (const bad of [
    { routineId: id(BINS), memberIds: [id(ALEX)], currentIndex: 0 },
    { routineId: id(BINS), memberIds: [...twelve, id(13)], currentIndex: 0 },
    { routineId: id(BINS), memberIds: [id(ALEX), id(SAM), id(ALEX)], currentIndex: 0 },
    { routineId: id(BINS), memberIds: [id(ALEX), id(0)], currentIndex: 0 },
    { routineId: id(BINS), memberIds: [id(ALEX), id(SAM)], currentIndex: 2 },
    { routineId: id(BINS), memberIds: [id(ALEX), id(SAM)], currentIndex: -1 },
    { routineId: id(BINS), memberIds: [], currentIndex: 1 },
    { routineId: id(0), memberIds: [id(ALEX), id(SAM)], currentIndex: 0 },
    { routineId: id(BINS), memberIds: "nope", currentIndex: 0 },
  ]) assert.throws(() => encodeRotationPayload(bad), RotationFormatError, JSON.stringify(bad));
});

test("the turn payload is two IDs", () => {
  assert.deepEqual([...encodeTurnPayload({ routineId: id(BINS), memberId: id(SAM) })], [...bytes(BINS), ...bytes(SAM)]);
  assert.throws(() => encodeTurnPayload({ routineId: id(BINS), memberId: id(0) }), RotationFormatError);
  assert.throws(() => encodeTurnPayload({ routineId: id(BINS) }), RotationFormatError);
});

test("commands are KCMD 68 and 69 with the payload as text", () => {
  for (const [command, kind, length] of [
    [{ type: "set-routine-rotation", routineId: id(BINS), memberIds: [id(ALEX), id(SAM)], currentIndex: 0 }, 68, 52],
    [{ type: "set-routine-turn", routineId: id(BINS), memberId: id(SAM) }, 69, 32],
  ]) {
    const packet = encodeRotationIntent(command, identity);
    const view = new DataView(packet.buffer);
    assert.equal(String.fromCharCode(...packet.subarray(0, 4)), "KCMD");
    assert.equal(view.getUint16(8, true), kind);
    assert.ok(packet.subarray(92, 124).every((byte) => byte === 0), "no entity, date, option or expiry");
    assert.equal(view.getUint32(124, true), length);
    assert.equal(packet.length, 128 + length);
  }
  assert.throws(() => encodeRotationIntent({ type: "set-item-section" }, identity), RotationFormatError);
});

test("KRRS decodes strictly", () => {
  const krrs = Uint8Array.from([
    ...magic("KRRS"), 1, 0, 0, 0, 2, 0, 0, 0,
    ...bytes(0x20), 3, 2, 0, 0, ...bytes(SAM), ...bytes(ALEX), ...bytes(JO),
    ...bytes(0x21), 2, 0, 1, 0, ...bytes(ALEX), ...bytes(SAM),
  ]);
  assert.deepEqual(decodeRoutineRotations(krrs), [
    { routineId: id(0x20), memberIds: [id(SAM), id(ALEX), id(JO)], current: id(JO), next: id(SAM) },
    { routineId: id(0x21), memberIds: [id(ALEX), id(SAM)], current: id(ALEX), next: id(SAM) },
  ]);
  assert.deepEqual(decodeRoutineRotations(Uint8Array.from([...magic("KRRS"), 1, 0, 0, 0, 0, 0, 0, 0])), []);
  const broken = (change, why) => {
    const copy = krrs.slice();
    change(copy);
    assert.throws(() => decodeRoutineRotations(copy), RotationFormatError, why);
  };
  assert.throws(() => decodeRoutineRotations(Uint8Array.from([...krrs, 0])), RotationFormatError, "trailing bytes");
  assert.throws(() => decodeRoutineRotations(krrs.subarray(0, krrs.length - 1)), RotationFormatError, "truncated");
  broken((copy) => { copy[4] = 2; }, "version");
  broken((copy) => { copy[6] = 1; }, "reserved");
  broken((copy) => { copy[29] = 3; }, "current past the list");
  broken((copy) => { copy[30] = 2; }, "next isn't after current");
  broken((copy) => { copy[31] = 1; }, "reserved per routine");
  broken((copy) => { copy[28] = 1; }, "one member");
  broken((copy) => { copy.set(bytes(ALEX), 32); }, "a repeated member");
  broken((copy) => { copy.set(bytes(0x20), 80); }, "routines in ID order, once");
});

test("turnAmong passes over members who aren't active", () => {
  const rotation = { memberIds: [id(ALEX), id(SAM), id(JO)], current: id(SAM), next: id(JO) };
  assert.deepEqual(turnAmong(rotation), { current: id(SAM), next: id(JO) }, "membership unknown: everyone");
  assert.deepEqual(turnAmong(rotation, [id(ALEX), id(SAM), id(JO)]), { current: id(SAM), next: id(JO) });
  assert.deepEqual(turnAmong(rotation, [id(ALEX), id(SAM)]), { current: id(SAM), next: id(ALEX) }, "Jo is passed over");
  assert.deepEqual(turnAmong(rotation, [id(ALEX), id(JO)]), { current: id(JO), next: id(ALEX) }, "Sam's turn passes to Jo");
  assert.deepEqual(turnAmong(rotation, [id(JO), id(9)]), { current: null, next: null }, "fewer than two active");
});
