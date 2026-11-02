// Store sections codecs (#411): the kind-66 and kind-67 payloads, their KCMD
// packets and KSHS, matching rust/src/store_sections.rs.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SECTIONS, SectionFormatError, decodeShoppingSections, encodeItemSectionPayload, encodeSectionIntent,
  encodeShoppingSectionsPayload, normalizeSectionName,
} from "./kin-sections.js";

const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const bytes = (hex) => Array.from({ length: 16 }, () => Number.parseInt(hex.slice(0, 2), 16));
const text = (value) => { const encoded = new TextEncoder().encode(value); return [encoded.length, 0, ...encoded]; };
const magic = (value) => [...value].map((c) => c.charCodeAt(0));
const identity = { eventId: id(1), householdId: id(2), actorId: id(3), deviceId: id(4), timestamp: 1_791_475_200_000, logicalTime: 5n };

test("names are trimmed as Rust trims them and bounded to 40 bytes", () => {
  assert.equal(normalizeSectionName("  Dairy & eggs　"), "Dairy & eggs");
  assert.equal(normalizeSectionName("\u0085Bakery "), "Bakery");
  assert.equal(normalizeSectionName("é".repeat(20)), "é".repeat(20), "40 bytes");
  assert.throws(() => normalizeSectionName("é".repeat(20) + "x"), SectionFormatError, "41 bytes");
  assert.throws(() => normalizeSectionName(" \t "), SectionFormatError);
  assert.throws(() => normalizeSectionName("a\u0007b"), SectionFormatError);
  // U+FEFF isn't White_Space for Rust, so it stays.
  assert.equal(normalizeSectionName("﻿X"), "﻿X");
});

test("the list payload is the count, then each ID and name", () => {
  assert.deepEqual([...encodeShoppingSectionsPayload({ sections: [] })], [0, 0, 0, 0]);
  assert.deepEqual(
    [...encodeShoppingSectionsPayload({ sections: [{ sectionId: id(1), name: " Produce" }, { sectionId: id(2), name: "Dairy" }] })],
    [2, 0, 0, 0, ...bytes(id(1)), ...text("Produce"), ...bytes(id(2)), ...text("Dairy")],
  );
  const many = Array.from({ length: MAX_SECTIONS + 1 }, (_, n) => ({ sectionId: id(n + 1), name: `S${n}` }));
  assert.throws(() => encodeShoppingSectionsPayload({ sections: many }), SectionFormatError);
  assert.doesNotThrow(() => encodeShoppingSectionsPayload({ sections: many.slice(1) }));
  assert.throws(() => encodeShoppingSectionsPayload({ sections: [{ sectionId: id(0), name: "Dairy" }] }), SectionFormatError);
  assert.throws(() => encodeShoppingSectionsPayload({}), SectionFormatError);
});

test("the item payload is two IDs, zero clearing", () => {
  assert.deepEqual([...encodeItemSectionPayload({ itemId: id(7), sectionId: id(2) })], [...bytes(id(7)), ...bytes(id(2))]);
  assert.deepEqual([...encodeItemSectionPayload({ itemId: id(7), sectionId: null })], [...bytes(id(7)), ...new Array(16).fill(0)]);
  assert.throws(() => encodeItemSectionPayload({ itemId: id(0), sectionId: null }), SectionFormatError);
  assert.throws(() => encodeItemSectionPayload({ itemId: id(7), sectionId: "nope" }), SectionFormatError);
});

test("commands are KCMD 66 and 67 with the payload as text", () => {
  for (const [command, kind] of [
    [{ type: "set-shopping-sections", sections: [{ sectionId: id(1), name: "Produce" }] }, 66],
    [{ type: "set-item-section", itemId: id(7), sectionId: id(1) }, 67],
  ]) {
    const packet = encodeSectionIntent(command, identity);
    const view = new DataView(packet.buffer);
    assert.equal(String.fromCharCode(...packet.subarray(0, 4)), "KCMD");
    assert.equal(view.getUint16(8, true), kind);
    assert.ok(packet.subarray(92, 124).every((byte) => byte === 0));
    assert.equal(view.getUint32(124, true), packet.length - 128);
  }
  assert.throws(() => encodeSectionIntent({ type: "set-item-emoji" }, identity), SectionFormatError);
});

test("KSHS decodes strictly", () => {
  const kshs = Uint8Array.from([
    ...magic("KSHS"), 1, 0, 0, 0,
    1, 0, 0, 0, ...bytes(id(2)), ...text("Dairy"),
    1, 0, 0, 0, ...bytes(id(9)), ...bytes(id(2)),
  ]);
  assert.deepEqual(decodeShoppingSections(kshs), {
    sections: [{ sectionId: id(2), name: "Dairy" }],
    itemSections: new Map([[id(9), id(2)]]),
  });
  const empty = Uint8Array.from([...magic("KSHS"), 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(decodeShoppingSections(empty), { sections: [], itemSections: new Map() });
  assert.throws(() => decodeShoppingSections(Uint8Array.from([...kshs, 0])), SectionFormatError, "trailing bytes");
  assert.throws(() => decodeShoppingSections(kshs.subarray(0, kshs.length - 1)), SectionFormatError, "truncated");
  const reserved = kshs.slice();
  reserved[6] = 1;
  assert.throws(() => decodeShoppingSections(reserved), SectionFormatError, "reserved");
  const unlisted = kshs.slice();
  unlisted.fill(0x33, kshs.length - 16);
  assert.throws(() => decodeShoppingSections(unlisted), SectionFormatError, "an item's section is listed");
});
