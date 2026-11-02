import test from "node:test";
import assert from "node:assert/strict";
import { generateVaultKey, openVault, sealVault } from "./account-vault.js";
import { VaultKeeper, refreshVault, vaultApi } from "./account-vault-sync.js";
import { SyncKeyStore, onEpochInstalled } from "../sync/key-store.js";

const householdId = "a".repeat(32);
const memberId = "b".repeat(32);
const context = { householdId, memberId };
const key = (byte) => new Uint8Array(32).fill(byte);
const epoch = (number, family = "household") => ({ family, epoch: number, key: key(number + (family === "chat" ? 100 : 0)) });

/** The service's vault route as the client sees it: compare-and-set on the
 * version, 409 vault_version_conflict otherwise. */
function fakeService() {
  const service = { vault: null, uploads: 0, downloads: 0, conflictAlways: false };
  service.api = {
    async download() { service.downloads += 1; return { vault: service.vault && { ...service.vault, ciphertext: service.vault.ciphertext.slice() }, wrappers: [] }; },
    async upload({ expectedVersion, ciphertext }) {
      service.uploads += 1;
      if (service.conflictAlways || (service.vault?.version ?? 0) !== expectedVersion)
        throw Object.assign(new Error("conflict"), { code: "vault_version_conflict" });
      service.vault = { version: expectedVersion + 1, ciphertext: ciphertext.slice(), updatedAt: 1 };
      return { version: service.vault.version };
    },
  };
  return service;
}

async function seed(service, vaultKey, epochs, version = 1) {
  service.vault = { version, ciphertext: await sealVault(vaultKey, { epochs }, { ...context, version }), updatedAt: 1 };
}

const epochsIn = async (service, vaultKey) =>
  (await openVault(vaultKey, service.vault.ciphertext, { ...context, version: service.vault.version }))
    .epochs.map((entry) => `${entry.family}:${entry.epoch}`);

test("a new epoch key is sealed into the next vault version; nothing new uploads nothing", async () => {
  const service = fakeService();
  const vaultKey = generateVaultKey();
  assert.deepEqual(await refreshVault({ api: service.api, vaultKey, ...context, local: { epochs: [epoch(1)] } }),
    { status: "no_vault", version: 0, ciphertext: null });
  assert.equal(service.uploads, 0, "no vault is ever created here");

  await seed(service, vaultKey, [epoch(1)]);
  const updated = await refreshVault({ api: service.api, vaultKey, ...context, local: { epochs: [epoch(1), epoch(2), epoch(1, "chat")] } });
  assert.equal(updated.status, "updated");
  assert.equal(updated.version, 2);
  assert.deepEqual(await epochsIn(service, vaultKey), ["household:1", "household:2", "chat:1"]);

  const unchanged = await refreshVault({ api: service.api, vaultKey, ...context, local: { epochs: [epoch(2)] }, current: updated });
  assert.equal(unchanged.status, "current");
  assert.equal(service.uploads, 1);
});

test("on a version conflict the device downloads, merges by epoch and retries once", async () => {
  const service = fakeService();
  const vaultKey = generateVaultKey();
  await seed(service, vaultKey, [epoch(1)]);
  const stale = { version: 1, ciphertext: service.vault.ciphertext.slice() };
  // Another device added epoch 3 meanwhile (version 2).
  await seed(service, vaultKey, [epoch(1), epoch(3)], 2);
  const result = await refreshVault({ api: service.api, vaultKey, ...context, local: { epochs: [epoch(1), epoch(4)] }, current: stale });
  assert.equal(result.status, "updated");
  assert.equal(result.version, 3);
  assert.deepEqual(await epochsIn(service, vaultKey), ["household:1", "household:3", "household:4"], "both devices' keys survive");
  assert.equal(service.uploads, 2);
  assert.equal(service.downloads, 1);

  // A merge that turns out to add nothing stops there.
  await seed(service, vaultKey, [epoch(1), epoch(3), epoch(4), epoch(5)], 4);
  assert.equal((await refreshVault({ api: service.api, vaultKey, ...context, local: { epochs: [epoch(5)] }, current: result })).status, "current");

  // A second conflict in a row is left for the next attempt.
  service.conflictAlways = true;
  const uploads = service.uploads;
  await assert.rejects(refreshVault({ api: service.api, vaultKey, ...context, local: { epochs: [epoch(6)] } }), { code: "vault_version_conflict" });
  assert.equal(service.uploads - uploads, 2);
});

test("conflicting key bytes for one epoch, a wrong vault key or a relabelled version are refused", async () => {
  const service = fakeService();
  const vaultKey = generateVaultKey();
  await seed(service, vaultKey, [epoch(1)]);
  await assert.rejects(refreshVault({ api: service.api, vaultKey, ...context, local: { epochs: [{ family: "household", epoch: 1, key: key(9) }] } }),
    { code: "vault_epoch_conflict" });
  await assert.rejects(refreshVault({ api: service.api, vaultKey: generateVaultKey(), ...context, local: { epochs: [epoch(2)] } }),
    { code: "vault_unlock_failed" });
  // A service that serves version 1's bytes as version 5 is caught.
  service.vault.version = 5;
  await assert.rejects(refreshVault({ api: service.api, vaultKey, ...context, local: { epochs: [epoch(2)] } }), { code: "vault_unlock_failed" });
  assert.equal(service.uploads, 0);
});

test("the keeper re-seals the vault when this device installs an epoch key for its household", async () => {
  const service = fakeService();
  const vaultKey = generateVaultKey();
  await seed(service, vaultKey, [epoch(1)]);
  let held = [epoch(1)];
  let vaultKeyHeld = true;
  const keeper = new VaultKeeper({
    api: service.api, householdId, memberId,
    vaultKey: async () => (vaultKeyHeld ? vaultKey.slice() : null),
    localContents: async () => ({ epochs: held.map((entry) => ({ ...entry, key: entry.key.slice() })) }),
  });
  const stop = keeper.watch(onEpochInstalled);
  try {
    const store = new SyncKeyStore(fakeEpochDatabase());
    const install = async (label, keyEpoch) => {
      await store.saveEpoch({ householdId: label, keyEpoch, householdKey: {}, sealed: { householdId: label, keyEpoch }, fingerprint: `f${keyEpoch}` });
      await keeper.queue;
    };
    held = [epoch(1), epoch(2)];
    await install(householdId, 2);
    assert.deepEqual(await epochsIn(service, vaultKey), ["household:1", "household:2"]);
    // Installing the same key again is not news.
    const uploads = service.uploads;
    await install(householdId, 2);
    assert.equal(service.uploads, uploads);
    // Another household's key is not this member's to keep.
    await install("c".repeat(32), 7);
    assert.equal(service.uploads, uploads);
    // A chat key is.
    held = [epoch(1), epoch(2), epoch(1, "chat")];
    await install(`chat:${householdId}`, 1);
    assert.deepEqual(await epochsIn(service, vaultKey), ["household:1", "household:2", "chat:1"]);
    assert.equal(service.downloads, 1, "the keeper reuses what it uploaded");
    // Without the vault key on this device, nothing happens.
    vaultKeyHeld = false;
    assert.deepEqual(await keeper.update(), { status: "no_vault_key" });
  } finally {
    stop();
  }
  assert.equal(vaultKey.some((value) => value !== 0), true, "the caller's own copy is untouched");
});

test("vaultApi speaks the service's JSON with base64url bytes", async () => {
  const calls = [];
  const ciphertext = new Uint8Array([75, 86, 76, 84, 1, 2, 3]);
  const wrapped = new Uint8Array(61).fill(1);
  const api = vaultApi(async (path, options) => {
    calls.push([path, options.method, options.body && JSON.parse(options.body)]);
    if (options.method === "GET") return { vault: { version: 3, ciphertext: "S1ZMVAECAw", updatedAt: 9 }, wrappers: [{ wrapperId: "1".repeat(32), wrapped: Buffer.from(wrapped).toString("base64url") }] };
    return { version: 4 };
  });
  const downloaded = await api.download();
  assert.deepEqual(downloaded.vault.ciphertext, ciphertext);
  assert.deepEqual(downloaded.wrappers[0].wrapped, wrapped);
  await api.upload({ expectedVersion: 3, ciphertext });
  await api.putWrapper({ wrapperId: "2".repeat(32), type: "backup-code", version: 1, params: {}, wrapped }, { currentAuthKey: "A".repeat(43), extra: "dropped" });
  await api.removeWrapper("2".repeat(32), { flow: "flow-1", credential: { id: "cred" } });
  assert.throws(() => api.removeWrapper("../x"));
  assert.deepEqual(calls.slice(1).map(([path, method]) => [path, method]), [
    ["/api/account/vault", "PUT"], [`/api/account/vault/wrappers/${"2".repeat(32)}`, "PUT"], [`/api/account/vault/wrappers/${"2".repeat(32)}`, "DELETE"],
  ]);
  assert.deepEqual(calls[1][2], { expectedVersion: 3, ciphertext: "S1ZMVAECAw" });
  assert.equal(calls[2][2].wrapped.length, 82);
  // The per-wrapper routes carry the fresh confirmation the service asks for (#592 follow-up).
  assert.equal(calls[2][2].currentAuthKey, "A".repeat(43));
  assert.equal(calls[2][2].extra, undefined);
  assert.deepEqual(calls[3][2], { flow: "flow-1", credential: { id: "cred" } });
});

/** Just enough of IndexedDB for SyncKeyStore.saveEpoch: one epochs store. */
function fakeEpochDatabase() {
  const rows = new Map();
  return {
    transaction() {
      const transaction = {
        objectStore: () => ({
          get(key) {
            const request = {};
            queueMicrotask(() => {
              request.result = rows.get(key);
              request.onsuccess?.();
              queueMicrotask(() => transaction.oncomplete?.());
            });
            return request;
          },
          add(row) { rows.set(row.key, row); },
        }),
        abort() { queueMicrotask(() => transaction.onabort?.()); },
      };
      return transaction;
    },
  };
}
