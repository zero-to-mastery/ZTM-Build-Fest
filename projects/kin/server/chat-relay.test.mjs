// The chat relay (#111): chat events in their own encrypted stream, apart
// from the household relay, with the same envelope rules. Each service test
// runs against the in-memory and the durable store.
import assert from "node:assert/strict";
import test from "node:test";
import { ChatRelayService } from "./chat-relay-service.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { decodeEventPage, encodeEnvelopeBatch, ENVELOPE_CONTENT_TYPE } from "../web/sync/envelope-wire.js";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const hex = (byte, length = 16) => byte.toString(16).padStart(2, "0").repeat(length);

/** An envelope as the service sees it: valid in shape, opaque inside. */
function envelope(who, { eventId, deviceSequence, logicalTime = deviceSequence, keyEpoch = 1 }) {
  return {
    protocolVersion: 1,
    envelopeVersion: 1,
    eventId,
    householdId: who.householdId,
    deviceId: who.deviceId,
    deviceSequence,
    logicalTime: String(logicalTime),
    keyEpoch,
    nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(40, deviceSequence).toString("base64url"),
    signature: Buffer.alloc(64, 2).toString("base64url"),
  };
}

function household(store = null) {
  const pairing = new PairingService({ store });
  const sync = new EncryptedSyncService(pairing, { store });
  const hints = [];
  sync.liveService = { eventsAccepted: (householdId, deviceId) => hints.push(deviceId), revalidate() {} };
  const relay = new ChatRelayService({ syncService: sync, store });
  const adult = pairing.bootstrap({ credential: credential(`adult-${Math.random()}`) });
  const invitation = pairing.createDevicePairing(adult.sessionToken);
  const claim = pairing.claimPairing({ code: invitation.code, credential: credential(`laptop-${Math.random()}`), deviceLabel: "Laptop" });
  pairing.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const laptop = pairing.activateClaim(claim.claimToken);
  sync.enable(adult.sessionToken);
  const auth = (who) => sync.authorize(who.sessionToken);
  return { pairing, sync, relay, adult, laptop, auth, hints };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store)); } finally { store.close(); }
  });
}

const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;

bothStores("chat events are pushed, ordered and pulled in their own stream", (h) => {
  const first = envelope(h.adult, { eventId: hex(1), deviceSequence: 1 });
  const second = envelope(h.adult, { eventId: hex(2), deviceSequence: 2 });
  const result = h.relay.push(h.auth(h.adult), [first, second]);
  assert.equal(result.accepted, 2);
  assert.deepEqual(h.hints, [h.adult.deviceId], "the household's other devices hear about it");
  const reply = envelope(h.laptop, { eventId: hex(3), deviceSequence: 1, logicalTime: 3 });
  h.relay.push(h.auth(h.laptop), [reply]);
  const page = h.relay.pull(h.auth(h.laptop), "", "2");
  assert.deepEqual(page.events.map((row) => row.envelope.eventId), [hex(1), hex(2)]);
  assert.equal(page.hasMore, true);
  assert.deepEqual(h.relay.status(h.auth(h.adult)).deviceSequence, 2, "a device can pick up its chat sequence");
  assert.deepEqual(h.relay.status(h.auth(h.laptop)).deviceSequence, 1);
  const rest = h.relay.pull(h.auth(h.laptop), page.nextCursor, "20");
  assert.deepEqual(rest.events.map((row) => row.envelope.eventId), [hex(3)]);
  assert.equal(rest.hasMore, false);
  // The household relay never sees chat.
  assert.deepEqual(h.sync.pull(h.adult.sessionToken, "", "20").events, []);
});

bothStores("the envelope rules hold: sequences, duplicates, devices, epochs, cursors", (h) => {
  const auth = h.auth(h.adult);
  h.relay.push(auth, [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]);
  assert.throws(() => h.relay.push(auth, [envelope(h.adult, { eventId: hex(2), deviceSequence: 3 })]), rejects("sync_sequence_gap", 409));
  // The same event again is fine; the same ID with other bytes is not.
  assert.equal(h.relay.push(auth, [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]).accepted, 1);
  const altered = envelope(h.adult, { eventId: hex(1), deviceSequence: 2 });
  assert.throws(() => h.relay.push(auth, [altered]), rejects("event_duplicate_conflict", 409));
  // Another device's envelope, a key epoch nobody holds, an empty batch.
  assert.throws(() => h.relay.push(auth, [envelope(h.laptop, { eventId: hex(4), deviceSequence: 1 })]), rejects("event_envelope_invalid", 400));
  assert.throws(() => h.relay.push(auth, [envelope(h.adult, { eventId: hex(5), deviceSequence: 2, keyEpoch: 2 })]), rejects("event_envelope_invalid", 400));
  assert.throws(() => h.relay.push(auth, []), rejects("sync_batch_invalid", 400));
  assert.throws(() => h.relay.push(auth, [envelope(h.adult, { eventId: hex(6), deviceSequence: 2, logicalTime: 10 ** 15 })]), rejects("logical_time_invalid", 400));
  assert.throws(() => h.relay.pull(auth, "AAAAAAAAAAk", "20"), rejects("sync_cursor_invalid", 400));
  assert.throws(() => h.relay.pull(auth, "", "201"), rejects("sync_cursor_invalid", 400));
});

bothStores("chat waits out a key rotation and needs household sync set up", (h) => {
  h.sync.state(h.adult.householdId).rotationPending = true;
  assert.throws(() => h.relay.push(h.auth(h.adult), [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]), rejects("sync_rotation_pending", 409));
  h.sync.state(h.adult.householdId).rotationPending = false;
  h.sync.state(h.adult.householdId).enabled = false;
  assert.throws(() => h.relay.push(h.auth(h.adult), [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]), rejects("chat_sync_unavailable", 409));
});

bothStores("members who can't take part can't use the chat relay", (h) => {
  const auth = h.auth(h.adult);
  const removed = { ...auth, member: { ...auth.member, active: false } };
  assert.throws(() => h.relay.push(removed, [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]), rejects("chat_unavailable", 403));
  assert.throws(() => h.relay.pull(removed, "", "20"), rejects("chat_unavailable", 403));
});

/** A sealed "delete for me" record as the service sees it: routing fields
 * it checks, ciphertext it can't read. */
function hiddenRecord(who, revision, extra = {}) {
  return {
    version: 1, householdId: who.householdId, memberId: who.memberId, senderDeviceId: who.deviceId, revision,
    nonce: "AAAAAAAAAAAAAAAA", ciphertext: "c2VhbGVk", signature: "c2lnbmVk",
    recipients: [{ deviceId: who.deviceId, fingerprint: "f", ephemeralPublicKey: {}, salt: "s", nonce: "n", wrappedKey: "w" }],
    ...extra,
  };
}

bothStores("each member's delete-for-me record is theirs, compare-and-set", (h) => {
  const auth = h.auth(h.adult);
  assert.deepEqual(h.relay.hidden(auth), { revision: 0, record: null });
  assert.deepEqual(h.relay.putHidden(auth, { expectedRevision: 0, record: hiddenRecord(h.adult, 1) }), { revision: 1 });
  assert.equal(h.relay.hidden(auth).record.ciphertext, "c2VhbGVk");
  // A stale revision loses; the next one wins.
  assert.throws(() => h.relay.putHidden(auth, { expectedRevision: 0, record: hiddenRecord(h.adult, 1) }), rejects("chat_hidden_stale", 409));
  assert.deepEqual(h.relay.putHidden(auth, { expectedRevision: 1, record: hiddenRecord(h.adult, 2) }), { revision: 2 });
  // The record must name this member, this device and the next revision.
  for (const record of [
    hiddenRecord(h.adult, 4),
    hiddenRecord(h.adult, 3, { memberId: "ee".repeat(16) }),
    hiddenRecord(h.adult, 3, { senderDeviceId: h.laptop.deviceId }),
    hiddenRecord(h.adult, 3, { recipients: [] }),
    hiddenRecord(h.adult, 3, { ciphertext: "x".repeat(300_000) }),
    null,
  ])
    assert.throws(() => h.relay.putHidden(auth, { expectedRevision: 2, record }), rejects("chat_hidden_invalid", 400));
  // The same member's other device shares it; others never reach it.
  assert.equal(h.relay.hidden(h.auth(h.laptop)).revision, 2);
  const removed = { ...auth, member: { ...auth.member, active: false } };
  assert.throws(() => h.relay.hidden(removed), rejects("chat_unavailable", 403));
});

test("the chat relay persists and household deletion purges it", () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household(store);
    h.relay.push(h.auth(h.adult), [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]);
    const reopened = new ChatRelayService({ syncService: h.sync, store });
    assert.equal(reopened.pull(h.auth(h.laptop), "", "20").events.length, 1);
    assert.deepEqual(store.chatRelayState(h.adult.householdId), { nextSequence: 2, eventCount: 1, maxLogicalTime: "1" });
    h.relay.putHidden(h.auth(h.adult), { expectedRevision: 0, record: hiddenRecord(h.adult, 1) });
    assert.equal(new ChatRelayService({ syncService: h.sync, store }).hidden(h.auth(h.adult)).revision, 1, "kept across restarts");
    assert.ok(store.householdPurgeStatus(h.adult.householdId).counts.chatEvents > 0);
    store.forcePurgeHousehold(h.adult.householdId, Date.now());
    assert.equal(store.householdPurgeStatus(h.adult.householdId).counts.chatEvents, 0);
    assert.equal(store.validate(), true);
  } finally {
    store.close();
  }
});

test("the chat event routes move binary batches and pages", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${url}/api/chat/events`)).status, 401);
  // The emoji table (#113) is served as JSON from the app.
  const table = await fetch(`${url}/chat/emoji.json`);
  assert.equal(table.status, 200);
  assert.match(table.headers.get("content-type"), /^application\/json/);
  assert.equal((await table.json()).version, 1);
  const adult = app.service.bootstrap({ credential: credential("adult") });
  app.syncService.enable(adult.sessionToken);
  const cookie = `kin_session=${adult.sessionToken}; kin_device=${adult.deviceToken}`;
  const push = await fetch(`${url}/api/chat/events`, {
    method: "POST", headers: { cookie, "content-type": ENVELOPE_CONTENT_TYPE },
    body: encodeEnvelopeBatch([envelope(adult, { eventId: hex(7), deviceSequence: 1 })]),
  });
  assert.equal(push.status, 200);
  assert.equal((await push.json()).accepted, 1);
  const pull = await fetch(`${url}/api/chat/events?cursor=&limit=20`, { headers: { cookie } });
  assert.equal(pull.status, 200);
  const page = decodeEventPage(new Uint8Array(await pull.arrayBuffer()));
  assert.deepEqual(page.events.map((row) => row.envelope.eventId), [hex(7)]);
  const put = await fetch(`${url}/api/chat/hidden`, {
    method: "PUT", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 0, record: hiddenRecord(adult, 1) }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { revision: 1 });
  assert.equal((await (await fetch(`${url}/api/chat/hidden`, { headers: { cookie } })).json()).revision, 1);
  const household = await fetch(`${url}/api/sync/events?cursor=&limit=20`, { headers: { cookie } });
  assert.equal(decodeEventPage(new Uint8Array(await household.arrayBuffer())).events.length, 0);
});

// ---- Read-receipt slots (#121) ----------------------------------------------------

/** A receipt slot as the service sees it: an envelope whose sequence is the
 * revision it writes, opaque inside. */
const slot = (who, revision, extra = {}) => envelope(who, { eventId: hex(revision + 10), deviceSequence: revision, logicalTime: 1_700_000_000_000, ...extra });

bothStores("each member has one receipt slot, replaced compare-and-set and never added to the chat log", (h) => {
  const writes = [];
  h.sync.liveService.receiptsChanged = (householdId, deviceId) => writes.push(deviceId);
  const auth = h.auth(h.adult);
  assert.deepEqual(h.relay.receipts(auth), { slots: [] });
  assert.deepEqual(h.relay.putReceipt(auth, { expectedRevision: 0, record: slot(h.adult, 1) }), { revision: 1 });
  assert.deepEqual(writes, [h.adult.deviceId], "the household's other devices are told");
  // The member's other device replaces the same slot.
  assert.deepEqual(h.relay.putReceipt(h.auth(h.laptop), { expectedRevision: 1, record: slot(h.laptop, 2) }), { revision: 2 });
  const { slots } = h.relay.receipts(auth);
  assert.equal(slots.length, 1, "one slot per member, however many devices and writes");
  assert.equal(slots[0].revision, 2);
  assert.equal(slots[0].record.deviceId, h.laptop.deviceId);
  // A stale writer is refused with the conflict to resolve.
  assert.throws(() => h.relay.putReceipt(auth, { expectedRevision: 1, record: slot(h.adult, 2) }), rejects("chat_receipts_stale", 409));
  // Nothing went into the chat event stream.
  assert.deepEqual(h.relay.pull(auth, "", "20").events, []);
});

bothStores("a receipt slot must be this device's own small envelope for the revision it replaces", (h) => {
  const auth = h.auth(h.adult);
  for (const [body, label] of [
    [{ expectedRevision: 0, record: slot(h.adult, 2) }, "a sequence that isn't the next revision"],
    [{ expectedRevision: 0, record: slot(h.laptop, 1) }, "another device's envelope"],
    [{ expectedRevision: 0, record: slot(h.adult, 1, { keyEpoch: 9 }) }, "a key epoch the household doesn't have"],
    [{ expectedRevision: 0, record: { ...slot(h.adult, 1), ciphertext: "A".repeat(5000) } }, "over the size bound"],
    [{ expectedRevision: -1, record: slot(h.adult, 0) }, "a negative revision"],
    [{ expectedRevision: "0", record: slot(h.adult, 1) }, "a revision that isn't a number"],
    [{ expectedRevision: 0, record: null }, "no record"],
    [{ expectedRevision: 0, record: { ...slot(h.adult, 1), householdId: "other" } }, "another household"],
  ]) assert.throws(() => h.relay.putReceipt(auth, body), rejects("chat_receipts_invalid", 400), label);
  assert.deepEqual(h.relay.receipts(auth), { slots: [] }, "nothing was stored");
});

bothStores("receipt writes are limited per device", (h) => {
  const auth = h.auth(h.adult);
  let revision = 0;
  for (; revision < 40; revision += 1) h.relay.putReceipt(auth, { expectedRevision: revision, record: slot(h.adult, revision + 1) });
  assert.throws(() => h.relay.putReceipt(auth, { expectedRevision: revision, record: slot(h.adult, revision + 1) }), rejects("chat_receipts_rate_limited", 429));
  // The other device has its own allowance.
  assert.equal(h.relay.putReceipt(h.auth(h.laptop), { expectedRevision: revision, record: slot(h.laptop, revision + 1) }).revision, revision + 1);
  assert.equal(h.relay.receipts(auth).slots.length, 1);
});

test("the receipt routes carry JSON, need a session, and stay out of the chat stream", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const admin = app.service.bootstrap({ credential: { id: "admin", publicKey: "key-admin", algorithm: -7 } });
  app.syncService.enable(admin.sessionToken);
  const headers = { cookie: `kin_session=${admin.sessionToken}; kin_device=${admin.deviceToken}`, "content-type": "application/json", origin: "https://kin.example.org" };
  const record = envelope({ householdId: admin.householdId, deviceId: admin.deviceId }, { eventId: hex(1), deviceSequence: 1, logicalTime: 1_700_000_000_000 });
  assert.equal((await fetch(`${base}/api/chat/receipts`)).status, 401, "a session is required");
  const put = await fetch(`${base}/api/chat/receipts`, { method: "PUT", headers, body: JSON.stringify({ expectedRevision: 0, record }) });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { revision: 1 });
  const got = await (await fetch(`${base}/api/chat/receipts`, { headers })).json();
  assert.equal(got.slots.length, 1);
  assert.equal(got.slots[0].memberId, admin.memberId);
  const stale = await fetch(`${base}/api/chat/receipts`, { method: "PUT", headers, body: JSON.stringify({ expectedRevision: 0, record }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "chat_receipts_stale");
});

bothStores("a device can send only so many chat events a minute (#125)", (h) => {
  const auth = h.auth(h.adult);
  let sequence = 0;
  const batch = (count) => Array.from({ length: count }, () => {
    sequence += 1;
    return envelope(h.adult, { eventId: hex(sequence % 255, 16).replace(/..$/, sequence.toString(16).padStart(2, "0")).slice(0, 32).padEnd(32, "0"), deviceSequence: sequence });
  });
  const send = (count) => h.relay.push(auth, batch(count));
  // 120 a minute, spent in batches of 20.
  for (let round = 0; round < 6; round += 1) send(20);
  const before = sequence;
  assert.throws(() => send(1), rejects("chat_rate_limited", 429));
  sequence = before;
  // A refused batch changes nothing: the same events go through later.
  h.sync.now = () => Date.now() + 61_000;
  h.relay.eventWindow.now = h.sync.now;
  assert.equal(send(20).accepted, 20);
  // Another device has its own allowance.
  assert.equal(h.relay.push(h.auth(h.laptop), [envelope(h.laptop, { eventId: hex(250), deviceSequence: 1, logicalTime: 1 })]).accepted, 1);
});

bothStores("an admin sees the household's chat event total (#125)", (h) => {
  const auth = h.auth(h.adult);
  h.relay.push(auth, [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 }), envelope(h.adult, { eventId: hex(2), deviceSequence: 2 })]);
  assert.deepEqual(h.relay.eventUsage(auth), { events: 2, eventLimit: 250_000 });
});

bothStores("a batch that fails doesn't use up the sending allowance (#125)", (h) => {
  const auth = h.auth(h.adult);
  // A gap in the device sequence is refused after the rate check.
  for (let attempt = 0; attempt < 10; attempt += 1)
    assert.throws(() => h.relay.push(auth, Array.from({ length: 20 }, (_, i) => envelope(h.adult, { eventId: hex(attempt * 20 + i + 1, 16), deviceSequence: 50 + i }))), rejects("sync_sequence_gap", 409));
  assert.equal(h.relay.push(auth, [envelope(h.adult, { eventId: hex(250), deviceSequence: 1 })]).accepted, 1, "still allowed to send");
});
