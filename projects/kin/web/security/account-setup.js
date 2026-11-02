// Signing up and unlocking with a password (ADR 0018, #558): the steps
// between a typed password and the keys Kin keeps, with no UI and no
// storage of their own. The first-run screens, the lock screen and the
// household panel call these.
//
//   password --PBKDF2 (600,000) + HKDF--> authKey      sent to the service
//                                     \-> passwordKey  never sent
//   passwordKey --HKDF "kin/local-password/v1"--> this device's local root wrapper
//   passwordKey ---------------------------------> the account vault's password wrapper
//
// The local wrapper's KEK is derived from passwordKey under its own purpose,
// so the two wrappers never share a key. Callers zero every byte array they
// get back once used.
import {
  derivePasswordKeys,
  generateCertificationKey,
  generateVaultKey,
  newPasswordSalt,
  newWrapperId,
  PASSWORD_ITERATIONS,
  sealVault,
  wipeVaultContents,
  wrapVaultKey,
} from "./account-vault.js";
import { normalizeUsername, passwordProblem, usernameProblem } from "./account-credentials.js";
import { fromBase64Url, localPasswordKek, toBase64Url, VaultError } from "./local-vault.js";

/**
 * Everything a new password account needs, from the typed username and
 * password: `{ username, salt, iterations, authKey, passwordKey, localKek }`.
 * Refuses (VaultError, code "password_rejected") a username or password
 * below the floor, with the plain words to show.
 */
export async function prepareSignUp({ username, password }) {
  const name = normalizeUsername(username);
  const problem = name ? passwordProblem(password, { username: name }) : usernameProblem(username);
  if (problem) throw new VaultError(problem, "password_rejected");
  const salt = newPasswordSalt();
  const { authKey, passwordKey } = await derivePasswordKeys(password, salt);
  const localKek = await localPasswordKek(passwordKey);
  return { username: name, salt, iterations: PASSWORD_ITERATIONS, authKey, passwordKey, localKek };
}

/** The sign-up fields the service reads (server/pairing-service/passwords.mjs). */
export function signUpBody({ username, salt, iterations, authKey }) {
  return { username, salt: toBase64Url(salt), iterations, authKey: toBase64Url(authKey) };
}

/** Zeroes a prepared sign-up's secrets. */
export function wipeSignUp(prepared) {
  for (const key of ["authKey", "passwordKey", "localKek"]) prepared?.[key]?.fill?.(0);
}

/** The manifest's password wrapper, or null (households set up with a
 * backup key have none). */
export function passwordWrapper(manifest) {
  return (manifest?.wrappers ?? []).find((wrapper) => wrapper?.type === "password") ?? null;
}

/**
 * Derives, from a typed password and this device's password wrapper, the
 * local KEK that unlocks it and the authKey that signs in (one PBKDF2 run
 * gives both, offline). `{ localKek, authKey, passwordKey }`.
 */
export async function passwordUnlockKeys(wrapper, password) {
  if (!wrapper) throw new VaultError("This device doesn't unlock with a password.", "wrapper_unavailable");
  if (typeof password !== "string" || !password) throw new VaultError("Enter your password.", "password_rejected");
  const { authKey, passwordKey } = await derivePasswordKeys(password, fromBase64Url(wrapper.salt), { iterations: wrapper.iterations });
  return { localKek: await localPasswordKek(passwordKey), authKey, passwordKey };
}

/**
 * The account's current password parameters (`{ salt, iterations }`) from
 * the service, for `username`, or null when it can't be asked (offline, a
 * limit, an error). Used at unlock to notice a password changed on another
 * device (#560 follow-up). An unknown username gets made-up parameters from
 * the service; they differ from the wrapper's too, and the new password then
 * simply fails to sign in.
 */
export async function currentPasswordParameters(username, { fetchImpl = (...args) => globalThis.fetch(...args), signal } = {}) {
  if (!username || globalThis.navigator?.onLine === false) return null;
  try {
    const response = await fetchImpl("/api/account/sign-in/parameters", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal, body: JSON.stringify({ username }),
    });
    if (!response.ok) return null;
    const value = await response.json();
    return typeof value?.salt === "string" && Number.isSafeInteger(value.iterations) ? { salt: value.salt, iterations: value.iterations } : null;
  } catch {
    return null;
  }
}

/** Whether `parameters` (the service's) are not this device's password
 * wrapper's: the password was changed on another device. */
export function passwordChangedElsewhere(wrapper, parameters) {
  return Boolean(wrapper && parameters && (parameters.salt !== wrapper.salt || parameters.iterations !== wrapper.iterations));
}

/**
 * The keys of a password typed under the service's current `parameters`:
 * `{ localKek, authKey, passwordKey, salt, iterations }`; the caller zeroes
 * the byte arrays.
 */
export async function keysUnder(parameters, password) {
  if (typeof password !== "string" || !password) throw new VaultError("Enter your password.", "password_rejected");
  const { authKey, passwordKey } = await derivePasswordKeys(password, fromBase64Url(parameters.salt), { iterations: parameters.iterations });
  return { localKek: await localPasswordKek(passwordKey), authKey, passwordKey, salt: parameters.salt, iterations: parameters.iterations };
}

/** authKey for a fresh confirmation, from the parameters the service sent
 * (`{ salt, iterations }`). Returns base64url; nothing else is kept. */
export async function confirmationAuthKey(password, { salt, iterations }) {
  const { authKey, passwordKey } = await derivePasswordKeys(password, fromBase64Url(salt), { iterations });
  passwordKey.fill(0);
  try { return toBase64Url(authKey); } finally { authKey.fill(0); }
}

/**
 * Creates the member's account vault on their first device (ADR 0018
 * section 1): a new vault key VK, the household and chat epoch keys this
 * device holds, and a new certification key (kept in the vault for the
 * new-device story, #568), sealed as version 1 with one password wrapper,
 * then uploaded compare-and-set from version 0. `api` is account-vault-sync
 * vaultApi(). Returns VK for the device to keep; the caller zeroes its copy.
 */
export async function createAccountVault({ api, householdId, memberId, passwordKey, salt, iterations = PASSWORD_ITERATIONS, epochs = [] }) {
  const vaultKey = generateVaultKey();
  const certification = await generateCertificationKey();
  const contents = { epochs, certificationKey: certification.pkcs8 };
  try {
    const ciphertext = await sealVault(vaultKey, contents, { householdId, memberId, version: 1 });
    const wrapperId = newWrapperId();
    const wrapped = await wrapVaultKey(vaultKey, passwordKey, { householdId, memberId, type: "password", wrapperId, version: 1 });
    await api.upload({ expectedVersion: 0, ciphertext, wrappers: [{
      wrapperId, type: "password", version: 1,
      params: { kdf: "pbkdf2-sha256", iterations, salt: toBase64Url(salt) },
      wrapped,
    }] });
    return vaultKey;
  } catch (error) {
    vaultKey.fill(0);
    throw error;
  } finally {
    wipeVaultContents(contents);
  }
}
