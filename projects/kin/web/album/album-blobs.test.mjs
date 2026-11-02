// The family album's images (#673): which blobs every device keeps, adding a
// photo before a household key exists, and the sync pass that uploads,
// re-encrypts and deletes, with in-memory stand-ins for the album store, the
// event store and the service.
import assert from "node:assert/strict";
import test from "node:test";
import { ALBUM_UNDO_GRACE_MS, albumKeep, captureAlbumPhoto, openAlbumPhoto, reconcileAlbum, withinUndoGrace } from "./album-blobs.js";
import { encryptAttachment } from "../attachments/attachment-crypto.js";

const NOW = 1_791_475_200_000;
const id = (n) => `a1b0${n.toString(16).padStart(28, "0")}`;
const photo = (n) => ({ photoId: n.toString(16).padStart(32, "0"), attachmentId: id(n), addedBy: "0a".repeat(16), addedAt: NOW - 5_000, caption: "" });

class MemoryAlbumStore {
  constructor() { this.rows = new Map(); }
  async get(attachmentId) { const row = this.rows.get(attachmentId); return row ? { ...row } : null; }
  async inventory() { return [...this.rows.values()].map((row) => ({ attachmentId: row.attachmentId, state: row.state, storedAt: 0, sealed: !row.ciphertext })); }
  async put(row) { this.rows.set(row.attachmentId, { ciphertext: null, sealed: null, keyEpoch: null, digest: null, ...row }); }
  async setState(attachmentId, state) { const row = this.rows.get(attachmentId); if (row) row.state = state; return Boolean(row); }
  async delete(attachmentId) { this.rows.delete(attachmentId); }
}

function service(listed = []) {
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push([options.method ?? "GET", path]);
    if (path === "/api/sync/attachments?album=1") return { ok: true, json: async () => ({ attachments: listed }) };
    return { ok: true, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

test("every device keeps live photos and those removed within the Undo grace", () => {
  const album = {
    photos: [photo(1)],
    removed: [{ photoId: "02".repeat(16), attachmentId: id(2), removedAt: NOW - 1_000 }, { photoId: "03".repeat(16), attachmentId: id(3), removedAt: NOW - ALBUM_UNDO_GRACE_MS }],
  };
  assert.deepEqual([...albumKeep(album, NOW)].sort(), [id(1), id(2)]);
  assert.equal(withinUndoGrace(album, id(2), NOW), true);
  assert.equal(withinUndoGrace(album, id(3), NOW), false, "an hour later it is gone");
  assert.deepEqual([...albumKeep(null, NOW)], []);
});

test("a photo added before the household has a key is sealed on this device, then its event appended", async () => {
  const albumStore = new MemoryAlbumStore();
  const appended = [];
  const sealedWith = [];
  const store = { async sealAttachmentData(attachmentId, data) { sealedWith.push([attachmentId, data.parentKind, data.parentId, data.type]); return { sealed: true }; } };
  const image = new File([new Uint8Array([1, 2, 3])], "beach.jpg", { type: "image/jpeg" });
  const result = await captureAlbumPhoto({
    file: image, caption: "Beach", identity: null, store, keyStore: null, albumStore,
    append: async (command) => { appended.push(command); }, prepare: async (file) => file,
  });
  assert.match(result.attachmentId, /^a1b0[a-f0-9]{28}$/);
  assert.match(result.photoId, /^[a-f0-9]{32}$/);
  assert.deepEqual(sealedWith, [[result.attachmentId, "album", result.attachmentId, "image/jpeg"]]);
  assert.deepEqual(appended, [{ type: "add-album-photo", photoId: result.photoId, attachmentId: result.attachmentId, caption: "Beach" }]);
  assert.equal(albumStore.rows.get(result.attachmentId).state, "queued");
});

test("a photo that can't be prepared adds nothing", async () => {
  const albumStore = new MemoryAlbumStore();
  const appended = [];
  await assert.rejects(captureAlbumPhoto({
    file: new File(["x"], "notes.txt", { type: "text/plain" }), identity: null, store: {}, albumStore,
    append: async (command) => { appended.push(command); },
    prepare: async () => { throw Object.assign(new Error("no"), { userMessage: "Choose a JPEG, PNG or WebP photo." }); },
  }), (error) => error.userMessage === "Choose a JPEG, PNG or WebP photo.");
  assert.equal(appended.length, 0);
  assert.equal(albumStore.rows.size, 0);
});

test("a sync pass uploads queued live photos once and leaves synced ones alone", async () => {
  const householdKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const householdId = "aa".repeat(16);
  const encrypted = await encryptAttachment(new File([new Uint8Array([9, 9, 9])], "a.jpg", { type: "image/jpeg" }), { householdId, attachmentId: id(1), keyEpoch: 1, householdKey, parentKind: "album", parentId: id(1) });
  const albumStore = new MemoryAlbumStore();
  await albumStore.put({ attachmentId: id(1), ciphertext: encrypted.ciphertext, keyEpoch: 1, digest: encrypted.digest, state: "queued" });
  await albumStore.put({ attachmentId: id(2), ciphertext: encrypted.ciphertext, keyEpoch: 1, digest: encrypted.digest, state: "synced" });
  const { calls, fetchImpl } = service([]);
  const album = { photos: [photo(1), photo(2)], removed: [] };
  const result = await reconcileAlbum({ album, identity: { householdId }, store: {}, keyStore: null, albumStore, now: NOW, fetchImpl });
  assert.equal(result.available, true);
  assert.deepEqual(calls, [["GET", "/api/sync/attachments?album=1"], ["POST", `/api/sync/attachments/${id(1)}`]]);
  assert.equal(albumStore.rows.get(id(1)).state, "synced");

  // Opening it decrypts what this device keeps.
  const keyStore = { getEpoch: async () => ({ householdKey }) };
  const opened = await openAlbumPhoto({ photo: photo(1), identity: { householdId }, store: {}, keyStore, albumStore });
  assert.deepEqual([...new Uint8Array(await opened.blob.arrayBuffer())], [9, 9, 9]);
});

test("unneeded blobs go on the second pass that still finds them unneeded", async () => {
  const albumStore = new MemoryAlbumStore();
  await albumStore.put({ attachmentId: id(5), sealed: { s: 1 }, state: "synced" });
  await albumStore.put({ attachmentId: id(6), sealed: { s: 1 }, state: "synced" });
  const listed = [{ attachmentId: id(5) }, { attachmentId: id(7) }, { attachmentId: "c".repeat(32) }];
  const album = { photos: [], removed: [{ photoId: "06".repeat(16), attachmentId: id(6), removedAt: NOW - 60_000 }] };
  const suspected = new Set();
  const first = service(listed);
  await reconcileAlbum({ album, store: {}, albumStore, suspected, now: NOW, fetchImpl: first.fetchImpl });
  assert.deepEqual(first.calls, [["GET", "/api/sync/attachments?album=1"]], "nothing is deleted on the first pass");
  assert.equal(albumStore.rows.size, 2);
  const second = service(listed);
  await reconcileAlbum({ album, store: {}, albumStore, suspected, now: NOW, fetchImpl: second.fetchImpl });
  assert.deepEqual(second.calls.slice(1).sort(), [["DELETE", `/api/sync/attachments/${id(5)}`], ["DELETE", `/api/sync/attachments/${id(7)}`]]);
  assert.deepEqual([...albumStore.rows.keys()], [id(6)], "the photo removed a minute ago is kept for Undo; other attachments are never touched");
  // After the grace, it goes too.
  const later = NOW + ALBUM_UNDO_GRACE_MS;
  await reconcileAlbum({ album, store: {}, albumStore, suspected, now: later, fetchImpl: service([]).fetchImpl });
  await reconcileAlbum({ album, store: {}, albumStore, suspected, now: later, fetchImpl: service([]).fetchImpl });
  assert.equal(albumStore.rows.size, 0);
});

test("a photo that becomes live between passes is not deleted", async () => {
  const albumStore = new MemoryAlbumStore();
  await albumStore.put({ attachmentId: id(8), sealed: { s: 1 }, state: "local" });
  const suspected = new Set();
  await reconcileAlbum({ album: { photos: [], removed: [] }, store: {}, albumStore, suspected, now: NOW, fetchImpl: service([]).fetchImpl });
  await reconcileAlbum({ album: { photos: [photo(8)], removed: [] }, store: { openAttachmentData: async () => { throw new Error("locked"); } }, albumStore, suspected, now: NOW, fetchImpl: service([]).fetchImpl });
  assert.equal(albumStore.rows.has(id(8)), true);
  assert.equal(suspected.size, 0);
});

test("offline, nothing on the service is touched and nothing fails", async () => {
  const albumStore = new MemoryAlbumStore();
  const fetchImpl = async () => { throw new TypeError("offline"); };
  const result = await reconcileAlbum({ album: { photos: [photo(1)], removed: [] }, store: {}, albumStore, now: NOW, fetchImpl });
  assert.equal(result.available, false);
  assert.deepEqual(await reconcileAlbum({ album: null, albumStore }), { available: false });
});
