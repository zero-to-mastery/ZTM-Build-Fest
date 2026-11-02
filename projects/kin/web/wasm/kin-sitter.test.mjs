// The sitter page codecs (#442): the kind-70 payload, its KCMD packet and
// KSIT, matching rust/src/sitter.rs (TEST-VECTORS 060, 063 and 064).
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SITTER_ENTRIES, SitterFormatError, canChangeSitterPage, decodeSitterPage, encodeSitterIntent,
  encodeSitterPagePayload, normalizeSitterIntro,
} from "./kin-sitter.js";

const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const bytes = (hex) => Array.from({ length: 16 }, () => Number.parseInt(hex.slice(0, 2), 16));
const text = (value) => { const encoded = new TextEncoder().encode(value); return [encoded.length & 0xff, encoded.length >> 8, ...encoded]; };
const magic = (value) => [...value].map((c) => c.charCodeAt(0));
const identity = { eventId: id(1), householdId: id(2), actorId: id(3), deviceId: id(4), timestamp: 1_791_475_200_000, logicalTime: 5n };

test("only Adults may change the page", () => {
  assert.equal(canChangeSitterPage("adult"), true);
  for (const kind of ["limited", "temporary", null, undefined, "Adult"]) assert.equal(canChangeSitterPage(kind), false, String(kind));
});

test("the intro is trimmed as Rust trims it, keeps newlines and is bounded to 500 bytes", () => {
  assert.equal(normalizeSitterIntro("  Bed by 8.\r\nThanks!　"), "Bed by 8.\nThanks!");
  assert.equal(normalizeSitterIntro("\n\nHi\n"), "Hi");
  assert.equal(normalizeSitterIntro(null), "");
  assert.equal(normalizeSitterIntro("é".repeat(250)), "é".repeat(250), "500 bytes");
  assert.throws(() => normalizeSitterIntro("é".repeat(250) + "x"), SitterFormatError, "501 bytes");
  assert.throws(() => normalizeSitterIntro("a\tb"), SitterFormatError);
  assert.throws(() => normalizeSitterIntro("a\u0007b"), SitterFormatError);
  assert.throws(() => normalizeSitterIntro("a\u0085b"), SitterFormatError, "NEL inside is a control");
});

test("the payload is the count, each entry, then the intro (060)", () => {
  assert.deepEqual([...encodeSitterPagePayload({ intro: "", entries: [] })], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    [...encodeSitterPagePayload({ intro: " Bed by 8.\nThanks! ", entries: [
      { kind: "note", id: id(1) }, { kind: "reference-record", id: id(2) }, { kind: "routine", id: id(3) },
    ] })],
    [3, 0, 0, 0, 1, 0, 0, 0, ...bytes(id(1)), 2, 0, 0, 0, ...bytes(id(2)), 3, 0, 0, 0, ...bytes(id(3)), ...text("Bed by 8.\nThanks!")],
  );
  const many = Array.from({ length: MAX_SITTER_ENTRIES + 1 }, (_, n) => ({ kind: "note", id: id(n + 1) }));
  assert.throws(() => encodeSitterPagePayload({ entries: many }), SitterFormatError);
  assert.doesNotThrow(() => encodeSitterPagePayload({ entries: many.slice(1) }));
  for (const entry of [{ kind: "item", id: id(1) }, { kind: "toString", id: id(1) }, { kind: "note", id: id(0) }, { kind: "note", id: "nope" }, null])
    assert.throws(() => encodeSitterPagePayload({ entries: [entry] }), SitterFormatError, JSON.stringify(entry));
  assert.throws(() => encodeSitterPagePayload({}), SitterFormatError);
});

test("the command is KCMD 70 with the payload as text (063)", () => {
  const packet = encodeSitterIntent({ type: "set-sitter-page", intro: "Hi", entries: [{ kind: "routine", id: id(3) }] }, identity);
  const view = new DataView(packet.buffer);
  assert.equal(String.fromCharCode(...packet.subarray(0, 4)), "KCMD");
  assert.equal(view.getUint16(8, true), 70);
  assert.ok(packet.subarray(92, 124).every((byte) => byte === 0), "no entity, date, option or expiry");
  assert.equal(view.getUint32(124, true), packet.length - 128);
  assert.deepEqual([...packet.subarray(128)], [1, 0, 0, 0, 3, 0, 0, 0, ...bytes(id(3)), ...text("Hi")]);
  assert.throws(() => encodeSitterIntent({ type: "set-item-emoji" }, identity), SitterFormatError);
});

test("KSIT decodes strictly (064)", () => {
  const ksit = Uint8Array.from([
    ...magic("KSIT"), 1, 0, 0, 0,
    3, 0, 0, 0,
    3, 0, 0, 0, ...bytes(id(3)),
    2, 0, 0, 0, ...bytes(id(2)),
    1, 0, 0, 0, ...bytes(id(1)),
    ...text("Hi"),
  ]);
  assert.deepEqual(decodeSitterPage(ksit), {
    intro: "Hi",
    entries: [{ kind: "routine", id: id(3) }, { kind: "reference-record", id: id(2) }, { kind: "note", id: id(1) }],
  });
  const empty = Uint8Array.from([...magic("KSIT"), 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(decodeSitterPage(empty), { intro: "", entries: [] });
  const broken = (mutate, why) => {
    const copy = ksit.slice();
    mutate(copy);
    assert.throws(() => decodeSitterPage(copy), SitterFormatError, why);
  };
  assert.throws(() => decodeSitterPage(Uint8Array.from([...ksit, 0])), SitterFormatError, "trailing bytes");
  assert.throws(() => decodeSitterPage(ksit.subarray(0, ksit.length - 1)), SitterFormatError, "truncated");
  assert.throws(() => decodeSitterPage(ksit.subarray(0, 13)), SitterFormatError, "short header");
  broken((b) => { b[0] = 0x58; }, "magic");
  broken((b) => { b[4] = 2; }, "version");
  broken((b) => { b[6] = 1; }, "reserved");
  broken((b) => { b[8] = 4; }, "count disagrees");
  broken((b) => { b[12] = 4; }, "unknown kind");
  broken((b) => { b[13] = 1; }, "entry reserved");
  broken((b) => { b.fill(0, 16, 32); }, "zero ID");
  broken((b) => { b.set(b.subarray(12, 32), 32); }, "an entry twice");
  broken((b) => { b[b.length - 1] = 0xff; }, "invalid UTF-8");
});
