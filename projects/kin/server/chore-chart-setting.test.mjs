// Adults on the chore chart (ADR 0022 §6, #676): a household admin, with a
// fresh passkey or password, allows adults to join the children's chart. The
// service keeps the choice and its revision (schema 28) and delivers it to
// every member as `choreChart` in /api/sync/status. Each adult still joins
// themselves, in the household history (kind 79).
import assert from "node:assert/strict";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService, choreChartOf } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && (status === undefined || error.status === status);

function household(store = null) {
  const pairing = new PairingService({ store });
  const sync = new EncryptedSyncService(pairing, { store });
  sync.liveService = { eventsAccepted() {}, revalidate() {} };
  sync.pushService = { eventsAccepted() {}, removeUntrusted() {} };
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
  return { pairing, sync, admin, adult, child };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store)); } finally { store.close(); }
  });
}

bothStores("adults stay off the chart until an admin allows them, and every member hears it", (h) => {
  for (const who of [h.admin, h.adult, h.child])
    assert.deepEqual(h.sync.status(who.sessionToken).choreChart, { adults: false, revision: 0, admin: who === h.admin });
  assert.deepEqual(h.pairing.setChoreChart(h.admin.sessionToken, { adults: true, expectedRevision: 0 }, h.admin.memberId),
    { adults: true, revision: 1, changed: true });
  for (const who of [h.admin, h.adult, h.child])
    assert.deepEqual(h.sync.status(who.sessionToken).choreChart, { adults: true, revision: 1, admin: who === h.admin });
  assert.deepEqual(h.pairing.setChoreChart(h.admin.sessionToken, { adults: true, expectedRevision: 1 }, h.admin.memberId),
    { adults: true, revision: 1, changed: false }, "the same choice changes nothing");
  assert.equal(h.pairing.setChoreChart(h.admin.sessionToken, { adults: false, expectedRevision: 1 }, h.admin.memberId).revision, 2);
});

bothStores("only a household admin with a fresh confirmation changes it, from the current revision", (h) => {
  assert.throws(() => h.pairing.setChoreChart(h.adult.sessionToken, { adults: true, expectedRevision: 0 }, h.adult.memberId), rejects("household_admin_required", 403));
  assert.throws(() => h.pairing.setChoreChart(h.child.sessionToken, { adults: true, expectedRevision: 0 }, h.child.memberId), rejects("adult_required", 403));
  assert.throws(() => h.pairing.choreChartContext(h.adult.sessionToken), rejects("household_admin_required", 403));
  assert.throws(() => h.pairing.setChoreChart(h.admin.sessionToken, { adults: true, expectedRevision: 0 }, h.adult.memberId), rejects("fresh_auth_required", 401));
  for (const change of [{ adults: "yes", expectedRevision: 0 }, { adults: true, expectedRevision: -1 }, { adults: true }, null])
    assert.throws(() => h.pairing.setChoreChart(h.admin.sessionToken, change, h.admin.memberId), rejects("chore_chart_invalid", 400));
  assert.throws(() => h.pairing.setChoreChart(h.admin.sessionToken, { adults: true, expectedRevision: 3 }, h.admin.memberId), rejects("chore_chart_stale", 409));
  assert.equal(choreChartOf(h.pairing.households.get(h.admin.householdId)).adults, false);
});

test("the setting persists across a restart, within the column bounds", () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household(store);
    h.pairing.setChoreChart(h.admin.sessionToken, { adults: true, expectedRevision: 0 }, h.admin.memberId);
    const reloaded = new PairingService({ store });
    assert.deepEqual(reloaded.households.get(h.admin.householdId).choreChart, { adults: true, revision: 1 });
    const row = store.db.prepare("SELECT chore_adults, chore_adults_revision FROM households WHERE id = ?").get(h.admin.householdId);
    assert.deepEqual({ ...row }, { chore_adults: 1, chore_adults_revision: 1 });
    assert.equal(store.validate(), true);
    assert.throws(() => store.db.prepare("UPDATE households SET chore_adults = 2 WHERE id = ?").run(h.admin.householdId), /CHECK/);
  } finally {
    store.close();
  }
});

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

test("the chore chart routes take an admin's fresh passkey and refuse others", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, webauthn: stubWebAuthn(), origin: "http://localhost", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const admin = app.service.bootstrap({ credential: credential("chores-admin") });
  const invitation = app.service.createPairing(admin.sessionToken, { kind: "adult" });
  const claim = app.service.claimPairing({ code: invitation.code, credential: credential("chores-sam"), deviceLabel: "Phone" });
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
  const change = { adults: true, expectedRevision: 0 };
  assert.equal((await call(sam, "/api/household/chore-chart/options", change)).status, 403, "not an admin");
  assert.equal((await call(admin, "/api/household/chore-chart/options", { adults: 1, expectedRevision: 0 })).status, 400);
  assert.equal((await call(admin, "/api/household/chore-chart/options", { adults: true, expectedRevision: 2 })).status, 409);
  const options = await call(admin, "/api/household/chore-chart/options", change);
  assert.equal(options.status, 200, JSON.stringify(options.body));
  assert.deepEqual(options.body.publicKey.allowCredentials, [{ id: "chores-admin" }]);
  const wrong = await call(admin, "/api/household/chore-chart/finish", { flow: options.body.flow, credential: { id: "chores-sam" } });
  assert.equal(wrong.status, 401, "another member's passkey");
  const again = await call(admin, "/api/household/chore-chart/options", change);
  const done = await call(admin, "/api/household/chore-chart/finish", { flow: again.body.flow, credential: { id: "chores-admin" } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body, { adults: true, revision: 1, changed: true });
  assert.deepEqual((await call(sam, "/api/sync/status")).body.choreChart, { adults: true, revision: 1, admin: false });
  // A features flow can't finish a chore chart change, or the other way.
  const features = await call(admin, "/api/household/features/options", { off: 0, expectedRevision: 0 });
  assert.equal((await call(admin, "/api/household/chore-chart/finish", { flow: features.body.flow, credential: { id: "chores-admin" } })).status, 400);
});
