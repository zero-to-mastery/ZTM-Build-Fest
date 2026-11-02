// A signed-in member's account security, step by step (ADR 0018,
// #560-#562, #571-#573): adding a passkey, "require password and passkey",
// changing the password and making a backup code. No DOM: the security
// panel (components/security/account.js) calls these with what the person
// typed, this device's vault key VK and its unlocked local vault, and saves
// the local manifest each returns.
//
// Every change asks for the current password, which the service checks
// fresh (`currentAuthKey`), and goes to the service as one request, so the
// account never sits between two states: the passkey wrapper replaces the
// password-only one in the same transaction, a new password and its
// re-wrapped wrappers land together, and a new backup code replaces the old.
import { derivePasswordKeys, newPasswordSalt, PASSWORD_ITERATIONS } from "./account-vault.js";
import {
  accountWrapperState,
  addPasskeyChange,
  backupCodeChange,
  newPrfSalt,
  passwordChangeWrappers,
  removePasskeyChange,
  requireBothChange,
  wrapperChangeBody,
} from "./account-wrappers.js";
import { assertPasskeyPrf, PRF_UNAVAILABLE_MESSAGE, registerAccountPasskey } from "./account-passkey.js";
import { passwordProblem } from "./account-credentials.js";
import { fromBase64Url, localPasswordKek, toBase64Url, VaultError } from "./local-vault.js";
import { signInRequest } from "./new-device.js";

/** The signed-in member's account (GET /api/account/security). */
export function accountSecurity({ request = signInRequest } = {}) {
  return request("/api/account/security", {}, { method: "GET" });
}

/** What the settings and Today show, from accountSecurity(): */
export function accountState(security) {
  const wrappers = security?.vault?.wrappers ?? [];
  const state = accountWrapperState(wrappers);
  const backup = wrappers.find((wrapper) => wrapper.type === "backup-code") ?? null;
  return {
    ...state,
    // An account this device can change: the member has a password and a
    // vault, and (when the panel said so) this device keeps the vault key.
    // A device set up the old way, of a member who moved to an account on
    // another device, isn't one until it finishes the move (#575).
    account: Boolean(security?.password && security?.vault) && security?.deviceHoldsVaultKey !== false,
    passkeys: security?.passkeys ?? [],
    // A passkey registered but not (or no longer) opening the vault: after
    // a passkey without PRF, or a backup-code sign-in that dropped the
    // combined wrapper (#572).
    passkeyNeedsSetup: (security?.passkeys?.length ?? 0) > 0 && !state.passkey,
    backupCodeMadeAt: backup?.updatedAt ?? null,
    memberSince: security?.memberSince ?? null,
  };
}

/** The current password's keys, from the service's parameters: `{ authKey,
 * passwordKey, salt, iterations }` (bytes; the caller zeroes them). */
export async function currentPasswordKeys(password, security) {
  const parameters = security?.passwordParameters;
  if (!parameters) throw new VaultError("This account doesn't sign in with a password.", "password_rejected");
  if (typeof password !== "string" || !password) throw new VaultError("Enter your password.", "password_rejected");
  const salt = fromBase64Url(parameters.salt);
  const { authKey, passwordKey } = await derivePasswordKeys(password, salt, { iterations: parameters.iterations });
  return { authKey, passwordKey, salt, iterations: parameters.iterations };
}

function wipe(...values) {
  for (const value of values) value?.fill?.(0);
}

function context(identity) {
  return { householdId: identity.householdId, memberId: identity.memberId };
}

/**
 * Adds a passkey (#561): registers it (after the password), takes its PRF
 * outputs, swaps the vault's password-only wrapper for its passkey wrapper
 * in one request, and adds a passkey unlock to this device's local vault.
 * Resolves to `{ credentialId, manifest }`: the local manifest to save, or
 * null when the passkey gave no local PRF output.
 */
export async function addAccountPasskey({ password, security, identity, vaultKey, localVault, request = signInRequest, credentials, signal }) {
  const keys = await currentPasswordKeys(password, security);
  const salts = { first: newPrfSalt(), second: newPrfSalt() };
  let outputs = null;
  try {
    const currentAuthKey = toBase64Url(keys.authKey);
    const registered = await registerAccountPasskey({ currentAuthKey, salts, request, credentials, signal });
    outputs = registered;
    if (!outputs.first || !outputs.second) {
      // Most authenticators evaluate PRF only when signing in: one more touch.
      wipe(outputs.first, outputs.second);
      outputs = await assertPasskeyPrf({ evalByCredential: { [registered.credentialId]: salts }, request, credentials, signal });
    }
    if (outputs.credentialId !== registered.credentialId) throw new VaultError(PRF_UNAVAILABLE_MESSAGE, "unsupported_unlock");
    const change = await addPasskeyChange({ vaultKey, ...context(identity), wrappers: security.vault.wrappers,
      prfOutput: outputs.first, credentialId: registered.credentialId, prfSalt: salts.first,
      passwordKey: keys.passwordKey, password: { salt: keys.salt, iterations: keys.iterations } });
    await request("/api/account/vault/wrappers", { currentAuthKey, ...wrapperChangeBody(change) });
    let manifest = null;
    if (outputs.second && !localVault.manifest.wrappers.some((wrapper) => wrapper.credentialId === registered.credentialId))
      manifest = await localVault.addCredentialWrapper(outputs.second, { credentialId: registered.credentialId, prfSalt: salts.second });
    return { credentialId: registered.credentialId, manifest };
  } finally {
    wipe(keys.authKey, keys.passwordKey, outputs?.first, outputs?.second);
  }
}

/**
 * A passkey the account knows that doesn't open the vault (yet): asks it
 * for its PRF output and gives it a passkey wrapper, as adding one does,
 * without registering anything new.
 */
export async function finishPasskeySetup({ password, security, identity, vaultKey, request = signInRequest, credentials, signal }) {
  const keys = await currentPasswordKeys(password, security);
  const salt = newPrfSalt();
  let asserted = null;
  try {
    const evalByCredential = Object.fromEntries(security.passkeys.map((id) => [id, { first: salt }]));
    asserted = await assertPasskeyPrf({ evalByCredential, request, credentials, signal });
    const change = await addPasskeyChange({ vaultKey, ...context(identity), wrappers: security.vault.wrappers,
      prfOutput: asserted.first, credentialId: asserted.credentialId, prfSalt: salt,
      passwordKey: keys.passwordKey, password: { salt: keys.salt, iterations: keys.iterations } });
    await request("/api/account/vault/wrappers", { currentAuthKey: toBase64Url(keys.authKey), ...wrapperChangeBody(change) });
  } finally {
    wipe(keys.authKey, keys.passwordKey, asserted?.first);
  }
}

/**
 * "Require password and passkey" on or off (#561/#562): the passkey just
 * used and the password make the combined wrapper (on), or the passkey a
 * passkey-alone wrapper again (off), replacing the other kind in one step.
 */
export async function setRequireBoth({ on, password, security, identity, vaultKey, request = signInRequest, credentials, signal }) {
  const keys = await currentPasswordKeys(password, security);
  const salt = newPrfSalt();
  let asserted = null;
  try {
    const evalByCredential = Object.fromEntries(security.passkeys.map((id) => [id, { first: salt }]));
    asserted = await assertPasskeyPrf({ evalByCredential, request, credentials, signal });
    const change = await requireBothChange({ on, vaultKey, ...context(identity), wrappers: security.vault.wrappers,
      prfOutput: asserted.first, credentialId: asserted.credentialId, prfSalt: salt,
      passwordKey: keys.passwordKey, password: { salt: keys.salt, iterations: keys.iterations } });
    await request("/api/account/vault/wrappers", { currentAuthKey: toBase64Url(keys.authKey), ...wrapperChangeBody(change) });
  } finally {
    wipe(keys.authKey, keys.passwordKey, asserted?.first);
  }
}

/**
 * Changes the password (#560): new keys from a new salt; the vault's
 * password-dependent wrappers re-wrapped (with the passkey's PRF output
 * for a combined wrapper, so that setting asks for the passkey too); the
 * new verifier and those wrappers in one request; then this device's local
 * password wrapper under the new password. Resolves to the local manifest
 * to save, or null when this device doesn't unlock with a password.
 */
export async function changeAccountPassword({ current, next, security, identity, vaultKey, localVault, request = signInRequest, credentials, signal }) {
  const problem = passwordProblem(next, { username: security?.username });
  if (problem) throw new VaultError(problem, "password_rejected");
  const keys = await currentPasswordKeys(current, security);
  const salt = newPasswordSalt();
  const iterations = PASSWORD_ITERATIONS;
  let fresh = null;
  let asserted = null;
  let kek = null;
  try {
    fresh = await derivePasswordKeys(next, salt, { iterations });
    const combined = security.vault.wrappers.filter((wrapper) => wrapper.type === "password-passkey");
    if (combined.length) {
      const evalByCredential = Object.fromEntries(combined.map((wrapper) => [wrapper.params.credentialId, { first: wrapper.params.prfSalt }]));
      asserted = await assertPasskeyPrf({ evalByCredential, request, credentials, signal });
    }
    const change = await passwordChangeWrappers({ vaultKey, ...context(identity), wrappers: security.vault.wrappers,
      passwordKey: fresh.passwordKey, password: { salt, iterations },
      prf: asserted ? { credentialId: asserted.credentialId, prfOutput: asserted.first } : null });
    const body = { currentAuthKey: toBase64Url(keys.authKey), salt: toBase64Url(salt), iterations, authKey: toBase64Url(fresh.authKey) };
    if (change.put.length || change.remove.length) body.vaultChange = wrapperChangeBody(change);
    await request("/api/account/password", body);
    if (!localVault.manifest.wrappers.some((wrapper) => wrapper.type === "password")) return null;
    kek = await localPasswordKek(fresh.passwordKey);
    return await localVault.replacePasswordWrapper(kek, { salt: toBase64Url(salt), iterations, username: security.username ?? undefined });
  } finally {
    wipe(keys.authKey, keys.passwordKey, fresh?.authKey, fresh?.passwordKey, asserted?.first, kek);
  }
}

/**
 * Removes one of the member's passkeys (#592 follow-up), after the
 * password: its vault wrappers go (and, for the last passkey, a password
 * wrapper comes back) with the service's record of it, in one request.
 * This device's own unlock with that passkey goes too; if that was its only
 * way in (a device set up with the passkey alone), the password unlocks it
 * from now on instead. Resolves to the local manifest to save, or null.
 */
export async function removeAccountPasskey({ password, credentialId, security, identity, vaultKey, localVault, request = signInRequest }) {
  if (!(security?.passkeys ?? []).includes(credentialId))
    throw new VaultError("That passkey isn't on your account any more.", "credential_unavailable");
  const keys = await currentPasswordKeys(password, security);
  let kek = null;
  try {
    const change = await removePasskeyChange({ vaultKey, ...context(identity), wrappers: security.vault?.wrappers ?? [], credentialId,
      passwordKey: keys.passwordKey, password: { salt: keys.salt, iterations: keys.iterations } });
    const body = { currentAuthKey: toBase64Url(keys.authKey), credentialId };
    if (change.put.length || change.remove.length) body.vaultChange = wrapperChangeBody(change);
    await request("/api/account/passkeys/remove", body);
    const local = localVault.manifest.wrappers.filter((wrapper) => wrapper.type === "prf" && wrapper.credentialId === credentialId);
    if (!local.length) return null;
    let manifest = null;
    // The passkey was this device's only way in: the password takes over.
    if (!localVault.manifest.wrappers.some((wrapper) => wrapper.type === "recovery" || wrapper.type === "password")) {
      kek = await localPasswordKek(keys.passwordKey);
      manifest = await localVault.addPasswordWrapper(kek, { salt: toBase64Url(keys.salt), iterations: keys.iterations, username: security.username ?? undefined });
    }
    for (const wrapper of local) manifest = localVault.removeWrapper(wrapper.id);
    return manifest;
  } finally {
    wipe(keys.authKey, keys.passwordKey, kek);
  }
}

/**
 * Turns on a new backup code (#572), after the person saved it: its
 * wrapper replaces any earlier code's in one request, so the old code
 * stops working at the same moment. `codeBytes` from generateBackupCode.
 */
export async function saveBackupCode({ password, codeBytes, security, identity, vaultKey, request = signInRequest }) {
  const keys = await currentPasswordKeys(password, security);
  try {
    const change = await backupCodeChange({ vaultKey, ...context(identity), wrappers: security.vault.wrappers, codeBytes });
    await request("/api/account/vault/wrappers", { currentAuthKey: toBase64Url(keys.authKey), ...wrapperChangeBody(change) });
  } finally {
    wipe(keys.authKey, keys.passwordKey);
  }
}
