// A member's private blobs (#502, ADR 0019): sealed journal photos keyed by
// member, like the private relay stream. Only the member's own trusted
// devices store, fetch or delete them; another member's device, an admin's
// included, finds nothing; a Temporary member never has them, a Limited one
// not while the household turned private storage off; removing the member
// or deleting the household purges them. Each service test runs against the
// in-memory and the durable store.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { MAX_PRIVATE_RETIRE_REFS, PRIVATE_UPLOADS_PER_MINUTE, PrivateBlobService } from "./private-blob-service.mjs";
import { PrivateRelayService } from "./private-relay-service.mjs";
import { createKinServer } from "./server.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

/** A sealed blob stand-in (the service only hashes it) and its reference. */
function blob(fill, size = 64) {
  const ciphertext = Buffer.alloc(size, fill);
  return { ref: createHash("sha256").update(ciphertext).digest("hex"), ciphertext };
}

function household(store = null) {
  const pairing = new PairingService({ store });
  const sync = new EncryptedSyncService(pairing, { store });
  sync.liveService = { eventsAccepted() {}, memberEventsAccepted() {}, revalidate() {} };
  sync.pushService = { eventsAccepted() {}, removeUntrusted() {} };
  const relay = new PrivateRelayService({ syncService: sync, store });
  const blobs = new PrivateBlobService({ relay, store });
  sync.privateRelayService = relay;
  sync.privateBlobService = blobs;
  // As server.mjs wires it.
  pairing.onMemberRemoved = (_householdId, memberId) => { relay.forgetMember(memberId); blobs.forgetMember(memberId); };
  const admin = pairing.bootstrap({ credential: credential(`admin-${Math.random()}`) });
  const admit = (sessionToken, options, label) => {
    const invitation = options ? pairing.createPairing(sessionToken, options) : pairing.createDevicePairing(sessionToken);
    const claim = pairing.claimPairing({ code: invitation.code, credential: credential(`${label}-${Math.random()}`), deviceLabel: label });
    pairing.approvePairing(sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  };
  const sam = admit(admin.sessionToken, { kind: "adult" }, "Phone");
  const samLaptop = admit(sam.sessionToken, null, "Laptop");
  const child = admit(admin.sessionToken, { kind: "limited" }, "Tablet");
  const guest = admit(admin.sessionToken, { kind: "temporary", expiresAt: Date.now() + 86_400_000 }, "Guest phone");
  sync.enable(admin.sessionToken);
  const auth = (who) => sync.authorize(who.sessionToken);
  return { pairing, sync, relay, blobs, admin, sam, samLaptop, child, guest, auth, store };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store)); } finally { store.close(); }
  });
}

const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;

bothStores("a member's photos reach their own devices and nobody else's", (h) => {
  const photo = blob(1);
  assert.deepEqual(h.blobs.put(h.auth(h.sam), photo.ref, photo.ciphertext), { accepted: true, size: 64 });
  assert.deepEqual(h.blobs.put(h.auth(h.sam), photo.ref, photo.ciphertext), { accepted: false, size: 64 }, "again is a no-op");
  // Sam's laptop fetches it.
  assert.deepEqual(h.blobs.get(h.auth(h.samLaptop), photo.ref), photo.ciphertext);
  // Every other member, the household admin included, finds nothing there.
  for (const other of [h.admin, h.child]) {
    assert.throws(() => h.blobs.get(h.auth(other), photo.ref), rejects("private_blob_missing", 404));
    assert.equal(h.blobs.retire(h.auth(other), [photo.ref]).retired, 0, "and can't delete it");
    assert.equal(h.blobs.usage(h.auth(other)).blobs, 0);
  }
  assert.deepEqual(h.blobs.get(h.auth(h.sam), photo.ref), photo.ciphertext, "still Sam's");
  // The same bytes uploaded by another member are that member's own copy:
  // deleting either leaves the other.
  assert.equal(h.blobs.put(h.auth(h.admin), photo.ref, photo.ciphertext).accepted, true);
  assert.equal(h.blobs.retire(h.auth(h.admin), [photo.ref]).retired, 1);
  assert.deepEqual(h.blobs.get(h.auth(h.sam), photo.ref), photo.ciphertext);
  const usage = h.blobs.usage(h.auth(h.sam));
  assert.equal(usage.blobs, 1);
  assert.equal(usage.blobBytes, 64);
});

bothStores("uploads are checked against their reference and bounds", (h) => {
  const auth = h.auth(h.sam);
  const photo = blob(2);
  assert.throws(() => h.blobs.put(auth, "a".repeat(64), photo.ciphertext), rejects("private_blob_invalid", 400));
  assert.throws(() => h.blobs.put(auth, photo.ref.slice(1), photo.ciphertext), rejects("private_blob_invalid", 400));
  const tiny = blob(3, 28);
  assert.throws(() => h.blobs.put(auth, tiny.ref, tiny.ciphertext), rejects("private_blob_invalid", 400));
  const huge = blob(4, 4 * 1024 * 1024 + 4097);
  assert.throws(() => h.blobs.put(auth, huge.ref, huge.ciphertext), rejects("private_blob_invalid", 400));
  assert.throws(() => h.blobs.get(auth, "nope"), rejects("private_blob_invalid", 400));
  assert.throws(() => h.blobs.retire(auth, []), rejects("private_blob_invalid", 400));
  assert.throws(() => h.blobs.retire(auth, [photo.ref, photo.ref]), rejects("private_blob_invalid", 400));
  assert.throws(() => h.blobs.retire(auth, Array.from({ length: MAX_PRIVATE_RETIRE_REFS + 1 }, (_, n) => blob(n % 250, 30 + n).ref)), rejects("private_blob_invalid", 400));
});

bothStores("each member has a photo quota of their own", (h) => {
  h.blobs.storage.privateBlobLimits = { blobs: 2, bytes: 1000 };
  const auth = h.auth(h.sam);
  h.blobs.put(auth, blob(1).ref, blob(1).ciphertext);
  h.blobs.put(auth, blob(2).ref, blob(2).ciphertext);
  assert.throws(() => h.blobs.put(auth, blob(3).ref, blob(3).ciphertext), rejects("private_storage_full", 409));
  assert.equal(h.blobs.put(h.auth(h.admin), blob(3).ref, blob(3).ciphertext).accepted, true, "another member's quota is apart");
  // Deleting frees room.
  assert.equal(h.blobs.retire(auth, [blob(1).ref, blob(9).ref]).retired, 1, "one not held is skipped");
  assert.equal(h.blobs.put(auth, blob(3).ref, blob(3).ciphertext).accepted, true);
  assert.throws(() => h.blobs.get(auth, blob(1).ref), rejects("private_blob_missing", 404));
  const big = blob(5, 950);
  assert.throws(() => h.blobs.put(h.auth(h.admin), big.ref, big.ciphertext), rejects("private_storage_full", 409), "bytes count too");
  if (h.store) assert.equal(h.store.validate(), true);
});

bothStores("a device can upload only so many photos a minute", (h) => {
  const auth = h.auth(h.sam);
  for (let n = 0; n < PRIVATE_UPLOADS_PER_MINUTE; n += 1) h.blobs.put(auth, blob(n % 250, 30 + n).ref, blob(n % 250, 30 + n).ciphertext);
  const next = blob(1, 500);
  assert.throws(() => h.blobs.put(auth, next.ref, next.ciphertext), rejects("private_rate_limited", 429));
  // An upload already held costs nothing.
  const held = blob(0, 30);
  assert.equal(h.blobs.put(auth, held.ref, held.ciphertext).accepted, false);
});

bothStores("Temporary members, and Limited members while it's off, have no private blobs", (h) => {
  const photo = blob(1);
  for (const call of [() => h.blobs.put(h.auth(h.guest), photo.ref, photo.ciphertext), () => h.blobs.get(h.auth(h.guest), photo.ref)])
    assert.throws(call, rejects("private_unavailable", 403));
  assert.equal(h.blobs.put(h.auth(h.child), photo.ref, photo.ciphertext).accepted, true, "on by default for children and teens");
  h.pairing.setPrivatePolicy(h.admin.sessionToken, { limited: false }, h.admin.memberId);
  assert.throws(() => h.blobs.get(h.auth(h.child), photo.ref), rejects("private_off", 403));
  assert.throws(() => h.blobs.retire(h.auth(h.child), [photo.ref]), rejects("private_off", 403));
  h.pairing.setPrivatePolicy(h.admin.sessionToken, { limited: true }, h.admin.memberId);
  assert.deepEqual(h.blobs.get(h.auth(h.child), photo.ref), photo.ciphertext, "kept while it was off");
});

bothStores("a revoked device and a removed member are refused, and removal purges the blobs", (h) => {
  const photo = blob(1);
  h.blobs.put(h.auth(h.samLaptop), photo.ref, photo.ciphertext);
  const laptop = h.auth(h.samLaptop);
  h.pairing.revokeDevice(h.sam.sessionToken, h.samLaptop.deviceId, h.sam.memberId);
  assert.throws(() => h.blobs.get(laptop, photo.ref), rejects("private_unavailable", 403));
  assert.deepEqual(h.blobs.get(h.auth(h.sam), photo.ref), photo.ciphertext, "the phone still reads it");
  h.blobs.put(h.auth(h.admin), blob(2).ref, blob(2).ciphertext);
  const before = h.auth(h.sam);
  h.pairing.removeOtherAdult(h.admin.sessionToken, h.sam.memberId, h.admin.memberId);
  assert.throws(() => h.blobs.get(before, photo.ref), rejects("private_unavailable", 403));
  assert.equal(h.blobs.storage.privateBlobBytes(h.sam.memberId, photo.ref), null, "purged");
  assert.equal(h.blobs.usage(h.auth(h.admin)).blobs, 1, "nobody else's are touched");
  if (h.store) assert.equal(h.store.validate(), true);
});

test("deleting the household purges every member's blobs", () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household(store);
    h.blobs.put(h.auth(h.sam), blob(1).ref, blob(1).ciphertext);
    h.blobs.put(h.auth(h.child), blob(2).ref, blob(2).ciphertext);
    assert.equal(store.householdPurgeStatus(h.sam.householdId).counts.privateEvents, 2);
    store.forcePurgeHousehold(h.sam.householdId, Date.now());
    assert.equal(store.householdPurgeStatus(h.sam.householdId).counts.privateEvents, 0);
    assert.equal(store.privateBlobBytes(h.sam.memberId, blob(1).ref), null);
    assert.equal(store.validate(), true);
  } finally {
    store.close();
  }
});

test("the private blob routes serve only the session's own member", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `${`http://127.0.0.1:${app.server.address().port}`}/api/private/blobs`;
  const photo = blob(7, 2048);
  assert.equal((await fetch(`${url}/${photo.ref}`)).status, 401);
  assert.equal((await fetch(`${url}/${photo.ref}`, { method: "PUT", body: photo.ciphertext })).status, 401, "refused before the body is read");
  const admin = app.service.bootstrap({ credential: credential("admin") });
  const invite = (options, label) => {
    const invitation = app.service.createPairing(admin.sessionToken, options);
    const claim = app.service.claimPairing({ code: invitation.code, credential: credential(label), deviceLabel: label });
    app.service.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
    return app.service.activateClaim(claim.claimToken);
  };
  const sam = invite({ kind: "adult" }, "sam");
  const guest = invite({ kind: "temporary", expiresAt: Date.now() + 86_400_000 }, "guest");
  app.syncService.enable(admin.sessionToken);
  const cookie = (who) => ({ cookie: `kin_session=${who.sessionToken}; kin_device=${who.deviceToken}` });
  const put = await fetch(`${url}/${photo.ref}`, { method: "PUT", headers: { ...cookie(sam), "content-type": "application/octet-stream" }, body: photo.ciphertext });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { accepted: true, size: 2048 });
  const got = await fetch(`${url}/${photo.ref}`, { headers: cookie(sam) });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), photo.ciphertext);
  // The admin's request reaches the admin's own (empty) blobs.
  assert.equal((await fetch(`${url}/${photo.ref}`, { headers: cookie(admin) })).status, 404);
  const adminRetire = await fetch(`${url}/retire`, { method: "POST", headers: { ...cookie(admin), "content-type": "application/json" }, body: JSON.stringify({ refs: [photo.ref] }) });
  assert.deepEqual(await adminRetire.json(), { retired: 0 });
  assert.equal((await fetch(`${url}/${photo.ref}`, { headers: cookie(sam) })).status, 200, "still Sam's");
  // A Temporary member is refused before the body is read.
  assert.equal((await fetch(`${url}/${photo.ref}`, { method: "PUT", headers: cookie(guest), body: photo.ciphertext })).status, 403);
  // The private status carries the member's photo use.
  const status = await (await fetch(`${url.replace("/blobs", "/status")}`, { headers: cookie(sam) })).json();
  assert.equal(status.blobs, 1);
  assert.equal(status.blobBytes, 2048);
  assert.ok(status.blobByteLimit > 0 && status.blobLimit > 0);
  const retire = await fetch(`${url}/retire`, { method: "POST", headers: { ...cookie(sam), "content-type": "application/json" }, body: JSON.stringify({ refs: [photo.ref] }) });
  assert.deepEqual(await retire.json(), { retired: 1 });
  assert.equal((await fetch(`${url}/${photo.ref}`, { headers: cookie(sam) })).status, 404);
});
