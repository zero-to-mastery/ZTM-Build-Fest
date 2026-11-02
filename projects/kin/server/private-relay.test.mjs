// Each member's private relay (#491, ADR 0019): a stream keyed by member,
// with the chat relay's envelope rules, that only the member's own trusted
// devices reach. Every refusal the ADR lists is tested here: another
// member's device (an admin's included), a removed member, a revoked device,
// a Temporary member, and a Limited member while the household's setting is
// off. Each service test runs against the in-memory and the durable store.
import assert from "node:assert/strict";
import test from "node:test";
import { BoardRelayService } from "./board-relay-service.mjs";
import { ChatRelayService } from "./chat-relay-service.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { MAX_MEMBER_PRIVATE_EVENTS, PRIVATE_EVENTS_PER_MINUTE, PrivateRelayService } from "./private-relay-service.mjs";
import { createKinServer } from "./server.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { decodeEventPage, encodeEnvelopeBatch, ENVELOPE_CONTENT_TYPE } from "../web/sync/envelope-wire.js";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const hex = (byte, length = 16) => byte.toString(16).padStart(2, "0").repeat(length);

function envelope(who, { eventId, deviceSequence, logicalTime = deviceSequence, keyEpoch = 1, householdId = who.householdId, deviceId = who.deviceId }) {
  return {
    protocolVersion: 1, envelopeVersion: 1, eventId, householdId, deviceId,
    deviceSequence, logicalTime: String(logicalTime), keyEpoch,
    nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(40, deviceSequence).toString("base64url"),
    signature: Buffer.alloc(64, 2).toString("base64url"),
  };
}

/** A household: the founding admin, Sam (an Adult) with a phone and a
 * laptop, a Limited member and a Temporary member. */
function household(store = null) {
  const pairing = new PairingService({ store });
  const sync = new EncryptedSyncService(pairing, { store });
  const hints = [];
  sync.liveService = {
    eventsAccepted: (...args) => hints.push(["household", ...args]),
    memberEventsAccepted: (...args) => hints.push(["member", ...args]),
    revalidate() {},
  };
  sync.pushService = { eventsAccepted() {}, removeUntrusted() {} };
  const relay = new PrivateRelayService({ syncService: sync, store });
  sync.privateRelayService = relay;
  // As server.mjs wires it: removal purges the member's stream.
  pairing.onMemberRemoved = (_householdId, memberId) => relay.forgetMember(memberId);
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
  return { pairing, sync, relay, admin, sam, samLaptop, child, guest, auth, hints, store };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store)); } finally { store.close(); }
  });
}

const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;
const ids = (page) => page.events.map((row) => row.envelope.eventId);

bothStores("a member's private events go only to their own stream", (h) => {
  assert.equal(h.sam.memberId, h.samLaptop.memberId, "the phone and the laptop are one member's");
  const result = h.relay.push(h.auth(h.sam), [
    envelope(h.sam, { eventId: hex(1), deviceSequence: 1 }),
    envelope(h.sam, { eventId: hex(2), deviceSequence: 2 }),
  ]);
  assert.equal(result.accepted, 2);
  assert.deepEqual(h.hints, [["member", h.sam.householdId, h.sam.memberId, h.sam.deviceId]],
    "only Sam's other devices hear about it; nothing goes to the household");
  // Sam's laptop reads them, and adds its own with its own sequence.
  assert.deepEqual(ids(h.relay.pull(h.auth(h.samLaptop), "", "20")), [hex(1), hex(2)]);
  h.relay.push(h.auth(h.samLaptop), [envelope(h.samLaptop, { eventId: hex(3), deviceSequence: 1, logicalTime: 3 })]);
  const page = h.relay.pull(h.auth(h.sam), "", "2");
  assert.deepEqual(ids(page), [hex(1), hex(2)]);
  assert.equal(page.hasMore, true);
  assert.deepEqual(ids(h.relay.pull(h.auth(h.sam), page.nextCursor, "20")), [hex(3)]);
  const status = h.relay.status(h.auth(h.sam));
  assert.equal(status.deviceSequence, 2);
  assert.equal(status.events, 3);
  assert.equal(status.eventLimit, MAX_MEMBER_PRIVATE_EVENTS);
  assert.equal(status.latestCursor, h.relay.pull(h.auth(h.sam), "", "20").nextCursor);
  assert.equal(h.relay.status(h.auth(h.samLaptop)).deviceSequence, 1);

  // Every other member, the admin included, reaches only their own stream.
  for (const other of [h.admin, h.child]) {
    assert.deepEqual(ids(h.relay.pull(h.auth(other), "", "20")), [], "another member never sees Sam's events");
    assert.equal(h.relay.status(h.auth(other)).events, 0);
  }
  // Their own events stay theirs too, numbered from 1 in their own stream.
  h.relay.push(h.auth(h.admin), [envelope(h.admin, { eventId: hex(9), deviceSequence: 1 })]);
  assert.deepEqual(ids(h.relay.pull(h.auth(h.sam), "", "20")), [hex(1), hex(2), hex(3)]);
  assert.deepEqual(ids(h.relay.pull(h.auth(h.admin), "", "20")), [hex(9)]);

  // No other relay ever sees a private event.
  assert.deepEqual(h.sync.pull(h.sam.sessionToken, "", "20").events, []);
  assert.deepEqual(new ChatRelayService({ syncService: h.sync, store: h.store }).pull(h.auth(h.sam), "", "20").events, []);
  assert.deepEqual(new BoardRelayService({ syncService: h.sync, store: h.store }).pull(h.auth(h.sam), "", "20").events, []);
});

bothStores("the envelope rules hold on a private stream", (h) => {
  const auth = h.auth(h.sam);
  h.relay.push(auth, [envelope(h.sam, { eventId: hex(1), deviceSequence: 1 })]);
  assert.throws(() => h.relay.push(auth, [envelope(h.sam, { eventId: hex(2), deviceSequence: 3 })]), rejects("sync_sequence_gap", 409));
  assert.equal(h.relay.push(auth, [envelope(h.sam, { eventId: hex(1), deviceSequence: 1 })]).accepted, 1, "a retry is idempotent");
  assert.throws(() => h.relay.push(auth, [envelope(h.sam, { eventId: hex(1), deviceSequence: 2 })]), rejects("event_duplicate_conflict", 409));
  // Only this device's own envelopes, of its own household.
  assert.throws(() => h.relay.push(auth, [envelope(h.samLaptop, { eventId: hex(4), deviceSequence: 1 })]), rejects("event_envelope_invalid", 400));
  assert.throws(() => h.relay.push(auth, [envelope(h.sam, { eventId: hex(4), deviceSequence: 2, householdId: hex(0xee) })]), rejects("event_envelope_invalid", 400));
  // The key epoch is a member-key epoch, not the household's (which is 1
  // here); only its range is the service's to check.
  assert.equal(h.relay.push(auth, [envelope(h.sam, { eventId: hex(5), deviceSequence: 2, keyEpoch: 7 })]).accepted, 1);
  assert.throws(() => h.relay.push(auth, [envelope(h.sam, { eventId: hex(6), deviceSequence: 3, keyEpoch: 129 })]), rejects("event_envelope_invalid", 400));
  assert.throws(() => h.relay.push(auth, []), rejects("sync_batch_invalid", 400));
  assert.throws(() => h.relay.push(auth, [envelope(h.sam, { eventId: hex(6), deviceSequence: 3, logicalTime: 10 ** 15 })]), rejects("logical_time_invalid", 400));
  assert.throws(() => h.relay.pull(auth, "AAAAAAAAAAk", "20"), rejects("sync_cursor_invalid", 400));
  assert.throws(() => h.relay.pull(auth, "", "201"), rejects("sync_cursor_invalid", 400));
  // Household sync must be set up (device keys are how devices check each other).
  h.sync.state(h.sam.householdId).enabled = false;
  assert.throws(() => h.relay.push(auth, [envelope(h.sam, { eventId: hex(8), deviceSequence: 3 })]), rejects("private_sync_unavailable", 409));
  h.sync.state(h.sam.householdId).enabled = true;
  // A household key rotation doesn't pause it: the member key is apart.
  h.sync.state(h.sam.householdId).rotationPending = true;
  assert.equal(h.relay.push(auth, [envelope(h.sam, { eventId: hex(8), deviceSequence: 3 })]).accepted, 1);
});

bothStores("another member's device, an admin's included, can't write or read someone else's stream", (h) => {
  h.relay.push(h.auth(h.sam), [envelope(h.sam, { eventId: hex(1), deviceSequence: 1 })]);
  for (const other of [h.admin, h.child]) {
    // Posing as Sam's device is refused outright.
    assert.throws(() => h.relay.push(h.auth(other), [envelope(h.sam, { eventId: hex(2), deviceSequence: 2 })]), rejects("event_envelope_invalid", 400));
    assert.throws(() => h.relay.push(h.auth(other), [envelope(other, { eventId: hex(2), deviceSequence: 1, deviceId: h.samLaptop.deviceId })]), rejects("event_envelope_invalid", 400));
    // And what it reads is its own (empty) stream, never Sam's.
    assert.deepEqual(ids(h.relay.pull(h.auth(other), "", "20")), []);
  }
  // A cursor from Sam's stream means nothing in another member's.
  const cursor = h.relay.pull(h.auth(h.sam), "", "20").nextCursor;
  assert.throws(() => h.relay.pull(h.auth(h.admin), cursor, "20"), rejects("sync_cursor_invalid", 400));
  assert.equal(h.relay.status(h.auth(h.sam)).events, 1);
});

bothStores("Temporary members never have private storage", (h) => {
  const guest = h.auth(h.guest);
  assert.throws(() => h.relay.push(guest, [envelope(h.guest, { eventId: hex(1), deviceSequence: 1 })]), rejects("private_unavailable", 403));
  assert.throws(() => h.relay.pull(guest, "", "20"), rejects("private_unavailable", 403));
  assert.throws(() => h.relay.status(guest), rejects("private_unavailable", 403));
  assert.deepEqual(h.sync.status(h.guest.sessionToken).private, { access: "none" });
});

bothStores("Limited members have it until an admin turns it off", (h) => {
  const write = (who, eventId, deviceSequence) => h.relay.push(h.auth(who), [envelope(who, { eventId, deviceSequence })]);
  assert.equal(write(h.child, hex(1), 1).accepted, 1, "on by default");
  assert.deepEqual(h.sync.status(h.child.sessionToken).private, { access: "write" });
  assert.deepEqual(h.sync.status(h.admin.sessionToken).private, { access: "write", policy: { limited: true } }, "the admin sees the setting");
  assert.deepEqual(h.sync.householdSettings(h.admin.sessionToken).privatePolicy, { limited: true });
  assert.equal(h.sync.householdSettings(h.sam.sessionToken).privatePolicy, undefined, "only an admin");
  // Only an admin, with a fresh passkey, changes it.
  assert.throws(() => h.pairing.setPrivatePolicy(h.sam.sessionToken, { limited: false }, h.sam.memberId), (error) => error.status === 403);
  assert.throws(() => h.pairing.setPrivatePolicy(h.child.sessionToken, { limited: false }, h.child.memberId), (error) => error.status === 403);
  assert.throws(() => h.pairing.setPrivatePolicy(h.admin.sessionToken, { limited: false }, h.sam.memberId), (error) => error.code === "fresh_auth_required");
  assert.throws(() => h.pairing.setPrivatePolicy(h.admin.sessionToken, { limited: "no" }, h.admin.memberId), (error) => error.code === "private_policy_invalid");
  assert.deepEqual(h.pairing.setPrivatePolicy(h.admin.sessionToken, { limited: false }, h.admin.memberId), { limited: false, revision: 1, changed: true });
  assert.deepEqual(h.pairing.setPrivatePolicy(h.admin.sessionToken, { limited: false }, h.admin.memberId), { limited: false, revision: 1, changed: false });
  // Off: the service refuses the stream outright, reading included.
  assert.throws(() => write(h.child, hex(2), 2), rejects("private_off", 403));
  assert.throws(() => h.relay.pull(h.auth(h.child), "", "20"), rejects("private_off", 403));
  assert.throws(() => h.relay.status(h.auth(h.child)), rejects("private_off", 403));
  assert.deepEqual(h.sync.status(h.child.sessionToken).private, { access: "none" });
  // Adults are untouched, and nobody can read the child's stream either way.
  assert.equal(write(h.sam, hex(3), 1).accepted, 1);
  assert.deepEqual(ids(h.relay.pull(h.auth(h.admin), "", "20")), []);
  // On again: what was stored is still there for the child.
  h.pairing.setPrivatePolicy(h.admin.sessionToken, { limited: true }, h.admin.memberId);
  assert.deepEqual(ids(h.relay.pull(h.auth(h.child), "", "20")), [hex(1)]);
});

bothStores("a revoked device is refused and the member's other devices carry on", (h) => {
  h.relay.push(h.auth(h.samLaptop), [envelope(h.samLaptop, { eventId: hex(1), deviceSequence: 1 })]);
  const before = h.auth(h.samLaptop);
  h.pairing.revokeDevice(h.sam.sessionToken, h.samLaptop.deviceId, h.sam.memberId);
  assert.throws(() => h.auth(h.samLaptop), (error) => error instanceof PairingError && error.status === 401, "a revoked device has no session");
  // Even an authorization taken before the revocation is refused.
  assert.throws(() => h.relay.pull(before, "", "20"), rejects("private_unavailable", 403));
  assert.throws(() => h.relay.push(before, [envelope(h.samLaptop, { eventId: hex(2), deviceSequence: 2 })]), rejects("private_unavailable", 403));
  assert.deepEqual(ids(h.relay.pull(h.auth(h.sam), "", "20")), [hex(1)], "the phone still reads everything");
});

bothStores("a removed member is refused and their stream is purged", (h) => {
  h.relay.push(h.auth(h.sam), [envelope(h.sam, { eventId: hex(1), deviceSequence: 1 })]);
  h.relay.push(h.auth(h.admin), [envelope(h.admin, { eventId: hex(2), deviceSequence: 1 })]);
  const before = h.auth(h.sam);
  h.pairing.removeOtherAdult(h.admin.sessionToken, h.sam.memberId, h.admin.memberId);
  assert.throws(() => h.auth(h.sam), (error) => error instanceof PairingError);
  assert.throws(() => h.relay.pull(before, "", "20"), rejects("private_unavailable", 403));
  assert.deepEqual(h.relay.storage.privateRelayState(h.sam.memberId), { nextSequence: 1, eventCount: 0, maxLogicalTime: "0" }, "purged");
  assert.equal(h.relay.storage.findPrivateEvent(h.sam.memberId, hex(1)), null);
  assert.equal(h.relay.status(h.auth(h.admin)).events, 1, "nobody else's stream is touched");
  if (h.store) assert.equal(h.store.validate(), true);
});

bothStores("a device can send only so many private events a minute", (h) => {
  const auth = h.auth(h.sam);
  let sequence = 0;
  const batch = (count) => Array.from({ length: count }, () => {
    sequence += 1;
    return envelope(h.sam, { eventId: sequence.toString(16).padStart(32, "0"), deviceSequence: sequence });
  });
  for (let sent = 0; sent < PRIVATE_EVENTS_PER_MINUTE; sent += 20) h.relay.push(auth, batch(20));
  assert.throws(() => h.relay.push(auth, batch(1)), rejects("private_rate_limited", 429));
});

bothStores("a member's stream has a quota of its own", (h) => {
  h.relay.stream.maxEvents = 2;
  h.relay.push(h.auth(h.sam), [envelope(h.sam, { eventId: hex(1), deviceSequence: 1 }), envelope(h.sam, { eventId: hex(2), deviceSequence: 2 })]);
  assert.throws(() => h.relay.push(h.auth(h.sam), [envelope(h.sam, { eventId: hex(3), deviceSequence: 3 })]), rejects("private_limit", 413));
  assert.equal(h.relay.push(h.auth(h.admin), [envelope(h.admin, { eventId: hex(3), deviceSequence: 1 })]).accepted, 1, "another member's quota is apart");
  assert.equal(MAX_MEMBER_PRIVATE_EVENTS, 50_000, "the engine's private log cap");
});

test("private streams persist, and deleting the household purges every one", () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household(store);
    h.relay.push(h.auth(h.sam), [envelope(h.sam, { eventId: hex(1), deviceSequence: 1 })]);
    h.relay.push(h.auth(h.child), [envelope(h.child, { eventId: hex(2), deviceSequence: 1 })]);
    assert.deepEqual(ids(new PrivateRelayService({ syncService: h.sync, store }).pull(h.auth(h.samLaptop), "", "20")), [hex(1)]);
    assert.deepEqual(store.privateRelayState(h.sam.memberId), { nextSequence: 2, eventCount: 1, maxLogicalTime: "1" });
    assert.equal(store.householdPurgeStatus(h.sam.householdId).counts.privateEvents, 6);
    store.forcePurgeHousehold(h.sam.householdId, Date.now());
    assert.equal(store.householdPurgeStatus(h.sam.householdId).counts.privateEvents, 0);
    assert.equal(store.householdPurgeStatus(h.sam.householdId).purged, true);
    assert.equal(store.validate(), true);
  } finally {
    store.close();
  }
});

test("the private storage setting persists across a restart", () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household(store);
    assert.deepEqual(new PairingService({ store }).households.get(h.admin.householdId).privatePolicy, { limited: true, revision: 0 });
    h.pairing.setPrivatePolicy(h.admin.sessionToken, { limited: false }, h.admin.memberId);
    assert.deepEqual(new PairingService({ store }).households.get(h.admin.householdId).privatePolicy, { limited: false, revision: 1 });
    assert.equal(store.validate(), true);
  } finally {
    store.close();
  }
});

test("the private routes move binary batches and pages for the session's own member", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${url}/api/private/events`)).status, 401);
  assert.equal((await fetch(`${url}/api/private/status`)).status, 401);
  const admin = app.service.bootstrap({ credential: credential("admin") });
  const invitation = app.service.createPairing(admin.sessionToken, { kind: "adult" });
  const claim = app.service.claimPairing({ code: invitation.code, credential: credential("sam"), deviceLabel: "Phone" });
  app.service.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
  const sam = app.service.activateClaim(claim.claimToken);
  app.syncService.enable(admin.sessionToken);
  const cookie = (who) => `kin_session=${who.sessionToken}; kin_device=${who.deviceToken}`;
  const push = await fetch(`${url}/api/private/events`, {
    method: "POST", headers: { cookie: cookie(sam), "content-type": ENVELOPE_CONTENT_TYPE },
    body: encodeEnvelopeBatch([envelope(sam, { eventId: hex(7), deviceSequence: 1 })]),
  });
  assert.equal(push.status, 200);
  assert.equal((await push.json()).accepted, 1);
  const page = async (who) => decodeEventPage(new Uint8Array(await (await fetch(`${url}/api/private/events?cursor=&limit=20`, { headers: { cookie: cookie(who) } })).arrayBuffer()));
  assert.deepEqual((await page(sam)).events.map((row) => row.envelope.eventId), [hex(7)]);
  assert.deepEqual((await page(admin)).events, [], "the admin's request reaches the admin's own stream");
  const status = await (await fetch(`${url}/api/private/status`, { headers: { cookie: cookie(sam) } })).json();
  assert.equal(status.deviceSequence, 1);
  assert.equal(status.events, 1);
  const syncStatus = await (await fetch(`${url}/api/sync/status`, { headers: { cookie: cookie(sam) } })).json();
  assert.deepEqual(syncStatus.private, { access: "write" });
  // The setting's passkey flow is an admin's.
  const options = await fetch(`${url}/api/household/private-policy/options`, {
    method: "POST", headers: { cookie: cookie(sam), "content-type": "application/json" }, body: JSON.stringify({ limited: false }),
  });
  assert.equal(options.status, 403);
  const adminOptions = await fetch(`${url}/api/household/private-policy/options`, {
    method: "POST", headers: { cookie: cookie(admin), "content-type": "application/json" }, body: JSON.stringify({ limited: "off" }),
  });
  assert.equal(adminOptions.status, 400);
  // Removing Sam through the service purges Sam's stream (server.mjs wires it).
  app.service.removeOtherAdult(admin.sessionToken, sam.memberId, admin.memberId);
  assert.equal(app.privateRelayService.storage.privateRelayState(sam.memberId).eventCount, 0);
  assert.equal((await fetch(`${url}/api/private/events?cursor=&limit=20`, { headers: { cookie: cookie(sam) } })).status, 401, "a removed member has no session");
});
