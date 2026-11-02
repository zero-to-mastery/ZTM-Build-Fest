// Post-v0.40 live verification reproduction P-001. Run from any directory: node <this file>. Requires Node >= 22.13.
// rotateEpoch records the new epoch for every recipient's grant but never for the rotating device itself, so
// the device directory under-reports what the rotating Adult holds. Every other client then tries to provision
// that Adult with an epoch it created. Adults succeed redundantly; before this PR's client fix, Limited and
// Temporary clients received 403 adult_required from that attempt and paused before pull and push.
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
const pairing = new PairingService();
const sync = new EncryptedSyncService(pairing);
const a = pairing.bootstrap({ credential: credential("a"), deviceLabel: "A", syncPublicKeys: await keys() });
sync.enable(a.sessionToken);
const invite = pairing.createPairing(a.sessionToken, { kind: "limited" });
const claim = pairing.claimPairing({ code: invite.code, credential: credential("c"), deviceLabel: "C" });
pairing.approvePairing(a.sessionToken, invite.pairingId, claim.version);
const c = pairing.activateClaim(claim.claimToken);
const deviceC = pairing.devices.get(c.deviceId);
deviceC.syncPublicKeys = await keys(); // keys attach after activation, as in sync-service.test.mjs
deviceC.syncKeyFingerprint = "c".repeat(64);
sync.onDeviceAdded(a.householdId, c.deviceId);
sync.rotateEpoch(a.sessionToken, { expectedEpoch: 1, packages: [{
  version: 1, householdId: a.householdId, senderDeviceId: a.deviceId, recipientDeviceId: c.deviceId,
  recipientFingerprint: deviceC.syncKeyFingerprint, keyEpoch: 2, grantId: "1".repeat(32), expiresAt: Date.now() + 60_000,
  ephemeralPublicKey: { kty: "EC", crv: "P-256" }, salt: Buffer.alloc(32).toString("base64url"),
  nonce: Buffer.alloc(12).toString("base64url"), wrappedKey: Buffer.alloc(48).toString("base64url"),
  signature: Buffer.alloc(64).toString("base64url") }], proposalId: "2".repeat(32) });
const entryA = sync.deviceDirectory(c.sessionToken).find((device) => device.deviceId === a.deviceId);
console.log("current epoch:", sync.status(a.sessionToken).currentEpoch, "; rotating device A provisionedEpochs:", entryA.provisionedEpochs,
  entryA.provisionedEpochs.includes(2) ? "(fixed: includes the epoch A created)"
    : "(defect: expected to include 2; the directory omits the epoch A itself created)");
try {
  sync.createProvisioningGrant(c.sessionToken, { recipientDeviceId: a.deviceId, keyEpoch: 2 });
} catch (error) {
  console.log("Limited C trying to fill that gap:", error.status, error.code, "(the client now skips this step for non-Adults)");
}
