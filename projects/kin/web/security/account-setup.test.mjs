// Signing up with a password, unlocking with it, and the first account vault (#558).
import assert from "node:assert/strict";
import test from "node:test";
import { openVault, PASSWORD_ITERATIONS, unwrapVaultKey } from "./account-vault.js";
import { confirmationAuthKey, createAccountVault, currentPasswordParameters, keysUnder, passwordChangedElsewhere, passwordUnlockKeys, passwordWrapper, prepareSignUp, signUpBody, wipeSignUp } from "./account-setup.js";
import { LocalVault, toBase64Url } from "./local-vault.js";

const householdId = "a".repeat(32);
const memberId = "b".repeat(32);

test("sign-up refuses weak passwords and odd usernames in plain words, before any key work", async () => {
  await assert.rejects(prepareSignUp({ username: "sam", password: "short" }), { code: "password_rejected", message: /at least 10 characters/ });
  await assert.rejects(prepareSignUp({ username: "sam", password: "password123" }), { code: "password_rejected", message: /too easy to guess/ });
  await assert.rejects(prepareSignUp({ username: "s", password: "four unrelated words" }), { code: "password_rejected", message: /username/ });
});

test("one password gives the sign-in key, a local unlock and the vault key's wrapper, all different", async () => {
  const prepared = await prepareSignUp({ username: "Sam", password: "four unrelated words" });
  assert.equal(prepared.username, "sam");
  assert.equal(prepared.iterations, PASSWORD_ITERATIONS);
  const body = signUpBody(prepared);
  assert.deepEqual(Object.keys(body).sort(), ["authKey", "iterations", "salt", "username"]);
  assert.ok(!JSON.stringify(body).includes(toBase64Url(prepared.passwordKey)), "passwordKey is never in what's sent");
  const distinct = new Set([prepared.authKey, prepared.passwordKey, prepared.localKek].map((bytes) => toBase64Url(bytes)));
  assert.equal(distinct.size, 3);

  // The local root, unlocked again from the typed password alone.
  const { vault, manifest } = await LocalVault.createWithPassword(prepared.localKek,
    { salt: toBase64Url(prepared.salt), iterations: prepared.iterations, username: prepared.username });
  vault.lock();
  const wrapper = passwordWrapper(manifest);
  assert.equal(wrapper.username, "sam");
  const again = await passwordUnlockKeys(wrapper, "four unrelated words");
  assert.deepEqual(again.authKey, prepared.authKey, "the same authKey signs in after an offline unlock");
  (await LocalVault.unlock(manifest, again.localKek, wrapper.id)).lock();
  const wrong = await passwordUnlockKeys(wrapper, "four unrelated wordz");
  await assert.rejects(LocalVault.unlock(manifest, wrong.localKek, wrapper.id), { code: "unlock_failed" });
  assert.equal(passwordWrapper({ wrappers: [{ type: "recovery" }] }), null);

  // A fresh confirmation derives the same authKey from the service's parameters.
  assert.equal(await confirmationAuthKey("four unrelated words", { salt: toBase64Url(prepared.salt), iterations: prepared.iterations }), body.authKey);
  wipeSignUp(prepared);
  assert.ok(prepared.authKey.every((byte) => byte === 0) && prepared.localKek.every((byte) => byte === 0));
});

test("the first account vault holds this device's epoch keys and a certification key, behind one password wrapper", async () => {
  const prepared = await prepareSignUp({ username: "robin", password: "a long kitchen sentence" });
  const uploads = [];
  const api = { upload: async (value) => { uploads.push(value); return { version: 1 }; } };
  const epochKey = new Uint8Array(32).fill(9);
  const vaultKey = await createAccountVault({ api, householdId, memberId, passwordKey: prepared.passwordKey, salt: prepared.salt,
    epochs: [{ family: "household", epoch: 1, key: epochKey }] });
  assert.equal(uploads.length, 1);
  const [upload] = uploads;
  assert.equal(upload.expectedVersion, 0);
  assert.equal(upload.wrappers.length, 1);
  const [wrapper] = upload.wrappers;
  assert.deepEqual({ type: wrapper.type, version: wrapper.version, params: wrapper.params },
    { type: "password", version: 1, params: { kdf: "pbkdf2-sha256", iterations: PASSWORD_ITERATIONS, salt: toBase64Url(prepared.salt) } });
  // The password opens it; the contents are what this device had.
  const opened = await unwrapVaultKey(wrapper.wrapped, prepared.passwordKey, { householdId, memberId, type: "password", wrapperId: wrapper.wrapperId, version: 1 });
  assert.deepEqual(opened, vaultKey);
  const contents = await openVault(vaultKey, upload.ciphertext, { householdId, memberId, version: 1 });
  assert.deepEqual(contents.epochs.map(({ family, epoch, key }) => [family, epoch, [...key]]), [["household", 1, [...new Uint8Array(32).fill(9)]]]);
  assert.ok(contents.certificationKey?.length > 100, "a PKCS8 certification key is kept for the new-device story");
  // authKey, which the service sees, can't open it.
  await assert.rejects(unwrapVaultKey(wrapper.wrapped, prepared.authKey, { householdId, memberId, type: "password", wrapperId: wrapper.wrapperId, version: 1 }),
    { code: "vault_unlock_failed" });
  // A failed upload leaves nothing behind.
  await assert.rejects(createAccountVault({ api: { upload: async () => { throw Object.assign(new Error("taken"), { code: "vault_version_conflict" }); } },
    householdId, memberId, passwordKey: prepared.passwordKey, salt: prepared.salt }), { code: "vault_version_conflict" });
});

test("a password changed on another device is noticed from the service's parameters, online only (#560 follow-up)", async () => {
  const wrapper = { salt: "c2FsdHNhbHRzYWx0c2FsdA", iterations: 600_000, username: "sam" };
  const answers = [];
  const fetchImpl = async (path, options) => { answers.push([path, JSON.parse(options.body)]); return { ok: true, json: async () => ({ salt: "bmV3c2FsdG5ld3NhbHRuZQ", iterations: 600_000 }) }; };
  const parameters = await currentPasswordParameters("sam", { fetchImpl });
  assert.deepEqual(answers, [["/api/account/sign-in/parameters", { username: "sam" }]]);
  assert.equal(passwordChangedElsewhere(wrapper, parameters), true);
  assert.equal(passwordChangedElsewhere(wrapper, { salt: wrapper.salt, iterations: 600_000 }), false);
  assert.equal(passwordChangedElsewhere(wrapper, null), false, "offline: nothing to compare, the device's password works");
  assert.equal(await currentPasswordParameters("sam", { fetchImpl: async () => { throw new TypeError("offline"); } }), null);
  assert.equal(await currentPasswordParameters("sam", { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }), null);
  assert.equal(await currentPasswordParameters("", { fetchImpl }), null);
  // The keys of the new password under the new parameters.
  const prepared = await prepareSignUp({ username: "sam", password: "five other unrelated words" });
  const keys = await keysUnder({ salt: toBase64Url(prepared.salt), iterations: prepared.iterations }, "five other unrelated words");
  assert.deepEqual(keys.authKey, prepared.authKey);
  assert.deepEqual(keys.localKek, prepared.localKek);
  wipeSignUp(prepared);
});
