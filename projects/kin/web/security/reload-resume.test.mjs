import test from "node:test";
import assert from "node:assert/strict";
import { ReloadResume, RESUME_WINDOW_MS, TICKET_STORAGE_KEY, currentNavigationType, readReloadResumePreference, writeReloadResumePreference } from "./reload-resume.js";

const VAULT_ID = "a".repeat(32);

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function memoryKeys() {
  const map = new Map();
  return {
    map,
    put: async (id, key) => { map.set(id, key); },
    get: async (id) => map.get(id),
    delete: async (id) => { map.delete(id); },
    ids: async () => [...map.keys()],
  };
}

function fakeVault({ rootVersion = 1, lockEpoch = 3 } = {}) {
  return {
    vaultId: VAULT_ID, rootVersion, securityEpoch: lockEpoch, locked: false,
    root: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    assertUnlocked() { if (this.locked) throw new Error("locked"); },
  };
}

function setup({ enabled = true } = {}) {
  const clock = { now: 1_000_000 };
  const session = memoryStorage();
  const keys = memoryKeys();
  const live = new Set();
  const liveness = {
    hold: (id) => { live.add(id); return () => live.delete(id); },
    heldIds: async () => new Set(live),
  };
  const options = { session, keys, liveness, now: () => clock.now, enabled: () => enabled };
  return { clock, session, keys, live, options, resume: new ReloadResume(options) };
}

const manifestFor = (vault, changes = {}) => async () => ({
  phase: "encrypted", vaultId: vault.vaultId, rootVersion: vault.rootVersion, lockEpoch: vault.securityEpoch, ...changes,
});

/** Arms, writes on "pagehide", then a fresh page load takes the ticket. */
async function reloadCycle(context, { navigationType = "reload", advance = 0, changes = {}, autoLockAt = null } = {}) {
  const vault = fakeVault();
  assert.equal(await context.resume.arm(vault), true);
  assert.equal(context.resume.write({ vault, autoLockAt }), true);
  context.clock.now += advance;
  const next = new ReloadResume(context.options);
  return { vault, result: await next.take({ navigationType, readManifest: manifestFor(vault, changes) }) };
}

test("a refresh inside the window returns the same root, once", async () => {
  const context = setup();
  const { vault, result } = await reloadCycle(context);
  assert.deepEqual([...result.root], [...vault.root]);
  assert.equal(context.session.map.has(TICKET_STORAGE_KEY), false, "the ticket is consumed");
  assert.equal(context.keys.map.size, 0, "the key is consumed");
  const again = await new ReloadResume(context.options).take({ navigationType: "reload", readManifest: manifestFor(vault) });
  assert.equal(again, null);
});

test("the stored ticket never holds the root bytes", async () => {
  const context = setup();
  const vault = fakeVault();
  await context.resume.arm(vault);
  context.resume.write({ vault });
  const stored = context.session.map.get(TICKET_STORAGE_KEY);
  const rootHex = Buffer.from(vault.root).toString("hex");
  const rootBase64 = Buffer.from(vault.root).toString("base64");
  assert.ok(!stored.includes(rootHex) && !stored.includes(rootBase64));
});

for (const navigationType of ["navigate", "back_forward", "prerender", null]) {
  test(`a ${navigationType ?? "unknown"} page load stays locked and consumes the ticket`, async () => {
    const context = setup();
    const { result } = await reloadCycle(context, { navigationType });
    assert.equal(result, null);
    assert.equal(context.session.map.size, 0);
    assert.equal(context.keys.map.size, 0);
  });
}

test("an expired ticket stays locked", async () => {
  const context = setup();
  assert.equal((await reloadCycle(context, { advance: RESUME_WINDOW_MS + 1 })).result, null);
});

test("a passed auto-lock deadline stays locked; a future one is carried over", async () => {
  const context = setup();
  assert.equal((await reloadCycle(context, { advance: 10, autoLockAt: 1_000_005 })).result, null);
  const later = setup();
  const { result } = await reloadCycle(later, { advance: 10, autoLockAt: 1_060_000 });
  assert.equal(result.autoLockAt, 1_060_000);
});

for (const [label, changes] of [
  ["a lock from another tab (lock epoch moved)", { lockEpoch: 4 }],
  ["a rotated root", { rootVersion: 2 }],
  ["another household", { vaultId: "b".repeat(32) }],
  ["an unfinished migration", { phase: "root-rotating" }],
]) {
  test(`${label} stays locked`, async () => {
    const context = setup();
    assert.equal((await reloadCycle(context, { changes })).result, null);
  });
}

test("Lock, auto-lock or any real lock deletes the key and ticket", async () => {
  const context = setup();
  const vault = fakeVault();
  await context.resume.arm(vault);
  context.resume.write({ vault });
  await context.resume.disarm();
  assert.equal(context.session.map.size, 0);
  assert.equal(context.keys.map.size, 0);
  assert.equal(context.live.size, 0);
  const result = await new ReloadResume(context.options).take({ navigationType: "reload", readManifest: manifestFor(vault) });
  assert.equal(result, null);
});

test("a lock while arming leaves no key behind", async () => {
  const context = setup();
  const vault = fakeVault();
  const arming = context.resume.arm(vault);
  await context.resume.disarm();
  assert.equal(await arming, false);
  assert.equal(context.keys.map.size, 0);
  assert.equal(context.resume.write({ vault }), false);
});

test("nothing is written for a locked or different vault, or with the setting off", async () => {
  const context = setup();
  const vault = fakeVault();
  await context.resume.arm(vault);
  assert.equal(context.resume.write({ vault: fakeVault() }), false);
  vault.locked = true;
  assert.equal(context.resume.write({ vault }), false);
  const off = setup({ enabled: false });
  assert.equal(await off.resume.arm(fakeVault()), false);
  assert.equal(off.keys.map.size, 0);
});

test("a tampered or corrupt ticket is discarded", async () => {
  const context = setup();
  const vault = fakeVault();
  await context.resume.arm(vault);
  context.resume.write({ vault });
  const ticket = JSON.parse(context.session.map.get(TICKET_STORAGE_KEY));
  ticket.sealed = Buffer.from(new Uint8Array(48)).toString("base64");
  context.session.map.set(TICKET_STORAGE_KEY, JSON.stringify(ticket));
  assert.equal(await new ReloadResume(context.options).take({ navigationType: "reload", readManifest: manifestFor(vault) }), null);
  context.session.map.set(TICKET_STORAGE_KEY, "{not json");
  assert.equal(await new ReloadResume(context.options).take({ navigationType: "reload", readManifest: manifestFor(vault) }), null);
  assert.equal(context.session.map.size, 0);
});

test("sweep deletes keys of closed tabs but never a live tab's", async () => {
  const context = setup();
  await context.resume.arm(fakeVault());
  context.keys.map.set("c".repeat(32), {});
  await context.resume.sweep();
  assert.deepEqual([...context.keys.map.keys()], [context.resume.armed.id]);
});

test("the preference defaults on and can be turned off", () => {
  const storage = memoryStorage();
  assert.equal(readReloadResumePreference(storage), true);
  writeReloadResumePreference(false, storage);
  assert.equal(readReloadResumePreference(storage), false);
  writeReloadResumePreference(true, storage);
  assert.equal(readReloadResumePreference(storage), true);
});

test("the navigation type comes from the navigation timing entry", () => {
  assert.equal(currentNavigationType({ getEntriesByType: () => [{ type: "reload" }] }), "reload");
  assert.equal(currentNavigationType({ getEntriesByType: () => [] }), null);
  assert.equal(currentNavigationType(undefined), null);
});
