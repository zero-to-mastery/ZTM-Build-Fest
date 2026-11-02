// Vault-wrapper transitions (#561/#572), with real Web Crypto: what each
// secret opens after each step. password only -> passkey (password-only gone)
// -> require password and passkey -> off; a password change re-wraps; a new
// backup code replaces the old one.
import assert from "node:assert/strict";
import test from "node:test";
import { derivePasswordKeys, backupCodeKek, combinedKek, generateVaultKey, passkeyKek, unwrapVaultKey } from "./account-vault.js";
import {
  accountWrapperState,
  addPasskeyChange,
  backupCodeChange,
  makeWrapper,
  passwordChangeWrappers,
  passwordParams,
  removePasskeyChange,
  requireBothChange,
  wrapperChangeBody,
} from "./account-wrappers.js";
import { generateBackupCode } from "./backup-code.js";

const householdId = "a".repeat(32);
const memberId = "b".repeat(32);
const ids = { householdId, memberId };
const random = () => crypto.getRandomValues(new Uint8Array(32));
const SALT = new Uint8Array(16).fill(3);
const password = { salt: SALT, iterations: 600_000 };
let keys = null;
const passwordKeys = async () => (keys ??= await derivePasswordKeys("four unrelated words", SALT));

/** Applies a change to a list of wrappers, as the service does. */
function apply(wrappers, { put, remove }) {
  const next = wrappers.filter((wrapper) => !remove.includes(wrapper.wrapperId) && !put.some((entry) => entry.wrapperId === wrapper.wrapperId));
  return [...next, ...put];
}

async function opens(wrapper, kek, vaultKey) {
  try {
    const opened = await unwrapVaultKey(wrapper.wrapped, kek, { ...ids, type: wrapper.type, wrapperId: wrapper.wrapperId, version: wrapper.version });
    return opened.every((value, index) => value === vaultKey[index]);
  } catch (error) {
    if (error.code === "vault_unlock_failed") return false;
    throw error;
  }
}

test("password only -> passkey -> require both -> off: each secret opens exactly what it should", async () => {
  const vaultKey = generateVaultKey();
  const { passwordKey } = await passwordKeys();
  let wrappers = [await makeWrapper({ vaultKey, kek: passwordKey, type: "password", params: passwordParams(password), ...ids })];
  assert.deepEqual(accountWrapperState(wrappers), { passwordOnly: true, passkey: false, requireBoth: false, backupCode: false, credentialIds: [] });

  // Adding a passkey: its wrapper in, the password-only wrapper out (D3).
  const prf = random();
  const credentialId = "cred-1".padEnd(24, "x");
  const added = await addPasskeyChange({ vaultKey, ...ids, wrappers, prfOutput: prf, credentialId, prfSalt: "salt-1" });
  assert.deepEqual(added.remove, [wrappers[0].wrapperId]);
  wrappers = apply(wrappers, added);
  assert.deepEqual(wrappers.map((wrapper) => wrapper.type), ["passkey"]);
  assert.equal(await opens(wrappers[0], await passkeyKek(prf), vaultKey), true, "the passkey alone opens it");
  assert.equal(await opens(wrappers[0], passwordKey, vaultKey), false, "the password alone no longer does");
  assert.deepEqual(wrappers[0].params, { credentialId, prfSalt: "salt-1" });

  // Require password and passkey: the combined wrapper replaces it.
  const prf2 = random();
  const strict = await requireBothChange({ on: true, vaultKey, ...ids, wrappers, prfOutput: prf2, credentialId, prfSalt: "salt-2", passwordKey, password });
  wrappers = apply(wrappers, strict);
  assert.deepEqual(wrappers.map((wrapper) => wrapper.type), ["password-passkey"]);
  const both = wrappers[0];
  assert.equal(await opens(both, await combinedKek(prf2, passwordKey), vaultKey), true, "password and passkey together open it");
  assert.equal(await opens(both, await passkeyKek(prf2), vaultKey), false, "the passkey alone doesn't");
  assert.equal(await opens(both, passwordKey, vaultKey), false, "the password alone doesn't");
  assert.equal(await opens(both, await combinedKek(random(), passwordKey), vaultKey), false, "another passkey with the password doesn't");
  assert.deepEqual(Object.keys(both.params).sort(), ["credentialId", "iterations", "kdf", "prfSalt", "salt"]);
  await assert.rejects(requireBothChange({ on: true, vaultKey, ...ids, wrappers, prfOutput: prf2, credentialId }), /password/);

  // Off again: a passkey-alone wrapper replaces the combined one.
  const prf3 = random();
  const relaxed = await requireBothChange({ on: false, vaultKey, ...ids, wrappers, prfOutput: prf3, credentialId, prfSalt: "salt-3" });
  wrappers = apply(wrappers, relaxed);
  assert.deepEqual(wrappers.map((wrapper) => wrapper.type), ["passkey"]);
  assert.equal(await opens(wrappers[0], await passkeyKek(prf3), vaultKey), true);
});

test("adding a passkey while both are required joins it that way, and needs the password", async () => {
  const vaultKey = generateVaultKey();
  const { passwordKey } = await passwordKeys();
  const prf = random();
  let wrappers = [await makeWrapper({ vaultKey, kek: await combinedKek(prf, passwordKey), type: "password-passkey",
    params: { ...passwordParams(password), credentialId: "one".padEnd(24, "x"), prfSalt: "s" }, ...ids })];
  await assert.rejects(addPasskeyChange({ vaultKey, ...ids, wrappers, prfOutput: random(), credentialId: "two".padEnd(24, "x"), prfSalt: "t" }), /password/);
  const second = random();
  const change = await addPasskeyChange({ vaultKey, ...ids, wrappers, prfOutput: second, credentialId: "two".padEnd(24, "x"), prfSalt: "t", passwordKey, password });
  assert.deepEqual(change.remove, []);
  wrappers = apply(wrappers, change);
  assert.deepEqual(wrappers.map((wrapper) => wrapper.type), ["password-passkey", "password-passkey"]);
  assert.equal(await opens(wrappers[1], await combinedKek(second, passwordKey), vaultKey), true);
  assert.equal(await opens(wrappers[1], await passkeyKek(second), vaultKey), false);
});

test("a password change re-wraps the password wrappers in place, and the combined one with its passkey", async () => {
  const vaultKey = generateVaultKey();
  const { passwordKey } = await passwordKeys();
  const nextSalt = new Uint8Array(16).fill(8);
  const next = await derivePasswordKeys("five other unrelated words", nextSalt);
  const nextPassword = { salt: nextSalt, iterations: 600_000 };
  // Password only.
  const only = [await makeWrapper({ vaultKey, kek: passwordKey, type: "password", params: passwordParams(password), ...ids })];
  const change = await passwordChangeWrappers({ vaultKey, ...ids, wrappers: only, passwordKey: next.passwordKey, password: nextPassword });
  assert.equal(change.put.length, 1);
  assert.equal(change.put[0].wrapperId, only[0].wrapperId, "same wrapper, next version");
  assert.equal(change.put[0].version, 2);
  assert.deepEqual(change.put[0].params, passwordParams(nextPassword));
  assert.equal(await opens(change.put[0], next.passwordKey, vaultKey), true, "the new password opens it");
  assert.equal(await opens(change.put[0], passwordKey, vaultKey), false, "the old one doesn't");
  // Require both: re-wrapped with the passkey that was used; without it, removed.
  const prf = random();
  const credentialId = "cred".padEnd(24, "x");
  const combined = [await makeWrapper({ vaultKey, kek: await combinedKek(prf, passwordKey), type: "password-passkey",
    params: { ...passwordParams(password), credentialId, prfSalt: "p" }, ...ids })];
  const withPasskey = await passwordChangeWrappers({ vaultKey, ...ids, wrappers: combined, passwordKey: next.passwordKey, password: nextPassword, prf: { credentialId, prfOutput: prf } });
  assert.equal(withPasskey.put[0].version, 2);
  assert.equal(withPasskey.put[0].params.prfSalt, "p", "the passkey's PRF input stays");
  assert.equal(await opens(withPasskey.put[0], await combinedKek(prf, next.passwordKey), vaultKey), true);
  assert.equal(await opens(withPasskey.put[0], await combinedKek(prf, passwordKey), vaultKey), false);
  const without = await passwordChangeWrappers({ vaultKey, ...ids, wrappers: combined, passwordKey: next.passwordKey, password: nextPassword });
  assert.deepEqual(without, { put: [], remove: [combined[0].wrapperId] }, "after a backup code, the combined wrapper goes");
  // A passkey-alone wrapper doesn't depend on the password.
  const passkeyOnly = [await makeWrapper({ vaultKey, kek: await passkeyKek(prf), type: "passkey", params: { credentialId, prfSalt: "p" }, ...ids })];
  assert.deepEqual(await passwordChangeWrappers({ vaultKey, ...ids, wrappers: passkeyOnly, passwordKey: next.passwordKey, password: nextPassword }), { put: [], remove: [] });
});

test("a new backup code replaces the old one, and only the new code opens the vault", async () => {
  const vaultKey = generateVaultKey();
  const first = await generateBackupCode();
  let wrappers = apply([], await backupCodeChange({ vaultKey, ...ids, wrappers: [], codeBytes: first.bytes }));
  assert.equal(wrappers.length, 1);
  assert.equal(wrappers[0].type, "backup-code");
  assert.match(wrappers[0].params.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await opens(wrappers[0], await backupCodeKek(first.bytes), vaultKey), true);
  const second = await generateBackupCode();
  const change = await backupCodeChange({ vaultKey, ...ids, wrappers, codeBytes: second.bytes });
  assert.deepEqual(change.remove, [wrappers[0].wrapperId]);
  wrappers = apply(wrappers, change);
  assert.equal(wrappers.length, 1);
  assert.equal(await opens(wrappers[0], await backupCodeKek(second.bytes), vaultKey), true);
  assert.equal(await opens(wrappers[0], await backupCodeKek(first.bytes), vaultKey), false, "the old code stops working");
  // The request body carries base64url keys.
  const body = wrapperChangeBody(change);
  assert.match(body.put[0].wrapped, /^[A-Za-z0-9_-]+$/);
});

test("removing a passkey (#592 follow-up): its wrappers go; the last one brings the password back", async () => {
  const vaultKey = generateVaultKey();
  const { passwordKey } = await passwordKeys();
  const [a, b] = [random(), random()];
  const passkeyA = await makeWrapper({ vaultKey, kek: await passkeyKek(a), ...ids, type: "passkey", params: { credentialId: "cred-a", prfSalt: "salt-a" } });
  const passkeyB = await makeWrapper({ vaultKey, kek: await passkeyKek(b), ...ids, type: "passkey", params: { credentialId: "cred-b", prfSalt: "salt-b" } });
  const code = await makeWrapper({ vaultKey, kek: random(), ...ids, type: "backup-code", params: { verifier: "v" } });
  // Another passkey remains: only this one's wrapper goes, no password wrapper.
  const one = await removePasskeyChange({ vaultKey, ...ids, wrappers: [passkeyA, passkeyB, code], credentialId: "cred-a" });
  assert.deepEqual(one, { put: [], remove: [passkeyA.wrapperId] });
  // The last passkey: the password opens the vault again (never only the code).
  const last = await removePasskeyChange({ vaultKey, ...ids, wrappers: [passkeyB, code], credentialId: "cred-b", passwordKey, password });
  assert.deepEqual(last.remove, [passkeyB.wrapperId]);
  assert.equal(last.put[0].type, "password");
  assert.equal(await opens(last.put[0], passwordKey, vaultKey), true);
  const after = apply([passkeyB, code], last);
  assert.deepEqual(accountWrapperState(after), { ...accountWrapperState(after), passwordOnly: true, passkey: false, backupCode: true });
  await assert.rejects(removePasskeyChange({ vaultKey, ...ids, wrappers: [passkeyB], credentialId: "cred-b" }), /Enter your password/);
  // A combined wrapper of that passkey goes too.
  const both = await makeWrapper({ vaultKey, kek: await combinedKek(a, passwordKey), ...ids, type: "password-passkey",
    params: { ...passwordParams(password), credentialId: "cred-a", prfSalt: "salt-a" } });
  const combined = await removePasskeyChange({ vaultKey, ...ids, wrappers: [both], credentialId: "cred-a", passwordKey, password });
  assert.deepEqual(combined.remove, [both.wrapperId]);
  assert.equal(combined.put[0].type, "password");
});
