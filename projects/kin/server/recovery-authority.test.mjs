// Issue #154 (A1): recovering a household admin needs an admin at the moment
// the recovery is approved, not only when it was created. Demoting an admin
// revokes the member recoveries they started.
import assert from "node:assert/strict";
import test from "node:test";
import { PairingService } from "./pairing-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

function addAdult(service, inviter, suffix) {
  const request = service.createPairing(inviter.sessionToken);
  const claim = service.claimPairing({
    code: request.code,
    credential: credential(`credential-${suffix}`),
    deviceLabel: `Adult ${suffix}`,
  });
  service.approvePairing(inviter.sessionToken, request.pairingId, claim.version);
  return service.activateClaim(claim.claimToken);
}

function household() {
  let now = 10_000;
  const service = new PairingService({ now: () => (now += 1) });
  const founder = service.bootstrap({ credential: credential("founder") });
  return { service, founder };
}

const promote = (service, by, target) =>
  service.setHouseholdAdmin(by.sessionToken, target.memberId, true, by.memberId);
const demote = (service, by, target) =>
  service.setHouseholdAdmin(by.sessionToken, target.memberId, false, by.memberId);

/** Start a recovery of `target` by `approver` and claim it with a new passkey. */
function claimedRecovery(service, approver, target, suffix) {
  const request = service.createMemberRecoveryPairing(approver.sessionToken, target.memberId);
  const claim = service.claimPairing({
    code: request.code,
    credential: credential(`recovered-${suffix}`),
    deviceLabel: `Recovered ${suffix}`,
  });
  return { request, claim };
}

function assertUntouched(service, target) {
  assert.equal(service.devices.get(target.deviceId).revokedAt, null, "the target's device stays trusted");
  assert.equal(service.authorize(target.sessionToken).member.id, target.memberId, "the target stays signed in");
  assert.ok(service.members.get(target.memberId).credentials.has(`credential-${target.suffix}`), "the target keeps its passkey");
}

test("a non-admin cannot approve recovery of a member promoted to admin after the recovery started", () => {
  const { service, founder } = household();
  const adultB = { ...addAdult(service, founder, "b"), suffix: "b" };
  const adultC = { ...addAdult(service, founder, "c"), suffix: "c" };
  // B is not an admin; C is not an admin yet, so creation is allowed.
  const { request, claim } = claimedRecovery(service, adultB, adultC, "c");
  promote(service, founder, adultC);
  assert.throws(
    () => service.approvePairing(adultB.sessionToken, request.pairingId, claim.version),
    (error) => error.code === "household_admin_required",
  );
  assertUntouched(service, adultC);
  assert.equal(
    service.events.some((event) => event.type === "member_recovery_completed"),
    false,
  );
});

test("demoting an admin revokes the member recovery they started", () => {
  const { service, founder } = household();
  const adultC = { ...addAdult(service, founder, "c"), suffix: "c" };
  const adultD = { ...addAdult(service, founder, "d"), suffix: "d" };
  promote(service, founder, adultC);
  promote(service, founder, adultD);
  // Admin founder starts recovering admin C, then D demotes the founder.
  const { request, claim } = claimedRecovery(service, founder, adultC, "c");
  demote(service, adultD, founder);
  assert.equal(service.pairings.get(request.pairingId).state, "Revoked");
  assert.ok(
    service.events.some((event) =>
      event.type === "pairing_revoked" && event.pairingId === request.pairingId && event.reason === "admin_revoked"),
  );
  assert.throws(
    () => service.approvePairing(founder.sessionToken, request.pairingId, claim.version),
    (error) => error.code === "pairing_revoked",
  );
  assertUntouched(service, adultC);
});

test("approval re-checks the approver's current admin role even if the pairing survived", () => {
  // Defense in depth: the approval check holds without the demotion revocation.
  const { service, founder } = household();
  const adultC = { ...addAdult(service, founder, "c"), suffix: "c" };
  const adultD = { ...addAdult(service, founder, "d"), suffix: "d" };
  promote(service, founder, adultC);
  promote(service, founder, adultD);
  const { request, claim } = claimedRecovery(service, founder, adultC, "c");
  delete service.members.get(founder.memberId).householdAdmin;
  assert.throws(
    () => service.approvePairing(founder.sessionToken, request.pairingId, claim.version),
    (error) => error.code === "household_admin_required",
  );
  assertUntouched(service, adultC);
});

test("an admin can still recover another admin", () => {
  const { service, founder } = household();
  const adultC = { ...addAdult(service, founder, "c"), suffix: "c" };
  promote(service, founder, adultC);
  const { request, claim } = claimedRecovery(service, founder, adultC, "c");
  service.approvePairing(founder.sessionToken, request.pairingId, claim.version);
  const recovered = service.activateClaim(claim.claimToken);
  assert.equal(recovered.memberId, adultC.memberId);
  assert.notEqual(service.devices.get(adultC.deviceId).revokedAt, null);
});

test("a non-admin can still recover a non-admin", () => {
  const { service, founder } = household();
  const adultB = addAdult(service, founder, "b");
  const adultC = addAdult(service, founder, "c");
  const { request, claim } = claimedRecovery(service, adultB, adultC, "c");
  service.approvePairing(adultB.sessionToken, request.pairingId, claim.version);
  assert.equal(service.activateClaim(claim.claimToken).memberId, adultC.memberId);
});

test("demotion leaves the demoted admin's own device pairing alone", () => {
  const { service, founder } = household();
  const adultD = addAdult(service, founder, "d");
  promote(service, founder, adultD);
  const devicePairing = service.createDevicePairing(founder.sessionToken);
  demote(service, adultD, founder);
  assert.equal(service.pairings.get(devicePairing.pairingId).state, "Pending");
});
