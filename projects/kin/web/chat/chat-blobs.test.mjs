// Chat content blobs on the device (#110): sealing, the service client, the
// local store with its tombstones, and deletion reaching an offline device.
import assert from "node:assert/strict";
import test from "node:test";
import { createKinServer } from "../../server/server.mjs";
import { ChatBlobClient } from "./chat-blob-client.js";
import { blobRef, ChatBlobError, MIN_CHAT_BLOB_BYTES, openChatBlob, openChatText, sealChatBlob, sealChatText } from "./chat-blob-crypto.js";
import { ChatBlobStore, chatBlobDatabaseName } from "./chat-blob-store.js";
import { ChatBlobs } from "./chat-blobs.js";
import { fakeIndexedDB } from "./fake-indexeddb.test-support.mjs";

const HOUSEHOLD = "aa".repeat(16);
const unopenable = (error) => error instanceof ChatBlobError && error.code === "chat_blob_invalid";

test("a message seals under its own key and opens only with that key and blob", async () => {
  const sealed = await sealChatText("Dinner at 6 🍝");
  assert.equal(sealed.key.length, 32);
  assert.equal(sealed.ciphertext[0], 1, "format 1");
  assert.equal(sealed.ref, await blobRef(sealed.ciphertext));
  assert.equal(await openChatText(sealed.ciphertext, sealed), "Dinner at 6 🍝");
  const again = await sealChatText("Dinner at 6 🍝");
  assert.notEqual(again.ref, sealed.ref, "a fresh key and nonce every time");
  assert.notDeepEqual(again.key, sealed.key);
  const tampered = sealed.ciphertext.slice();
  tampered[20] ^= 1;
  const otherVersion = sealed.ciphertext.slice();
  otherVersion[0] = 2;
  for (const [bytes, keys] of [
    [tampered, sealed],
    [tampered, { ...sealed, ref: await blobRef(tampered) }],
    [sealed.ciphertext, { ...sealed, key: again.key }],
    [sealed.ciphertext, { ...sealed, ref: again.ref }],
    [sealed.ciphertext, { ...sealed, key: new Uint8Array(32) }],
    [otherVersion, { ...sealed, ref: await blobRef(otherVersion) }],
    [sealed.ciphertext.subarray(0, MIN_CHAT_BLOB_BYTES - 1), sealed],
  ])
    await assert.rejects(openChatBlob(bytes, keys), unopenable);
  await assert.rejects(sealChatText("lone \ud800"), ChatBlobError);
  await assert.rejects(sealChatBlob(new Uint8Array()), ChatBlobError);
});

test("the local store keeps blobs by reference and never takes back a deleted one", async () => {
  const indexedDB = fakeIndexedDB();
  const store = await ChatBlobStore.open(HOUSEHOLD, { indexedDB, now: () => 5 });
  const first = await sealChatText("one"), second = await sealChatText("two");
  assert.equal(await store.put(first.ref, first.ciphertext), true);
  await store.put(second.ref, second.ciphertext);
  assert.deepEqual(await store.get(first.ref), first.ciphertext);
  assert.equal(await store.retire([first.ref, first.ref, "not a ref"]), 1);
  assert.equal(await store.get(first.ref), null);
  assert.equal(await store.isRetired(first.ref), true);
  assert.equal(await store.put(first.ref, first.ciphertext), false, "a deleted blob is never kept again");
  assert.equal(await store.get(first.ref), null);
  // The bytes are gone, not hidden: only the tombstone remains.
  const db = indexedDB.databases.get(chatBlobDatabaseName(HOUSEHOLD));
  assert.equal(db.stores.get("blobs").has(first.ref), false);
  assert.deepEqual(db.stores.get("retired").get(first.ref), { ref: first.ref, retiredAt: 5 });
  await store.destroy();
  assert.equal(indexedDB.databases.size, 0, "removing the household deletes the database");
  await assert.rejects(ChatBlobStore.open("nope", { indexedDB }), ChatBlobError);
  await assert.rejects(ChatBlobStore.open(HOUSEHOLD, { indexedDB: null }), ChatBlobError);
});

/** A fake service: a map of blobs, deleted refs, and a switch for being offline. */
function fakeService() {
  const blobs = new Map(), deleted = new Set();
  const state = { offline: false, calls: [] };
  const reply = (status, body) => new Response(body instanceof Uint8Array ? body : JSON.stringify(body), { status });
  const fetch = async (path, init) => {
    state.calls.push([init.method, path]);
    if (state.offline) throw new TypeError("network down");
    const ref = path.split("/").pop();
    if (init.method === "PUT") { blobs.set(ref, new Uint8Array(init.body)); return reply(200, { accepted: true, size: init.body.length }); }
    if (init.method === "GET") {
      if (deleted.has(ref)) return reply(410, { error: "chat_blob_deleted", message: "This message was deleted." });
      return blobs.has(ref) ? reply(200, blobs.get(ref)) : reply(404, { error: "chat_blob_missing" });
    }
    for (const retired of JSON.parse(init.body).refs) { blobs.delete(retired); deleted.add(retired); }
    return reply(200, { retired: 1 });
  };
  return { blobs, deleted, state, client: new ChatBlobClient({ fetch }) };
}

test("a message's content is fetched on demand, kept, and shows as deleted once deleted", async () => {
  const service = fakeService();
  const author = new ChatBlobs({ store: await ChatBlobStore.open(HOUSEHOLD, { indexedDB: fakeIndexedDB() }), client: service.client });
  const reader = new ChatBlobs({ store: await ChatBlobStore.open(HOUSEHOLD, { indexedDB: fakeIndexedDB() }), client: service.client });
  const message = await author.seal("Pick up milk");
  assert.deepEqual(await reader.openText(message), { pending: true }, "not uploaded yet");
  assert.deepEqual(await author.upload(message.ref), { uploaded: true });
  assert.deepEqual(await reader.openText(message), { text: "Pick up milk" });
  service.state.offline = true;
  assert.deepEqual(await reader.openText(message), { text: "Pick up milk" }, "kept locally after the first fetch");
  service.state.offline = false;
  // A blob deleted on the service shows as a deleted message, not an error.
  const other = await author.seal("Never mind");
  await author.upload(other.ref);
  service.deleted.add(other.ref);
  assert.deepEqual(await reader.openText(other), { deleted: true });
  assert.equal(await reader.store.isRetired(other.ref), true);
  // A tampered blob from the service is refused and not kept.
  const third = await author.seal("Third");
  await author.upload(third.ref);
  service.blobs.get(third.ref)[25] ^= 1;
  await assert.rejects(reader.openText(third), unopenable);
  assert.equal(await reader.store.get(third.ref), null);
});

test("deleting retires the blob on the author's device, the service, and later an offline device", async () => {
  const service = fakeService();
  const author = new ChatBlobs({ store: await ChatBlobStore.open(HOUSEHOLD, { indexedDB: fakeIndexedDB() }), client: service.client });
  const offline = new ChatBlobs({ store: await ChatBlobStore.open(HOUSEHOLD, { indexedDB: fakeIndexedDB() }), client: service.client });
  const message = await author.seal("Surprise party Saturday");
  await author.upload(message.ref);
  assert.deepEqual(await offline.openText(message), { text: "Surprise party Saturday" });
  // The author deletes; the engine's page lists the blob as retired.
  assert.deepEqual(await author.retire([message.ref], { remote: [message.ref] }), { deleted: 1, remoteError: null });
  assert.equal(service.blobs.has(message.ref), false);
  assert.deepEqual(await author.openText(message), { deleted: true });
  // The other device was offline; when it syncs, its page lists the same
  // retired blob and it deletes its copy without asking the service.
  service.state.calls.length = 0;
  assert.deepEqual(await offline.retire([message.ref]), { deleted: 1, remoteError: null });
  assert.deepEqual(service.state.calls, []);
  assert.deepEqual(await offline.openText(message), { deleted: true });
  assert.equal(await offline.store.get(message.ref), null);
  // Offline at deletion time, the local deletion still happens; the service
  // is retried by the next call.
  const later = await author.seal("Oops");
  await author.upload(later.ref);
  service.state.offline = true;
  const result = await author.retire([later.ref], { remote: [later.ref] });
  assert.equal(result.deleted, 1);
  assert.equal(result.remoteError.code, "connection_unavailable");
  assert.equal(await author.upload(later.ref).then((value) => value.uploaded), false, "a deleted blob isn't uploaded");
  service.state.offline = false;
  await author.retire([later.ref], { remote: [later.ref] });
  assert.equal(service.deleted.has(later.ref), true);
});

test("another tab's connection closes for a deletion; one that won't blocks it with a clear error", async () => {
  const indexedDB = fakeIndexedDB();
  const tab = await ChatBlobStore.open(HOUSEHOLD, { indexedDB });
  const other = await ChatBlobStore.open(HOUSEHOLD, { indexedDB });
  await tab.destroy();
  assert.equal(indexedDB.databases.size, 0, "the other tab let go when asked");
  assert.equal(other.db.closed, true);
  const again = await ChatBlobStore.open(HOUSEHOLD, { indexedDB });
  const stubborn = await ChatBlobStore.open(HOUSEHOLD, { indexedDB });
  stubborn.db.onversionchange = () => {}; // an old version that doesn't listen
  await assert.rejects(again.destroy(), (error) => error.code === "chat_storage_blocked");
});

test("a failing read inside put rejects once, with nothing left unhandled", async () => {
  const indexedDB = fakeIndexedDB();
  const store = await ChatBlobStore.open(HOUSEHOLD, { indexedDB });
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const sealed = await sealChatText("x");
    indexedDB.failNext = true;
    await assert.rejects(store.put(sealed.ref, sealed.ciphertext), (error) => error.code === "chat_storage_unavailable");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
    assert.equal(await store.put(sealed.ref, sealed.ciphertext), true, "the store still works");
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("a blob deleted while its upload was in flight is retired right after", async () => {
  const service = fakeService();
  const store = await ChatBlobStore.open(HOUSEHOLD, { indexedDB: fakeIndexedDB() });
  const blobs = new ChatBlobs({ store, client: service.client });
  const message = await blobs.seal("Typo");
  // The user deletes while the upload is on the wire.
  const upload = service.client.upload.bind(service.client);
  service.client.upload = async (ref, bytes) => {
    const result = await upload(ref, bytes);
    await store.retire([ref]);
    return result;
  };
  assert.deepEqual(await blobs.upload(message.ref), { uploaded: false });
  assert.equal(service.deleted.has(message.ref), true, "the service was told at once");
  // An upload the service refuses as already deleted is not an error.
  const refused = await blobs.seal("Gone already");
  service.deleted.add(refused.ref);
  service.client.upload = async () => { throw Object.assign(new ChatBlobError("This message was deleted."), { code: "chat_blob_deleted" }); };
  assert.deepEqual(await blobs.upload(refused.ref), { uploaded: false });
});

test("the client talks to the real service: upload, download, deletion and refusal", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const admin = app.service.bootstrap({ credential: { id: "admin", publicKey: "key-admin", algorithm: -7 } });
  const invitation = app.service.createPairing(admin.sessionToken);
  const claim = app.service.claimPairing({ code: invitation.code, credential: { id: "partner", publicKey: "key-partner", algorithm: -7 }, deviceLabel: "Phone" });
  app.service.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
  const partner = app.service.activateClaim(claim.claimToken);
  const as = (who) => new ChatBlobClient({ fetch: (path, init) => fetch(base + path, { ...init, headers: { ...init.headers, cookie: `kin_session=${who.sessionToken}; kin_device=${who.deviceToken}` } }) });
  const adminBlobs = new ChatBlobs({ store: await ChatBlobStore.open(HOUSEHOLD, { indexedDB: fakeIndexedDB() }), client: as(admin) });
  const partnerBlobs = new ChatBlobs({ store: await ChatBlobStore.open(HOUSEHOLD, { indexedDB: fakeIndexedDB() }), client: as(partner) });
  const message = await adminBlobs.seal("Bins go out tonight");
  await adminBlobs.upload(message.ref);
  assert.deepEqual(await partnerBlobs.openText(message), { text: "Bins go out tonight" });
  // The partner is neither the uploader nor an admin: the service refuses.
  await assert.rejects(as(partner).retire([message.ref]), (error) => error.code === "chat_blob_retire_forbidden");
  const result = await adminBlobs.retire([message.ref], { remote: [message.ref] });
  assert.equal(result.remoteError, null);
  assert.deepEqual(await as(partner).download(message.ref), { deleted: true });
  await assert.rejects(as(admin).upload(message.ref, (await sealChatText("x")).ciphertext), (error) => error.code === "chat_blob_invalid");
});

test("evicting old blobs frees the cache without deleting anything for good (#125)", async () => {
  let clock = 1_000;
  const store = await ChatBlobStore.open(HOUSEHOLD, { indexedDB: fakeIndexedDB(), now: () => clock });
  const sealed = [];
  for (const text of ["old one", "old kept", "fresh"]) {
    const blob = await sealChatText(text);
    sealed.push(blob);
    await store.put(blob.ref, blob.ciphertext);
    clock += 1_000;
  }
  const [old, kept, fresh] = sealed;
  const dropped = await store.evictOlderThan(2_500, { keep: new Set([kept.ref]) });
  assert.equal(dropped, 1, "only the old blob that isn't kept");
  assert.equal(await store.get(old.ref), null);
  assert.ok(await store.get(kept.ref));
  assert.ok(await store.get(fresh.ref));
  assert.equal(await store.isRetired(old.ref), false, "no tombstone: it can be fetched again");
  assert.equal(await store.put(old.ref, old.ciphertext), true, "and stored again");
  assert.equal(await store.evictOlderThan(Number.NaN), 0);
  store.close();
});
