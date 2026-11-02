// "Set up Kin for someone" (#613): an invitation a household admin prepares
// for one person. It carries the member kind and easy mode, and a card sealed
// on the admin's device that the service stores without reading; it lasts up
// to 7 days and survives a restart, so a printed sheet still works; it stays
// single-use, and the inviter still approves the claim after comparing
// fingerprints.
import assert from "node:assert/strict";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import {
  CLAIM_TTL_MS,
  PairingError,
  PairingService,
} from "./pairing-service.mjs";
import {
  MAX_PREPARED_INVITATIONS,
  PREPARED_CLAIM_TTL_MS,
  PREPARED_DAY_MS,
  preparedVerifier,
} from "./pairing-service/shared.mjs";
import { createKinServer } from "./server.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && (status === undefined || error.status === status);
// A sealed card as the admin's device makes it: base64url, opaque here.
const CARD = "A".repeat(16) + "sealed-card_bytes-0123456789abcdefghijklmnop";

function clock(start = Date.UTC(2026, 9, 21, 9)) {
  const time = { now: start };
  return { time, now: () => time.now };
}

function household({ store = null, now } = {}) {
  const pairing = new PairingService({ store, now });
  const admin = pairing.bootstrap({ credential: credential(`admin-${Math.random()}`) });
  return { pairing, admin };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(null));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(store); } finally { store.close(); }
  });
}

bothStores("a prepared invitation carries the kind, easy mode and the sealed card to whoever holds the code", (store) => {
  const { time, now } = clock();
  const { pairing, admin } = household({ store, now });
  const made = pairing.createPreparedPairing(admin.sessionToken, { kind: "adult", easyMode: true, card: CARD, days: 7 });
  assert.match(made.code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(made.prepared, true);
  assert.equal(made.easyMode, true);
  assert.equal(made.state, "Pending");
  assert.equal(made.invitationExpiresAt, time.now + 7 * PREPARED_DAY_MS);
  assert.equal(made.expiresAt, made.invitationExpiresAt);
  const checked = pairing.validatePairingCode(made.code.toLowerCase().replace("-", " "));
  assert.deepEqual(checked, { valid: true, purpose: "adult", prepared: { memberKind: "adult", easyMode: true, card: CARD, expiresAt: made.invitationExpiresAt } });
  // An ordinary invitation says nothing more than before.
  const ordinary = pairing.createPairing(admin.sessionToken, { kind: "adult" });
  assert.deepEqual(pairing.validatePairingCode(ordinary.code), { valid: true, purpose: "adult" });
  // ... and making it didn't end the prepared one (nor the reverse).
  assert.equal(pairing.pairingForAdult(admin.sessionToken, made.pairingId).state, "Pending");
  pairing.createPreparedPairing(admin.sessionToken, { kind: "limited", easyMode: false });
  assert.equal(pairing.pairingForAdult(admin.sessionToken, ordinary.pairingId).state, "Pending");
  if (store) {
    const rows = store.loadPreparedInvitations(time.now);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.id === made.pairingId).verifier, preparedVerifier(made.code));
    assert.ok(!JSON.stringify(rows).includes(made.code.replace("-", "")), "the service keeps a verifier, never the code");
  }
});

bothStores("a prepared invitation is single-use and still needs the inviter's approval", (store) => {
  const { now } = clock();
  const { pairing, admin } = household({ store, now });
  const made = pairing.createPreparedPairing(admin.sessionToken, { easyMode: true, card: CARD, days: 3 });
  const claim = pairing.claimPairing({ code: made.code, credential: credential("rose"), deviceLabel: "Safari on iPhone" });
  assert.throws(() => pairing.activateClaim(claim.claimToken), rejects("claim_not_confirmed", 409), "nothing before approval");
  const waiting = pairing.pairingForClaim(claim.claimToken);
  assert.equal(waiting.prepared, true);
  assert.equal(waiting.easyMode, true);
  assert.throws(() => pairing.claimPairing({ code: made.code, credential: credential("other"), deviceLabel: "x" }), rejects("pairing_claimed", 409));
  pairing.approvePairing(admin.sessionToken, made.pairingId, claim.version);
  const joined = pairing.activateClaim(claim.claimToken);
  assert.equal(pairing.members.get(joined.memberId).householdId, admin.householdId);
  assert.throws(() => pairing.validatePairingCode(made.code), rejects("invalid_code", 404), "the code is spent");
  if (store) assert.deepEqual(store.loadPreparedInvitations(now()), [], "and gone from the service's database");
});

bothStores("a prepared invitation lasts 1 to 7 days and its claim waits a day for approval", (store) => {
  const { time, now } = clock();
  const { pairing, admin } = household({ store, now });
  for (const days of [0, 8, 1.5, "7"])
    assert.throws(() => pairing.createPreparedPairing(admin.sessionToken, { days }), rejects("prepared_expiry_invalid"));
  const oneDay = pairing.createPreparedPairing(admin.sessionToken, { days: 1 });
  time.now += PREPARED_DAY_MS - 1;
  assert.equal(pairing.validatePairingCode(oneDay.code).valid, true);
  time.now += 1;
  assert.throws(() => pairing.validatePairingCode(oneDay.code), rejects("pairing_expired", 410));
  if (store) assert.deepEqual(store.loadPreparedInvitations(now()), []);
  // A day later the admin signs in again (sessions last 12 hours).
  const session = pairing.issueSession(admin.memberId, admin.deviceId).sessionToken;
  const week = pairing.createPreparedPairing(session, { days: 7 });
  time.now += 6 * PREPARED_DAY_MS;
  const claim = pairing.claimPairing({ code: week.code, credential: credential("late"), deviceLabel: "x" });
  // Longer than an ordinary claim's window, so the helper can answer later.
  assert.ok(claim.expiresAt - time.now === PREPARED_CLAIM_TTL_MS && PREPARED_CLAIM_TTL_MS > CLAIM_TTL_MS);
  time.now += PREPARED_CLAIM_TTL_MS;
  assert.equal(pairing.pairingForClaim(claim.claimToken).state, "Expired");
});

bothStores("its card must be a sealed value, and easy mode a yes or no", (store) => {
  const { pairing, admin } = household({ store });
  for (const card of ["short", "x".repeat(2049), "not base64url!".repeat(4), 42, { name: "Rose" }])
    assert.throws(() => pairing.createPreparedPairing(admin.sessionToken, { card }), rejects("prepared_card_invalid"));
  assert.throws(() => pairing.createPreparedPairing(admin.sessionToken, { easyMode: "yes" }), rejects("prepared_invalid"));
  assert.throws(() => pairing.createPreparedPairing(admin.sessionToken, { kind: "owner" }), rejects("member_kind_invalid"));
  assert.throws(() => pairing.createPreparedPairing(admin.sessionToken, { kind: "temporary" }), rejects("temporary_expiry_required"));
});

bothStores("only household management makes them, at most three wait, and each inviter sees their own", (store) => {
  const { now } = clock();
  const { pairing, admin } = household({ store, now });
  const invitation = pairing.createPairing(admin.sessionToken, { kind: "adult" });
  const claim = pairing.claimPairing({ code: invitation.code, credential: credential("adult"), deviceLabel: "x" });
  pairing.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
  const adult = pairing.activateClaim(claim.claimToken);
  assert.throws(() => pairing.createPreparedPairing(adult.sessionToken, {}), rejects("household_admin_required", 403));
  for (let index = 0; index < MAX_PREPARED_INVITATIONS; index += 1) pairing.createPreparedPairing(admin.sessionToken, { days: 2 });
  assert.throws(() => pairing.createPreparedPairing(admin.sessionToken, {}), rejects("prepared_limit", 409));
  const mine = pairing.preparedPairings(admin.sessionToken);
  assert.equal(mine.length, MAX_PREPARED_INVITATIONS);
  assert.ok(mine.every((entry) => entry.prepared && entry.state === "Pending" && !("code" in entry) && !("card" in entry)));
  assert.deepEqual(pairing.preparedPairings(adult.sessionToken), []);
  pairing.revokePairing(admin.sessionToken, mine[0].pairingId);
  assert.equal(pairing.preparedPairings(admin.sessionToken).length, MAX_PREPARED_INVITATIONS - 1);
  if (store) assert.equal(store.loadPreparedInvitations(now()).length, MAX_PREPARED_INVITATIONS - 1, "a cancelled one leaves the database");
  pairing.createPreparedPairing(admin.sessionToken, {});
});

test("a prepared invitation survives a restart; a claim in flight does not, and the code works again", () => {
  const store = new DurableStore(":memory:");
  try {
    const { time, now } = clock();
    const first = household({ store, now });
    const made = first.pairing.createPreparedPairing(first.admin.sessionToken, { easyMode: true, card: CARD, days: 7 });
    const ordinary = first.pairing.createPairing(first.admin.sessionToken, { kind: "adult" });
    first.pairing.claimPairing({ code: made.code, credential: credential("before"), deviceLabel: "x" });
    time.now += PREPARED_DAY_MS;
    // The service restarts: a new process, a new secret.
    const restarted = new PairingService({ store, now });
    assert.throws(() => restarted.validatePairingCode(ordinary.code), rejects("invalid_code", 404), "ordinary codes end with the process");
    assert.deepEqual(restarted.validatePairingCode(made.code).prepared, { memberKind: "adult", easyMode: true, card: CARD, expiresAt: made.invitationExpiresAt });
    // The inviter signs in again and finds it waiting.
    const session = restarted.issueSession(first.admin.memberId, first.admin.deviceId).sessionToken;
    assert.deepEqual(restarted.preparedPairings(session).map((entry) => entry.pairingId), [made.pairingId]);
    const claim = restarted.claimPairing({ code: made.code, credential: credential("rose"), deviceLabel: "x" });
    restarted.approvePairing(session, made.pairingId, claim.version);
    restarted.activateClaim(claim.claimToken);
    assert.deepEqual(store.loadPreparedInvitations(now()), []);
    // Another restart doesn't bring it back.
    assert.throws(() => new PairingService({ store, now }).validatePairingCode(made.code), rejects("invalid_code", 404));
    // Nor one past its expiry.
    const later = new PairingService({ store, now });
    const laterSession = later.issueSession(first.admin.memberId, first.admin.deviceId).sessionToken;
    const expiring = later.createPreparedPairing(laterSession, { days: 1 });
    time.now += PREPARED_DAY_MS;
    assert.throws(() => new PairingService({ store, now }).validatePairingCode(expiring.code), rejects("invalid_code", 404));
  } finally {
    store.close();
  }
});

test("deleting the household purges its prepared invitations", () => {
  const store = new DurableStore(":memory:");
  try {
    const { pairing, admin } = household({ store });
    pairing.createPreparedPairing(admin.sessionToken, { card: CARD });
    assert.equal(store.loadPreparedInvitations(Date.now()).length, 1);
    pairing.expireHouseholdPairings(admin.householdId);
    assert.equal(store.loadPreparedInvitations(Date.now()).length, 0);
  } finally {
    store.close();
  }
});

test("the routes: an admin prepares and lists; the code holder reads the card", async () => {
  const store = new DurableStore(":memory:");
  const kin = createKinServer({ port: 0, host: "127.0.0.1", origin: "http://127.0.0.1", store });
  try {
    const admin = kin.service.bootstrap({ credential: credential("route-admin") });
    await new Promise((done) => kin.server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${kin.server.address().port}`;
    const headers = { "Content-Type": "application/json", Origin: "http://127.0.0.1", Cookie: `kin_session=${admin.sessionToken}` };
    const made = await fetch(`${base}/api/pairings/prepared`, { method: "POST", headers, body: JSON.stringify({ kind: "adult", easyMode: true, card: CARD, days: 5 }) });
    assert.equal(made.status, 201);
    const value = await made.json();
    assert.equal(value.prepared, true);
    const listed = await (await fetch(`${base}/api/pairings/prepared`, { headers })).json();
    assert.deepEqual(listed.invitations.map((entry) => entry.pairingId), [value.pairingId]);
    const checked = await fetch(`${base}/api/account/invitation`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ code: value.code }) });
    assert.equal(checked.status, 200);
    assert.equal((await checked.json()).prepared.card, CARD);
    const refused = await fetch(`${base}/api/pairings/prepared`, { method: "POST", headers, body: JSON.stringify({ days: 30 }) });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, "prepared_expiry_invalid");
  } finally {
    kin.server.closeAllConnections?.();
    await new Promise((done) => kin.server.close(done));
    store.close();
  }
});
