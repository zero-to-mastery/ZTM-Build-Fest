import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "./durable-store.mjs";
import {
  MAX_TRUSTED_DEVICES,
  PairingService,
} from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

function addSameMemberDevice(service, adult, suffix) {
  const request = service.createDevicePairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: request.code,
    credential: credential(`credential-${suffix}`),
    deviceLabel: `Device ${suffix}`,
    rateKey: `device-${suffix}`,
  });
  service.approvePairing(
    adult.sessionToken,
    request.pairingId,
    claim.version,
  );
  return service.activateClaim(claim.claimToken);
}

test("replacement creates fresh device authority and revokes the lost device", () => {
  let now = 1_000;
  const service = new PairingService({ now: () => now });
  const adult = service.bootstrap({
    credential: credential("original"),
    deviceLabel: "Current phone",
  });
  const lost = addSameMemberDevice(service, adult, "lost");
  const lostSession = lost.sessionToken;

  now += 1;
  const request = service.createReplacementPairing(
    adult.sessionToken,
    lost.deviceId,
  );
  const claim = service.claimPairing({
    code: request.code,
    credential: credential("replacement"),
    deviceLabel: "Replacement phone",
  });
  const approved = service.approvePairing(
    adult.sessionToken,
    request.pairingId,
    claim.version,
  );
  const activated = service.activateClaim(claim.claimToken);

  assert.equal(approved.purpose, "replacement");
  assert.equal(approved.lostDeviceId, lost.deviceId);
  assert.notEqual(activated.deviceId, lost.deviceId);
  assert.equal(activated.memberId, adult.memberId);
  assert.equal(service.devices.get(lost.deviceId).revokedAt, now);
  assert.throws(
    () => service.authorize(lostSession),
    (error) => error.code === "authentication_required",
  );
  assert.equal(service.devices.get(activated.deviceId).revokedAt, null);
  assert.ok(
    service.events.some(
      (event) =>
        event.type === "device_replacement_completed" &&
        event.lostDeviceId === lost.deviceId,
    ),
  );
});

test("replacement is same-member, device-bound, single-use, and stale-safe", () => {
  const service = new PairingService();
  const adult = service.bootstrap({ credential: credential("a") });
  const lost = addSameMemberDevice(service, adult, "old");
  assert.throws(
    () => service.createReplacementPairing(adult.sessionToken, adult.deviceId),
    (error) => error.code === "replacement_unavailable",
  );
  assert.throws(
    () => service.createReplacementPairing(adult.sessionToken, "f".repeat(32)),
    (error) => error.code === "replacement_unavailable",
  );

  const request = service.createReplacementPairing(
    adult.sessionToken,
    lost.deviceId,
  );
  const claim = service.claimPairing({
    code: request.code,
    credential: credential("new"),
    deviceLabel: "New device",
  });
  assert.throws(
    () =>
      service.approvePairing(
        adult.sessionToken,
        request.pairingId,
        request.version,
      ),
    (error) => error.code === "stale_pairing",
  );
  service.approvePairing(
    adult.sessionToken,
    request.pairingId,
    claim.version,
  );
  assert.equal(
    service.approvePairing(
      adult.sessionToken,
      request.pairingId,
      claim.version,
    ).state,
    "Confirmed",
  );
  service.activateClaim(claim.claimToken);
  assert.throws(
    () => service.activateClaim(claim.claimToken),
    (error) => error.code === "claim_not_confirmed",
  );
});

function addAdult(service, adult, suffix = "b") {
  const request = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: request.code,
    credential: credential(`credential-${suffix}`),
    deviceLabel: `Adult ${suffix}`,
  });
  service.approvePairing(
    adult.sessionToken,
    request.pairingId,
    claim.version,
  );
  return service.activateClaim(claim.claimToken);
}

test("one adult authorizes another adult's fresh identity without impersonation", () => {
  let now = 5_000;
  const service = new PairingService({ now: () => now });
  const adultA = service.bootstrap({ credential: credential("adult-a") });
  const adultB = addAdult(service, adultA);
  const oldCredentialIds = [...service.members.get(adultB.memberId).credentials];

  now += 1;
  const request = service.createMemberRecoveryPairing(
    adultA.sessionToken,
    adultB.memberId,
  );
  const claim = service.claimPairing({
    code: request.code,
    credential: credential("adult-b-recovered"),
    deviceLabel: "B replacement",
  });
  service.approvePairing(
    adultA.sessionToken,
    request.pairingId,
    claim.version,
  );
  const recovered = service.activateClaim(claim.claimToken);

  assert.equal(recovered.memberId, adultB.memberId);
  assert.notEqual(recovered.memberId, adultA.memberId);
  assert.notEqual(recovered.deviceId, adultB.deviceId);
  assert.equal(service.devices.get(adultB.deviceId).revokedAt, now);
  assert.throws(
    () => service.authorize(adultB.sessionToken),
    (error) => error.code === "authentication_required",
  );
  for (const credentialId of oldCredentialIds)
    assert.equal(service.credentials.has(credentialId), false);
  assert.deepEqual(
    [...service.members.get(adultB.memberId).credentials],
    ["adult-b-recovered"],
  );
  assert.ok(
    service.events.some(
      (event) =>
        event.type === "member_recovery_completed" &&
        event.approverMemberId === adultA.memberId &&
        event.memberId === adultB.memberId,
    ),
  );
});

test("unrelated, removed, revoked, stale, and replayed recovery authority fails closed", () => {
  const service = new PairingService();
  const adultA = service.bootstrap({ credential: credential("a") });
  const adultB = addAdult(service, adultA, "target");
  const outsiderService = new PairingService();
  const outsider = outsiderService.bootstrap({ credential: credential("x") });
  assert.throws(
    () =>
      service.createMemberRecoveryPairing(
        adultA.sessionToken,
        outsider.memberId,
      ),
    (error) => error.code === "recovery_unavailable",
  );
  assert.throws(
    () => service.createMemberRecoveryPairing(adultA.sessionToken, adultA.memberId),
    (error) => error.code === "recovery_unavailable",
  );

  const request = service.createMemberRecoveryPairing(
    adultA.sessionToken,
    adultB.memberId,
  );
  const claim = service.claimPairing({
    code: request.code,
    credential: credential("fresh-b"),
    deviceLabel: "Fresh B",
  });
  assert.throws(
    () =>
      service.approvePairing(
        adultA.sessionToken,
        request.pairingId,
        request.version,
      ),
    (error) => error.code === "stale_pairing",
  );
  service.removeOtherAdult(adultA.sessionToken, adultB.memberId, adultA.memberId);
  assert.throws(
    () =>
      service.approvePairing(
        adultA.sessionToken,
        request.pairingId,
        claim.version,
      ),
    (error) => error.code === "membership_removed",
  );
  assert.throws(
    () => service.createMemberRecoveryPairing(adultB.sessionToken, adultA.memberId),
    (error) => ["authentication_required", "device_not_trusted"].includes(error.code),
  );
});

test("stale backup restore preserves newer recovery, revocation, credentials, and key authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-recovery-"));
  const targetPath = join(directory, "kin.sqlite");
  const backupPath = join(directory, "stale.sqlite");
  let store = new DurableStore(targetPath, { acquireProcessLock: false });
  try {
    const service = new PairingService({ store });
    const sync = new EncryptedSyncService(service, { store });
    const adultA = service.bootstrap({ credential: credential("restore-a") });
    const adultB = addAdult(service, adultA, "restore-b");
    await store.backup(backupPath);

    const request = service.createMemberRecoveryPairing(
      adultA.sessionToken,
      adultB.memberId,
    );
    const claim = service.claimPairing({
      code: request.code,
      credential: credential("restore-b-fresh"),
      deviceLabel: "Recovered B",
    });
    service.approvePairing(
      adultA.sessionToken,
      request.pairingId,
      claim.version,
    );
    const recovered = service.activateClaim(claim.claimToken);
    sync.onAccessChange(adultA.householdId, [adultB.deviceId]);
    const before = store.loadIdentity();
    assert.equal(before.credentials.has("credential-restore-b"), false);
    assert.equal(before.credentials.has("restore-b-fresh"), true);
    assert.ok(before.devices.get(adultB.deviceId).revokedAt);
    assert.equal(sync.status(adultA.sessionToken).rotationPending, true);
    assert.equal(store.loadActiveAuthority()[0].sync.rotation_pending, 1);
    store.close();
    store = null;

    const result = await DurableStore.restoreBackup(backupPath, targetPath, {
      acknowledgeDeletionHistory: true,
    });
    assert.equal(result.preservedAuthorityCount, 1);
    const restored = new DurableStore(targetPath, {
      acquireProcessLock: false,
    });
    try {
      const identity = restored.loadIdentity();
      assert.equal(identity.credentials.has("credential-restore-b"), false);
      assert.equal(identity.credentials.has("restore-b-fresh"), true);
      assert.ok(identity.devices.get(adultB.deviceId).revokedAt);
      assert.equal(identity.devices.get(recovered.deviceId).revokedAt, null);
      const restoredService = new PairingService({ store: restored });
      assert.equal(
        restored.loadSyncState(adultA.householdId, identity).rotationPending,
        true,
      );
      assert.throws(
        () =>
          restoredService.reauthenticate(
            adultB.deviceToken,
            "credential-restore-b",
          ),
        (error) => ["device_not_trusted", "invalid_passkey"].includes(error.code),
      );
      assert.equal(restored.validate(), true);
    } finally {
      restored.close();
    }
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("replacement succeeds at the trusted-device limit using post-operation capacity", () => {
  const service = new PairingService();
  const adult = service.bootstrap({ credential: credential("limit-a") });
  const devices = [];
  for (let index = 1; index < MAX_TRUSTED_DEVICES; index += 1)
    devices.push(addSameMemberDevice(service, adult, `limit-${index}`));
  assert.equal(
    service.activeTrustedDeviceCount(service.households.get(adult.householdId)),
    MAX_TRUSTED_DEVICES,
  );
  const lost = devices.at(-1);
  const request = service.createReplacementPairing(
    adult.sessionToken,
    lost.deviceId,
  );
  const claim = service.claimPairing({
    code: request.code,
    credential: credential("limit-replacement"),
    deviceLabel: "Limit replacement",
  });
  service.approvePairing(
    adult.sessionToken,
    request.pairingId,
    claim.version,
  );
  assert.equal(
    service.activeTrustedDeviceCount(service.households.get(adult.householdId)),
    MAX_TRUSTED_DEVICES,
  );
  assert.ok(service.devices.get(lost.deviceId).revokedAt);
});

test("member recovery succeeds at the trusted-device limit after target revocation", () => {
  const service = new PairingService();
  const adultA = service.bootstrap({ credential: credential("capacity-a") });
  const adultB = addAdult(service, adultA, "capacity-b");
  for (let index = 2; index < MAX_TRUSTED_DEVICES; index += 1)
    addSameMemberDevice(service, adultA, `capacity-${index}`);
  assert.equal(
    service.activeTrustedDeviceCount(service.households.get(adultA.householdId)),
    MAX_TRUSTED_DEVICES,
  );
  const request = service.createMemberRecoveryPairing(
    adultA.sessionToken,
    adultB.memberId,
  );
  const claim = service.claimPairing({
    code: request.code,
    credential: credential("capacity-recovered"),
    deviceLabel: "Recovered at capacity",
  });
  service.approvePairing(
    adultA.sessionToken,
    request.pairingId,
    claim.version,
  );
  assert.equal(
    service.activeTrustedDeviceCount(service.households.get(adultA.householdId)),
    MAX_TRUSTED_DEVICES,
  );
  assert.ok(service.devices.get(adultB.deviceId).revokedAt);
});

test("restore rejects a backup that predates a currently active household", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-predating-recovery-"));
  const targetPath = join(directory, "kin.sqlite");
  const backupPath = join(directory, "before-household.sqlite");
  let store = new DurableStore(targetPath, { acquireProcessLock: false });
  try {
    await store.backup(backupPath);
    const service = new PairingService({ store });
    const adult = service.bootstrap({
      credential: credential("created-later"),
      deviceLabel: "Current authority",
    });
    store.close();
    store = null;
    await assert.rejects(
      DurableStore.restoreBackup(backupPath, targetPath, {
        acknowledgeDeletionHistory: true,
      }),
      (error) =>
        error.code === "restore_missing_active_household" &&
        error.message ===
          "Cannot restore a backup that predates a currently active household.",
    );
    const preserved = new DurableStore(targetPath, {
      acquireProcessLock: false,
    });
    try {
      const identity = preserved.loadIdentity();
      assert.equal(identity.households.has(adult.householdId), true);
      assert.equal(identity.credentials.has("created-later"), true);
      assert.equal(preserved.validate(), true);
    } finally {
      preserved.close();
    }
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

