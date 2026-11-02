// Devices carried over from the old address (ADR 0026 §6, #769): after a
// move they can't sign in here, and a household admin removes them
// together, after one fresh confirmation, in one revocation with one new
// household epoch.
import assert from "node:assert/strict";
import test from "node:test";
import { derivePasswordKeys } from "../web/security/account-vault.js";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { requestBody } from "./sync-wire-test-utils.mjs";

const FLOW_TTL_MS = 2 * 60 * 1000;
const OPTIONS = "/api/devices/carried-over/revocation/options";
const FINISH = "/api/devices/carried-over/revocation/finish";
const credential = (suffix) => ({ id: `credential-${suffix}`, publicKey: `key-${suffix}`, algorithm: -7 });

// The WebAuthn checks stand in for a browser's passkey: an assertion passes
// when it names a registered credential and the flow it was asked for.
function stubWebAuthn() {
  return {
    registrationOptions: (flow) => ({ challenge: flow }),
    authenticationOptions: (flow, credentialIds) => ({ challenge: flow, allowCredentials: credentialIds.map((id) => ({ id })) }),
    verifyRegistration: (response) => ({ id: response.id, publicKey: `key-${response.id}`, algorithm: -7, signCount: 0 }),
    verifyAuthentication(response, flow, registered) {
      if (!registered || response?.id !== registered.id || response?.flow !== flow)
        throw new PairingError("passkey_verification_failed", "Invalid passkey.", 401);
      // As a real authenticator does, each use raises the signature counter.
      registered.signCount += 1;
      return true;
    },
    discardFlow() {},
  };
}

/** A household whose admin signed in here, and devices from the old address:
 * the admin's old laptop and both of Sam's devices. Robin (an Adult) and Kit
 * (Limited) signed in here too. */
async function movedHousehold(t) {
  let now = 1_000_000;
  const clock = () => now;
  const service = new PairingService({ now: clock, secret: Buffer.alloc(32, 7) });
  const admin = service.bootstrap({ credential: credential("admin"), deviceLabel: "Admin phone" });
  const add = (request, suffix, actor = admin) => {
    const claim = service.claimPairing({ code: request.code, credential: credential(suffix), deviceLabel: suffix, rateKey: suffix });
    service.approvePairing(actor.sessionToken, request.pairingId, claim.version);
    return service.activateClaim(claim.claimToken);
  };
  const adminTablet = add(service.createDevicePairing(admin.sessionToken), "admin-tablet");
  const adminLaptop = add(service.createDevicePairing(admin.sessionToken), "admin-laptop");
  const sam = add(service.createPairing(admin.sessionToken), "sam");
  const samTablet = add(service.createDevicePairing(sam.sessionToken), "sam-tablet", sam);
  const robin = add(service.createPairing(admin.sessionToken), "robin");
  const kit = add(service.createPairing(admin.sessionToken, { kind: "limited" }), "kit");

  const store = new DurableStore(":memory:");
  const application = createKinServer({ service, store, webauthn: stubWebAuthn(), now: clock, origin: "http://localhost" });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => application.server.close(resolve)).finally(() => store.close()));
  const url = `http://127.0.0.1:${application.server.address().port}`;
  const call = async (path, who, body = {}) => {
    const request = requestBody(path, "POST", body);
    const response = await fetch(`${url}${path}`, {
      method: "POST", headers: { ...request.headers, Cookie: `kin_session=${who.sessionToken}` }, body: request.body,
    });
    return { status: response.status, body: await response.json() };
  };

  // What the import and a restart leave behind: the mark, and no token.
  const carried = [adminLaptop, sam, samTablet];
  for (const { deviceId } of carried) {
    const device = service.devices.get(deviceId);
    service.deviceTokens.delete(device.tokenHash);
    device.tokenHash = null;
    device.carriedOver = true;
    for (const [sessionHash, session] of service.sessions)
      if (session.deviceId === deviceId) service.sessions.delete(sessionHash);
  }
  service.persistHousehold(admin.householdId);
  application.syncService.enable(admin.sessionToken);
  return {
    service, store, application, admin, adminTablet, adminLaptop, sam, samTablet, robin, kit, call,
    carriedIds: carried.map(({ deviceId }) => deviceId),
    advance: (value) => { now += value; },
    finish: (who, flow, id = "credential-admin") => call(FINISH, who, { flow, credential: { id, flow } }),
    status: () => application.syncService.status(admin.sessionToken),
    revoked: (ids) => ids.filter((deviceId) => service.devices.get(deviceId).revokedAt),
  };
}

test("the device list says which devices came from the old address", async (t) => {
  const household = await movedHousehold(t);
  const listed = household.service.listDevices(household.admin.sessionToken);
  assert.deepEqual(listed.filter((device) => device.carriedOver).map((device) => device.id).sort(), [...household.carriedIds].sort());
  assert.equal(listed.find((device) => device.id === household.admin.deviceId).carriedOver, false);
});

test("only a household admin can remove devices from the old address", async (t) => {
  const household = await movedHousehold(t);
  const asAdult = await household.call(OPTIONS, household.robin);
  assert.equal(asAdult.status, 403);
  assert.equal(asAdult.body.error, "household_admin_required");
  const asLimited = await household.call(OPTIONS, household.kit);
  assert.equal(asLimited.status, 403);
  assert.equal(asLimited.body.error, "adult_required");
  assert.deepEqual(household.revoked(household.carriedIds), []);
});

test("removal takes one fresh confirmation bound to the admin's session and device", async (t) => {
  const household = await movedHousehold(t);
  const { admin, adminTablet, call, finish } = household;
  const unchanged = () => {
    assert.deepEqual(household.revoked(household.carriedIds), []);
    assert.equal(household.status().rotationPending, false);
  };
  const options = async (who = admin) => {
    const response = await call(OPTIONS, who);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };

  const started = await options();
  assert.equal(started.devices, 3);
  assert.ok(started.publicKey.allowCredentials.some(({ id }) => id === "credential-admin"));
  assert.ok(!started.publicKey.allowCredentials.some(({ id }) => id === "credential-sam"));
  assert.deepEqual([...household.application.flows.get(started.flow).deviceIds].sort(), [...household.carriedIds].sort());
  unchanged(); // asking isn't removing

  assert.equal((await finish(admin, (await options()).flow, "credential-sam")).status, 401, "someone else's passkey");
  unchanged();
  assert.equal((await finish(admin, (await options(adminTablet)).flow, "credential-admin-tablet")).status, 400, "a flow from another session");
  unchanged();

  // Each finish takes only its own kind of flow.
  const single = await call(`/api/devices/${household.sam.deviceId}/revocation/options`, admin);
  assert.equal((await finish(admin, single.body.flow)).status, 400);
  const bulk = await options();
  assert.equal((await call("/api/devices/revocation/finish", admin, { flow: bulk.flow, credential: { id: "credential-admin", flow: bulk.flow } })).status, 400);
  unchanged();

  const late = await options();
  household.advance(FLOW_TTL_MS + 1);
  assert.equal((await finish(admin, late.flow)).status, 410);
  unchanged();
});

test("one removal revokes every carried-over device with one time and one new epoch", async (t) => {
  const household = await movedHousehold(t);
  const { admin, service, application, call, finish } = household;
  const epoch = household.status().currentEpoch;
  const changes = [];
  const onAccessChange = application.syncService.onAccessChange.bind(application.syncService);
  application.syncService.onAccessChange = (householdId, ids) => { changes.push([householdId, [...ids].sort()]); return onAccessChange(householdId, ids); };

  const started = await call(OPTIONS, admin);
  const finished = await finish(admin, started.body.flow);
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.deepEqual([...finished.body.revoked].sort(), [...household.carriedIds].sort());
  const times = new Set(household.carriedIds.map((deviceId) => service.devices.get(deviceId).revokedAt));
  assert.deepEqual([...times], [finished.body.revokedAt], "one time for all of them");
  assert.deepEqual(changes, [[admin.householdId, [...household.carriedIds].sort()]], "one access change");
  assert.equal(household.status().rotationPending, true);
  assert.equal(household.status().currentEpoch, epoch);
  const audited = service.events.filter((event) => event.type === "device_revoked" && event.reason === "carried_over");
  assert.deepEqual(audited.map((event) => event.deviceId).sort(), [...household.carriedIds].sort());
  for (const untouched of [admin, household.adminTablet, household.robin, household.kit])
    assert.equal(service.devices.get(untouched.deviceId).revokedAt, null);
  assert.equal(service.listDevices(admin.sessionToken).some((device) => device.carriedOver), false);

  // It survives a restart; there is nothing left to remove.
  const reloaded = new PairingService({ store: household.store });
  for (const deviceId of household.carriedIds) assert.equal(reloaded.devices.get(deviceId).revokedAt, finished.body.revokedAt);
  const again = await call(OPTIONS, admin);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "nothing_carried_over");
});

test("a device that re-joined between asking and confirming is left alone", async (t) => {
  const household = await movedHousehold(t);
  const { admin, service, application, call, finish } = household;
  let accessChanges = 0;
  const onAccessChange = application.syncService.onAccessChange.bind(application.syncService);
  application.syncService.onAccessChange = (...args) => { accessChanges += 1; return onAccessChange(...args); };

  const started = await call(OPTIONS, admin);
  // Sam's tablet signs in here again; the admin's laptop is replaced.
  service.issueDeviceToken(service.devices.get(household.samTablet.deviceId));
  service.devices.get(household.adminLaptop.deviceId).revokedAt = service.now();
  const finished = await finish(admin, started.body.flow);
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.deepEqual(finished.body.revoked, [household.sam.deviceId]);
  assert.equal(service.devices.get(household.samTablet.deviceId).revokedAt, null);
  assert.equal(accessChanges, 1);
});

test("when every device re-joined before confirming, nothing changes and there is no new epoch", async (t) => {
  const household = await movedHousehold(t);
  const { admin, service, call, finish } = household;
  const started = await call(OPTIONS, admin);
  for (const deviceId of household.carriedIds) service.issueDeviceToken(service.devices.get(deviceId));
  const none = await finish(admin, started.body.flow);
  assert.equal(none.status, 200, JSON.stringify(none.body));
  assert.deepEqual(none.body, { revoked: [], revokedAt: null });
  assert.deepEqual(household.revoked(household.carriedIds), []);
  assert.equal(household.status().rotationPending, false);
  // The confirmation's raised signature counter is still saved.
  const counter = service.credentials.get("credential-admin").signCount;
  assert.ok(counter > 0);
  assert.equal(new PairingService({ store: household.store }).credentials.get("credential-admin").signCount, counter);
});

test("a device given a token here is no longer carried over", async (t) => {
  const household = await movedHousehold(t);
  const { service, admin, samTablet } = household;
  service.issueDeviceToken(service.devices.get(samTablet.deviceId));
  service.persistHousehold(admin.householdId);
  assert.equal("carriedOver" in service.devices.get(samTablet.deviceId), false);
  assert.equal("carriedOver" in new PairingService({ store: household.store }).devices.get(samTablet.deviceId), false);
  assert.equal(service.carriedOverRevocationContext(admin.sessionToken).deviceIds.includes(samTablet.deviceId), false);
});

test("the admin check takes several devices at once", async (t) => {
  const household = await movedHousehold(t);
  const { service, admin, adminTablet } = household;
  const record = service.households.get(admin.householdId);
  assert.doesNotThrow(() => service.requireAdminAccessAfterRevocation(record, household.carriedIds));
  assert.throws(() => service.requireAdminAccessAfterRevocation(record, [admin.deviceId, adminTablet.deviceId, household.adminLaptop.deviceId]),
    { code: "last_household_admin" });
});

// #778: a device from the old address can't sign in here, so it doesn't keep
// a household admin's access usable.
test("an admin's devices from the old address don't count as usable access", async (t) => {
  const household = await movedHousehold(t);
  const { service, admin, adminTablet, adminLaptop } = household;
  const record = service.households.get(admin.householdId);
  // Only the old laptop would be left.
  assert.throws(() => service.requireAdminAccessAfterRevocation(record, [admin.deviceId, adminTablet.deviceId]),
    { code: "last_household_admin" });
  // One that still has a token can sign in here, so it counts.
  const laptop = service.devices.get(adminLaptop.deviceId);
  laptop.tokenHash = "a-token-hash";
  laptop.carriedOver = true;
  assert.doesNotThrow(() => service.requireAdminAccessAfterRevocation(record, [admin.deviceId, adminTablet.deviceId]));
});

test("an admin whose devices are all from the old address isn't another usable admin", async (t) => {
  const household = await movedHousehold(t);
  const { service, admin, sam } = household;
  // Sam is an admin, but both of Sam's devices came from the old address.
  service.members.get(sam.memberId).householdAdmin = true;
  assert.throws(() => service.setHouseholdAdmin(admin.sessionToken, admin.memberId, false, admin.memberId),
    { code: "last_household_admin" });
  assert.throws(() => service.leaveHousehold(admin.sessionToken, admin.memberId),
    { code: "last_household_admin" });
  assert.equal(service.members.get(admin.memberId).householdAdmin, true);
  assert.equal(service.members.get(admin.memberId).active, true);

  // The removal itself still goes ahead: the admin keeps devices signed in here.
  assert.deepEqual([...service.carriedOverRevocationContext(admin.sessionToken).deviceIds].sort(), [...household.carriedIds].sort());

  // Once Sam's tablet re-joins, Sam has usable access and the admin may step down.
  service.issueDeviceToken(service.devices.get(household.samTablet.deviceId));
  assert.equal(service.setHouseholdAdmin(admin.sessionToken, admin.memberId, false, admin.memberId).changed, true);
});

test("an Adult whose devices are all from the old address isn't another usable trusted Adult", async (t) => {
  const household = await movedHousehold(t);
  const { service, admin, robin, sam } = household;
  const record = service.households.get(admin.householdId);
  assert.equal(service.hasUsableTrustedDevice(sam.memberId), false);
  // Leave the admin with only the old laptop: then the other Adults besides
  // Robin have only devices from the old address, and neither counts.
  for (const { deviceId } of [admin, household.adminTablet]) service.devices.get(deviceId).revokedAt = service.now();
  assert.equal(service.hasOtherUsableTrustedAdult(record, robin.memberId), false);
  assert.throws(() => service.leaveHousehold(robin.sessionToken, robin.memberId), { code: "last_adult" });
  service.issueDeviceToken(service.devices.get(household.samTablet.deviceId));
  assert.equal(service.hasOtherUsableTrustedAdult(record, robin.memberId), true);
});

test("before any admin re-joins, an Adult can still revoke their own device", async (t) => {
  const household = await movedHousehold(t);
  const { service, admin, robin } = household;
  const request = service.createDevicePairing(robin.sessionToken);
  const claim = service.claimPairing({ code: request.code, credential: credential("robin-tablet"), deviceLabel: "robin-tablet", rateKey: "robin-tablet" });
  service.approvePairing(robin.sessionToken, request.pairingId, claim.version);
  const robinTablet = service.activateClaim(claim.claimToken);
  // The admin's devices came from the old address too, so no admin has usable
  // access yet; Robin revoking a device can't take any away.
  for (const { deviceId } of [admin, household.adminTablet]) {
    const device = service.devices.get(deviceId);
    service.deviceTokens.delete(device.tokenHash);
    device.tokenHash = null;
    device.carriedOver = true;
  }
  const record = service.households.get(admin.householdId);
  assert.equal(service.hasUsableAdminAccess(record), false);
  assert.ok(service.deviceRevocationContext(robin.sessionToken, robinTablet.deviceId));
  assert.ok(service.revokeDevice(robin.sessionToken, robinTablet.deviceId, robin.memberId).revokedAt);
});

test("an admin with no passkey confirms the removal with their password", { timeout: 60_000 }, async () => {
  const salt = new Uint8Array(16).fill(3);
  const { authKey, passwordKey } = await derivePasswordKeys("four unrelated words", salt);
  passwordKey.fill(0);
  const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
  const store = new DurableStore(":memory:");
  const application = createKinServer({ store, webauthn: stubWebAuthn(), origin: "http://localhost" });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${application.server.address().port}`;
  const jar = new Map();
  const call = async (path, body = {}) => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") },
      body: JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const [name, value] = line.split(";")[0].split("=");
      if (value) jar.set(name, value); else jar.delete(name);
    }
    return { status: response.status, body: await response.json() };
  };
  try {
    const created = await call("/api/account/bootstrap", { username: "admin.pw", authKey: b64(authKey), salt: b64(salt), iterations: 600_000, deviceLabel: "Phone" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { service } = application;
    const sessionToken = jar.get("kin_session");
    const request = service.createPairing(sessionToken);
    const claim = service.claimPairing({ code: request.code, credential: credential("old"), deviceLabel: "Old phone", rateKey: "old" });
    service.approvePairing(sessionToken, request.pairingId, claim.version);
    const old = service.activateClaim(claim.claimToken);
    const device = service.devices.get(old.deviceId);
    service.deviceTokens.delete(device.tokenHash);
    device.tokenHash = null;
    device.carriedOver = true;
    service.persistHousehold(created.body.householdId);

    const options = await call(OPTIONS);
    assert.equal(options.status, 200, JSON.stringify(options.body));
    assert.equal(options.body.password.username, "admin.pw");
    const finished = await call(FINISH, { flow: options.body.flow, authKey: b64(authKey) });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.deepEqual(finished.body.revoked, [old.deviceId]);
  } finally {
    await new Promise((resolve) => application.server.close(resolve));
    store.close();
  }
});
