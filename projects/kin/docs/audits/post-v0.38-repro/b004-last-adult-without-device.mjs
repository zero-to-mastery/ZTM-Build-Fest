// Post-v0.38 trust audit reproduction. Run from any directory: node <this file>. Requires Node >= 22.13.
import { fileURLToPath as kinAuditPath } from "node:url";
const KIN = kinAuditPath(new URL("../../../", import.meta.url));
// Throwaway HTTP authorization probes for Kin v0.38.1 (synthetic data, in-memory SQLite).
import { PairingError, PairingService } from "../../../server/pairing-service.mjs";
import { createKinServer } from "../../../server/server.mjs";
import { DurableStore } from "../../../server/durable-store.mjs";
import assert from "node:assert/strict";

const cred = (s) => ({ id: `credential-${s}`, publicKey: `key-${s}`, algorithm: -7 });
const webauthn = {
  registrationOptions: (flow) => ({ challenge: flow }),
  authenticationOptions: (flow, ids) => ({ challenge: flow, allowCredentials: ids.map((id) => ({ id })) }),
  verifyRegistration: (r, flow) => { if (r?.flow !== flow) throw new PairingError("registration_failed", "x", 400); return { id: r.id, publicKey: `key-${r.id}`, algorithm: -7, signCount: 0 }; },
  verifyAuthentication: (r, flow, c) => { if (!c || r?.id !== c.id || r?.flow !== flow) throw new PairingError("passkey_verification_failed", "x", 401); return true; },
};
const t = { now: 1_000_000 };
const service = new PairingService({ now: () => t.now, secret: Buffer.alloc(32, 5) });
const adult = service.bootstrap({ credential: cred("a"), deviceLabel: "A" });
const admit = (kind, suffix, opts = {}) => {
  const inv = service.createPairing(adult.sessionToken, { kind, ...opts });
  const claim = service.claimPairing({ code: inv.code, credential: cred(suffix), deviceLabel: suffix });
  service.approvePairing(adult.sessionToken, inv.pairingId, claim.version);
  return service.activateClaim(claim.claimToken);
};
const adultB = admit("adult", "b");
const limited = admit("limited", "l");
const temp = admit("temporary", "t", { expiresAt: 5_000_000 });
const limited2 = admit("limited", "l2");

const app = createKinServer({ service, store: new DurableStore(":memory:"), webauthn, now: () => t.now, origin: "http://localhost" });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const req = async (path, { method = "GET", body, cookie } = {}) => {
  const headers = {}; if (body) headers["Content-Type"] = "application/json"; if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};
const show = (label, r) => console.log(`${label}: ${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);

try {
  console.log("=== Limited/Temporary probes on routes NOT in the existing denial test ===");
  const pend = service.createPairing(adult.sessionToken, { kind: "adult" });
  const pendClaim = service.claimPairing({ code: pend.code, credential: cred("x"), deviceLabel: "X" });
  for (const [name, m, credId] of [["limited", limited, "credential-l"], ["temporary", temp, "credential-t"]]) {
    const cookie = `kin_session=${m.sessionToken}; kin_device=${m.deviceToken}`;
    show(`${name} POST /api/devices/replacements`, await req("/api/devices/replacements", { method: "POST", cookie, body: { deviceId: m.deviceId } }));
    show(`${name} POST approve/finish (forged flow)`, await req(`/api/pairings/${pend.pairingId}/approve/finish`, { method: "POST", cookie, body: { flow: "forged", credential: { id: credId, flow: "forged" } } }));
    show(`${name} POST remove/options target=adultB`, await req("/api/household/membership/remove/options", { method: "POST", cookie, body: { memberId: adultB.memberId } }));
    show(`${name} POST deletion/finish (no flow)`, await req("/api/household/deletion/finish", { method: "POST", cookie, body: {} }));
    // Self-leave flow obtained legitimately, then try to redirect to another member in finish body
    const opt = await req("/api/household/membership/remove/options", { method: "POST", cookie, body: { memberId: m.memberId } });
    show(`${name} POST remove/options self`, opt);
    console.log(`  server-side flow target = ${app.flows.get(opt.json.flow)?.targetMemberId === m.memberId ? "self" : "OTHER"}`);
    show(`${name} remove/finish self flow + body.memberId=adultB (ignored?)`, await req("/api/household/membership/remove/finish", { method: "POST", cookie, body: { flow: opt.json.flow, memberId: adultB.memberId, targetMemberId: adultB.memberId, credential: { id: credId, flow: opt.json.flow } } }));
    console.log(`  adultB active=${service.members.get(adultB.memberId).active}; ${name} active=${service.members.get(m.memberId).active}`);
  }
  // Adult's flow cannot be finished by another member
  const aCookie = `kin_session=${adult.sessionToken}; kin_device=${adult.deviceToken}`;

  console.log("\n=== Adult invitation input validation via HTTP ===");
  show("adult POST /api/pairings kind=temporary expiresAt=MAX_SAFE_INTEGER", await req("/api/pairings", { method: "POST", cookie: aCookie, body: { kind: "temporary", expiresAt: Number.MAX_SAFE_INTEGER } }));
  show("adult POST /api/pairings kind=Limited", await req("/api/pairings", { method: "POST", cookie: aCookie, body: { kind: "Limited" } }));
  show("adult POST /api/pairings kind=guest", await req("/api/pairings", { method: "POST", cookie: aCookie, body: { kind: "guest", expiresAt: 9_000_000 } }));
  show("adult POST /api/pairings kind=null", await req("/api/pairings", { method: "POST", cookie: aCookie, body: { kind: null } }));

  console.log("\n=== Temporary expiry over HTTP (fresh temp) ===");
  const temp2 = admit("temporary", "t2", { expiresAt: 2_000_000 });
  const t2Cookie = `kin_session=${temp2.sessionToken}; kin_device=${temp2.deviceToken}`;
  t.now = 1_999_999;
  show("temp2 GET /api/sync/events at expiresAt-1", await req("/api/sync/events", { cookie: t2Cookie }));
  t.now = 2_000_000;
  show("temp2 GET /api/sync/events at expiresAt", await req("/api/sync/events", { cookie: t2Cookie }));
  show("temp2 POST /api/login/options at expiresAt", await req("/api/login/options", { method: "POST", cookie: t2Cookie, body: {} }));
  show("adult GET /api/sync/status after expiry", await req("/api/sync/status", { cookie: aCookie }));

  console.log("\n=== Last-Adult protection: Adult A revokes Adult B's only device, then self-leaves (HTTP) ===");
  show("A DELETE /api/devices/<B device>", await req(`/api/devices/${adultB.deviceId}`, { method: "DELETE", cookie: aCookie }));
  service.revokeDevice(adult.sessionToken, adultB.deviceId, adult.memberId); // equivalent post-passkey service operation
  const leaveOpt = await req("/api/household/membership/remove/options", { method: "POST", cookie: aCookie, body: { memberId: adult.memberId } });
  show("A remove/options self", leaveOpt);
  const leave = await req("/api/household/membership/remove/finish", { method: "POST", cookie: aCookie, body: { flow: leaveOpt.json.flow, credential: { id: "credential-a", flow: leaveOpt.json.flow } } });
  show("A remove/finish self (fresh passkey)", leave);
  assert.equal(leave.status, 409, "the only Adult with a usable device must not leave");
  assert.equal(service.hasUsableTrustedDevice(adult.memberId), true);
  const bCookie = `kin_session=${adultB.sessionToken}; kin_device=${adultB.deviceToken}`;
  show("B POST /api/login/options", await req("/api/login/options", { method: "POST", cookie: bCookie, body: {} }));
  const lCookie = `kin_session=${limited2.sessionToken}; kin_device=${limited2.deviceToken}`;
  show("Limited2 GET /api/sync/status", await req("/api/sync/status", { cookie: lCookie }));
  const remaining = [...service.households.get(adult.householdId).members].map((id) => service.members.get(id)).filter((m) => m.active);
  console.log("remaining active members:", remaining.map((m) => `${m.kind}(devices=${[...service.devices.values()].filter((d) => d.memberId === m.id && !d.revokedAt).length})`).join(", "));
} finally {
  await new Promise((r) => app.server.close(r));
  app.store?.close();
}
