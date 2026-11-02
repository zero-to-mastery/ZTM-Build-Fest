// The member key (#486, #487, #488, ADR 0019): created on first use, kept
// only in the member's account vault (contents format 2), read by every one
// of the member's devices, rotated when one of them is revoked, and dropped
// on lock. A fake vault service plays the compare-and-set routes.
import test from "node:test";
import assert from "node:assert/strict";
import { generateVaultKey, openVault, sealVault } from "../security/account-vault.js";
import { VaultKeeper } from "../security/account-vault-sync.js";
import { MemberKeyRing, memberRevocationMark } from "./member-key.js";

const householdId = "a".repeat(32);
const memberId = "b".repeat(32);
const context = { householdId, memberId };

function fakeService() {
  const service = { vault: null, uploads: 0, downloads: 0, offline: false, serve: null };
  service.api = {
    async download() {
      service.downloads += 1;
      if (service.offline) throw Object.assign(new Error("offline"), { code: "connection_unavailable" });
      const vault = service.serve ?? service.vault;
      return { vault: vault && { ...vault, ciphertext: vault.ciphertext.slice() }, wrappers: [] };
    },
    async upload({ expectedVersion, ciphertext }) {
      service.uploads += 1;
      if ((service.vault?.version ?? 0) !== expectedVersion) throw Object.assign(new Error("conflict"), { code: "vault_version_conflict" });
      service.vault = { version: expectedVersion + 1, ciphertext: ciphertext.slice(), updatedAt: 1 };
      return { version: service.vault.version };
    },
  };
  return service;
}

async function seed(service, vaultKey, contents = { epochs: [{ family: "household", epoch: 1, key: new Uint8Array(32).fill(1) }] }) {
  service.vault = { version: 1, ciphertext: await sealVault(vaultKey, contents, { ...context, version: 1 }), updatedAt: 1 };
}

const memberKeysIn = async (service, vaultKey) =>
  (await openVault(vaultKey, service.vault.ciphertext, { ...context, version: service.vault.version })).memberKeys;

function ring(service, vaultKey, { cache = null, held = () => true } = {}) {
  return new MemberKeyRing({ api: service.api, ...context, vaultKey: async () => (held() ? vaultKey.slice() : null), cache });
}

async function roundTrip(from, to, epoch) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await from.key(epoch), new TextEncoder().encode("mine"));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await to.key(epoch), sealed));
}

test("without a vault key or a vault there is no member key, and nothing is created", async () => {
  const service = fakeService();
  const vaultKey = generateVaultKey();
  assert.equal(await ring(service, vaultKey, { held: () => false }).load(), "no_vault_key");
  assert.equal(service.downloads, 0, "no vault key, no request");
  const phone = ring(service, vaultKey);
  assert.equal(await phone.load(), "no_vault");
  assert.equal(await phone.create(), "no_vault", "private storage needs an account vault (ADR 0019)");
  assert.equal(service.uploads, 0);
  assert.equal(phone.available, false);
  assert.throws(() => phone.current(), { code: "private_key_unavailable" });
});

test("first use creates epoch 1 in the vault, and the member's other devices read the same key", async () => {
  const service = fakeService();
  const vaultKey = generateVaultKey();
  await seed(service, vaultKey);
  const phone = ring(service, vaultKey);
  assert.equal(await phone.load(), "no_member_key");
  assert.equal(await phone.create({ revokedThrough: 1234 }), "ready");
  assert.equal(service.vault.version, 2);
  assert.equal(service.vault.ciphertext.length > 0, true);
  const stored = await memberKeysIn(service, vaultKey);
  assert.deepEqual(stored.map(({ epoch, revokedThrough }) => [epoch, revokedThrough]), [[1, 1234]]);
  // The vault's household epochs are kept, and the contents are now format 2.
  assert.equal((await openVault(vaultKey, service.vault.ciphertext, { ...context, version: 2 })).epochs.length, 1);
  assert.equal(phone.current().epoch, 1);
  assert.equal(phone.current().key.extractable, false, "held as a non-extractable CryptoKey");
  // Creating again changes nothing.
  assert.equal(await phone.create(), "ready");
  assert.equal(service.vault.version, 2);

  const laptop = ring(service, vaultKey);
  assert.equal(await laptop.load(), "ready");
  assert.equal(await roundTrip(phone, laptop, 1), "mine");

  // Lock drops every key; the next unlock reads the vault again.
  phone.lock();
  assert.equal(phone.available, false);
  assert.equal(phone.status, "locked");
  assert.equal(await phone.load(), "ready");
});

test("the household epoch keeper never drops member keys when it re-seals the vault", async () => {
  const service = fakeService();
  const vaultKey = generateVaultKey();
  await seed(service, vaultKey);
  await ring(service, vaultKey).create();
  const keeper = new VaultKeeper({ api: service.api, ...context, vaultKey: async () => vaultKey.slice(),
    localContents: async () => ({ epochs: [{ family: "household", epoch: 2, key: new Uint8Array(32).fill(2) }] }) });
  assert.equal((await keeper.update()).status, "updated");
  assert.deepEqual((await memberKeysIn(service, vaultKey)).map((entry) => entry.epoch), [1]);
});

test("revoking one of the member's devices starts the next epoch once; a racing device adopts it", async () => {
  const service = fakeService();
  const vaultKey = generateVaultKey();
  await seed(service, vaultKey);
  const phone = ring(service, vaultKey);
  await phone.create({ revokedThrough: 0 });
  const tablet = ring(service, vaultKey);
  await tablet.load();

  // Nothing newer than the epoch: nothing to do, and no request.
  const downloads = service.downloads;
  assert.equal(await phone.rotate({ revokedThrough: 0 }), "current");
  assert.equal(service.downloads, downloads);

  // The laptop was revoked at 5000: the phone starts epoch 2.
  assert.equal(await phone.rotate({ revokedThrough: 5000 }), "rotated");
  assert.deepEqual((await memberKeysIn(service, vaultKey)).map(({ epoch, revokedThrough }) => [epoch, revokedThrough]), [[1, 0], [2, 5000]]);
  assert.equal(phone.current().epoch, 2);
  // The tablet, seeing the same revocation, finds the epoch already made.
  assert.equal(await tablet.rotate({ revokedThrough: 5000 }), "adopted");
  assert.equal(tablet.current().epoch, 2);
  assert.equal(await roundTrip(phone, tablet, 2), "mine");
  assert.equal(await roundTrip(tablet, phone, 1), "mine", "old epochs stay readable");
});

test("two devices that start the same epoch at once end with one key", async () => {
  const service = fakeService();
  const vaultKey = generateVaultKey();
  await seed(service, vaultKey);
  const phone = ring(service, vaultKey);
  await phone.create();
  const tablet = ring(service, vaultKey);
  await tablet.load();
  // Both read version 2 before either writes: the second's upload conflicts,
  // its merge finds a different epoch 2, and it adopts the first's.
  const realDownload = service.api.download;
  let gate;
  const bothRead = new Promise((resolve) => { gate = resolve; });
  let reads = 0;
  service.api.download = async () => {
    const value = await realDownload();
    reads += 1;
    if (reads === 2) gate();
    await bothRead;
    return value;
  };
  const results = await Promise.all([phone.rotate({ revokedThrough: 9 }), tablet.rotate({ revokedThrough: 9 })]);
  service.api.download = realDownload;
  assert.deepEqual(results.sort(), ["adopted", "rotated"]);
  assert.deepEqual((await memberKeysIn(service, vaultKey)).map((entry) => entry.epoch), [1, 2]);
  assert.equal(await roundTrip(phone, tablet, 2), "mine", "both hold the winner's epoch 2");
});

test("an offline unlock opens the cached vault; the service can't roll it back", async () => {
  const service = fakeService();
  const vaultKey = generateVaultKey();
  await seed(service, vaultKey);
  let saved = null;
  const cache = { load: async () => saved, save: async (known) => { saved = { version: known.version, ciphertext: known.ciphertext.slice() }; } };
  const phone = ring(service, vaultKey, { cache });
  await phone.create();
  const old = { ...service.vault, ciphertext: service.vault.ciphertext.slice() };
  await phone.rotate({ revokedThrough: 7 });
  assert.equal(saved.version, 3);

  service.offline = true;
  const offline = ring(service, vaultKey, { cache });
  assert.equal(await offline.load(), "ready");
  assert.equal(offline.current().epoch, 2);
  // Back online, a service serving the older version 2 is ignored.
  service.offline = false;
  service.serve = old;
  const rolledBack = ring(service, vaultKey, { cache });
  assert.equal(await rolledBack.load(), "ready");
  assert.equal(rolledBack.current().epoch, 2);
  // Offline with nothing cached: the error surfaces for the next pass.
  service.offline = true;
  await assert.rejects(ring(service, vaultKey).load(), { code: "connection_unavailable" });
});

test("a missing epoch is looked for once, then reported", async () => {
  const service = fakeService();
  const vaultKey = generateVaultKey();
  await seed(service, vaultKey);
  const phone = ring(service, vaultKey);
  await phone.create();
  const laptop = ring(service, vaultKey);
  await laptop.load();
  await phone.rotate({ revokedThrough: 3 });
  // The laptop hasn't seen epoch 2 yet: it re-reads the vault and finds it.
  assert.ok(await laptop.key(2));
  const downloads = service.downloads;
  await assert.rejects(laptop.key(9), { code: "private_key_missing" });
  await assert.rejects(laptop.key(9), { code: "private_key_missing" });
  assert.equal(service.downloads, downloads + 1, "one vault read per missing epoch");
});

test("the revocation mark is the latest revocation among the member's own devices", () => {
  const devices = [
    { deviceId: "1", memberId, revokedAt: 10 },
    { deviceId: "2", memberId, revokedAt: null },
    { deviceId: "3", memberId: "c".repeat(32), revokedAt: 99 },
    { deviceId: "4", memberId, revokedAt: 25 },
  ];
  assert.equal(memberRevocationMark(devices, memberId), 25, "another member's revocation doesn't count");
  assert.equal(memberRevocationMark([], memberId), 0);
});
