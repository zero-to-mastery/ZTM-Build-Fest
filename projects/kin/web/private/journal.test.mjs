// The journal on the device (#497, #501): commands through the engine's
// private path into the private log, normalized content, the first write
// making the member key, photos sealed as private blobs that upload on the
// next pass and open again on another device, and deletions queued for the
// service. A stand-in plays the engine and the log (rust/src/journal_tests.rs
// and private-log.test.mjs cover the real ones); IndexedDB and the service
// routes are in-memory doubles.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeIndexedDB } from "../chat/fake-indexeddb.test-support.mjs";
import { Journal, JournalError, journalPhotoProblem } from "./journal.js";
import { openPrivateBlob, PrivateBlobClient, PrivateBlobs, PrivateBlobStore, sealPrivateBlob } from "./private-blobs.js";

const HOUSEHOLD = "aa".repeat(16), MEMBER = "01".repeat(16), DEVICE = "11".repeat(16);
const decoder = new TextDecoder();

function fakeLog({ reason = "ready", entries = [] } = {}) {
  const listeners = new Set();
  const log = {
    reason, appended: [], enabled: 0, logical: 1n,
    identity: { householdId: HOUSEHOLD, memberId: MEMBER, deviceId: DEVICE },
    records: { view: () => ({ length: log.appended.length }) },
    get active() { return log.reason === "ready"; },
    nextLogicalTime: () => log.logical,
    syncIdentity: () => ({ householdId: HOUSEHOLD, bindings: [] }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notify() { for (const listener of listeners) listener(log); },
    async enable() { log.enabled += 1; log.reason = "ready"; return "ready"; },
    async append(bytes) { log.appended.push(JSON.parse(decoder.decode(bytes))); log.logical += 1n; log.notify(); },
    // As PrivateLog.execute does: name the event here, then store it.
    async execute(command) {
      const { encodedEvent } = fakeEngine().executePrivateCommand(command, {
        eventId: "0b".repeat(16), householdId: HOUSEHOLD, actorId: MEMBER, deviceId: DEVICE, timestamp: 1_791_475_200_000, logicalTime: log.logical,
      }, log.records.view(), 0, 20261003, log.syncIdentity());
      await log.append(encodedEvent);
    },
    projection: () => ({ journal: entries }),
  };
  return log;
}

const fakeEngine = () => ({
  executePrivateCommand(command, identity, records, asOf, civilDate, syncIdentity) {
    assert.equal(typeof records.length, "number", "the private log goes to the engine as a view");
    assert.equal(syncIdentity.householdId, HOUSEHOLD);
    return { encodedEvent: new TextEncoder().encode(JSON.stringify({ command, identity: { ...identity, logicalTime: String(identity.logicalTime) } })) };
  },
});

/** The service's blob routes in memory, for one member. */
function fakeService() {
  const held = new Map();
  const calls = [];
  const fetch = async (path, init = {}) => {
    calls.push(`${init.method} ${path.replace(/[a-f0-9]{64}/, "<ref>")}`);
    const ref = path.match(/[a-f0-9]{64}$/)?.[0];
    if (init.method === "PUT") { held.set(ref, new Uint8Array(init.body)); return new Response(JSON.stringify({ accepted: true }), { status: 200 }); }
    if (init.method === "GET") return held.has(ref) ? new Response(held.get(ref), { status: 200 }) : new Response("{}", { status: 404 });
    const { refs } = JSON.parse(init.body);
    let retired = 0;
    for (const each of refs) if (held.delete(each)) retired += 1;
    return new Response(JSON.stringify({ retired }), { status: 200 });
  };
  return { held, calls, client: new PrivateBlobClient({ fetch }) };
}

async function blobsOn(service, indexedDB = fakeIndexedDB()) {
  const store = await PrivateBlobStore.open(HOUSEHOLD, MEMBER, { indexedDB });
  return new PrivateBlobs({ store, client: service.client, householdId: HOUSEHOLD, memberId: MEMBER });
}

test("writing an entry goes through the engine's private path with clean content", async () => {
  const log = fakeLog();
  const journal = new Journal({ log, engine: fakeEngine(), blobs: null });
  const id = await journal.create({ date: "2026-10-03", title: "  Park\nday ", body: "\r\nSwings.\r\nThen cocoa.\t\n", photos: [] });
  assert.match(id, /^[a-f0-9]{32}$/);
  const [{ command, identity }] = log.appended;
  assert.deepEqual(command, { type: "create-journal-entry", entryId: id, date: "2026-10-03", title: "Park day", body: "Swings.\nThen cocoa.", photos: [] });
  assert.equal(identity.householdId, HOUSEHOLD);
  assert.equal(identity.actorId, MEMBER);
  assert.equal(identity.deviceId, DEVICE);
  assert.equal(identity.logicalTime, "1");
  assert.equal(identity.timestamp, 1_791_475_200_000);
  await journal.remove(id);
  await journal.restore(id);
  assert.deepEqual(log.appended.map((event) => [event.command.type, event.identity.logicalTime]), [
    ["create-journal-entry", "1"], ["delete-journal-entry", "2"], ["restore-journal-entry", "3"],
  ]);
});

test("nothing to save, or too much, is said plainly and writes nothing", async () => {
  const log = fakeLog();
  const journal = new Journal({ log, engine: fakeEngine(), blobs: null });
  await assert.rejects(journal.create({ date: "2026-10-03", title: " ", body: "\n\t" }), (error) => error instanceof JournalError && /Write something/.test(error.message));
  await assert.rejects(journal.create({ date: "2026-10-03", title: "t".repeat(201), body: "" }), /title is too long/);
  await assert.rejects(journal.create({ date: "2026-10-03", body: "b".repeat(20_001) }), /too long to save/);
  assert.equal(log.appended.length, 0);
});

test("an unchanged edit writes nothing; a change writes the whole entry", async () => {
  const entry = { id: "0a".repeat(16), date: "2026-10-03", title: "Park", body: "Swings.", photos: [] };
  const log = fakeLog({ entries: [entry] });
  const journal = new Journal({ log, engine: fakeEngine(), blobs: null });
  assert.equal(await journal.edit(entry.id, { date: "2026-10-03", title: "Park ", body: "Swings.\n" }), false);
  assert.equal(log.appended.length, 0);
  assert.equal(await journal.edit(entry.id, { date: "2026-10-02", title: "Park", body: "Swings." }), true);
  assert.deepEqual(log.appended[0].command, { type: "edit-journal-entry", entryId: entry.id, date: "2026-10-02", title: "Park", body: "Swings.", photos: [] });
});

test("the first write makes the member key; until then the journal is empty", async () => {
  const log = fakeLog({ reason: "no_member_key", entries: [{ id: "x" }] });
  const journal = new Journal({ log, engine: fakeEngine(), blobs: null });
  assert.equal(journal.usable, true);
  assert.deepEqual(journal.entries(), [], "nothing to read before the key exists");
  await journal.create({ date: "2026-10-03", body: "First." });
  assert.equal(log.enabled, 1);
  assert.equal(log.appended.length, 1);
  // A member who has no account yet can't write.
  const none = new Journal({ log: { ...fakeLog({ reason: "no_vault" }), async enable() { return "no_vault"; }, get active() { return false; }, reason: "no_member_key" }, engine: fakeEngine(), blobs: null });
  await assert.rejects(none.create({ date: "2026-10-03", body: "x" }), (error) => error.code === "journal_unavailable");
});

test("photos are sealed per member, upload on the pass and open on another device", async () => {
  const service = fakeService();
  const phone = await blobsOn(service);
  const photo = new Uint8Array(5000).fill(7);
  const sealed = await phone.seal(photo);
  assert.equal(sealed.size, 5000 + 29);
  assert.deepEqual(service.calls, [], "kept here first; nothing sent until the pass");
  assert.deepEqual((await phone.open(sealed)).bytes, photo, "this device opens its own copy");
  // Another device has nothing yet: it's on its way.
  const laptop = await blobsOn(service);
  assert.deepEqual(await laptop.open(sealed), { pending: true });
  await phone.sync();
  const puts = () => service.calls.filter((call) => call.startsWith("PUT")).length;
  assert.equal(puts(), 1);
  assert.equal(service.held.size, 1);
  assert.deepEqual((await laptop.open(sealed)).bytes, photo, "fetched, checked and opened");
  await phone.sync();
  assert.equal(puts(), 1, "uploaded once");
  // A blob from the service that isn't the one named is refused.
  service.held.set(sealed.ref, new Uint8Array(service.held.get(sealed.ref)).fill(1, 20, 30));
  const tablet = await blobsOn(service);
  await assert.rejects(tablet.open(sealed), /couldn't be opened/);
  // Removing: gone here at once, deleted on the service on the next pass.
  await phone.discard([sealed.ref]);
  assert.equal(await phone.store.get(sealed.ref), null);
  await phone.sync();
  assert.deepEqual(service.calls.at(-1), "POST /api/private/blobs/retire");
  assert.equal(service.held.size, 0);
  assert.deepEqual(await phone.store.retireQueue(), []);
});

test("a sealed photo is bound to its member and household", async () => {
  const sealed = await sealPrivateBlob(new Uint8Array([1, 2, 3]), { householdId: HOUSEHOLD, memberId: MEMBER });
  assert.deepEqual(await openPrivateBlob(sealed.ciphertext, { ...sealed, householdId: HOUSEHOLD, memberId: MEMBER }), new Uint8Array([1, 2, 3]));
  await assert.rejects(openPrivateBlob(sealed.ciphertext, { ...sealed, householdId: HOUSEHOLD, memberId: "02".repeat(16) }), /couldn't be opened/);
  await assert.rejects(openPrivateBlob(sealed.ciphertext, { ...sealed, key: "03".repeat(32), householdId: HOUSEHOLD, memberId: MEMBER }), /couldn't be opened/);
});

test("cached photos the journal no longer names are dropped, pending ones kept", async () => {
  const service = fakeService();
  const blobs = await blobsOn(service);
  const kept = await blobs.seal(new Uint8Array([1]));
  const draft = await blobs.seal(new Uint8Array([2]));
  await blobs.sync();
  const fresh = await blobs.seal(new Uint8Array([3]));
  assert.equal(await blobs.store.prune(new Set([kept.ref])), 1, "the uploaded one nobody names");
  assert.ok(await blobs.store.get(kept.ref));
  assert.equal(await blobs.store.get(draft.ref), null);
  assert.ok(await blobs.store.get(fresh.ref), "still pending: maybe an entry not saved yet");
});

test("journal photos follow the household attachment rules", async () => {
  assert.equal(journalPhotoProblem(new Blob([new Uint8Array(10)], { type: "image/jpeg" })), null);
  assert.match(journalPhotoProblem(new Blob(["%PDF"], { type: "application/pdf" })), /JPEG, PNG or WebP photo/);
  assert.match(journalPhotoProblem(new Blob([], { type: "image/png" })), /empty/);
  assert.match(journalPhotoProblem(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "image/webp" })), /4 MB or smaller/);
  // A file that says it's a JPEG but isn't one is refused before it is read.
  const journal = new Journal({ log: fakeLog(), engine: fakeEngine(), blobs: null });
  await assert.rejects(journal.addPhoto(new File([new Uint8Array([1, 2, 3, 4])], "x.jpg", { type: "image/jpeg" })), /Choose a valid JPEG/);
  // A real one is drawn again, thumbnailed and sealed twice.
  const service = fakeService();
  const blobs = await blobsOn(service);
  const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], "park.jpg", { type: "image/jpeg" });
  const drawing = new Journal({
    log: fakeLog(), engine: fakeEngine(), blobs,
    prepare: async () => ({ blob: new Blob([new Uint8Array(100).fill(9)], { type: "image/jpeg" }), thumbnail: new Blob([new Uint8Array(10).fill(8)], { type: "image/jpeg" }) }),
  });
  const added = await drawing.addPhoto(jpeg);
  assert.equal(added.type, "image/jpeg");
  assert.equal(added.size, 129);
  assert.notEqual(added.ref, added.thumbnail);
  const full = await drawing.photoBlob(added);
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), new Uint8Array(100).fill(9));
  const thumb = await drawing.photoBlob(added, { thumbnail: true });
  assert.equal(thumb.type, "image/jpeg");
  assert.equal(thumb.size, 10);
});
