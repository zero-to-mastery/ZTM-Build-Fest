import test from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_COMMANDS, BOARD_EVENT_KINDS, MAX_STROKE_PAYLOAD_BYTES, MAX_STROKE_POINTS, MAX_X, MAX_Y,
  boardPoints, decodeBoard, encodeBoardIntent, encodeBoardPayload, normalizeNote, simplifyStroke, splitStroke, strokePayloadSize,
} from "./kin-board.js";

const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const identity = { eventId: id(9), householdId: id(0xaa), actorId: id(1), deviceId: id(0x11), timestamp: 1_791_475_200_001, logicalTime: 1 };

test("a stroke payload matches the Rust layout byte for byte", () => {
  // The same stroke as rust/src/board_tests.rs: (100, 200) -> (103, 198).
  const payload = encodeBoardPayload({ type: "add-stroke", strokeId: id(7), colour: 2, width: 1, points: [[100, 200], [103, 198]] });
  assert.deepEqual([...payload], [...new Uint8Array(16).fill(7), 2, 1, 2, 0, 100, 0, 200, 0, 6, 3]);
  assert.equal(strokePayloadSize([[100, 200], [103, 198]]), payload.length);
});

test("every board command has a payload and a KCMD action from 52", () => {
  const commands = [
    { type: "add-stroke", strokeId: id(1), colour: 0, width: 0, points: [[0, 0]] },
    { type: "hide-stroke", strokeId: id(1), hidden: true },
    { type: "place-magnet", magnetId: id(2), x: 7, y: 8, content: { kind: "emoji", emoji: "🧲" } },
    { type: "move-magnet", magnetId: id(2), x: 1, y: 2 },
    { type: "hide-magnet", magnetId: id(2), hidden: false },
    { type: "clear-board", clearId: id(3) },
    { type: "undo-clear", clearId: id(3) },
  ];
  commands.forEach((command, index) => {
    assert.equal(command.type, BOARD_COMMANDS[index]);
    const packet = encodeBoardIntent(command, identity);
    const view = new DataView(packet.buffer);
    assert.equal(String.fromCharCode(...packet.subarray(0, 4)), "KCMD");
    assert.equal(view.getUint16(8, true), 52 + index);
    // No entity ID, date, option or expiry: the payload carries everything.
    assert.ok(packet.subarray(92, 124).every((byte) => byte === 0));
    assert.equal(view.getUint32(124, true), packet.length - 128);
  });
  assert.equal(BOARD_EVENT_KINDS.length, BOARD_COMMANDS.length);
});

test("magnets: emoji, Kin-drawn and canonical notes only", () => {
  const kin = encodeBoardPayload({ type: "place-magnet", magnetId: id(2), x: 10, y: 20, content: { kind: "kin", number: 12 } });
  assert.deepEqual([...kin.subarray(16)], [2, 12, 10, 0, 20, 0, 0, 0]);
  const note = encodeBoardPayload({ type: "place-magnet", magnetId: id(2), x: 0, y: 0, content: { kind: "note", text: "Milk please" } });
  assert.equal(new TextDecoder().decode(note.subarray(24)), "Milk please");
  for (const content of [{ kind: "kin", number: 0 }, { kind: "kin", number: 13 }, { kind: "note", text: " Milk" }, { kind: "note", text: "x".repeat(61) }, { kind: "bogus" }])
    assert.throws(() => encodeBoardPayload({ type: "place-magnet", magnetId: id(2), x: 0, y: 0, content }), /magnet/);
  assert.throws(() => encodeBoardPayload({ type: "move-magnet", magnetId: id(2), x: MAX_X + 1, y: 0 }), /position/);
  assert.throws(() => encodeBoardPayload({ type: "clear-board", clearId: "0".repeat(32) }), /clear/);
});

test("notes normalize like Rust", () => {
  assert.equal(normalizeNote("  Milk please "), "Milk please");
  for (const bad of ["", "   ", "a\nb", "é".repeat(61), 7]) assert.equal(normalizeNote(bad), null);
});

test("points are rounded, clamped and de-duplicated", () => {
  assert.deepEqual(boardPoints([[-3, 2.4], [-1, 2.6], [5000, 9000], [5000.2, 9000]]), [[0, 2], [0, 3], [MAX_X, MAX_Y]]);
});

test("simplifying keeps the ends and drops points within tolerance", () => {
  const line = Array.from({ length: 50 }, (_, index) => [index * 10, 100 + (index % 2)]);
  const simple = simplifyStroke(line, 2);
  assert.deepEqual(simple[0], line[0]);
  assert.deepEqual(simple.at(-1), line.at(-1));
  assert.ok(simple.length < 5);
  const corner = [[0, 0], [50, 0], [100, 0], [100, 50], [100, 100]];
  assert.deepEqual(simplifyStroke(corner, 2), [[0, 0], [100, 0], [100, 100]]);
});

test("long strokes split into pieces that each fit one event and join up", () => {
  // A zigzag with large deltas: 3 bytes per coordinate, so the byte limit binds first.
  const points = Array.from({ length: 3000 }, (_, index) => [index % 2 ? MAX_X : 0, index % 2 ? MAX_Y : 0]);
  const pieces = splitStroke(points);
  assert.ok(pieces.length > 1);
  for (const piece of pieces) {
    assert.ok(piece.length <= MAX_STROKE_POINTS);
    assert.ok(strokePayloadSize(piece) <= MAX_STROKE_PAYLOAD_BYTES);
  }
  for (let index = 1; index < pieces.length; index += 1) assert.deepEqual(pieces[index][0], pieces[index - 1].at(-1));
  assert.deepEqual(pieces.at(-1).at(-1), points.at(-1));
});

test("KBRD decodes strokes, magnets and the open clear", () => {
  const out = [..."KBRD"].map((c) => c.charCodeAt(0));
  out.push(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, ...new Array(16).fill(30));
  out.push(...new Array(16).fill(1), ...new Array(16).fill(0x22), 2, 1, 2, 0, 100, 0, 200, 0, 103, 0, 198, 0);
  const emoji = [...new TextEncoder().encode("🧲")];
  out.push(...new Array(16).fill(2), ...new Array(16).fill(0x33), 1, 0, 7, 0, 8, 0, emoji.length, 0, ...emoji);
  const board = decodeBoard(Uint8Array.from(out));
  assert.equal(board.openClear, id(30));
  assert.deepEqual([...board.strokes[0].points], [100, 200, 103, 198]);
  assert.equal(board.strokes[0].author, id(0x22));
  assert.deepEqual(board.magnets, [{ id: id(2), author: id(0x33), kind: "emoji", number: 0, x: 7, y: 8, text: "🧲" }]);
  assert.throws(() => decodeBoard(Uint8Array.from([...out, 0])), /invalid fridge/);
  assert.throws(() => decodeBoard(Uint8Array.from(out.slice(0, 40))), /invalid fridge/);
});
