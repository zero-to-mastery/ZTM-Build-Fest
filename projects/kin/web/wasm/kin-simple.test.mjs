// Simple view codecs (#344): the kind-64 payload and KCMD packet, KIEM and
// KMTQ/KMTD, matching rust/src/simple.rs.
import assert from "node:assert/strict";
import test from "node:test";
import {
  SimpleFormatError, decodeItemEmojis, decodeMyThings, encodeItemEmojiIntent, encodeItemEmojiPayload, encodeMyThingsQuery,
} from "./kin-simple.js";

const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const le16 = (value) => [value & 0xff, value >> 8];
const le32 = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
const bytes = (hex) => Array.from({ length: 16 }, () => Number.parseInt(hex.slice(0, 2), 16));

test("the emoji payload is the item, a flag word and the text", () => {
  const sock = new TextEncoder().encode("🧦");
  assert.deepEqual([...encodeItemEmojiPayload({ itemId: id(7), emoji: "🧦" })], [...bytes(id(7)), 1, 0, 0, 0, ...le16(sock.length), ...sock]);
  assert.deepEqual([...encodeItemEmojiPayload({ itemId: id(7), emoji: null })], [...bytes(id(7)), 0, 0, 0, 0]);
  assert.throws(() => encodeItemEmojiPayload({ itemId: id(0), emoji: "🧦" }), SimpleFormatError);
  assert.throws(() => encodeItemEmojiPayload({ itemId: id(7), emoji: "" }), SimpleFormatError);
  const packet = encodeItemEmojiIntent({ type: "set-item-emoji", itemId: id(7), emoji: "🧦" },
    { eventId: id(1), householdId: id(2), actorId: id(3), deviceId: id(4), timestamp: 1_791_475_200_000, logicalTime: 5n });
  assert.equal(String.fromCharCode(...packet.subarray(0, 4)), "KCMD");
  const view = new DataView(packet.buffer);
  assert.equal(view.getUint16(8, true), 64);
  assert.ok(packet.subarray(92, 124).every((byte) => byte === 0), "the entity, date, option and expiry stay zero");
  assert.equal(view.getUint32(124, true), packet.length - 128);
});

test("KIEM and KMTD decode strictly", () => {
  const text = new TextEncoder().encode("🎒");
  const kiem = Uint8Array.from([..."KIEM"].map((c) => c.charCodeAt(0)).concat([1, 0, 0, 0], le32(1), bytes(id(9)), le16(text.length), [...text]));
  assert.deepEqual(decodeItemEmojis(kiem), new Map([[id(9), "🎒"]]));
  assert.throws(() => decodeItemEmojis(Uint8Array.from([...kiem, 0])), SimpleFormatError, "trailing bytes");
  const kmtd = Uint8Array.from([..."KMTD"].map((c) => c.charCodeAt(0)).concat(
    [1, 0, 0, 0], le32(2),
    [1, 0, 0, 0], bytes(id(1)), le32(0),
    [2, 1, 0, 0], bytes(id(2)), le32(20261003),
  ));
  assert.deepEqual(decodeMyThings(kmtd), [
    { kind: "item", itemId: id(1) },
    { kind: "routine", routineId: id(2), occurrenceKey: 20261003, done: true },
  ]);
  const bad = kmtd.slice();
  bad[12] = 3;
  assert.throws(() => decodeMyThings(bad), SimpleFormatError, "unknown kind");
  const query = encodeMyThingsQuery(id(5));
  assert.equal(query.length, 24);
  assert.equal(String.fromCharCode(...query.subarray(0, 4)), "KMTQ");
  assert.throws(() => encodeMyThingsQuery(id(0)), SimpleFormatError);
});
