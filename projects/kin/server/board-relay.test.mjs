// The fridge's relay (#317, ADR 0011): board events in a third encrypted
// stream with the chat relay's envelope rules. Each service test runs
// against the in-memory and the durable store.
import assert from "node:assert/strict";
import test from "node:test";
import { BoardRelayService, BOARD_EVENTS_PER_MINUTE, MAX_HOUSEHOLD_BOARD_EVENTS } from "./board-relay-service.mjs";
import { ChatRelayService } from "./chat-relay-service.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { decodeEventPage, encodeEnvelopeBatch, ENVELOPE_CONTENT_TYPE } from "../web/sync/envelope-wire.js";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const hex = (byte, length = 16) => byte.toString(16).padStart(2, "0").repeat(length);

function envelope(who, { eventId, deviceSequence, logicalTime = deviceSequence, keyEpoch = 1 }) {
  return {
    protocolVersion: 1, envelopeVersion: 1, eventId, householdId: who.householdId, deviceId: who.deviceId,
    deviceSequence, logicalTime: String(logicalTime), keyEpoch,
    nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(40, deviceSequence).toString("base64url"),
    signature: Buffer.alloc(64, 2).toString("base64url"),
  };
}

function household(store = null) {
  const pairing = new PairingService({ store });
  const sync = new EncryptedSyncService(pairing, { store });
  const hints = [];
  sync.liveService = { eventsAccepted: (householdId, deviceId, flags) => hints.push([deviceId, flags]), revalidate() {} };
  const pushes = [];
  sync.pushService = { eventsAccepted: (...args) => pushes.push(args), removeUntrusted() {} };
  const relay = new BoardRelayService({ syncService: sync, store });
  const chat = new ChatRelayService({ syncService: sync, store });
  const adult = pairing.bootstrap({ credential: credential(`adult-${Math.random()}`) });
  const invitation = pairing.createDevicePairing(adult.sessionToken);
  const claim = pairing.claimPairing({ code: invitation.code, credential: credential(`laptop-${Math.random()}`), deviceLabel: "Laptop" });
  pairing.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const laptop = pairing.activateClaim(claim.claimToken);
  sync.enable(adult.sessionToken);
  const auth = (who) => sync.authorize(who.sessionToken);
  return { pairing, sync, relay, chat, adult, laptop, auth, hints, pushes };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store)); } finally { store.close(); }
  });
}

const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;

bothStores("board events are pushed, ordered and pulled in their own stream", (h) => {
  const result = h.relay.push(h.auth(h.adult), [
    envelope(h.adult, { eventId: hex(1), deviceSequence: 1 }),
    envelope(h.adult, { eventId: hex(2), deviceSequence: 2 }),
  ]);
  assert.equal(result.accepted, 2);
  assert.deepEqual(h.hints, [[h.adult.deviceId, undefined]], "other devices get a plain sync hint");
  assert.deepEqual(h.pushes, [], "the fridge never sends a push notification");
  h.relay.push(h.auth(h.laptop), [envelope(h.laptop, { eventId: hex(3), deviceSequence: 1, logicalTime: 3 })]);
  const page = h.relay.pull(h.auth(h.laptop), "", "2");
  assert.deepEqual(page.events.map((row) => row.envelope.eventId), [hex(1), hex(2)]);
  assert.equal(page.hasMore, true);
  assert.equal(h.relay.status(h.auth(h.adult)).deviceSequence, 2);
  const rest = h.relay.pull(h.auth(h.laptop), page.nextCursor, "20");
  assert.deepEqual(rest.events.map((row) => row.envelope.eventId), [hex(3)]);
  // Neither the household relay nor chat sees board events, and the board's
  // sequence is counted apart from chat's.
  assert.deepEqual(h.sync.pull(h.adult.sessionToken, "", "20").events, []);
  assert.deepEqual(h.chat.pull(h.auth(h.adult), "", "20").events, []);
  assert.equal(h.chat.status(h.auth(h.adult)).deviceSequence, 0);
  assert.deepEqual(h.relay.eventUsage(h.auth(h.adult)), { events: 3, eventLimit: MAX_HOUSEHOLD_BOARD_EVENTS });
});

bothStores("the envelope rules hold on the board stream", (h) => {
  const auth = h.auth(h.adult);
  h.relay.push(auth, [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]);
  assert.throws(() => h.relay.push(auth, [envelope(h.adult, { eventId: hex(2), deviceSequence: 3 })]), rejects("sync_sequence_gap", 409));
  assert.equal(h.relay.push(auth, [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]).accepted, 1, "a retry is idempotent");
  assert.throws(() => h.relay.push(auth, [envelope(h.adult, { eventId: hex(1), deviceSequence: 2 })]), rejects("event_duplicate_conflict", 409));
  assert.throws(() => h.relay.push(auth, [envelope(h.laptop, { eventId: hex(4), deviceSequence: 1 })]), rejects("event_envelope_invalid", 400));
  assert.throws(() => h.relay.push(auth, [envelope(h.adult, { eventId: hex(5), deviceSequence: 2, keyEpoch: 2 })]), rejects("event_envelope_invalid", 400));
  assert.throws(() => h.relay.push(auth, []), rejects("sync_batch_invalid", 400));
  assert.throws(() => h.relay.push(auth, [envelope(h.adult, { eventId: hex(6), deviceSequence: 2, logicalTime: 10 ** 15 })]), rejects("logical_time_invalid", 400));
  assert.throws(() => h.relay.pull(auth, "AAAAAAAAAAk", "20"), rejects("sync_cursor_invalid", 400));
  assert.throws(() => h.relay.pull(auth, "", "201"), rejects("sync_cursor_invalid", 400));
});

bothStores("the board waits for household sync and key rotations", (h) => {
  h.sync.state(h.adult.householdId).rotationPending = true;
  assert.throws(() => h.relay.push(h.auth(h.adult), [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]), rejects("sync_rotation_pending", 409));
  h.sync.state(h.adult.householdId).rotationPending = false;
  h.sync.state(h.adult.householdId).enabled = false;
  assert.throws(() => h.relay.push(h.auth(h.adult), [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]), rejects("board_sync_unavailable", 409));
});

bothStores("members who can't take part can't reach the fridge", (h) => {
  const auth = h.auth(h.adult);
  const removed = { ...auth, member: { ...auth.member, active: false } };
  assert.throws(() => h.relay.push(removed, [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]), rejects("board_unavailable", 403));
  assert.throws(() => h.relay.pull(removed, "", "20"), rejects("board_unavailable", 403));
  assert.throws(() => h.relay.status(removed), rejects("board_unavailable", 403));
});

bothStores("a device can send only so many board events a minute", (h) => {
  const auth = h.auth(h.adult);
  let sequence = 0;
  const batch = (count) => Array.from({ length: count }, () => { sequence += 1; return envelope(h.adult, { eventId: hex(sequence % 250, 15) + sequence.toString(16).padStart(2, "0").slice(-2), deviceSequence: sequence }); });
  for (let sent = 0; sent < BOARD_EVENTS_PER_MINUTE; sent += 20) h.relay.push(auth, batch(20));
  assert.throws(() => h.relay.push(auth, batch(1)), rejects("board_rate_limited", 429));
});

test("the board relay persists and household deletion purges it", () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household(store);
    h.relay.push(h.auth(h.adult), [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]);
    assert.equal(new BoardRelayService({ syncService: h.sync, store }).pull(h.auth(h.laptop), "", "20").events.length, 1);
    assert.deepEqual(store.boardRelayState(h.adult.householdId), { nextSequence: 2, eventCount: 1, maxLogicalTime: "1" });
    assert.ok(store.householdPurgeStatus(h.adult.householdId).counts.boardEvents > 0);
    store.forcePurgeHousehold(h.adult.householdId, Date.now());
    assert.equal(store.householdPurgeStatus(h.adult.householdId).counts.boardEvents, 0);
    assert.equal(store.validate(), true);
  } finally {
    store.close();
  }
});

test("the board routes move binary batches and pages", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${url}/api/board/events`)).status, 401);
  const adult = app.service.bootstrap({ credential: credential("adult") });
  app.syncService.enable(adult.sessionToken);
  const cookie = `kin_session=${adult.sessionToken}; kin_device=${adult.deviceToken}`;
  const push = await fetch(`${url}/api/board/events`, {
    method: "POST", headers: { cookie, "content-type": ENVELOPE_CONTENT_TYPE },
    body: encodeEnvelopeBatch([envelope(adult, { eventId: hex(7), deviceSequence: 1 })]),
  });
  assert.equal(push.status, 200);
  assert.equal((await push.json()).accepted, 1);
  const pull = await fetch(`${url}/api/board/events?cursor=&limit=20`, { headers: { cookie } });
  assert.equal(pull.status, 200);
  assert.deepEqual(decodeEventPage(new Uint8Array(await pull.arrayBuffer())).events.map((row) => row.envelope.eventId), [hex(7)]);
  const status = await (await fetch(`${url}/api/board/status`, { headers: { cookie } })).json();
  assert.equal(status.deviceSequence, 1);
  assert.equal(status.events, 1);
  const chat = await fetch(`${url}/api/chat/events?cursor=&limit=20`, { headers: { cookie } });
  assert.equal(decodeEventPage(new Uint8Array(await chat.arrayBuffer())).events.length, 0, "chat never sees the fridge");
});

// ---- Who can use the fridge (#323) -------------------------------------------

/** A household with a Limited member's device beside the admin's. */
function withLimited(store = null) {
  const h = household(store);
  const invitation = h.pairing.createPairing(h.adult.sessionToken, { kind: "limited" });
  const claim = h.pairing.claimPairing({ code: invitation.code, credential: credential(`child-${Math.random()}`), deviceLabel: "Tablet" });
  h.pairing.approvePairing(h.adult.sessionToken, invitation.pairingId, claim.version);
  const child = h.pairing.activateClaim(claim.claimToken);
  return { ...h, child };
}

bothStoresWith(withLimited, "the admin decides whether Limited members draw, look or have no access", (h) => {
  const draw = (who, eventId, deviceSequence) => h.relay.push(h.auth(who), [envelope(who, { eventId, deviceSequence })]);
  assert.equal(draw(h.child, hex(1), 1).accepted, 1, "everyone draws by default");
  assert.equal(h.sync.status(h.child.sessionToken).board.access, "write");
  assert.deepEqual(h.sync.status(h.adult.sessionToken).board.policy, { limited: "write", temporary: "write" }, "the admin sees the policy");
  assert.equal(h.sync.status(h.child.sessionToken).board.policy, undefined, "others don't");
  assert.deepEqual(h.sync.householdSettings(h.adult.sessionToken).boardPolicy, { limited: "write", temporary: "write" }, "it comes with the household settings");
  assert.equal(h.sync.householdSettings(h.child.sessionToken).boardPolicy, undefined);
  // Only the admin, with a fresh passkey, changes it.
  assert.throws(() => h.pairing.setBoardPolicy(h.child.sessionToken, { limited: "none", temporary: "write" }, h.child.memberId), (error) => error.code === "household_admin_required" || error.status === 403);
  assert.throws(() => h.pairing.setBoardPolicy(h.adult.sessionToken, { limited: "read", temporary: "write" }, "someone-else"), (error) => error.code === "fresh_auth_required");
  assert.throws(() => h.pairing.setBoardPolicy(h.adult.sessionToken, { limited: "maybe", temporary: "write" }, h.adult.memberId), (error) => error.code === "board_policy_invalid");
  assert.deepEqual(h.pairing.setBoardPolicy(h.adult.sessionToken, { limited: "read", temporary: "write" }, h.adult.memberId), { limited: "read", temporary: "write", revision: 1, changed: true });
  // Look only: the fridge reads, but nothing new goes up.
  assert.equal(h.sync.status(h.child.sessionToken).board.access, "read");
  assert.throws(() => draw(h.child, hex(2), 2), rejects("board_read_only", 403));
  assert.equal(h.relay.pull(h.auth(h.child), "", "20").events.length, 1);
  // No access: not even reading.
  h.pairing.setBoardPolicy(h.adult.sessionToken, { limited: "none", temporary: "write" }, h.adult.memberId);
  assert.throws(() => h.relay.pull(h.auth(h.child), "", "20"), rejects("board_unavailable", 403));
  assert.throws(() => h.relay.status(h.auth(h.child)), rejects("board_unavailable", 403));
  // Adults always draw.
  assert.equal(draw(h.adult, hex(3), 1).accepted, 1);
});

test("the fridge policy persists across a restart", () => {
  const store = new DurableStore(":memory:");
  try {
    const h = withLimited(store);
    h.pairing.setBoardPolicy(h.adult.sessionToken, { limited: "read", temporary: "none" }, h.adult.memberId);
    const reloaded = new PairingService({ store });
    assert.deepEqual(reloaded.households.get(h.adult.householdId).boardPolicy, { limited: "read", temporary: "none", revision: 1 });
    assert.equal(store.validate(), true);
  } finally {
    store.close();
  }
});

function bothStoresWith(make, name, body) {
  test(`${name} (in memory)`, () => body(make()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(make(store)); } finally { store.close(); }
  });
}
