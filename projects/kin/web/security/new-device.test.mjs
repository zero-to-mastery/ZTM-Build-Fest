// Signing in on a new device (#568): which vault wrapper a sign-in opens,
// the key for each, opening the vault, and the device choice's rules.
import assert from "node:assert/strict";
import test from "node:test";
import { combinedKek, generateVaultKey, passkeyKek, sealVault, wrapVaultKey } from "./account-vault.js";
import {
  deviceChoiceProblem,
  openSignInVault,
  passkeyRequestOptions,
  selectVaultWrapper,
  signInKek,
  vaultHouseholdEpochs,
} from "./new-device.js";

const HOUSEHOLD = "a".repeat(32);
const MEMBER = "b".repeat(32);
const PASSWORD_KEY = new Uint8Array(32).fill(1);
const PRF = new Uint8Array(32).fill(2);
const CREDENTIAL = "c".repeat(43);

async function download() {
  const vaultKey = generateVaultKey();
  const ciphertext = await sealVault(vaultKey, { epochs: [{ family: "household", epoch: 1, key: new Uint8Array(32).fill(5) },
    { family: "chat", epoch: 1, key: new Uint8Array(32).fill(6) }] }, { householdId: HOUSEHOLD, memberId: MEMBER, version: 3 });
  const wrap = async (type, wrapperId, kek, params = {}) => ({ wrapperId, type, version: 1, params,
    wrapped: await wrapVaultKey(vaultKey, kek, { householdId: HOUSEHOLD, memberId: MEMBER, type, wrapperId, version: 1 }) });
  return {
    vaultKey,
    vault: { version: 3, ciphertext },
    wrappers: [
      await wrap("password", "1".repeat(32), PASSWORD_KEY),
      await wrap("passkey", "2".repeat(32), await passkeyKek(PRF), { credentialId: CREDENTIAL, prfSalt: "s" }),
      await wrap("password-passkey", "3".repeat(32), await combinedKek(PRF, PASSWORD_KEY), { credentialId: CREDENTIAL, prfSalt: "s" }),
      await wrap("passkey", "4".repeat(32), await passkeyKek(new Uint8Array(32).fill(9)), { credentialId: "d".repeat(43), prfSalt: "s" }),
    ],
  };
}

test("each sign-in method selects its own wrapper, a passkey's by its credential", async () => {
  const { wrappers } = await download();
  assert.equal(selectVaultWrapper(wrappers, { method: "password" }).wrapperId, "1".repeat(32));
  assert.equal(selectVaultWrapper(wrappers, { method: "passkey", credentialId: CREDENTIAL }).wrapperId, "2".repeat(32));
  assert.equal(selectVaultWrapper(wrappers, { method: "passkey", credentialId: "d".repeat(43) }).wrapperId, "4".repeat(32));
  assert.equal(selectVaultWrapper(wrappers, { method: "password-passkey", credentialId: CREDENTIAL }).wrapperId, "3".repeat(32));
  assert.equal(selectVaultWrapper(wrappers, { method: "passkey", credentialId: "e".repeat(43) }), null);
  assert.equal(selectVaultWrapper(wrappers, { method: "backup-code" }), null, "not a sign-in method here");
  assert.equal(selectVaultWrapper([wrappers[0]], { method: "passkey", credentialId: CREDENTIAL }), null);
});

test("the key for each wrapper: the password key, HKDF of the PRF output, or both", async () => {
  const { wrappers } = await download();
  assert.deepEqual([...await signInKek(wrappers[0], { passwordKey: PASSWORD_KEY })], [...PASSWORD_KEY]);
  assert.deepEqual([...await signInKek(wrappers[1], { prfOutput: PRF })], [...await passkeyKek(PRF)]);
  assert.deepEqual([...await signInKek(wrappers[2], { prfOutput: PRF, passwordKey: PASSWORD_KEY })], [...await combinedKek(PRF, PASSWORD_KEY)]);
  await assert.rejects(signInKek(wrappers[0], {}), (error) => error.code === "password_rejected");
  await assert.rejects(signInKek(wrappers[2], { prfOutput: PRF }), "require-both needs the password too");
});

test("the vault opens with each method and not with the wrong secret", async () => {
  const fixture = await download();
  const context = { download: fixture, householdId: HOUSEHOLD, memberId: MEMBER };
  for (const [method, secrets] of [["password", { passwordKey: PASSWORD_KEY }], ["passkey", { prfOutput: PRF, credentialId: CREDENTIAL }],
    ["password-passkey", { prfOutput: PRF, passwordKey: PASSWORD_KEY, credentialId: CREDENTIAL }]]) {
    const opened = await openSignInVault({ ...context, method, ...secrets });
    assert.deepEqual([...opened.vaultKey], [...fixture.vaultKey], method);
    assert.deepEqual(vaultHouseholdEpochs(opened.contents), [1], "household epochs only");
  }
  await assert.rejects(openSignInVault({ ...context, method: "password", passwordKey: new Uint8Array(32).fill(3) }),
    (error) => error.code === "vault_unlock_failed");
  await assert.rejects(openSignInVault({ ...context, method: "password-passkey", credentialId: CREDENTIAL, prfOutput: PRF, passwordKey: new Uint8Array(32).fill(3) }),
    (error) => error.code === "vault_unlock_failed", "both secrets are needed");
  await assert.rejects(openSignInVault({ ...context, memberId: "f".repeat(32), method: "password", passwordKey: PASSWORD_KEY }),
    (error) => error.code === "vault_unlock_failed", "a vault is bound to its member");
});

test("the device choice: a new device needs room; a replacement frees its own place", () => {
  const view = { devices: [{ deviceId: "1".repeat(32), label: "Phone" }], deviceLimit: { maximum: 16, active: 15 } };
  assert.equal(deviceChoiceProblem(view), null);
  assert.equal(deviceChoiceProblem(view, "1".repeat(32)), null);
  assert.match(deviceChoiceProblem(view, "9".repeat(32)), /Choose one of your devices/);
  const full = { ...view, deviceLimit: { maximum: 16, active: 16 } };
  assert.match(deviceChoiceProblem(full), /Choose a device this one replaces/);
  assert.equal(deviceChoiceProblem(full, "1".repeat(32)), null);
});

test("the passkey request asks for user verification and each passkey's PRF input", () => {
  const options = passkeyRequestOptions({ publicKey: { challenge: "AAAA", allowCredentials: [{ id: "AQID" }] }, prfSalts: { AQID: "BAUG" } });
  assert.equal(options.userVerification, "required");
  assert.deepEqual([...options.allowCredentials[0].id], [1, 2, 3]);
  assert.deepEqual([...options.extensions.prf.evalByCredential.AQID.first], [4, 5, 6]);
});
