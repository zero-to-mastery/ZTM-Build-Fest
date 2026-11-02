// Chat content blobs (#110): storing encrypted message content by hash,
// who may retire it, tombstones and claims, quotas, durability, erasure of
// retired bytes, and the HTTP routes. Each service test runs against the
// in-memory store and the durable store, which must decide alike.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatBlobService, MAX_RETIRE_REFS } from "./chat-blob-service.mjs";
import { DurableStore, MAX_CHAT_BLOB_BYTES, MIN_CHAT_BLOB_BYTES } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { SERVER_SCHEMA_VERSION, sqlitePragma } from "./durable-store/shared.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const clock = { now: 1_800_000_000_000 };

/** A sealed blob as a device makes it: version 1, nonce, ciphertext and tag. */
function blob(size = 64) {
  const bytes = randomBytes(size);
  bytes[0] = 1;
  return { bytes, ref: createHash("sha256").update(bytes).digest("hex") };
}

/** One household: the founding admin (two devices), and two other Adults. */
function household({ store = null, pairing = new PairingService({ store, now: () => clock.now }) } = {}) {
  const service = new ChatBlobService({ pairingService: pairing, store, now: () => clock.now });
  const admin = pairing.bootstrap({ credential: credential(`admin-${randomBytes(4).toString("hex")}`) });
  const add = (create, id) => {
    clock.now += 60_001;
    const invitation = create();
    const claim = pairing.claimPairing({ code: invitation.code, credential: credential(id), deviceLabel: "Edge on Windows" });
    pairing.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  };
  const adminLaptop = add(() => pairing.createDevicePairing(admin.sessionToken), `admin-laptop-${randomBytes(4).toString("hex")}`);
  const partner = add(() => pairing.createPairing(admin.sessionToken), `partner-${randomBytes(4).toString("hex")}`);
  const other = add(() => pairing.createPairing(admin.sessionToken), `other-${randomBytes(4).toString("hex")}`);
  const auth = (who) => pairing.authorize(who.sessionToken);
  return { pairing, service, store, admin, adminLaptop, partner, other, auth };
}

/** Runs `body` once with the in-memory store and once with a durable one. */
function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household({ store })); } finally { store.close(); }
  });
}

const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;

bothStores("a blob is stored once, by the hash of its bytes, and read back", (h) => {
  const content = blob();
  assert.deepEqual(h.service.put(h.auth(h.partner), content.ref, content.bytes), { accepted: true, size: 64 });
  assert.deepEqual(h.service.put(h.auth(h.admin), content.ref, content.bytes), { accepted: false, size: 64 }, "the same bytes again");
  assert.deepEqual(h.service.get(h.auth(h.admin), content.ref), content.bytes);
  const tampered = Buffer.from(content.bytes);
  tampered[10] ^= 1;
  const short = blob(MIN_CHAT_BLOB_BYTES - 1), large = blob(MAX_CHAT_BLOB_BYTES + 1);
  for (const [ref, bytes] of [
    [content.ref, tampered],
    [content.ref.toUpperCase(), content.bytes],
    ["ab".repeat(31), content.bytes],
    [short.ref, short.bytes],
    [large.ref, large.bytes],
  ])
    assert.throws(() => h.service.put(h.auth(h.partner), ref, bytes), rejects("chat_blob_invalid", 400));
  assert.throws(() => h.service.get(h.auth(h.partner), blob().ref), rejects("chat_blob_missing", 404));
});

test("another household can't read, overwrite or retire a blob", () => {
  const pairing = new PairingService({ now: () => clock.now });
  const ours = household({ pairing });
  const theirs = household({ pairing });
  const shared = new ChatBlobService({ pairingService: pairing, now: () => clock.now });
  const content = blob();
  shared.put(ours.auth(ours.partner), content.ref, content.bytes);
  assert.throws(() => shared.get(theirs.auth(theirs.partner), content.ref), rejects("chat_blob_missing", 404));
  assert.deepEqual(shared.retire(theirs.auth(theirs.admin), [content.ref]), { retired: 0, claimed: 1 }, "a claim in their household only");
  assert.deepEqual(shared.get(ours.auth(ours.admin), content.ref), content.bytes, "ours is untouched");
  // Their copy of the same bytes would be theirs alone, and their admin's
  // claim on it there refuses it.
  assert.throws(() => shared.put(theirs.auth(theirs.partner), content.ref, content.bytes), rejects("chat_blob_deleted", 410));
});

bothStores("the uploader retires from any of their devices, an admin retires anyone's, nobody else", (h) => {
  const own = blob(), partners = blob(), another = blob();
  h.service.put(h.auth(h.admin), own.ref, own.bytes);
  h.service.put(h.auth(h.partner), partners.ref, partners.bytes);
  h.service.put(h.auth(h.partner), another.ref, another.bytes);
  // The partner is not an admin: all or nothing, so their own blob stays too.
  assert.throws(() => h.service.retire(h.auth(h.partner), [another.ref, own.ref]), rejects("chat_blob_retire_forbidden", 403));
  assert.deepEqual(h.service.get(h.auth(h.partner), another.ref), another.bytes);
  assert.deepEqual(h.service.retire(h.auth(h.partner), [another.ref]), { retired: 1, claimed: 0 });
  // The admin posted from the phone and deletes from the laptop.
  assert.deepEqual(h.service.retire(h.auth(h.adminLaptop), [own.ref]), { retired: 1, claimed: 0 });
  const before = h.pairing.events.filter((event) => event.type === "chat_content_removed_by_admin").length;
  assert.deepEqual(h.service.retire(h.auth(h.admin), [partners.ref, own.ref]), { retired: 1, claimed: 0 }, "retired refs are skipped");
  const audits = h.pairing.events.filter((event) => event.type === "chat_content_removed_by_admin");
  assert.equal(audits.length, before + 1);
  assert.deepEqual(Object.keys(audits.at(-1)).sort(), ["at", "count", "deviceId", "householdId", "memberId", "persisted", "type"]);
  for (const refs of [[], ["zz"], Array.from({ length: MAX_RETIRE_REFS + 1 }, () => blob().ref), [own.ref, own.ref], "nope", undefined])
    assert.throws(() => h.service.retire(h.auth(h.admin), refs), rejects("chat_blob_invalid", 400));
});

bothStores("a retired blob is gone for good: reads and uploads say it was deleted", (h) => {
  const content = blob();
  h.service.put(h.auth(h.partner), content.ref, content.bytes);
  h.service.retire(h.auth(h.partner), [content.ref]);
  assert.throws(() => h.service.get(h.auth(h.admin), content.ref), rejects("chat_blob_deleted", 410));
  assert.throws(() => h.service.put(h.auth(h.partner), content.ref, content.bytes), rejects("chat_blob_deleted", 410));
  assert.deepEqual(h.service.retire(h.auth(h.partner), [content.ref]), { retired: 0, claimed: 0 });
});

bothStores("a delete that arrives before the upload keeps the content off the service", (h) => {
  // The author deletes while the upload is still queued: their own claim
  // refuses the upload when it lands.
  const early = blob();
  assert.deepEqual(h.service.retire(h.auth(h.adminLaptop), [early.ref]), { retired: 0, claimed: 1 });
  assert.throws(() => h.service.put(h.auth(h.admin), early.ref, early.bytes), rejects("chat_blob_deleted", 410));
  assert.throws(() => h.service.get(h.auth(h.partner), early.ref), rejects("chat_blob_missing", 404));
  // An admin's removal before the upload refuses it too.
  const removed = blob();
  h.service.retire(h.auth(h.admin), [removed.ref]);
  assert.throws(() => h.service.put(h.auth(h.partner), removed.ref, removed.bytes), rejects("chat_blob_deleted", 410));
  // Another member's claim can't stop the author's upload (no squatting)...
  const squatted = blob();
  h.service.retire(h.auth(h.other), [squatted.ref]);
  assert.equal(h.service.put(h.auth(h.partner), squatted.ref, squatted.bytes).accepted, true);
  assert.equal(h.service.storage.chatBlobUsage(h.admin.householdId).claims, 2, "the squat is dropped with the upload");
  // ...and can't cancel the author's own claim either.
  const both = blob();
  h.service.retire(h.auth(h.other), [both.ref]);
  h.service.retire(h.auth(h.partner), [both.ref]);
  assert.throws(() => h.service.put(h.auth(h.partner), both.ref, both.bytes), rejects("chat_blob_deleted", 410));
});

bothStores("quotas count live blobs only; tombstones and claims never block retiring", (h) => {
  const id = h.admin.householdId;
  h.service.storage.chatBlobLimits = { blobs: 2, bytes: 1_000, tombstones: 2, claims: 2 };
  const [a, b, c, d] = [blob(100), blob(100), blob(100), blob(950)];
  h.service.put(h.auth(h.partner), a.ref, a.bytes);
  h.service.put(h.auth(h.partner), b.ref, b.bytes);
  assert.throws(() => h.service.put(h.auth(h.partner), c.ref, c.bytes), rejects("chat_storage_full", 409), "two live blobs");
  clock.now += 1;
  h.service.retire(h.auth(h.partner), [a.ref]);
  assert.equal(h.service.put(h.auth(h.partner), c.ref, c.bytes).accepted, true, "retiring frees a live slot");
  clock.now += 1;
  h.service.retire(h.auth(h.partner), [b.ref]);
  assert.throws(() => h.service.put(h.auth(h.partner), d.ref, d.bytes), rejects("chat_storage_full", 409), "bytes");
  assert.deepEqual(h.service.storage.chatBlobUsage(id), { liveBlobs: 1, liveBytes: 100, tombstones: 2, claims: 0 });
  // A third tombstone prunes the oldest; retiring never fails for space.
  clock.now += 1;
  h.service.retire(h.auth(h.partner), [c.ref]);
  assert.deepEqual(h.service.storage.chatBlobUsage(id), { liveBlobs: 0, liveBytes: 0, tombstones: 2, claims: 0 });
  assert.equal(h.service.storage.chatBlobMeta(id, a.ref), null, "the oldest tombstone went");
  for (let index = 0; index < 4; index += 1) {
    clock.now += 1;
    h.service.retire(h.auth(h.partner), [blob().ref]);
  }
  assert.equal(h.service.storage.chatBlobUsage(id).claims, 2);
});

bothStores("a flood of one member's claims never pushes out another member's claim", (h) => {
  h.service.storage.chatBlobLimits = { claims: 2 };
  const early = blob();
  h.service.retire(h.auth(h.partner), [early.ref]);
  for (let index = 0; index < 10; index += 1) {
    clock.now += 1;
    h.service.retire(h.auth(h.other), [blob().ref]);
  }
  assert.equal(h.service.storage.chatBlobUsage(h.admin.householdId).claims, 3, "two of the flooder's, one of the author's");
  assert.throws(() => h.service.put(h.auth(h.partner), early.ref, early.bytes), rejects("chat_blob_deleted", 410));
});

bothStores("members who can't take part can't use chat blobs", (h) => {
  const content = blob();
  const auth = h.auth(h.partner);
  const removed = { ...auth, member: { ...auth.member, active: false } };
  for (const call of [() => h.service.put(removed, content.ref, content.bytes), () => h.service.get(removed, content.ref), () => h.service.retire(removed, [content.ref])])
    assert.throws(call, rejects("chat_unavailable", 403));
});

test("blobs, tombstones and claims persist; retired bytes leave the database files; deletion purges all", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kin-chat-blobs-"));
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, "kin.sqlite");
  store = new DurableStore(path);
  assert.ok(SERVER_SCHEMA_VERSION >= 12);
  assert.equal(sqlitePragma(store.db, "user_version", { simple: true }), SERVER_SCHEMA_VERSION);
  const h = household({ store });
  const kept = blob(), early = blob();
  // A recognizable blob, to look for in the raw files after retiring it.
  const marker = Buffer.alloc(8192, 0x5a);
  marker[0] = 1;
  const gone = { bytes: marker, ref: createHash("sha256").update(marker).digest("hex") };
  h.service.put(h.auth(h.partner), kept.ref, kept.bytes);
  h.service.put(h.auth(h.partner), gone.ref, gone.bytes);
  h.service.retire(h.auth(h.partner), [gone.ref, early.ref]);
  const needle = Buffer.alloc(256, 0x5a);
  for (const file of [path, `${path}-wal`].filter(existsSync))
    assert.equal(readFileSync(file).includes(needle), false, `retired bytes linger in ${file}`);
  // Sessions are process-local; the authorization taken before the restart
  // stands in for a fresh one.
  const auth = h.auth(h.admin), partnerAuth = h.auth(h.partner);
  store.close();
  store = new DurableStore(path);
  const reopened = new ChatBlobService({ pairingService: new PairingService({ store, now: () => clock.now }), store, now: () => clock.now });
  assert.deepEqual(reopened.get(auth, kept.ref), kept.bytes);
  assert.throws(() => reopened.get(auth, gone.ref), rejects("chat_blob_deleted", 410));
  assert.throws(() => reopened.put(partnerAuth, early.ref, early.bytes), rejects("chat_blob_deleted", 410), "the claim survives a restart");
  assert.deepEqual(store.chatBlobUsage(h.admin.householdId), { liveBlobs: 1, liveBytes: 64, tombstones: 1, claims: 1 });
  assert.ok(store.householdPurgeStatus(h.admin.householdId).counts.chatBlobs > 0);
  store.forcePurgeHousehold(h.admin.householdId, clock.now);
  assert.equal(store.householdPurgeStatus(h.admin.householdId).counts.chatBlobs, 0);
  assert.equal(store.chatBlobMeta(h.admin.householdId, kept.ref), null);
  assert.equal(store.validate(), true);
});

test("finalizing deletions checkpoints only when it purged something", () => {
  const store = new DurableStore(":memory:");
  try {
    const statements = [];
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = (sql) => { statements.push(sql); return prepare(sql); };
    store.finalizeExpiredDeletions(clock.now);
    assert.equal(statements.some((sql) => sql.includes("wal_checkpoint")), false);
  } finally {
    store.close();
  }
});

test("validation notices running counts that drifted from the rows", () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household({ store });
    const content = blob();
    h.service.put(h.auth(h.partner), content.ref, content.bytes);
    assert.equal(store.validate(), true);
    store.db.prepare("UPDATE chat_blob_usage SET live_bytes = live_bytes + 1").run();
    assert.throws(() => store.validate(), /chat storage counts/);
  } finally {
    store.close();
  }
});

test("the chat blob routes need a trusted session and move raw bytes", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const content = blob(200);
  assert.equal((await fetch(`${url}/api/chat/blobs/${content.ref}`)).status, 401);
  assert.equal((await fetch(`${url}/api/chat/blobs/${content.ref}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: content.bytes })).status, 401);
  const adult = app.service.bootstrap({ credential: credential("adult") });
  const cookie = `kin_session=${adult.sessionToken}; kin_device=${adult.deviceToken}`;
  const put = await fetch(`${url}/api/chat/blobs/${content.ref}`, { method: "PUT", headers: { cookie, "content-type": "application/octet-stream" }, body: content.bytes });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { accepted: true, size: 200 });
  const got = await fetch(`${url}/api/chat/blobs/${content.ref}`, { headers: { cookie } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), content.bytes);
  const wrong = await fetch(`${url}/api/chat/blobs/${blob().ref}`, { method: "PUT", headers: { cookie, "content-type": "application/octet-stream" }, body: content.bytes });
  assert.equal(wrong.status, 400);
  const nullBody = await fetch(`${url}/api/chat/blobs/retire`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "null" });
  assert.equal(nullBody.status, 400);
  const retire = await fetch(`${url}/api/chat/blobs/retire`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ refs: [content.ref] }) });
  assert.deepEqual(await retire.json(), { retired: 1, claimed: 0 });
  const after = await fetch(`${url}/api/chat/blobs/${content.ref}`, { headers: { cookie } });
  assert.equal(after.status, 410);
  assert.equal((await after.json()).error, "chat_blob_deleted");
  // The household's storage total, for an admin (#125).
  assert.equal((await fetch(`${url}/api/chat/storage`)).status, 401);
  const storage = await fetch(`${url}/api/chat/storage`, { headers: { cookie } });
  assert.equal(storage.status, 200);
  assert.deepEqual(await storage.json(), { bytes: 0, byteLimit: 256 * 1024 * 1024, blobs: 0, blobLimit: 250_000, events: 0, eventLimit: 250_000 });
});

bothStores("a device can upload only so many chat blobs and bytes at a time (#125)", (h) => {
  const auth = h.auth(h.partner);
  // 120 a minute.
  for (let index = 0; index < 120; index += 1) {
    const content = blob(64 + index);
    h.service.put(auth, content.ref, content.bytes);
  }
  const extra = blob(300);
  assert.throws(() => h.service.put(auth, extra.ref, extra.bytes), rejects("chat_rate_limited", 429));
  // A blob the service already holds costs nothing, so a retry of a finished upload goes through.
  const held = blob(64);
  clock.now += 61_000;
  h.service.put(auth, held.ref, held.bytes);
  for (let index = 0; index < 119; index += 1) {
    const next = blob(400 + index);
    h.service.put(auth, next.ref, next.bytes);
  }
  assert.equal(h.service.put(auth, held.ref, held.bytes).accepted, false);
  // Another device has its own allowance.
  assert.equal(h.service.put(h.auth(h.other), extra.ref, extra.bytes).accepted, true);
});

bothStores("only an admin sees the household's chat storage, as totals (#125)", (h) => {
  const first = blob(100), second = blob(200);
  h.service.put(h.auth(h.partner), first.ref, first.bytes);
  h.service.put(h.auth(h.other), second.ref, second.bytes);
  assert.deepEqual(h.service.usage(h.auth(h.admin)), { bytes: 300, byteLimit: 256 * 1024 * 1024, blobs: 2, blobLimit: 250_000 });
  assert.throws(() => h.service.usage(h.auth(h.partner)), rejects("household_admin_required", 403));
  h.service.retire(h.auth(h.partner), [first.ref]);
  assert.equal(h.service.usage(h.auth(h.admin)).bytes, 200);
});
