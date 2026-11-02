// Changing how a member's account vault opens (ADR 0018 D3/D4, #561/#572):
// the vault-wrapper transitions, as `{ put, remove }` changes the service
// applies in one step (POST /api/account/vault/wrappers) and checks against
// its wrapper-set rules (server/account-vault-service.mjs). Nothing here
// talks to the network; the security panel and the sign-in screens call
// these with VK and the secrets the person just gave, and zero those.
//
//   password only             [password]                        (sign-up; D3)
//   + passkey                 [passkey]                         password-only removed
//   require password+passkey  [password-passkey]                passkey-alone replaced
//   require ... off           [passkey]                         combined replaced
//   + backup code             [... , backup-code]               one per member; a new one replaces it
//   password changed          password / password-passkey re-wrapped (version + 1)
//
// Wrapper IDs are new for a new wrapper and kept (version + 1) for a
// re-wrap of the same one. Each passkey wrapper gets its own random PRF salt.
import {
  backupCodeAuthKey,
  backupCodeKek,
  backupCodeVerifier,
  combinedKek,
  newWrapperId,
  passkeyKek,
  wrapVaultKey,
} from "./account-vault.js";
import { toBase64Url } from "./local-vault.js";

export const PASSKEY_TYPES = Object.freeze(["passkey", "password-passkey"]);

/** A new random PRF salt for a passkey wrapper (32 bytes, base64url). */
export function newPrfSalt() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A password wrapper's public parameters. */
export function passwordParams({ salt, iterations }) {
  return { kdf: "pbkdf2-sha256", iterations, salt: typeof salt === "string" ? salt : toBase64Url(salt) };
}

/**
 * What a member's wrappers say about their account, from the service's
 * summary or a download (`[{ wrapperId, type, version, params }]`):
 * `{ passwordOnly, passkey, requireBoth, backupCode, credentialIds }`.
 */
export function accountWrapperState(wrappers = []) {
  const types = new Set(wrappers.map((wrapper) => wrapper.type));
  return {
    passwordOnly: types.has("password") && !types.has("passkey") && !types.has("password-passkey"),
    passkey: types.has("passkey") || types.has("password-passkey"),
    requireBoth: types.has("password-passkey"),
    backupCode: types.has("backup-code"),
    credentialIds: [...new Set(wrappers.filter((wrapper) => PASSKEY_TYPES.includes(wrapper.type)).map((wrapper) => wrapper.params?.credentialId))],
  };
}

/** One wrapper of VK under `kek`: `{ wrapperId, type, version, params, wrapped }`. */
export async function makeWrapper({ vaultKey, kek, type, params, householdId, memberId, wrapperId = newWrapperId(), version = 1 }) {
  const wrapped = await wrapVaultKey(vaultKey, kek, { householdId, memberId, type, wrapperId, version });
  return { wrapperId, type, version, params, wrapped };
}

async function passkeyWrapper({ vaultKey, householdId, memberId, prfOutput, credentialId, prfSalt, passwordKey = null, password = null, wrapperId, version }) {
  const both = Boolean(passwordKey);
  const kek = both ? await combinedKek(prfOutput, passwordKey) : await passkeyKek(prfOutput);
  try {
    return await makeWrapper({ vaultKey, kek, householdId, memberId, wrapperId, version,
      type: both ? "password-passkey" : "passkey",
      params: both ? { ...passwordParams(password), credentialId, prfSalt } : { credentialId, prfSalt } });
  } finally {
    kek.fill(0);
  }
}

/**
 * Adding a passkey (#561): a passkey wrapper for it, and every password-only
 * wrapper removed (D3: from now on a copy of the service's database holds
 * nothing a password guess opens). When the member already requires
 * password and passkey, the new passkey joins that way instead, so it needs
 * `passwordKey` and `password` (`{ salt, iterations }`).
 * `prfOutput` is this passkey's PRF output for `prfSalt`.
 */
export async function addPasskeyChange({ vaultKey, householdId, memberId, wrappers, prfOutput, credentialId, prfSalt, passwordKey = null, password = null }) {
  const requireBoth = accountWrapperState(wrappers).requireBoth;
  if (requireBoth && !passwordKey) throw new Error("Your account asks for your password and your passkey. Enter your password to add this passkey.");
  const put = [await passkeyWrapper({ vaultKey, householdId, memberId, prfOutput, credentialId, prfSalt,
    passwordKey: requireBoth ? passwordKey : null, password })];
  // A passkey that already had a wrapper gets the new one in its place.
  const remove = wrappers.filter((wrapper) => wrapper.type === "password" ||
    (PASSKEY_TYPES.includes(wrapper.type) && wrapper.params?.credentialId === credentialId)).map((wrapper) => wrapper.wrapperId);
  return { put, remove };
}

/**
 * "Require password and passkey" (#561/#562). On: the passkey-alone
 * wrappers are replaced by one combined wrapper for the passkey just used
 * (KEK from its PRF output and passwordKey), so neither secret alone opens
 * the vault. Off: the combined wrappers are replaced by a passkey-alone
 * wrapper for that passkey. Wrappers of other passkeys are removed either
 * way (opening them needs their own PRF output); the member adds those
 * passkeys again.
 */
export async function requireBothChange({ on, vaultKey, householdId, memberId, wrappers, prfOutput, credentialId, prfSalt = newPrfSalt(), passwordKey = null, password = null }) {
  if (on && !passwordKey) throw new Error("Enter your password to require it with your passkey.");
  const put = [await passkeyWrapper({ vaultKey, householdId, memberId, prfOutput, credentialId, prfSalt,
    passwordKey: on ? passwordKey : null, password })];
  const remove = wrappers.filter((wrapper) => PASSKEY_TYPES.includes(wrapper.type)).map((wrapper) => wrapper.wrapperId);
  return { put, remove };
}

/**
 * A new password (#560): every wrapper that depends on the password is
 * re-wrapped under the new one, keeping its ID (version + 1). A
 * password-passkey wrapper needs its passkey's PRF output too: `prf` is
 * `{ credentialId, prfOutput }` for the passkey just used, and combined
 * wrappers of other passkeys (or all of them, without `prf`, as after a
 * backup-code sign-in) are removed: the member turns "require password and
 * passkey" on again from a device with that passkey.
 */
export async function passwordChangeWrappers({ vaultKey, householdId, memberId, wrappers, passwordKey, password, prf = null }) {
  const put = [];
  const remove = [];
  for (const wrapper of wrappers) {
    const version = wrapper.version + 1;
    if (wrapper.type === "password") {
      put.push(await makeWrapper({ vaultKey, kek: passwordKey, householdId, memberId, type: "password", wrapperId: wrapper.wrapperId, version, params: passwordParams(password) }));
    } else if (wrapper.type === "password-passkey") {
      if (prf && wrapper.params?.credentialId === prf.credentialId)
        put.push(await passkeyWrapper({ vaultKey, householdId, memberId, prfOutput: prf.prfOutput, credentialId: prf.credentialId,
          prfSalt: wrapper.params.prfSalt, passwordKey, password, wrapperId: wrapper.wrapperId, version }));
      else remove.push(wrapper.wrapperId);
    }
  }
  return { put, remove };
}

/**
 * A new backup code (#572): its wrapper, with the service's check value
 * for a backup-code sign-in, replacing any earlier code's wrapper, so the
 * old code stops opening the vault (and signing in) in the same step.
 */
export async function backupCodeChange({ vaultKey, householdId, memberId, wrappers, codeBytes }) {
  const kek = await backupCodeKek(codeBytes);
  const authKey = await backupCodeAuthKey(codeBytes);
  try {
    const put = [await makeWrapper({ vaultKey, kek, householdId, memberId, type: "backup-code", params: { verifier: await backupCodeVerifier(authKey) } })];
    const remove = wrappers.filter((wrapper) => wrapper.type === "backup-code").map((wrapper) => wrapper.wrapperId);
    return { put, remove };
  } finally {
    kek.fill(0);
    authKey.fill(0);
  }
}

/**
 * Removing one passkey (#592 follow-up): every wrapper it opens goes. When
 * that leaves no wrapper a password or a passkey opens (it was the last
 * passkey), a password wrapper comes back, so the account is in the
 * password-only stage again (D3) rather than left with its backup code
 * alone; that needs `passwordKey` and `password` (`{ salt, iterations }`).
 */
export async function removePasskeyChange({ vaultKey, householdId, memberId, wrappers, credentialId, passwordKey = null, password = null }) {
  const remove = wrappers.filter((wrapper) => PASSKEY_TYPES.includes(wrapper.type) && wrapper.params?.credentialId === credentialId)
    .map((wrapper) => wrapper.wrapperId);
  const left = wrappers.filter((wrapper) => !remove.includes(wrapper.wrapperId));
  const put = [];
  if (!left.some((wrapper) => wrapper.type === "password" || PASSKEY_TYPES.includes(wrapper.type))) {
    if (!passwordKey || !password) throw new Error("Enter your password: it opens your account again once this passkey is gone.");
    put.push(await makeWrapper({ vaultKey, kek: passwordKey, householdId, memberId, type: "password", params: passwordParams(password) }));
  }
  return { put, remove };
}

/** A change's request body: the wrapped bytes as base64url. */
export function wrapperChangeBody({ put = [], remove = [] }) {
  return { put: put.map((wrapper) => ({ ...wrapper, wrapped: toBase64Url(wrapper.wrapped) })), remove: [...remove] };
}
