// Household features (ADR 0021 §2, #624): a household admin, with a fresh
// passkey or password, switches features off for everyone. The service keeps
// the set and its revision, delivers it in /api/sync/status, and enforces
// Chat and Fridge; everything else is a layout the devices apply.
import assert from "node:assert/strict";
import test from "node:test";
import { BoardRelayService } from "./board-relay-service.mjs";
import { ChatRelayService } from "./chat-relay-service.mjs";
import { DurableStore } from "./durable-store.mjs";
import { HOUSEHOLD_FEATURE_BITS, KNOWN_FEATURE_MASK, PairingError, PairingService, featuresOf } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { FEATURES } from "../web/features.js";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const bit = (name) => 2 ** HOUSEHOLD_FEATURE_BITS[name];
const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && (status === undefined || error.status === status);

function household(store = null) {
  const pairing = new PairingService({ store });
  const sync = new EncryptedSyncService(pairing, { store });
  sync.liveService = { eventsAccepted() {}, revalidate() {} };
  sync.pushService = { eventsAccepted() {}, removeUntrusted() {} };
  const chat = new ChatRelayService({ syncService: sync, store });
  const board = new BoardRelayService({ syncService: sync, store });
  sync.chatRelayService = chat;
  const admin = pairing.bootstrap({ credential: credential(`admin-${Math.random()}`) });
  const join = (kind) => {
    const invitation = pairing.createPairing(admin.sessionToken, { kind });
    const claim = pairing.claimPairing({ code: invitation.code, credential: credential(`${kind}-${Math.random()}`), deviceLabel: kind });
    pairing.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  };
  const adult = join("adult");
  const child = join("limited");
  sync.enable(admin.sessionToken);
  const auth = (who) => sync.authorize(who.sessionToken);
  return { pairing, sync, chat, board, admin, adult, child, auth };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store)); } finally { store.close(); }
  });
}

test("the service and the devices name the same feature bits", () => {
  assert.deepEqual(
    Object.fromEntries(FEATURES.map((feature) => [feature.id, feature.bit])),
    { ...HOUSEHOLD_FEATURE_BITS },
    "web/features.js and pairing-service/shared.mjs agree",
  );
  // Derived from the list: bits are added by stories (ADR 0022), never reused.
  assert.equal(KNOWN_FEATURE_MASK, Object.values(HOUSEHOLD_FEATURE_BITS).reduce((mask, bit) => mask + 2 ** bit, 0));
  assert.equal(new Set(Object.values(HOUSEHOLD_FEATURE_BITS)).size, Object.keys(HOUSEHOLD_FEATURE_BITS).length, "no bit is used twice");
});

bothStores("everything is on until an admin switches something off, and status says so to every member", (h) => {
  for (const who of [h.admin, h.adult, h.child])
    assert.deepEqual(h.sync.status(who.sessionToken).features, { off: 0, revision: 0, admin: who === h.admin });
  const result = h.pairing.setFeatures(h.admin.sessionToken, { off: bit("meals") | bit("fridge"), expectedRevision: 0 }, h.admin.memberId);
  assert.deepEqual(result, { off: bit("meals") | bit("fridge"), revision: 1, changed: true });
  for (const who of [h.admin, h.adult, h.child])
    assert.deepEqual(h.sync.status(who.sessionToken).features, { off: bit("meals") | bit("fridge"), revision: 1, admin: who === h.admin });
  // The same set again changes nothing and keeps the revision.
  assert.deepEqual(h.pairing.setFeatures(h.admin.sessionToken, { off: bit("meals") | bit("fridge"), expectedRevision: 1 }, h.admin.memberId),
    { off: bit("meals") | bit("fridge"), revision: 1, changed: false });
});

bothStores("only a household admin with a fresh confirmation changes features", (h) => {
  assert.throws(() => h.pairing.setFeatures(h.adult.sessionToken, { off: bit("meals"), expectedRevision: 0 }, h.adult.memberId), rejects("household_admin_required", 403));
  assert.throws(() => h.pairing.setFeatures(h.child.sessionToken, { off: bit("meals"), expectedRevision: 0 }, h.child.memberId), rejects("adult_required", 403));
  assert.throws(() => h.pairing.featuresContext(h.adult.sessionToken), rejects("household_admin_required", 403));
  assert.throws(() => h.pairing.setFeatures(h.admin.sessionToken, { off: bit("meals"), expectedRevision: 0 }, h.adult.memberId), rejects("fresh_auth_required", 401));
  // Once promoted, the other Adult may.
  h.pairing.setHouseholdAdmin(h.admin.sessionToken, h.adult.memberId, true, h.admin.memberId);
  assert.equal(h.pairing.setFeatures(h.adult.sessionToken, { off: bit("journal"), expectedRevision: 0 }, h.adult.memberId).revision, 1);
  assert.equal(featuresOf(h.pairing.households.get(h.admin.householdId)).off, bit("journal"));
});

bothStores("a change made from a stale revision is refused", (h) => {
  h.pairing.setFeatures(h.admin.sessionToken, { off: bit("routines"), expectedRevision: 0 }, h.admin.memberId);
  assert.throws(() => h.pairing.setFeatures(h.admin.sessionToken, { off: bit("week"), expectedRevision: 0 }, h.admin.memberId), rejects("features_stale", 409));
  assert.throws(() => h.pairing.setFeatures(h.admin.sessionToken, { off: bit("week"), expectedRevision: 5 }, h.admin.memberId), rejects("features_stale", 409));
  assert.equal(featuresOf(h.pairing.households.get(h.admin.householdId)).off, bit("routines"), "the earlier choice stands");
  assert.equal(h.pairing.setFeatures(h.admin.sessionToken, { off: bit("week"), expectedRevision: 1 }, h.admin.memberId).revision, 2);
});

bothStores("unknown bits and malformed sets are rejected", (h) => {
  for (const off of [2 ** 30, KNOWN_FEATURE_MASK + 1, -1, 1.5, "3", null, 2 ** 40, Number.MAX_SAFE_INTEGER])
    assert.throws(() => h.pairing.setFeatures(h.admin.sessionToken, { off, expectedRevision: 0 }, h.admin.memberId), rejects("features_invalid", 400), `off ${off}`);
  for (const expectedRevision of [-1, "0", undefined, 0.5])
    assert.throws(() => h.pairing.setFeatures(h.admin.sessionToken, { off: 0, expectedRevision }, h.admin.memberId), rejects("features_invalid", 400));
  assert.equal(h.pairing.setFeatures(h.admin.sessionToken, { off: KNOWN_FEATURE_MASK, expectedRevision: 0 }, h.admin.memberId).off, KNOWN_FEATURE_MASK, "every known feature may be off");
});

bothStores("Chat and Fridge refuse everyone while switched off, and come back as they were", (h) => {
  const routes = (who) => ({
    chat: (() => { try { h.chat.status(h.auth(who)); return "open"; } catch (error) { return error.code; } })(),
    board: (() => { try { h.board.status(h.auth(who)); return "open"; } catch (error) { return error.code; } })(),
    access: { chat: h.sync.status(who.sessionToken).chat.access, board: h.sync.status(who.sessionToken).board.access },
  });
  assert.deepEqual(routes(h.admin), { chat: "open", board: "open", access: { chat: "write", board: "write" } });
  h.pairing.setFeatures(h.admin.sessionToken, { off: bit("chat") | bit("fridge"), expectedRevision: 0 }, h.admin.memberId);
  for (const who of [h.admin, h.adult, h.child])
    assert.deepEqual(routes(who), { chat: "chat_unavailable", board: "board_unavailable", access: { chat: "none", board: "none" } }, "Adults and admins too");
  assert.throws(() => h.chat.pull(h.auth(h.admin), "", "20"), rejects("chat_unavailable", 403));
  assert.throws(() => h.board.pull(h.auth(h.adult), "", "20"), rejects("board_unavailable", 403));
  assert.equal(h.sync.deviceDirectory(h.admin.sessionToken).every((device) => device.chatAccess === "none"), true, "nobody can be mentioned");
  // Meals off is a layout: the service enforces nothing for it.
  h.pairing.setFeatures(h.admin.sessionToken, { off: bit("meals"), expectedRevision: 1 }, h.admin.memberId);
  assert.deepEqual(routes(h.child), { chat: "open", board: "open", access: { chat: "write", board: "write" } });
  // The admin's own access policy still applies once the feature is on.
  h.pairing.setChatPolicy(h.admin.sessionToken, { limited: "read", temporary: "write" }, h.admin.memberId);
  assert.equal(h.sync.status(h.child.sessionToken).chat.access, "read");
});

test("household features persist across a restart, within the column bounds", () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household(store);
    h.pairing.setFeatures(h.admin.sessionToken, { off: bit("sitter") | bit("talk"), expectedRevision: 0 }, h.admin.memberId);
    const reloaded = new PairingService({ store });
    assert.deepEqual(reloaded.households.get(h.admin.householdId).features, { off: bit("sitter") | bit("talk"), revision: 1 });
    const row = store.db.prepare("SELECT features_off, features_revision FROM households WHERE id = ?").get(h.admin.householdId);
    assert.deepEqual({ ...row }, { features_off: bit("sitter") | bit("talk"), features_revision: 1 });
    assert.equal(store.validate(), true);
    assert.throws(() => store.db.prepare("UPDATE households SET features_off = -1 WHERE id = ?").run(h.admin.householdId), /CHECK/);
  } finally {
    store.close();
  }
});

// The HTTP routes: WebAuthn stands in for a browser's passkey.
function stubWebAuthn() {
  return {
    registrationOptions: (flow) => ({ challenge: flow }),
    authenticationOptions: (flow, credentialIds) => ({ challenge: flow, allowCredentials: credentialIds.map((id) => ({ id })) }),
    verifyRegistration: (response) => ({ id: response.id, publicKey: `key-${response.id}`, algorithm: -7, signCount: 0 }),
    verifyAuthentication(response, flow, registered) {
      if (!registered || response?.id !== registered.id) throw new PairingError("passkey_verification_failed", "Invalid passkey.", 401);
      return true;
    },
    discardFlow() {},
  };
}

test("the features routes take an admin's fresh passkey and refuse others", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, webauthn: stubWebAuthn(), origin: "http://localhost", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const admin = app.service.bootstrap({ credential: credential("features-admin") });
  const invitation = app.service.createPairing(admin.sessionToken, { kind: "adult" });
  const claim = app.service.claimPairing({ code: invitation.code, credential: credential("features-sam"), deviceLabel: "Phone" });
  app.service.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
  const sam = app.service.activateClaim(claim.claimToken);
  app.syncService.enable(admin.sessionToken);
  const call = async (who, path, body) => {
    const response = await fetch(`${url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: `kin_session=${who.sessionToken}; kin_device=${who.deviceToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const change = { off: bit("meals") | bit("fridge"), expectedRevision: 0 };
  assert.equal((await call(sam, "/api/household/features/options", change)).status, 403, "not an admin");
  assert.equal((await call(admin, "/api/household/features/options", { off: 2 ** 20, expectedRevision: 0 })).status, 400, "unknown bit");
  assert.equal((await call(admin, "/api/household/features/options", { off: 4, expectedRevision: 3 })).status, 409, "stale before the prompt");
  const options = await call(admin, "/api/household/features/options", change);
  assert.equal(options.status, 200, JSON.stringify(options.body));
  assert.deepEqual(options.body.publicKey.allowCredentials, [{ id: "features-admin" }]);
  const wrong = await call(admin, "/api/household/features/finish", { flow: options.body.flow, credential: { id: "features-sam" } });
  assert.equal(wrong.status, 401, "another member's passkey");
  const again = await call(admin, "/api/household/features/options", change);
  const done = await call(admin, "/api/household/features/finish", { flow: again.body.flow, credential: { id: "features-admin" } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body, { off: change.off, revision: 1, changed: true });
  const status = await call(sam, "/api/sync/status");
  assert.deepEqual(status.body.features, { off: change.off, revision: 1, admin: false });
  assert.equal(status.body.board.access, "none");
  assert.equal((await call(sam, "/api/board/status")).status, 403, "the Fridge route refuses");
  // A second screen still showing revision 0 is refused at finish too.
  const staleOptions = await call(admin, "/api/household/features/options", { off: 0, expectedRevision: 1 });
  app.service.setFeatures(admin.sessionToken, { off: 0, expectedRevision: 1 }, admin.memberId);
  const stale = await call(admin, "/api/household/features/finish", { flow: staleOptions.body.flow, credential: { id: "features-admin" } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "features_stale");
  assert.equal((await call(sam, "/api/board/status")).status, 200, "on again, the Fridge opens");
});
