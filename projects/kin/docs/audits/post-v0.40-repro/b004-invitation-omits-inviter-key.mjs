// Post-v0.40 live verification reproduction B-004. Run from any directory: node <this file>. Requires Node >= 22.13.
// kin-household.js createPairing()/createDevicePairing() refuse the server's response unless its
// inviterKeyFingerprint equals the inviting device's local key, then show "This device's approved key does not
// match its local key." and never render the invitation code. Before the fix, POST /api/pairings and
// POST /api/devices/pairings omitted inviterKeyFingerprint, so every invitation from the real UI failed that check.
// Found once scripts/household-authority-regression.mjs required the code to be displayed, not just stored.
import { pathToFileURL, fileURLToPath } from "node:url";
const KIN = fileURLToPath(new URL("../../../", import.meta.url));
const { PairingService } = await import(pathToFileURL(KIN + "server/pairing-service.mjs").href);
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const [agreement, signing] = await Promise.all([
  crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
]);
const pairing = new PairingService();
const a = pairing.bootstrap({ credential: credential("a"), deviceLabel: "A", syncPublicKeys: {
  agreement: await crypto.subtle.exportKey("jwk", agreement.publicKey),
  signing: await crypto.subtle.exportKey("jwk", signing.publicKey),
} });
const localFingerprint = pairing.devices.get(a.deviceId).syncKeyFingerprint;
for (const [route, created] of [
  ["POST /api/pairings", pairing.createPairing(a.sessionToken, { kind: "adult" })],
  ["POST /api/devices/pairings", pairing.createDevicePairing(a.sessionToken)],
]) {
  console.log(route, "inviterKeyFingerprint:", created.inviterKeyFingerprint ?? "(missing)",
    created.inviterKeyFingerprint === localFingerprint
      ? "— fixed: the inviting client's key check passes and the code is shown"
      : "— defect: the inviting client rejects this response and never shows the code");
}
