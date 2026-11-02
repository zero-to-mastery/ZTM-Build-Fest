import test from "node:test";
import assert from "node:assert/strict";
import {
  WRAPPER_TYPES, backupCodeKek, combinedKek, decodeVaultContents, derivePasswordKeys, encodeVaultContents,
  generateCertificationKey, generateVaultKey, importCertificationKey, mergeVaultContents, newPasswordSalt,
  generateMemberKey, newWrapperId, openVault, passkeyKek, sealVault, unwrapVaultKey, wrapVaultKey,
} from "./account-vault.js";

const householdId = "a".repeat(32);
const memberId = "b".repeat(32);
const context = { householdId, memberId, version: 1 };
const random = (length = 32) => crypto.getRandomValues(new Uint8Array(length));

function sampleContents(certificationKey = null) {
  return {
    epochs: [
      { family: "chat", epoch: 1, key: random() },
      { family: "household", epoch: 2, key: random() },
      { family: "household", epoch: 1, key: random() },
    ],
    certificationKey,
    memberKeys: [],
  };
}

test("vault contents round-trip in canonical order and refuse malformed bytes", async () => {
  const { pkcs8 } = await generateCertificationKey();
  const contents = sampleContents(pkcs8);
  const encoded = encodeVaultContents(contents);
  const decoded = decodeVaultContents(encoded);
  assert.deepEqual(decoded.epochs.map(({ family, epoch }) => `${family}:${epoch}`), ["household:1", "household:2", "chat:1"]);
  assert.deepEqual(decoded.certificationKey, pkcs8);
  assert.deepEqual(decoded.memberKeys, []);
  assert.equal(encoded[0], 1, "a vault with no member key is still written as format 1");
  assert.deepEqual(encodeVaultContents(decoded), encoded);
  // The certification key imports for signing.
  const key = await importCertificationKey(decoded.certificationKey);
  assert.equal(key.algorithm.name, "ECDSA");

  assert.throws(() => decodeVaultContents(encoded.subarray(0, encoded.length - 1)), { code: "vault_corrupt" });
  assert.throws(() => decodeVaultContents(new Uint8Array([...encoded, 0])), { code: "vault_corrupt" });
  const unsorted = encoded.slice(); unsorted[7] = 9; // first entry's epoch becomes 9 > the next
  assert.throws(() => decodeVaultContents(unsorted), { code: "vault_corrupt" });
  const newer = encoded.slice(); newer[0] = 3;
  assert.throws(() => decodeVaultContents(newer), { code: "vault_unsupported" });
  assert.throws(() => encodeVaultContents({ epochs: [{ family: "household", epoch: 1, key: random() }, { family: "household", epoch: 1, key: random() }] }));
  assert.throws(() => encodeVaultContents({ epochs: [{ family: "household", epoch: 129, key: random() }] }));
});

test("format 2 holds member-key epochs; format 1's reserved slot reads as epoch 1", () => {
  const one = generateMemberKey(), two = generateMemberKey();
  assert.equal(one.length, 32);
  assert.notDeepEqual(one, two);
  const contents = { ...sampleContents(), memberKeys: [{ epoch: 2, key: two, revokedThrough: 1_791_475_200_123 }, { epoch: 1, key: one, revokedThrough: 0 }] };
  const encoded = encodeVaultContents(contents);
  assert.equal(encoded[0], 2, "written as format 2 once a member key exists");
  const decoded = decodeVaultContents(encoded);
  assert.deepEqual(decoded.memberKeys, [{ epoch: 1, key: one, revokedThrough: 0 }, { epoch: 2, key: two, revokedThrough: 1_791_475_200_123 }]);
  assert.deepEqual(decoded.epochs.map(({ family, epoch }) => `${family}:${epoch}`), ["household:1", "household:2", "chat:1"]);
  assert.deepEqual(encodeVaultContents(decoded), encoded);
  // The tail: count u16, then epoch u16, 0 u16, revokedThrough u64, key.
  const tail = encoded.length - 2 - 2 * 44;
  assert.deepEqual([...encoded.subarray(tail, tail + 6)], [0, 2, 0, 1, 0, 0]);
  assert.deepEqual([...encoded.subarray(tail + 6, tail + 14)], [0, 0, 0, 0, 0, 0, 0, 0]);

  // Damaged or out-of-range member-key lists are refused.
  const unsorted = encoded.slice(); unsorted[tail + 3] = 3;
  assert.throws(() => decodeVaultContents(unsorted), { code: "vault_corrupt" });
  const reserved = encoded.slice(); reserved[tail + 5] = 1;
  assert.throws(() => decodeVaultContents(reserved), { code: "vault_corrupt" });
  assert.throws(() => decodeVaultContents(encoded.subarray(0, encoded.length - 1)), { code: "vault_corrupt" });
  const empty = encoded.slice(0, tail + 2); empty[tail] = 0; empty[tail + 1] = 0;
  assert.throws(() => decodeVaultContents(empty), { code: "vault_corrupt" }, "format 2 always has a member key");
  assert.throws(() => encodeVaultContents({ memberKeys: [{ epoch: 1, key: one }, { epoch: 1, key: two }] }));
  assert.throws(() => encodeVaultContents({ memberKeys: [{ epoch: 129, key: one }] }));
  assert.throws(() => encodeVaultContents({ memberKeys: [{ epoch: 1, key: one.subarray(0, 16) }] }));
  assert.throws(() => encodeVaultContents({ memberKeys: [{ epoch: 1, key: one, revokedThrough: -1 }] }));

  // A format 1 vault from before ADR 0019 with its reserved slot filled.
  const legacy = encodeVaultContents({ epochs: [] });
  const filled = new Uint8Array(legacy.length + 32);
  filled.set(legacy);
  filled[filled.length - 33] = 32;
  filled.set(one, legacy.length);
  assert.deepEqual(decodeVaultContents(filled).memberKeys, [{ epoch: 1, key: one, revokedThrough: 0 }]);
});

test("a sealed vault opens only with its key, household, member and version", async () => {
  const vaultKey = generateVaultKey();
  const contents = sampleContents();
  const sealed = await sealVault(vaultKey, contents, context);
  const opened = await openVault(vaultKey, sealed, context);
  assert.deepEqual(opened.epochs.map((entry) => entry.key), [contents.epochs[2].key, contents.epochs[1].key, contents.epochs[0].key]);

  // Two seals of the same contents differ (fresh salt and nonce).
  assert.notDeepEqual(await sealVault(vaultKey, contents, context), sealed);
  await assert.rejects(openVault(generateVaultKey(), sealed, context), { code: "vault_unlock_failed" });
  for (const substitute of [{ householdId: "c".repeat(32) }, { memberId: "c".repeat(32) }, { version: 2 }])
    await assert.rejects(openVault(vaultKey, sealed, { ...context, ...substitute }), { code: "vault_unlock_failed" });
  for (const index of [5, 40, sealed.length - 1, sealed.length - 20]) {
    const tampered = sealed.slice(); tampered[index] ^= 1;
    await assert.rejects(openVault(vaultKey, tampered, context), { code: "vault_unlock_failed" });
  }
  const magic = sealed.slice(); magic[0] ^= 1;
  await assert.rejects(openVault(vaultKey, magic, context), { code: "vault_corrupt" });
  const format = sealed.slice(); format[4] = 2;
  await assert.rejects(openVault(vaultKey, format, context), { code: "vault_unsupported" });
  await assert.rejects(openVault(vaultKey, sealed.subarray(0, 60), context), { code: "vault_corrupt" });
});

test("each wrapper type round-trips and is bound to its type, ID, version and member", async () => {
  const vaultKey = generateVaultKey();
  for (const type of WRAPPER_TYPES) {
    const kek = random();
    const wrapper = { householdId, memberId, type, wrapperId: newWrapperId(), version: 1 };
    const wrapped = await wrapVaultKey(vaultKey, kek, wrapper);
    assert.equal(wrapped.length, 61);
    assert.deepEqual(await unwrapVaultKey(wrapped, kek, wrapper), vaultKey);
    await assert.rejects(unwrapVaultKey(wrapped, random(), wrapper), { code: "vault_unlock_failed" });
    const otherType = WRAPPER_TYPES.find((value) => value !== type);
    for (const substitute of [{ type: otherType }, { wrapperId: newWrapperId() }, { version: 2 }, { memberId: "c".repeat(32) }, { householdId: "c".repeat(32) }])
      await assert.rejects(unwrapVaultKey(wrapped, kek, { ...wrapper, ...substitute }), { code: "vault_unlock_failed" });
    const tampered = wrapped.slice(); tampered[30] ^= 1;
    await assert.rejects(unwrapVaultKey(tampered, kek, wrapper), { code: "vault_unlock_failed" });
  }
});

test("password keys: one stretch splits into independent authKey and passwordKey", async () => {
  const salt = newPasswordSalt();
  const first = await derivePasswordKeys("correct horse battery staple", salt);
  assert.equal(first.authKey.length, 32);
  assert.equal(first.passwordKey.length, 32);
  assert.notDeepEqual(first.authKey, first.passwordKey);
  // NFC normalization: a decomposed "é" derives the same keys as the composed one.
  const composed = await derivePasswordKeys("café", salt);
  const decomposed = await derivePasswordKeys("café", salt);
  assert.deepEqual(composed.passwordKey, decomposed.passwordKey);
  assert.notDeepEqual(composed.passwordKey, first.passwordKey);
  // Fewer iterations than the floor are refused before any work.
  await assert.rejects(derivePasswordKeys("x", salt, { iterations: 1000 }), { code: "password_params_invalid" });
  await assert.rejects(derivePasswordKeys("x", new Uint8Array(8)), { code: "password_params_invalid" });
  await assert.rejects(derivePasswordKeys("", salt), { code: "password_invalid" });

  // The password wrapper opens with passwordKey, never with authKey (what the service sees).
  const vaultKey = generateVaultKey();
  const wrapper = { householdId, memberId, type: "password", wrapperId: newWrapperId(), version: 1 };
  const wrapped = await wrapVaultKey(vaultKey, first.passwordKey, wrapper);
  assert.deepEqual(await unwrapVaultKey(wrapped, first.passwordKey, wrapper), vaultKey);
  await assert.rejects(unwrapVaultKey(wrapped, first.authKey, wrapper), { code: "vault_unlock_failed" });
  await assert.rejects(unwrapVaultKey(wrapped, composed.passwordKey, wrapper), { code: "vault_unlock_failed" });
});

test("passkey, backup-code and combined KEKs are domain separated; either secret alone fails the combined wrapper", async () => {
  const prf = random();
  const passwordKey = random();
  const passkey = await passkeyKek(prf);
  const backup = await backupCodeKek(prf);
  const both = await combinedKek(prf, passwordKey);
  assert.notDeepEqual(passkey, prf);
  assert.notDeepEqual(passkey, backup);
  assert.notDeepEqual(both, passkey);
  assert.deepEqual(await passkeyKek(prf), passkey);

  const vaultKey = generateVaultKey();
  const wrapper = { householdId, memberId, type: "password-passkey", wrapperId: newWrapperId(), version: 1 };
  const wrapped = await wrapVaultKey(vaultKey, both, wrapper);
  assert.deepEqual(await unwrapVaultKey(wrapped, await combinedKek(prf, passwordKey), wrapper), vaultKey);
  for (const kek of [passkey, passwordKey, prf, await combinedKek(prf, random()), await combinedKek(random(), passwordKey)])
    await assert.rejects(unwrapVaultKey(wrapped, kek, wrapper), { code: "vault_unlock_failed" });
});

test("merging takes the union by epoch, reports change, and refuses conflicting keys", () => {
  const one = random(); const two = random(); const three = random();
  const remote = { epochs: [{ family: "household", epoch: 1, key: one }, { family: "household", epoch: 2, key: two }], certificationKey: null };
  const local = { epochs: [{ family: "household", epoch: 2, key: two.slice() }, { family: "household", epoch: 3, key: three }] };
  const { contents, changed } = mergeVaultContents(remote, local);
  assert.equal(changed, true);
  assert.deepEqual(contents.epochs.map((entry) => entry.epoch), [1, 2, 3]);
  assert.equal(mergeVaultContents(contents, local).changed, false);
  assert.equal(mergeVaultContents(contents, { epochs: [{ family: "chat", epoch: 3, key: three }] }).changed, true);
  assert.throws(() => mergeVaultContents(remote, { epochs: [{ family: "household", epoch: 1, key: random() }] }), { code: "vault_epoch_conflict" });
  const certificationKey = random(138);
  assert.equal(mergeVaultContents(remote, { certificationKey }).contents.certificationKey, certificationKey);
  assert.throws(() => mergeVaultContents({ certificationKey }, { certificationKey: random(138) }), { code: "vault_key_conflict" });
});

test("merging keeps member keys from either side and refuses a second key for one epoch", () => {
  const one = random(), two = random();
  const stored = { epochs: [{ family: "household", epoch: 1, key: random() }], memberKeys: [{ epoch: 1, key: one, revokedThrough: 0 }] };
  // A device keeping household epochs (VaultKeeper) never drops member keys.
  const kept = mergeVaultContents(stored, { epochs: [{ family: "household", epoch: 2, key: random() }] });
  assert.equal(kept.changed, true);
  assert.deepEqual(kept.contents.memberKeys.map((entry) => entry.epoch), [1]);
  const rotated = mergeVaultContents(stored, { memberKeys: [{ epoch: 2, key: two, revokedThrough: 5 }] });
  assert.equal(rotated.changed, true);
  assert.deepEqual(rotated.contents.memberKeys.map((entry) => [entry.epoch, entry.revokedThrough]), [[1, 0], [2, 5]]);
  assert.equal(mergeVaultContents(rotated.contents, { memberKeys: [{ epoch: 2, key: two.slice(), revokedThrough: 5 }] }).changed, false);
  // Two devices that both started epoch 2: the second must adopt the first's.
  assert.throws(() => mergeVaultContents(rotated.contents, { memberKeys: [{ epoch: 2, key: random(), revokedThrough: 5 }] }), { code: "vault_member_key_conflict" });
  assert.throws(() => mergeVaultContents(rotated.contents, { memberKeys: [{ epoch: 2, key: two, revokedThrough: 6 }] }), { code: "vault_member_key_conflict" });
});
