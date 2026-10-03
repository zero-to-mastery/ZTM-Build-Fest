import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { PairingError, PairingService } from "./pairing-service.mjs";
import {
  createDeviceAuthorizationCertificate,
  deviceKeyFingerprint,
} from "../web/sync/crypto.js";

globalThis.crypto ??= webcrypto;

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

async function deviceKeyPair() {
  const [agreement, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]),
  ]);
  const keys = {
    agreementPrivateKey: agreement.privateKey,
    signingPrivateKey: signing.privateKey,
  };
  const publicKeys = {
    agreement: await crypto.subtle.exportKey("jwk", agreement.publicKey),
    signing: await crypto.subtle.exportKey("jwk", signing.publicKey),
  };
  return { keys, publicKeys };
}

const publicKeys = async () => (await deviceKeyPair()).publicKeys;

test("pairing binds the claimant public-key fingerprint to the approved device", async () => {
  const service = new PairingService();
  const inviterKeys = await deviceKeyPair();
  const inviter = service.bootstrap({
    credential: credential("a"),
    deviceLabel: "A",
    syncPublicKeys: inviterKeys.publicKeys,
  });
  const invite = service.createPairing(inviter.sessionToken);
  const claimantKeyPair = await deviceKeyPair();
  const claimantKeys = claimantKeyPair.publicKeys;
  const claim = service.claimPairing({
    code: invite.code,
    credential: credential("b"),
    deviceLabel: "B",
    syncPublicKeys: claimantKeys,
  });
  const pairing = service.pairingForAdult(
    inviter.sessionToken,
    invite.pairingId,
  );
  const claimant = service.pairingForClaim(claim.claimToken);
  assert.equal(pairing.syncKeyFingerprint, claimant.syncKeyFingerprint);
  assert.equal(pairing.syncKeyFingerprint.length, 64);
  assert.deepEqual(claimant.syncPublicKeys, claimantKeys);
  assert.equal("d" in claimant.syncPublicKeys.signing, false);

  const pendingPairing = service.pairings.get(invite.pairingId);
  const certificate = await createDeviceAuthorizationCertificate({
    householdId: inviter.householdId,
    memberId: pendingPairing.claimant.memberId,
    deviceId: pendingPairing.claimant.deviceId,
    issuerDeviceId: inviter.deviceId,
    issuerFingerprint: await deviceKeyFingerprint(inviterKeys.publicKeys),
    publicKeys: claimantKeys,
    signingKey: inviterKeys.keys.signingPrivateKey,
  });
  assert.throws(
    () =>
      service.approvePairing(
        inviter.sessionToken,
        invite.pairingId,
        claim.version,
        { ...certificate, deviceId: "f".repeat(32) },
      ),
    (error) => error.code === "device_certificate_invalid",
  );
  assert.equal(service.households.get(inviter.householdId).members.size, 1);
  service.approvePairing(
    inviter.sessionToken,
    invite.pairingId,
    claim.version,
    certificate,
  );
  const device = service.devices.get(
    service.pairings.get(invite.pairingId).confirmedDeviceId,
  );
  assert.deepEqual(device.syncPublicKeys, claimantKeys);
  assert.equal(device.syncKeyFingerprint, pairing.syncKeyFingerprint);
  assert.equal("d" in device.syncPublicKeys.signing, false);
});

test("invalid sync public keys fail before bootstrap mutates identity state", () => {
  const service = new PairingService();
  assert.throws(
    () =>
      service.bootstrap({
        credential: credential("a"),
        syncPublicKeys: { agreement: { d: "private" }, signing: {} },
      }),
    (error) =>
      error instanceof PairingError && error.code === "sync_device_key_invalid",
  );
  assert.equal(service.households.size, 0);
  assert.equal(service.members.size, 0);
  assert.equal(service.devices.size, 0);
});

test("sync-capable pairing approval requires a signer-bound device certificate", async () => {
  const service = new PairingService();
  const inviterKeys = await deviceKeyPair();
  const inviter = service.bootstrap({
    credential: credential("cert-inviter"),
    syncPublicKeys: inviterKeys.publicKeys,
  });
  const invite = service.createPairing(inviter.sessionToken);
  const claimantKeys = await deviceKeyPair();
  const claim = service.claimPairing({
    code: invite.code,
    credential: credential("cert-claimant"),
    deviceLabel: "Claimant",
    syncPublicKeys: claimantKeys.publicKeys,
  });
  assert.throws(
    () =>
      service.approvePairing(
        inviter.sessionToken,
        invite.pairingId,
        claim.version,
      ),
    (error) => error.code === "device_certificate_invalid",
  );
  assert.equal(service.households.get(inviter.householdId).members.size, 1);
  assert.equal(service.devices.size, 1);

  const pairing = service.pairings.get(invite.pairingId);
  const certificate = await createDeviceAuthorizationCertificate({
    householdId: inviter.householdId,
    memberId: pairing.claimant.memberId,
    deviceId: pairing.claimant.deviceId,
    issuerDeviceId: inviter.deviceId,
    issuerFingerprint: await deviceKeyFingerprint(inviterKeys.publicKeys),
    publicKeys: claimantKeys.publicKeys,
    signingKey: inviterKeys.keys.signingPrivateKey,
  });
  assert.equal(
    service.approvePairing(
      inviter.sessionToken,
      invite.pairingId,
      claim.version,
      certificate,
    ).state,
    "Confirmed",
  );
});

test("same-member device pairing adds a trusted device without adding an adult", async () => {
  const service = new PairingService();
  const adultKeys = await deviceKeyPair();
  const adult = service.bootstrap({
    credential: credential("adult-first"),
    deviceLabel: "First device",
    syncPublicKeys: adultKeys.publicKeys,
  });
  const request = service.createDevicePairing(adult.sessionToken);
  const claimantKeyPair = await deviceKeyPair();
  const claimantKeys = claimantKeyPair.publicKeys;
  const claim = service.claimPairing({
    code: request.code,
    credential: credential("adult-second-device"),
    deviceLabel: "Second device",
    syncPublicKeys: claimantKeys,
  });
  assert.equal(claim.purpose, "device");
  assert.equal(
    service.pairingForAdult(adult.sessionToken, request.pairingId).purpose,
    "device",
  );
  const pendingPairing = service.pairings.get(request.pairingId);
  const certificate = await createDeviceAuthorizationCertificate({
    householdId: adult.householdId,
    memberId: pendingPairing.claimant.memberId,
    deviceId: pendingPairing.claimant.deviceId,
    issuerDeviceId: adult.deviceId,
    issuerFingerprint: await deviceKeyFingerprint(adultKeys.publicKeys),
    publicKeys: claimantKeys,
    signingKey: adultKeys.keys.signingPrivateKey,
  });
  const approved = service.approvePairing(
    adult.sessionToken,
    request.pairingId,
    claim.version,
    certificate,
  );
  assert.equal(approved.state, "Confirmed");
  const pairing = service.pairings.get(request.pairingId);
  assert.equal(pairing.confirmedMemberId, adult.memberId);
  assert.equal(
    service.activeMemberCount(service.households.get(adult.householdId)),
    1,
  );
  assert.equal(service.members.get(adult.memberId).credentials.size, 2);
  assert.equal(
    [...service.devices.values()].filter(
      (device) => device.memberId === adult.memberId,
    ).length,
    2,
  );

  const activated = service.activateClaim(claim.claimToken);
  assert.equal(activated.memberId, adult.memberId);
  assert.notEqual(activated.deviceId, adult.deviceId);
  assert.deepEqual(
    service.devices.get(activated.deviceId).syncPublicKeys,
    claimantKeys,
  );
});
