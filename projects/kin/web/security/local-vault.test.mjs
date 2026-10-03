import test from "node:test";
import assert from "node:assert/strict";
import { LocalVault, randomRecoverySecret, serializeProtectedValue, deserializeProtectedValue, toBase64Url, fromBase64Url } from "./local-vault.js";

test("raw archive ciphertext preserves the published v1 crypto contract under old and rotated roots", async () => {
  const source = await LocalVault.create();
  const candidate = await LocalVault.createRotation(source.vault);
  const value = { formatVersion: 1, events: [{ encoded_event: new Uint8Array([1, 2, 255]), logical_time: 9n }] };
  const metadata = new TextEncoder().encode("authenticated archive metadata");
  for (const vault of [source.vault, candidate.vault]) {
    const raw = await vault.sealArchive(value, metadata, { rawCiphertext: true });
    assert.ok(raw.ciphertext instanceof Uint8Array);
    assert.equal(raw.version, 1);
    assert.equal(raw.rootVersion, undefined);
    assert.deepEqual(await vault.openArchive(raw, metadata, { ownedCiphertext: true }), value);
    assert.deepEqual(await vault.openArchive({ ...raw, ciphertext: toBase64Url(raw.ciphertext) }, metadata), value);
    const legacy = await vault.sealArchive(value, metadata);
    assert.deepEqual(await vault.openArchive({ ...legacy, ciphertext: fromBase64Url(legacy.ciphertext) }, metadata, { ownedCiphertext: true }), value);
    for (const index of [0, raw.ciphertext.length - 1]) {
      const changed = raw.ciphertext.slice(); changed[index] ^= 1;
      await assert.rejects(vault.openArchive({ ...raw, ciphertext: changed }, metadata, { ownedCiphertext: true }));
    }
    await assert.rejects(vault.openArchive(raw, new Uint8Array([1]), { ownedCiphertext: true }));
    await assert.rejects(vault.openArchive({ ...raw, ciphertext: raw.ciphertext.slice(0, 15) }, metadata, { ownedCiphertext: true }));
  }
  source.vault.lock(); candidate.vault.lock();
});

test("recovery wrapper unlocks encrypted canonical bytes without storing root or recovery secret", async () => {
  const { vault, manifest, recoverySecret } = await LocalVault.create();
  const value = { encoded_event: new Uint8Array([0, 1, 255]), logical_time: 42n, nested: [undefined, null] };
  const context = { store: "events", id: "example" };
  const encrypted = await vault.seal(value, context);
  assert.ok(!JSON.stringify(manifest).includes(recoverySecret));
  assert.deepEqual(await vault.open(encrypted, context), value);
  vault.lock();
  const restored = await LocalVault.unlock(manifest, recoverySecret);
  assert.deepEqual(await restored.open(encrypted, context), value);
  restored.lock();
});

test("wrong recovery key and wrong credential wrapper fail closed", async () => {
  const { vault, manifest } = await LocalVault.create();
  await assert.rejects(LocalVault.unlock(manifest, randomRecoverySecret()), { code: "unlock_failed" });
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const updated = await vault.addCredentialWrapper(secret, { credentialId: "credential-A", prfSalt: "salt-A" });
  const wrapper = updated.wrappers.find((entry) => entry.type === "prf");
  await assert.rejects(LocalVault.unlock(updated, crypto.getRandomValues(new Uint8Array(32)), wrapper.id), { code: "unlock_failed" });
  const unlocked = await LocalVault.unlock(updated, secret, wrapper.id);
  unlocked.lock(); vault.lock();
});

test("tampered ciphertext, nonce, salt, version and context are rejected", async () => {
  const { vault } = await LocalVault.create();
  const context = { store: "events", id: "one" };
  const envelope = await vault.seal("private household", context);
  for (const field of ["ciphertext", "nonce", "salt"])
    await assert.rejects(vault.open({ ...envelope, [field]: (envelope[field][0] === "A" ? "B" : "A") + envelope[field].slice(1) }, context));
  await assert.rejects(vault.open({ ...envelope, version: 2 }, context));
  await assert.rejects(vault.open(envelope, { store: "sync_outbox", id: "one" }));
  await assert.rejects(vault.open(envelope, { store: "events", id: "two" }));
  await assert.rejects(vault.open({ ...envelope, vaultId: "0".repeat(32) }, context));
  const { vault: other } = await LocalVault.create();
  await assert.rejects(other.open(envelope, context));
  vault.lock(); other.lock();
});

test("fresh encryptions use independent HKDF salts and nonces", async () => {
  const { vault } = await LocalVault.create();
  const records = await Promise.all(Array.from({ length: 100 }, () => vault.seal("same", { store: "events", id: "same" })));
  assert.equal(new Set(records.map((record) => record.salt)).size, 100);
  assert.equal(new Set(records.map((record) => record.nonce)).size, 100);
  assert.equal(new Set(records.map((record) => record.ciphertext)).size, 100);
  vault.lock();
});

test("credential enrollment leaves corpus unchanged and two credentials wrap same root", async () => {
  const { vault, recoverySecret } = await LocalVault.create();
  const context = { store: "events", id: "item" };
  const envelope = await vault.seal("shared history", context);
  const before = JSON.stringify(envelope);
  const alice = crypto.getRandomValues(new Uint8Array(32));
  const bob = crypto.getRandomValues(new Uint8Array(32));
  await vault.addCredentialWrapper(alice, { credentialId: "alice", prfSalt: "alice-salt" });
  const manifest = await vault.addCredentialWrapper(bob, { credentialId: "bob", prfSalt: "bob-salt" });
  for (const [credentialId, secret] of [["alice", alice], ["bob", bob]]) {
    const wrapper = manifest.wrappers.find((entry) => entry.credentialId === credentialId);
    const unlocked = await LocalVault.unlock(manifest, secret, wrapper.id);
    assert.equal(await unlocked.open(envelope, context), "shared history");
    unlocked.lock();
  }
  assert.equal(JSON.stringify(envelope), before);
  const removed = vault.removeWrapper(manifest.wrappers.find((entry) => entry.credentialId === "alice").id);
  assert.equal(removed.wrappers.length, 2);
  await assert.rejects(LocalVault.unlock(removed, alice, manifest.wrappers.find((entry) => entry.credentialId === "alice").id), { code: "wrapper_unavailable" });
  const recovered = await LocalVault.unlock(removed, recoverySecret);
  assert.equal(await recovered.open(envelope, context), "shared history");
  recovered.lock(); vault.lock();
});

test("last recovery wrapper cannot be removed", async () => {
  const { vault, manifest } = await LocalVault.create();
  assert.throws(() => vault.removeWrapper(manifest.wrappers[0].id), { code: "last_wrapper" });
  vault.lock();
});

test("lock revokes ongoing work and notifies all listeners", async () => {
  const { vault } = await LocalVault.create();
  let calls = 0;
  vault.onLock(() => { calls++; throw new Error("listener failure"); });
  vault.onLock(() => calls++);
  const pending = vault.seal("sensitive", { store: "events", id: 1 });
  vault.lock();
  await assert.rejects(pending, { code: "locked" });
  assert.equal(calls, 2);
  assert.equal(vault.root, null);
  await assert.rejects(vault.seal("no", { store: "events", id: 2 }), { code: "locked" });
  vault.lock(); assert.equal(calls, 2);
});

test("archive encryption is domain separated from local records", async () => {
  const { vault } = await LocalVault.create();
  const archive = await vault.sealArchive({ events: [new Uint8Array([1, 2])] });
  assert.deepEqual(await vault.openArchive(archive), { events: [new Uint8Array([1, 2])] });
  await assert.rejects(vault.open(archive, { store: "archive", id: "1" }));
  const local = await vault.seal("text", { store: "archive", id: "1" });
  await assert.rejects(vault.openArchive(local));
  vault.lock();
});

test("typed-value encoding preserves prototype-shaped keys as inert data", () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"text"}');
  const output = deserializeProtectedValue(serializeProtectedValue(input));
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal(output.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(output, input);
});

test("root replacement independently advances protection and retires old recovery and PRF wrappers", async () => {
  const source = await LocalVault.create();
  const prf = crypto.getRandomValues(new Uint8Array(32));
  await source.vault.addCredentialWrapper(prf, { credentialId: "old-credential", prfSalt: "old-salt" });
  const oldManifest = structuredClone(source.vault.manifest);
  const candidate = await LocalVault.createRotation(source.vault);
  assert.equal(candidate.manifest.vaultId, source.manifest.vaultId);
  assert.equal(candidate.manifest.rootVersion, 2);
  assert.equal(candidate.manifest.formatVersion, 2);
  assert.notDeepEqual(candidate.vault.root, source.vault.root);
  assert.notEqual(candidate.recoverySecret, source.recoverySecret);
  assert.equal(candidate.manifest.wrappers.length, 1);
  assert.equal(candidate.manifest.wrappers[0].type, "recovery");
  const context = { store: "events", id: "new-content" };
  const protectedValue = await candidate.vault.seal("newly protected history", context);
  const current = await LocalVault.unlock(candidate.manifest, candidate.recoverySecret);
  assert.equal(await current.open(protectedValue, context), "newly protected history");
  const copied = await LocalVault.unlock(oldManifest, source.recoverySecret);
  await assert.rejects(copied.open(protectedValue, context));
  await assert.rejects(LocalVault.unlock(candidate.manifest, source.recoverySecret));
  await assert.rejects(LocalVault.unlock(candidate.manifest, prf, oldManifest.wrappers[1].id));
  const next = await LocalVault.createRotation(candidate.vault);
  assert.equal(next.manifest.rootVersion, 3);
  for (const vault of [source.vault, candidate.vault, copied, current, next.vault]) vault.lock();
});

test("root version is authenticated in wrappers, verifiers and protected values", async () => {
  const source = await LocalVault.create();
  const candidate = await LocalVault.createRotation(source.vault);
  await assert.rejects(LocalVault.unlock({ ...candidate.manifest, rootVersion: 3 }, candidate.recoverySecret));
  const context = { store: "events", id: 12 };
  const row = await candidate.vault.seal("synthetic", context);
  for (const replacement of [0, 1, 3, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(candidate.vault.open({ ...row, rootVersion: replacement }, context));
  for (const field of ["salt", "nonce", "ciphertext"])
    await assert.rejects(candidate.vault.open({ ...row, [field]: (row[field][0] === "A" ? "B" : "A") + row[field].slice(1) }, context));
  await assert.rejects(candidate.vault.open({ ...row, version: 1 }, context));
  await assert.rejects(candidate.vault.open(row, { store: "sync_outbox", id: 12 }));
  await assert.rejects(candidate.vault.open(row, { store: "events", id: 13 }));
  source.vault.lock(); candidate.vault.lock();
});

test("interrupted candidate generation never mutates the current recovery manifest", async () => {
  const source = await LocalVault.create();
  const original = structuredClone(source.vault.manifest);
  await assert.rejects(LocalVault.createRotation(source.vault, "invalid"));
  assert.deepEqual(source.vault.manifest, original);
  const pending = LocalVault.createRotation(source.vault);
  source.vault.lock();
  await assert.rejects(pending, { code: "locked" });
  const restored = await LocalVault.unlock(original, source.recoverySecret);
  restored.lock();
});

test("interruption after recovery wrapping disposes the candidate and preserves the source", async () => {
  const source = await LocalVault.create();
  const original = LocalVault.prototype.createWrapper;
  let candidate;
  LocalVault.prototype.createWrapper = async function (...args) {
    candidate = this;
    await original.apply(this, args);
    throw new Error("synthetic failure after candidate recovery wrapping");
  };
  try {
    await assert.rejects(LocalVault.createRotation(source.vault), /after candidate recovery wrapping/);
    assert.equal(candidate.locked, true);
    assert.equal(candidate.root, null);
    assert.equal(source.vault.locked, false);
    const old = await LocalVault.unlock(source.manifest, source.recoverySecret);
    old.lock();
  } finally { LocalVault.prototype.createWrapper = original; source.vault.lock(); }
});

test("KARC v1 crypto roundtrips with a rotated root and authenticates metadata", async () => {
  const source = await LocalVault.create();
  const candidate = await LocalVault.createRotation(source.vault);
  // Node's HKDF provider limits info to 1024 bytes; the real browser regression
  // exercises complete KARC metadata and wrappers with the production adapter.
  const metadata = serializeProtectedValue({ archiveVersion: 1, rootVersion: candidate.manifest.rootVersion });
  const value = { events: [new Uint8Array([1, 3, 9])] };
  const envelope = await candidate.vault.sealArchive(value, metadata);
  assert.equal(envelope.version, 1);
  assert.deepEqual(await candidate.vault.openArchive(envelope, metadata), value);
  await assert.rejects(source.vault.openArchive(envelope, metadata));
  await assert.rejects(candidate.vault.openArchive(envelope, new Uint8Array()));
  source.vault.lock(); candidate.vault.lock();
});
