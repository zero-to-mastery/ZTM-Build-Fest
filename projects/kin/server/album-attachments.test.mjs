// The family album (#673, ADR 0022 §5): album photos are ordinary encrypted
// household attachments whose IDs start with "a1b0". They have a quota of
// their own (600 blobs, 400 MiB) beside the 64 other attachments, and the
// listing leaves them out unless the device asks for them, so an older
// device never reconciles them away as orphans. In memory and durable.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DurableStore, MAX_HOUSEHOLD_ALBUM_ATTACHMENTS, MAX_HOUSEHOLD_ALBUM_BYTES, MAX_HOUSEHOLD_ATTACHMENTS, isAlbumAttachmentId,
} from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const albumId = (n) => `a1b0${n.toString(16).padStart(28, "0")}`;
const otherId = (n) => n.toString(16).padStart(32, "0");

function household({ durable }) {
  const store = durable ? new DurableStore(":memory:") : null;
  const pairing = new PairingService({ store });
  const founder = pairing.bootstrap({ credential: credential("founder"), deviceLabel: "Founder" });
  const sync = new EncryptedSyncService(pairing, { store });
  sync.enable(founder.sessionToken);
  // Hundreds of uploads in a row: a second per request keeps the relay's
  // per-device rate limit (256 a minute) out of the way.
  let clock = Date.now();
  sync.now = () => (clock += 1_000);
  const push = (attachmentId, size = 64) => {
    const ciphertext = Buffer.alloc(size, attachmentId.charCodeAt(31));
    return sync.pushAttachment(founder.sessionToken, { attachmentId, keyEpoch: 1, ciphertext, digest: createHash("sha256").update(ciphertext).digest("hex") });
  };
  return { sync, founder, push, close: () => store?.close() };
}

test("album attachment IDs are recognised by their prefix", () => {
  assert.equal(isAlbumAttachmentId(albumId(1)), true);
  assert.equal(isAlbumAttachmentId(otherId(1)), false);
  assert.equal(isAlbumAttachmentId(null), false);
  assert.equal(MAX_HOUSEHOLD_ALBUM_ATTACHMENTS, 600);
  assert.equal(MAX_HOUSEHOLD_ALBUM_BYTES, 400 * 1024 * 1024);
});

for (const durable of [false, true]) {
  const label = durable ? "durable" : "in-memory";

  test(`${label}: album photos are listed only to devices that ask for them`, () => {
    const h = household({ durable });
    try {
      h.push(albumId(1));
      h.push(otherId(2));
      const ids = (options) => h.sync.listAttachments(h.founder.sessionToken, options).map((row) => row.attachmentId).sort();
      assert.deepEqual(ids(), [otherId(2)], "an older device sees no album photo");
      assert.deepEqual(ids({ album: false }), [otherId(2)]);
      assert.deepEqual(ids({ album: true }), [otherId(2), albumId(1)].sort());
      // Reading and deleting by ID work as for any attachment.
      assert.equal(h.sync.getAttachment(h.founder.sessionToken, albumId(1)).size, 64);
      assert.deepEqual(h.sync.removeAttachment(h.founder.sessionToken, albumId(1)), { removed: true });
      assert.deepEqual(ids({ album: true }), [otherId(2)]);
    } finally { h.close(); }
  });

  test(`${label}: the album and other attachments each have their own quota`, () => {
    const h = household({ durable });
    try {
      for (let n = 1; n <= MAX_HOUSEHOLD_ATTACHMENTS; n++) h.push(otherId(n));
      assert.throws(() => h.push(otherId(MAX_HOUSEHOLD_ATTACHMENTS + 1)), (error) => error.code === "attachment_limit");
      // A full set of other attachments leaves the album room.
      for (let n = 1; n <= MAX_HOUSEHOLD_ALBUM_ATTACHMENTS; n++) assert.equal(h.push(albumId(n), 29).accepted, true);
      assert.throws(() => h.push(albumId(MAX_HOUSEHOLD_ALBUM_ATTACHMENTS + 1), 29),
        (error) => error.code === "attachment_limit" && /family photos/.test(error.message));
      assert.equal(h.sync.listAttachments(h.founder.sessionToken, { album: true }).length, MAX_HOUSEHOLD_ATTACHMENTS + MAX_HOUSEHOLD_ALBUM_ATTACHMENTS);
      assert.equal(h.sync.listAttachments(h.founder.sessionToken).length, MAX_HOUSEHOLD_ATTACHMENTS);
    } finally { h.close(); }
  });
}
