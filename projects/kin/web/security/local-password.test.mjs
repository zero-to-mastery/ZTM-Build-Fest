// The local password wrapper and the "final verified unlock path" rule (#558).
import assert from "node:assert/strict";
import test from "node:test";
import { derivePasswordKeys, newPasswordSalt, PASSWORD_ITERATIONS } from "./account-vault.js";
import { hasFinalUnlockPath, hasVerifiedUnlockPath, LocalVault, localPasswordKek, toBase64Url, validateManifest } from "./local-vault.js";

async function passwordVault(password = "four unrelated words") {
  const salt = newPasswordSalt();
  const { authKey, passwordKey } = await derivePasswordKeys(password, salt);
  authKey.fill(0);
  const kek = await localPasswordKek(passwordKey);
  passwordKey.fill(0);
  const params = { salt: toBase64Url(salt), iterations: PASSWORD_ITERATIONS, username: "sam" };
  const created = await LocalVault.createWithPassword(kek, params);
  return { ...created, kek, params, salt };
}

test("a password-only root unlocks with the password, offline, and with nothing else", async () => {
  const { vault, manifest, kek, salt } = await passwordVault();
  const sealed = await vault.seal({ text: "milk" }, { store: "events", id: "one" });
  vault.lock();
  assert.equal(manifest.wrappers.length, 1);
  const [wrapper] = manifest.wrappers;
  assert.equal(wrapper.type, "password");
  assert.deepEqual({ kdf: wrapper.kdf, iterations: wrapper.iterations, username: wrapper.username },
    { kdf: "pbkdf2-sha256", iterations: PASSWORD_ITERATIONS, username: "sam" });
  assert.ok(!JSON.stringify(manifest).includes(toBase64Url(kek)), "the KEK is never stored");
  validateManifest(manifest);

  // The same password derives the same KEK again from the wrapper's salt.
  const again = await derivePasswordKeys("four unrelated words", salt);
  const reopened = await LocalVault.unlock(manifest, await localPasswordKek(again.passwordKey), wrapper.id);
  assert.deepEqual(await reopened.open(sealed, { store: "events", id: "one" }), { text: "milk" });
  reopened.lock();

  const wrong = await derivePasswordKeys("four unrelated wordz", salt);
  await assert.rejects(LocalVault.unlock(manifest, await localPasswordKek(wrong.passwordKey), wrapper.id), { code: "unlock_failed" });
  // The password KEK is not passwordKey itself: a distinct HKDF purpose.
  await assert.rejects(LocalVault.unlock(manifest, again.passwordKey, wrapper.id), { code: "unlock_failed" });
  // No recovery wrapper exists to fall back to.
  await assert.rejects(LocalVault.unlock(manifest, "00".repeat(32)), { code: "wrapper_unavailable" });
});

test("a password wrapper's KDF parameters are authenticated", async () => {
  const { manifest, kek } = await passwordVault();
  const [wrapper] = manifest.wrappers;
  const otherSalt = toBase64Url(newPasswordSalt());
  for (const changed of [{ salt: otherSalt }, { iterations: PASSWORD_ITERATIONS + 1 }]) {
    const tampered = { ...manifest, wrappers: [{ ...wrapper, ...changed }] };
    await assert.rejects(LocalVault.unlock(tampered, kek, wrapper.id), { code: "unlock_failed" });
  }
  // The username is only a password-manager hint and is not bound.
  const renamed = { ...manifest, wrappers: [{ ...wrapper, username: "sam.lee" }] };
  (await LocalVault.unlock(renamed, kek, wrapper.id)).lock();
});

test("password wrappers below the KDF floor or malformed are refused", async () => {
  const { manifest } = await passwordVault();
  const [wrapper] = manifest.wrappers;
  for (const changed of [{ iterations: 599_999 }, { kdf: "pbkdf2-sha1" }, { salt: "short" }, { username: "Sam Lee" }, { salt: undefined }])
    assert.throws(() => validateManifest({ ...manifest, wrappers: [{ ...wrapper, ...changed }] }), { message: /unlock metadata is invalid/ }, JSON.stringify(changed));
});

test("the final verified unlock path: a backup key, or a password for a password member", async () => {
  assert.equal(hasVerifiedUnlockPath([{ type: "recovery" }]), true);
  assert.equal(hasVerifiedUnlockPath([{ type: "password" }]), true);
  assert.equal(hasVerifiedUnlockPath([{ type: "prf" }]), false, "a passkey alone needs the service");
  assert.equal(hasVerifiedUnlockPath([]), false);
  assert.equal(hasVerifiedUnlockPath(undefined), false);

  // A password member who adds passkey unlock can remove the passkey again,
  // but never the password wrapper while it is the only independent path.
  const { vault, manifest } = await passwordVault();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const withPasskey = await vault.addCredentialWrapper(secret, { credentialId: "credential-A", prfSalt: "salt-A" });
  const passwordId = manifest.wrappers[0].id;
  const passkeyId = withPasskey.wrappers.find((entry) => entry.type === "prf").id;
  assert.throws(() => vault.removeWrapper(passwordId), { code: "last_wrapper" });
  assert.deepEqual(vault.removeWrapper(passkeyId).wrappers.map((entry) => entry.type), ["password"]);
  vault.lock();
});

test("a password change re-wraps the local root under the same wrapper ID; the old password stops opening it (#560)", async () => {
  const { vault, manifest, kek } = await passwordVault();
  const sealed = await vault.seal({ text: "bread" }, { store: "events", id: "two" });
  const salt = newPasswordSalt();
  const next = await derivePasswordKeys("five other unrelated words", salt);
  const nextKek = await localPasswordKek(next.passwordKey);
  const replaced = await vault.replacePasswordWrapper(nextKek, { salt: toBase64Url(salt), iterations: PASSWORD_ITERATIONS });
  vault.lock();
  const [wrapper] = replaced.wrappers;
  assert.equal(wrapper.id, manifest.wrappers[0].id, "same ID: no other tab's unlock is revoked");
  assert.equal(wrapper.salt, toBase64Url(salt));
  assert.equal(wrapper.username, "sam", "the username hint stays");
  validateManifest(replaced);
  const reopened = await LocalVault.unlock(replaced, nextKek, wrapper.id);
  assert.deepEqual(await reopened.open(sealed, { store: "events", id: "two" }), { text: "bread" }, "the same root: nothing is re-encrypted");
  reopened.lock();
  await assert.rejects(LocalVault.unlock(replaced, kek, wrapper.id), { code: "unlock_failed" });
  // A device without a password wrapper has nothing to replace.
  const { vault: keyed } = await LocalVault.create();
  await assert.rejects(keyed.replacePasswordWrapper(nextKek, { salt: toBase64Url(salt), iterations: PASSWORD_ITERATIONS }), { code: "wrapper_unavailable" });
  keyed.lock();
});

test("a passkey-only root for a member with a backup code: the account is its final path (#572)", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const { vault, manifest } = await LocalVault.createWithPasskey(secret, { credentialId: "credential-A", prfSalt: "salt-A" });
  assert.deepEqual(manifest.wrappers.map((entry) => entry.type), ["prf"]);
  assert.equal(manifest.accountRecovery, "backup-code");
  validateManifest(manifest);
  assert.equal(hasVerifiedUnlockPath(manifest.wrappers), false, "no offline path of its own");
  assert.equal(hasFinalUnlockPath(manifest), true);
  assert.equal(hasFinalUnlockPath({ ...manifest, accountRecovery: undefined }), false, "only with the account's backup code");
  assert.equal(hasFinalUnlockPath({ ...manifest, wrappers: [] }), false, "and a passkey to unlock with");
  assert.throws(() => validateManifest({ ...manifest, accountRecovery: "anything" }), /unsupported or corrupt/);
  // A second passkey can be added and removed; the last one stays.
  const other = crypto.getRandomValues(new Uint8Array(32));
  const two = await vault.addCredentialWrapper(other, { credentialId: "credential-B", prfSalt: "salt-B" });
  assert.equal(two.accountRecovery, "backup-code");
  assert.deepEqual(vault.removeWrapper(two.wrappers[1].id).wrappers.map((entry) => entry.credentialId), ["credential-A"]);
  assert.throws(() => vault.removeWrapper(manifest.wrappers[0].id), { code: "last_wrapper" });
  vault.lock();
  const reopened = await LocalVault.unlock(manifest, secret, manifest.wrappers[0].id);
  reopened.lock();
});

test("households set up with a backup key keep the old rule exactly", async () => {
  const { vault, manifest } = await LocalVault.create();
  const recoveryId = manifest.wrappers[0].id;
  const secret = crypto.getRandomValues(new Uint8Array(32));
  await vault.addCredentialWrapper(secret, { credentialId: "credential-A", prfSalt: "salt-A" });
  assert.throws(() => vault.removeWrapper(recoveryId), { code: "last_wrapper" });
  vault.lock();
});

test("a member moving to an account adds a password unlock beside the backup key and passkey (#575)", async () => {
  const { vault, manifest } = await LocalVault.create();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  await vault.addCredentialWrapper(secret, { credentialId: "credential-A", prfSalt: "salt-A" });
  const salt = newPasswordSalt();
  const keys = await derivePasswordKeys("four unrelated words", salt);
  const kek = await localPasswordKek(keys.passwordKey);
  const added = await vault.addPasswordWrapper(kek, { salt: toBase64Url(salt), iterations: PASSWORD_ITERATIONS, username: "robin" });
  assert.deepEqual(added.wrappers.map((entry) => entry.type), ["recovery", "prf", "password"]);
  validateManifest(added);
  await assert.rejects(vault.addPasswordWrapper(kek, { salt: toBase64Url(salt), iterations: PASSWORD_ITERATIONS }), { code: "wrapper_exists" });
  // The same root opens with the password, the backup key and the passkey.
  const sealed = await vault.seal({ text: "rice" }, { store: "events", id: "three" });
  vault.lock();
  const passwordWrapper = added.wrappers.find((entry) => entry.type === "password");
  const byPassword = await LocalVault.unlock(added, kek, passwordWrapper.id);
  assert.deepEqual(await byPassword.open(sealed, { store: "events", id: "three" }), { text: "rice" });
  byPassword.lock();
  (await LocalVault.unlock(added, secret, added.wrappers[1].id)).lock();
  assert.equal(added.wrappers[0].id, manifest.wrappers[0].id, "the backup key's wrapper is untouched (#576)");
});
