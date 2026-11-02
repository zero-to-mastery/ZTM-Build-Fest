// Post-v0.38 trust audit reproduction. Run from any directory: node <this file>. Requires Node >= 22.13.
import { fileURLToPath as kinAuditPath } from "node:url";
const KIN = kinAuditPath(new URL("../../../", import.meta.url));
import { PairingService } from "../../../server/pairing-service.mjs";
import { EncryptedSyncService } from "../../../server/sync-service.mjs";
const now = () => 1_000_000;
const service = new PairingService({ now });
const sync = new EncryptedSyncService(service, { now });
const adult = service.bootstrap({ credential: { id: "cred-a", publicKey: "k", algorithm: -7 }, deviceLabel: "Ana's phone" });
const memberId = "c".repeat(32), deviceId = "d".repeat(32);
service.members.set(memberId, { id: memberId, householdId: adult.householdId, active: true, kind: "temporary", expiresAt: 2_000_000, credentials: new Set() });
service.households.get(adult.householdId).members.add(memberId);
service.devices.set(deviceId, { id: deviceId, householdId: adult.householdId, memberId, label: "Babysitter phone", trustedAt: 1, revokedAt: null, tokenHash: null });
const temp = service.issueSession(memberId, deviceId);
const limitedId = "9".repeat(32), limitedDeviceId = "8".repeat(32);
service.members.set(limitedId, { id: limitedId, householdId: adult.householdId, active: true, kind: "limited", credentials: new Set() });
service.households.get(adult.householdId).members.add(limitedId);
service.devices.set(limitedDeviceId, { id: limitedDeviceId, householdId: adult.householdId, memberId: limitedId, label: "Child tablet", trustedAt: 1, revokedAt: null, tokenHash: null });
const limited = service.issueSession(limitedId, limitedDeviceId);
console.log("before:", sync.status(adult.sessionToken).enabled);
for (const [kind, member] of [["limited", limited], ["temporary", temp]]) {
  try { console.log(`${kind} enable ->`, sync.enable(member.sessionToken)); }
  catch (error) { console.log(`${kind} enable rejected ->`, error.code); }
}
console.log("adult enable ->", sync.enable(adult.sessionToken));
console.log("active Limited and Temporary participation:", sync.status(limited.sessionToken).enabled, sync.status(temp.sessionToken).enabled);
console.log("temporary sees directory kinds:", sync.deviceDirectory(temp.sessionToken).map(d => [d.memberKind, d.memberExpiresAt ?? null]));
