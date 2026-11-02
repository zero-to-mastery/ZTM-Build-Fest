// The chat access policy (#123): the admin decides whether Limited and
// Temporary members read and post, read only, or have no access; the service
// enforces it on the chat relay, uploads and live frames, and audits changes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatBlobService } from "./chat-blob-service.mjs";
import { ChatRelayService } from "./chat-relay-service.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService, chatAccess, chatPolicyOf } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const hex = (byte, length = 16) => byte.toString(16).padStart(2, "0").repeat(length);

function envelope(who, sequence) {
  return {
    protocolVersion: 1, envelopeVersion: 1, eventId: hex(sequence + 10), householdId: who.householdId, deviceId: who.deviceId,
    deviceSequence: sequence, logicalTime: String(sequence), keyEpoch: 1, nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(40, sequence).toString("base64url"), signature: Buffer.alloc(64, 2).toString("base64url"),
  };
}

function household(store = null) {
  const pairing = new PairingService({ store });
  const sync = new EncryptedSyncService(pairing, { store });
  const revalidated = [];
  sync.liveService = { eventsAccepted() {}, revalidate: (householdId) => revalidated.push(householdId) };
  const relay = new ChatRelayService({ syncService: sync, store });
  const blobs = new ChatBlobService({ pairingService: pairing, store });
  const admin = pairing.bootstrap({ credential: credential(`founder-${Math.random()}`) });
  const admit = (options) => {
    const invitation = pairing.createPairing(admin.sessionToken, options);
    const claim = pairing.claimPairing({ code: invitation.code, credential: credential(`m-${Math.random()}`), deviceLabel: "Phone" });
    pairing.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  };
  const child = admit({ kind: "limited" });
  const guest = admit({ kind: "temporary", expiresAt: Date.now() + 86_400_000 });
  const adult = admit({ kind: "adult" });
  sync.enable(admin.sessionToken);
  const auth = (who) => sync.authorize(who.sessionToken);
  const setPolicy = (limited, temporary) => pairing.setChatPolicy(admin.sessionToken, { limited, temporary }, admin.memberId);
  return { pairing, sync, relay, blobs, admin, child, guest, adult, auth, setPolicy, revalidated };
}

const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;
const ref = "ab".repeat(32);

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store), store); } finally { store.close(); }
  });
}

bothStores("a new household lets everyone read and post", (h) => {
  for (const who of [h.admin, h.adult, h.child, h.guest]) {
    assert.equal(h.sync.status(who.sessionToken).chat.access, "write");
    h.relay.status(h.auth(who));
  }
  assert.deepEqual(h.sync.status(h.admin.sessionToken).chat.policy, { limited: "write", temporary: "write" });
  assert.equal(h.sync.status(h.child.sessionToken).chat.policy, undefined, "only an admin sees the policy");
});

bothStores("read only: can read and hide for themselves, can't post, upload, or send receipts", (h) => {
  h.setPolicy("read", "write");
  const child = h.auth(h.child);
  assert.equal(h.sync.status(h.child.sessionToken).chat.access, "read");
  assert.equal(h.sync.status(h.guest.sessionToken).chat.access, "write", "the other class is untouched");
  h.relay.push(h.auth(h.admin), [envelope(h.admin, 1)]);
  assert.equal(h.relay.pull(child, "", "10").events.length, 1);
  h.relay.status(child);
  h.relay.receipts(child);
  h.relay.hidden(child);
  assert.throws(() => h.relay.push(child, [envelope(h.child, 1)]), rejects("chat_read_only", 403));
  assert.throws(() => h.relay.putReceipt(child, { expectedRevision: 0, record: {} }), rejects("chat_read_only", 403));
  assert.throws(() => h.blobs.put(child, ref, Buffer.alloc(64)), rejects("chat_read_only", 403));
  assert.throws(() => h.blobs.retire(child, [ref]), rejects("chat_read_only", 403));
});

bothStores("no access: nothing in chat works, and Adults are never affected", (h) => {
  h.setPolicy("none", "none");
  for (const who of [h.child, h.guest]) {
    const auth = h.auth(who);
    assert.equal(h.sync.status(who.sessionToken).chat.access, "none");
    assert.throws(() => h.relay.status(auth), rejects("chat_unavailable", 403));
    assert.throws(() => h.relay.pull(auth, "", "10"), rejects("chat_unavailable", 403));
    assert.throws(() => h.relay.receipts(auth), rejects("chat_unavailable", 403));
    assert.throws(() => h.relay.hidden(auth), rejects("chat_unavailable", 403));
    assert.throws(() => h.relay.push(auth, [envelope(who, 1)]), rejects("chat_unavailable", 403));
    assert.throws(() => h.blobs.get(auth, ref), rejects("chat_unavailable", 403));
    assert.throws(() => h.blobs.put(auth, ref, Buffer.alloc(64)), rejects("chat_unavailable", 403));
  }
  for (const who of [h.admin, h.adult]) assert.equal(h.sync.status(who.sessionToken).chat.access, "write");
  h.relay.push(h.auth(h.adult), [envelope(h.adult, 1)]);
});

bothStores("changes take effect on the next request and can be reversed", (h) => {
  const child = h.auth(h.child);
  h.relay.push(child, [envelope(h.child, 1)]);
  h.setPolicy("none", "write");
  assert.throws(() => h.relay.pull(child, "", "10"), rejects("chat_unavailable", 403));
  h.setPolicy("read", "write");
  h.relay.pull(child, "", "10");
  assert.throws(() => h.relay.push(child, [envelope(h.child, 2)]), rejects("chat_read_only", 403));
  h.setPolicy("write", "write");
  h.relay.push(child, [envelope(h.child, 2)]);
});

bothStores("only an admin changes it, with a fresh passkey, with valid values, audited without content", (h) => {
  assert.throws(() => h.pairing.setChatPolicy(h.adult.sessionToken, { limited: "none", temporary: "write" }, h.adult.memberId), rejects("household_admin_required", 403));
  assert.throws(() => h.pairing.setChatPolicy(h.child.sessionToken, { limited: "write", temporary: "write" }, h.child.memberId), (error) => error instanceof PairingError && error.status === 403);
  assert.throws(() => h.pairing.setChatPolicy(h.admin.sessionToken, { limited: "none", temporary: "write" }, h.adult.memberId), rejects("fresh_auth_required", 401));
  assert.throws(() => h.pairing.setChatPolicy(h.admin.sessionToken, { limited: "everything", temporary: "write" }, h.admin.memberId), rejects("chat_policy_invalid", 400));
  assert.deepEqual(h.sync.status(h.admin.sessionToken).chat.policy, { limited: "write", temporary: "write" }, "nothing changed");
  const result = h.setPolicy("read", "none");
  assert.equal(result.changed, true);
  assert.equal(result.revision, 1);
  assert.equal(h.setPolicy("read", "none").changed, false, "no change, no new revision");
  const audited = h.pairing.events.filter((entry) => entry.type === "chat_policy_changed");
  assert.equal(audited.length, 1, "one change, one entry");
  assert.deepEqual(
    { limited: audited[0].limited, temporary: audited[0].temporary, revision: audited[0].revision, actorId: audited[0].actorId },
    { limited: "read", temporary: "none", revision: 1, actorId: h.admin.memberId },
  );
});

test("the policy survives a restart", () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household(store);
    h.setPolicy("read", "none");
    const reloaded = new PairingService({ store });
    const home = reloaded.households.get(h.admin.householdId);
    assert.deepEqual(chatPolicyOf(home), { limited: "read", temporary: "none", revision: 1 });
    assert.equal(chatAccess(reloaded.members.get(h.child.memberId), home), "read");
    assert.equal(chatAccess(reloaded.members.get(h.guest.memberId), home), "none");
    assert.equal(chatAccess(reloaded.members.get(h.adult.memberId), home), "write");
  } finally {
    store.close();
  }
});

test("a policy change tells the live service to revalidate", () => {
  const h = household();
  h.setPolicy("read", "write");
  h.sync.chatPolicyChanged(h.admin.householdId);
  assert.deepEqual(h.revalidated, [h.admin.householdId]);
});

test("restoring an older backup keeps the current chat policy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-chat-policy-"));
  const targetPath = join(directory, "kin.sqlite");
  const backupPath = join(directory, "stale.sqlite");
  let store = new DurableStore(targetPath, { acquireProcessLock: false });
  try {
    const pairing = new PairingService({ store });
    const admin = pairing.bootstrap({ credential: credential(`restore-${Math.random()}`) });
    await store.backup(backupPath);
    pairing.setChatPolicy(admin.sessionToken, { limited: "none", temporary: "read" }, admin.memberId);
    store.close();
    store = null;
    const result = await DurableStore.restoreBackup(backupPath, targetPath, { acknowledgeDeletionHistory: true });
    assert.equal(result.preservedAuthorityCount, 1);
    const restored = new DurableStore(targetPath, { acquireProcessLock: false });
    try {
      const home = new PairingService({ store: restored }).households.get(admin.householdId);
      assert.deepEqual(chatPolicyOf(home), { limited: "none", temporary: "read", revision: 1 }, "the older backup does not reopen chat");
    } finally {
      restored.close();
    }
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a chat push, and its hint, skip members with no access", () => {
  const pushes = [], hints = [];
  const h = household();
  h.sync.pushService = { eventsAccepted: (...args) => pushes.push(args) };
  h.sync.liveService = { eventsAccepted: (...args) => hints.push(args), revalidate() {} };
  h.setPolicy("none", "write");
  h.relay.push(h.auth(h.adult), [envelope(h.adult, 1)]);
  assert.deepEqual(pushes[0].slice(2), [{ chat: true }], "marked as chat, so the push service can filter");
  assert.deepEqual(hints[0].slice(2), [{ chat: true }]);
});

test("the device directory says who can read chat, so mentions can be offered (#130)", () => {
  const h = household();
  h.setPolicy("read", "none");
  const access = new Map(h.sync.deviceDirectory(h.admin.sessionToken).map((device) => [device.memberId, device.chatAccess]));
  assert.equal(access.get(h.adult.memberId), "write");
  assert.equal(access.get(h.child.memberId), "read");
  assert.equal(access.get(h.guest.memberId), "none");
});
