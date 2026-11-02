// Post-v0.40 live verification reproduction B-002. Run from any directory: node <this file>. Requires Node >= 22.13.
// Two Adults A and B. An access change reserves a rotation; B commits it (epoch 3) and issues A's key package
// through the relay. Before A receives that package, A revokes B's device. The relay discards every pending
// grant from the revoked sender (sync-service.mjs onAccessChange), so no active device can ever obtain epoch 3,
// and the client refuses to rotate without the current epoch key (sync-coordinator.js commitRotation:
// "The current household key is unavailable for rotation."). Household sync is then permanently stuck.
// First observed as a timing-dependent failure of scripts/household-authority-regression.mjs in Chrome.
import { pathToFileURL, fileURLToPath } from "node:url";
const KIN = fileURLToPath(new URL("../../../", import.meta.url));
const { PairingService } = await import(pathToFileURL(KIN + "server/pairing-service.mjs").href);
const { EncryptedSyncService } = await import(pathToFileURL(KIN + "server/sync-service.mjs").href);
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const keys = async () => {
  const [agreement, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
  ]);
  return { agreement: await crypto.subtle.exportKey("jwk", agreement.publicKey), signing: await crypto.subtle.exportKey("jwk", signing.publicKey) };
};
const keyPackage = (sender, recipient, keyEpoch, grantId) => ({
  version: 1, householdId: sender.householdId, senderDeviceId: sender.deviceId, recipientDeviceId: recipient.id,
  recipientFingerprint: recipient.syncKeyFingerprint, keyEpoch, grantId, expiresAt: Date.now() + 60_000,
  ephemeralPublicKey: { kty: "EC", crv: "P-256" }, salt: Buffer.alloc(32).toString("base64url"),
  nonce: Buffer.alloc(12).toString("base64url"), wrappedKey: Buffer.alloc(48).toString("base64url"),
  signature: Buffer.alloc(64).toString("base64url"),
});
const grants = (pending) => pending.grants ?? pending;
const pairing = new PairingService();
const sync = new EncryptedSyncService(pairing);
const a = pairing.bootstrap({ credential: credential("a"), deviceLabel: "A", syncPublicKeys: await keys() });
const deviceA = pairing.devices.get(a.deviceId);
deviceA.syncKeyFingerprint ??= "a".repeat(64);
sync.enable(a.sessionToken);
const invite = pairing.createPairing(a.sessionToken);
const claim = pairing.claimPairing({ code: invite.code, credential: credential("b"), deviceLabel: "B" });
pairing.approvePairing(a.sessionToken, invite.pairingId, claim.version);
const b = pairing.activateClaim(claim.claimToken);
const deviceB = pairing.devices.get(b.deviceId);
deviceB.syncPublicKeys = await keys(); // keys attach after activation, as in sync-service.test.mjs
deviceB.syncKeyFingerprint = "b".repeat(64);
sync.onDeviceAdded(a.householdId, b.deviceId); // B joins: epoch 2 reserved
sync.rotateEpoch(a.sessionToken, { expectedEpoch: 1, packages: [keyPackage(a, deviceB, 2, "1".repeat(32))], proposalId: "2".repeat(32) });
const [grantForB] = grants(sync.pendingProvisioning(b.sessionToken));
sync.acknowledgeProvisioning(b.sessionToken, grantForB.grantId); // B now holds epoch 2
console.log("1. epoch", sync.status(a.sessionToken).currentEpoch, "; B provisioned epochs:", deviceB.syncProvisionedEpochs);
sync.onAccessChange(a.householdId); // e.g. a Temporary member expires: epoch 3 reserved
sync.rotateEpoch(b.sessionToken, { expectedEpoch: 2, packages: [keyPackage(b, deviceA, 3, "3".repeat(32))], proposalId: "4".repeat(32) });
console.log("2. B committed epoch 3; key packages waiting for A:", grants(sync.pendingProvisioning(a.sessionToken)).length);
pairing.revokeDevice(a.sessionToken, b.deviceId, a.memberId); // A revokes B before its next sync
sync.onAccessChange(a.householdId, [b.deviceId]);
const status = sync.status(a.sessionToken);
const holders = [...pairing.devices.values()].filter((device) => !device.revokedAt && device.syncProvisionedEpochs?.includes(status.currentEpoch));
const waiting = grants(sync.pendingProvisioning(a.sessionToken));
console.log("3. after revoking B: epoch", status.currentEpoch, "; rotationPending", status.rotationPending,
  "; key packages waiting for A:", waiting.length,
  "; active devices recorded as holding epoch", status.currentEpoch + ":", holders.length);
console.log(waiting.some((grant) => grant.keyEpoch === status.currentEpoch && grant.committedRotation === true)
  ? "Fixed: A's committed epoch-" + status.currentEpoch + " package survives B's revocation as recovery material."
  : "Defect: no package and no active holder remain, and the client cannot rotate to epoch 4 without epoch 3.");
