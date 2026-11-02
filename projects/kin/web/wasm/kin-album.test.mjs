// The family album codecs (#673): the kind-75 and kind-76 payloads, their
// KCMD packets and KALB, matching rust/src/album.rs (TEST-VECTORS 175 and
// 179).
import assert from "node:assert/strict";
import test from "node:test";
import {
  ALBUM_ATTACHMENT_PREFIX, AlbumFormatError, canRemoveAlbumPhoto, decodeAlbum, encodeAlbumIntent, encodeAlbumPayload,
  isAlbumAttachmentId, newAlbumAttachmentId, normalizeAlbumCaption,
} from "./kin-album.js";

const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const numbered = (n) => { const out = new Uint8Array(16); new DataView(out.buffer).setUint32(0, n, true); return out; };
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const attachment = (n) => { const out = new Uint8Array(16); out.set([0xa1, 0xb0]); new DataView(out.buffer).setUint32(2, n, true); return out; };
const text = (value) => { const encoded = new TextEncoder().encode(value); return [encoded.length & 0xff, encoded.length >> 8, ...encoded]; };
const magic = (value) => [...value].map((c) => c.charCodeAt(0));
const i64 = (value) => { const out = new Uint8Array(8); new DataView(out.buffer).setBigInt64(0, BigInt(value), true); return [...out]; };
const u32 = (value) => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value, true); return [...out]; };
const identity = { eventId: id(1), householdId: id(2), actorId: id(3), deviceId: id(4), timestamp: 1_791_475_200_000, logicalTime: 5n };
const BASE = 1_791_475_200_000;

test("album attachment IDs carry the a1b0 prefix", () => {
  assert.equal(ALBUM_ATTACHMENT_PREFIX, "a1b0");
  assert.equal(isAlbumAttachmentId(hex(attachment(1))), true);
  assert.equal(isAlbumAttachmentId("a1b0" + "0".repeat(28)), false, "the prefix alone");
  assert.equal(isAlbumAttachmentId(id(0x11)), false);
  assert.equal(isAlbumAttachmentId("A1B0" + "1".repeat(28)), false, "lower-case hex only");
  for (let n = 0; n < 20; n++) assert.equal(isAlbumAttachmentId(newAlbumAttachmentId()), true);
  assert.equal(newAlbumAttachmentId((bytes) => bytes), "a1b0" + "0".repeat(26) + "01", "never the bare prefix");
});

test("whoever added a photo, or an admin, may remove it", () => {
  const photo = { photoId: id(1), addedBy: id(0x0a) };
  assert.equal(canRemoveAlbumPhoto(photo, { memberId: id(0x0a) }), true, "who added it");
  assert.equal(canRemoveAlbumPhoto(photo, { memberId: id(0x0b) }), false, "someone else");
  assert.equal(canRemoveAlbumPhoto(photo, { memberId: id(0x0b), admin: true }), true, "an admin");
  assert.equal(canRemoveAlbumPhoto(photo, { memberId: null, local: true }), true, "a household that doesn't sync");
  assert.equal(canRemoveAlbumPhoto(photo, { memberId: null }), false, "a member not known yet");
  assert.equal(canRemoveAlbumPhoto(null, { admin: true }), false, "no photo");
  assert.equal(canRemoveAlbumPhoto(photo, { memberId: id(0x0b), admin: "yes" }), false, "only true is an admin");
});

test("a caption is trimmed as Rust trims it, made one line and bounded to 200 bytes", () => {
  assert.equal(normalizeAlbumCaption("  Grandma's 80th　"), "Grandma's 80th");
  assert.equal(normalizeAlbumCaption("Beach\r\nday"), "Beach day");
  assert.equal(normalizeAlbumCaption(null), "");
  assert.equal(normalizeAlbumCaption("é".repeat(100)), "é".repeat(100), "200 bytes");
  assert.throws(() => normalizeAlbumCaption("é".repeat(100) + "x"), AlbumFormatError, "201 bytes");
  assert.throws(() => normalizeAlbumCaption("a\tb"), AlbumFormatError);
  assert.throws(() => normalizeAlbumCaption("a\u0085b"), AlbumFormatError);
});

// 175
test("payloads match the Rust vectors", () => {
  const add = encodeAlbumPayload({ type: "add-album-photo", photoId: hex(numbered(1)), attachmentId: hex(attachment(1)), caption: " Grandma's 80th " });
  assert.deepEqual([...add], [...numbered(1), ...attachment(1), ...text("Grandma's 80th")]);
  assert.equal(add.length, 48);
  const bare = encodeAlbumPayload({ type: "add-album-photo", photoId: hex(numbered(2)), attachmentId: hex(attachment(2)), caption: "" });
  assert.equal(bare.length, 34);
  assert.deepEqual([...encodeAlbumPayload({ type: "remove-album-photo", photoId: hex(numbered(1)) })], [...numbered(1)]);
  for (const bad of [
    { type: "add-album-photo", photoId: hex(numbered(1)), attachmentId: id(0x22), caption: "" },
    { type: "add-album-photo", photoId: "0".repeat(32), attachmentId: hex(attachment(1)), caption: "" },
    { type: "add-album-photo", photoId: hex(numbered(1)), attachmentId: hex(attachment(1)), caption: "x".repeat(201) },
    { type: "remove-album-photo", photoId: "nope" },
    { type: "something-else" },
  ]) assert.throws(() => encodeAlbumPayload(bad), AlbumFormatError, JSON.stringify(bad));
});

// 179 (KCMD)
test("album commands travel as KCMD 75 and 76 through the engine's encoder", () => {
  const packet = encodeAlbumIntent({ type: "add-album-photo", photoId: hex(numbered(1)), attachmentId: hex(attachment(1)), caption: "Beach" }, identity);
  const view = new DataView(packet.buffer);
  assert.equal(String.fromCharCode(...packet.subarray(0, 4)), "KCMD");
  assert.equal(view.getUint16(8, true), 75);
  assert.ok(packet.subarray(92, 124).every((byte) => byte === 0), "no entity, date, option or expiry");
  assert.equal(view.getUint32(124, true), 34 + 5);
  assert.deepEqual([...packet.subarray(128)], [...numbered(1), ...attachment(1), ...text("Beach")]);
  const removal = encodeAlbumIntent({ type: "remove-album-photo", photoId: hex(numbered(1)) }, identity);
  assert.equal(new DataView(removal.buffer).getUint16(8, true), 76);
  assert.deepEqual([...removal.subarray(128)], [...numbered(1)]);

});

// 179 (KALB)
test("KALB decodes newest first, with the recent removals", () => {
  const kalb = Uint8Array.from([
    ...magic("KALB"), 1, 0, 0, 0, ...u32(2), ...u32(1),
    ...numbered(3), ...attachment(3), ...id(1).match(/../g).map((pair) => Number.parseInt(pair, 16)), ...i64(BASE + 1003), ...text("Zoo"),
    ...numbered(2), ...attachment(2), ...new Uint8Array(16).fill(2), ...i64(BASE + 1002), 0, 0,
    ...numbered(1), ...attachment(1), ...i64(BASE + 1004),
  ]);
  assert.deepEqual(decodeAlbum(kalb), {
    photos: [
      { photoId: hex(numbered(3)), attachmentId: hex(attachment(3)), addedBy: id(1), addedAt: BASE + 1003, caption: "Zoo" },
      { photoId: hex(numbered(2)), attachmentId: hex(attachment(2)), addedBy: id(2), addedAt: BASE + 1002, caption: "" },
    ],
    removed: [{ photoId: hex(numbered(1)), attachmentId: hex(attachment(1)), removedAt: BASE + 1004 }],
  });
  assert.deepEqual(decodeAlbum(Uint8Array.from([...magic("KALB"), 1, 0, 0, 0, ...u32(0), ...u32(0)])), { photos: [], removed: [] });
  const broken = [
    kalb.slice(0, -1),
    Uint8Array.of(...kalb, 0),
    (() => { const copy = kalb.slice(); copy[4] = 2; return copy; })(),
    (() => { const copy = kalb.slice(); copy[16 + 16] = 0x00; return copy; })(),
    (() => { const copy = kalb.slice(); copy.set(u32(501), 8); return copy; })(),
    (() => { const copy = kalb.slice(); copy.set(u32(65), 12); return copy; })(),
  ];
  for (const bytes of broken) assert.throws(() => decodeAlbum(bytes), AlbumFormatError);
});
