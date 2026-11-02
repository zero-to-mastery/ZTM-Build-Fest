// Simple view (#343, ADR 0013): a household admin, with a fresh passkey,
// turns a calmer layout on or off for one Limited member. The service stores
// and reports the switch; it is a layout, not a permission, so it changes
// nothing the member's devices may sync.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

function household(store = null) {
  const pairing = new PairingService({ store });
  const sync = new EncryptedSyncService(pairing, { store });
  sync.liveService = { eventsAccepted() {}, revalidate() {} };
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
  return { pairing, sync, admin, child, guest, adult };
}

const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store), store); } finally { store.close(); }
  });
}

bothStores("Simple view is off by default and reported to the member and for Limited rows", (h) => {
  for (const who of [h.admin, h.adult, h.child, h.guest])
    assert.equal(h.sync.status(who.sessionToken).simpleView, false);
  const members = h.pairing.householdView(h.admin.sessionToken).members;
  assert.equal(members.find((member) => member.id === h.child.memberId).simpleView, false);
  for (const id of [h.admin.memberId, h.adult.memberId, h.guest.memberId])
    assert.equal("simpleView" in members.find((member) => member.id === id), false, "only Limited rows carry it");
});

bothStores("an admin turns it on and off for a Limited member, with a fresh passkey", (h) => {
  assert.deepEqual(h.pairing.setSimpleView(h.admin.sessionToken, h.child.memberId, true, h.admin.memberId),
    { memberId: h.child.memberId, simpleView: true, changed: true });
  assert.equal(h.sync.status(h.child.sessionToken).simpleView, true);
  assert.equal(h.pairing.householdView(h.child.sessionToken).members.find((member) => member.current).simpleView, true);
  assert.equal(h.pairing.setSimpleView(h.admin.sessionToken, h.child.memberId, true, h.admin.memberId).changed, false);
  h.pairing.setSimpleView(h.admin.sessionToken, h.child.memberId, false, h.admin.memberId);
  assert.equal(h.sync.status(h.child.sessionToken).simpleView, false);
  assert.throws(() => h.pairing.setSimpleView(h.admin.sessionToken, h.child.memberId, true, h.adult.memberId),
    rejects("fresh_auth_required", 401), "the passkey must be the admin's own");
  assert.throws(() => h.pairing.setSimpleView(h.admin.sessionToken, h.child.memberId, "yes", h.admin.memberId),
    rejects("simple_view_invalid", 400));
});

bothStores("only an admin may change it, and only for a Limited member", (h) => {
  assert.throws(() => h.pairing.simpleViewContext(h.adult.sessionToken, h.child.memberId), rejects("household_admin_required", 403));
  assert.throws(() => h.pairing.simpleViewContext(h.child.sessionToken, h.child.memberId),
    (error) => error instanceof PairingError && error.status === 403, "a child can't switch it off");
  for (const who of [h.adult, h.guest, h.admin])
    assert.throws(() => h.pairing.setSimpleView(h.admin.sessionToken, who.memberId, true, h.admin.memberId),
      rejects("simple_view_limited_required", 409));
  assert.throws(() => h.pairing.simpleViewContext(h.admin.sessionToken, "ff".repeat(16)), rejects("not_found", 404));
});

test("the switch survives a restart of the durable store", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-simple-view-"));
  const path = join(directory, "kin.sqlite");
  try {
    const store = new DurableStore(path);
    const h = household(store);
    h.pairing.setSimpleView(h.admin.sessionToken, h.child.memberId, true, h.admin.memberId);
    store.close();
    const reopened = new DurableStore(path);
    try {
      const pairing = new PairingService({ store: reopened });
      assert.equal(pairing.members.get(h.child.memberId).simpleView, true);
      assert.equal(pairing.members.get(h.adult.memberId).simpleView, undefined);
      const row = reopened.db.prepare("SELECT simple_view FROM members WHERE id = ?").get(h.child.memberId);
      assert.equal(row.simple_view, 1);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stored Simple view on a non-Limited member is refused as invalid data", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-simple-view-"));
  const path = join(directory, "kin.sqlite");
  try {
    const store = new DurableStore(path);
    const h = household(store);
    store.db.prepare("UPDATE members SET simple_view = 1 WHERE id = ?").run(h.adult.memberId);
    store.close();
    assert.throws(() => new PairingService({ store: new DurableStore(path) }), /membership data is invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy household with no recorded admin can't change Simple view", () => {
  const h = household();
  // Simulate a household from before admins were recorded.
  for (const memberId of h.pairing.households.get(h.pairing.members.get(h.admin.memberId).householdId).members)
    delete h.pairing.members.get(memberId).householdAdmin;
  assert.throws(() => h.pairing.simpleViewContext(h.admin.sessionToken, h.child.memberId),
    (error) => error instanceof PairingError && error.status === 403);
});
