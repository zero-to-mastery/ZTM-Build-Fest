// Moving a member set up the old way to an account (ADR 0018 "Migration",
// #574/#575): a member whose devices unlock with a passkey and a per-device
// backup key, with no username, password or vault, chooses a username and a
// password, and this device makes their account vault from the keys it
// holds. No DOM: the security panel (components/security/account.js) calls
// this with what the person typed, and saves the local manifest it returns.
//
// The steps, each resumable (a failed or interrupted run is simply run
// again; every step first looks at what is already done):
//
//   1. password   POST /api/account/migrate/options and /finish: a fresh
//                 assertion of the member's passkey, then the username and
//                 the password's authKey (the service keeps only its
//                 Argon2id hash). The same touch asks the passkey for a PRF
//                 output under a new salt, for the vault wrapper.
//                 Already done (the service has a password): the typed
//                 password is checked by signing this device in with it.
//   2. vault key  this device keeps the vault key VK *before* the vault is
//                 uploaded, so a run cut off between the two uploads the
//                 same VK next time.
//   3. vault      no vault yet: the household and chat epoch keys this
//                 device holds and a new certification key, sealed as
//                 version 1, with one wrapper (ADR 0018 D3/D4): the
//                 passkey's, when it gave a PRF output (then no password-only
//                 wrapper ever exists), otherwise the password's.
//                 A vault already there (an earlier run, or another of the
//                 member's devices that moved first): opened with this
//                 device's VK, or else through one of its wrappers (the
//                 password, or the passkey), and that VK kept here.
//   4. endorse    the certification key endorsed by this device (the caller's
//                 `endorse`, household/account.js), so a new device can
//                 certify itself.
//   5. local      a password wrapper of this device's local root beside its
//                 passkey and backup-key wrappers, so the password unlocks
//                 it offline too. The backup key keeps working (#576).
//
// Members who decline keep using Kin exactly as before: nothing here runs
// until they choose to.
import {
  combinedKek,
  derivePasswordKeys,
  generateCertificationKey,
  generateVaultKey,
  openVault,
  passkeyKek,
  sealVault,
  unwrapVaultKey,
  wipeVaultContents,
} from "./account-vault.js";
import { makeWrapper, newPrfSalt, passwordParams } from "./account-wrappers.js";
import { assertPasskeyPrf, PRF_UNAVAILABLE_MESSAGE } from "./account-passkey.js";
import { passwordProblem, usernameProblem, normalizeUsername } from "./account-credentials.js";
import { prepareSignUp, signUpBody, wipeSignUp } from "./account-setup.js";
import { vaultApi } from "./account-vault-sync.js";
import { fromBase64Url, localPasswordKek, toBase64Url, VaultError } from "./local-vault.js";
import { signInRequest } from "./new-device.js";

/**
 * Where a member stands, from their account summary (GET
 * /api/account/security) and whether this device keeps their vault key:
 * - null: nothing to offer (no summary, or a Temporary member);
 * - "invite": set up the old way; invited to choose a username and password;
 * - "finish": the account exists (made here and cut off, or on another of
 *   their devices), but this device doesn't hold its keys yet;
 * - "done".
 */
export function migrationState(security, { holdsVaultKey = false } = {}) {
  if (!security || security.memberKind === "temporary") return null;
  if (!security.password) return (security.passkeys?.length ?? 0) > 0 ? "invite" : null;
  if (!security.vault || !holdsVaultKey) return "finish";
  return "done";
}

/** Plain words for what's wrong with a new username and password, or null. */
export function migrationProblems({ username, password, again }) {
  const problems = {};
  const name = normalizeUsername(username ?? "");
  if (!name) problems.username = usernameProblem(username ?? "");
  const weak = passwordProblem(password ?? "", { username: name });
  if (weak) problems.password = weak;
  else if (again !== undefined && again !== password) problems.again = "The passwords don't match. Type the same password twice.";
  return problems;
}

function wipe(...values) {
  for (const value of values) value?.fill?.(0);
}

function takeResult(value) {
  if (!value || value.byteLength !== 32) return null;
  const view = new Uint8Array(value);
  const copy = view.slice();
  view.fill(0);
  return copy;
}

function credentialJson(credential) {
  return {
    id: credential.id, type: credential.type, response: {
      clientDataJSON: toBase64Url(new Uint8Array(credential.response.clientDataJSON)),
      authenticatorData: toBase64Url(new Uint8Array(credential.response.authenticatorData)),
      signature: toBase64Url(new Uint8Array(credential.response.signature)),
      userHandle: credential.response.userHandle ? toBase64Url(new Uint8Array(credential.response.userHandle)) : null,
    },
  };
}

/**
 * Step 1 for a member without a password: the passkey ceremony and the new
 * username and password, in one request after one touch. Resolves to
 * `{ keys, prf }`: the password's keys (`prepareSignUp`'s, which the caller
 * wipes) and `{ credentialId, prfOutput, prfSalt }` when the passkey gave a
 * PRF output, else null.
 */
export async function setAccountPassword({ username, password, request = signInRequest, credentials = globalThis.navigator?.credentials, signal }) {
  const problems = migrationProblems({ username, password });
  const first = Object.values(problems)[0];
  if (first) throw new VaultError(first, "password_rejected");
  if (!globalThis.PublicKeyCredential || !credentials?.get)
    throw new VaultError("Passkeys aren't available in this browser. Set up your account on the device where your passkey works.", "unsupported_unlock");
  const keys = await prepareSignUp({ username, password });
  let prfOutput = null;
  try {
    const started = await request("/api/account/migrate/options", {});
    const prfSalt = newPrfSalt();
    const credential = await credentials.get({ signal, publicKey: {
      ...started.publicKey,
      challenge: fromBase64Url(started.publicKey.challenge),
      userVerification: "required",
      allowCredentials: (started.publicKey.allowCredentials ?? []).map((entry) => ({ ...entry, type: "public-key", id: fromBase64Url(entry.id) })),
      extensions: { prf: { eval: { first: fromBase64Url(prfSalt) } } },
    } });
    if (!credential) throw new VaultError("Confirming with your passkey was cancelled.", "authentication_failed");
    prfOutput = takeResult(credential.getClientExtensionResults?.()?.prf?.results?.first);
    await request("/api/account/migrate/finish", { flow: started.flow, credential: credentialJson(credential), ...signUpBody(keys) });
    return { keys, prf: prfOutput ? { credentialId: credential.id, prfOutput, prfSalt } : null };
  } catch (error) {
    wipeSignUp(keys);
    wipe(prfOutput);
    throw error;
  }
}

/**
 * Step 1 when the service already has the member's password (an earlier
 * run, or another device): the typed password's keys from the service's
 * parameters, checked by signing this device in with them. Resolves to
 * `{ keys }` like setAccountPassword (no PRF yet).
 */
export async function confirmAccountPassword({ password, security, request = signInRequest }) {
  const parameters = security?.passwordParameters;
  if (!parameters || !security.username) throw new VaultError("This account doesn't sign in with a password.", "password_rejected");
  if (typeof password !== "string" || !password) throw new VaultError("Enter your password.", "password_rejected");
  const salt = fromBase64Url(parameters.salt);
  const { authKey, passwordKey } = await derivePasswordKeys(password, salt, { iterations: parameters.iterations });
  try {
    await request("/api/login/password", { username: security.username, authKey: toBase64Url(authKey) });
  } catch (error) {
    wipe(passwordKey);
    if (error?.code === "sign_in_failed") throw new VaultError("That password didn't match. Check it and try again.", "password_rejected", error);
    throw error;
  } finally {
    wipe(authKey);
  }
  return { keys: { username: security.username, salt, iterations: parameters.iterations, passwordKey, localKek: await localPasswordKek(passwordKey) } };
}

/**
 * Steps 2 and 3: makes sure the member's vault exists and that this device
 * keeps its key. `keys` from step 1; `prf` its passkey output, if any;
 * `passkeys` the member's passkey IDs (used to ask a passkey for its PRF
 * output when step 1 didn't). Resolves to `{ created }`.
 */
export async function ensureAccountVault({ identity, keyStore, keys, prf = null, passkeys = [], request = signInRequest, credentials = globalThis.navigator?.credentials, signal, api = vaultApi((path, options) => request(path, options?.body ? JSON.parse(options.body) : {}, { method: options?.method ?? "POST" })) }) {
  const { householdId, memberId, deviceId } = identity;
  const context = { householdId, memberId };
  let download = await api.download();
  let held = await keyStore.accountVaultKey(householdId);
  try {
    if (!download.vault) {
      // Kept first, so a run cut off after the upload finds the same key.
      if (!held) {
        held = generateVaultKey();
        await keyStore.setAccountVaultKey(deviceId, held);
      }
      // No PRF yet (a resumed run): one touch of the passkey for it, else
      // the password wrapper. A passkey without PRF is no failure here.
      let asked = null;
      if (!prf && passkeys.length) {
        const prfSalt = newPrfSalt();
        try {
          asked = await assertPasskeyPrf({ evalByCredential: Object.fromEntries(passkeys.map((id) => [id, { first: prfSalt }])), request, credentials, signal });
          prf = { credentialId: asked.credentialId, prfOutput: asked.first, prfSalt };
        } catch (error) {
          if (error?.code !== "unsupported_unlock" && error?.message !== PRF_UNAVAILABLE_MESSAGE) throw error;
        }
      }
      const certification = await generateCertificationKey();
      const contents = { epochs: await keyStore.vaultEpochKeys(householdId), certificationKey: certification.pkcs8 };
      let kek = null;
      try {
        const ciphertext = await sealVault(held, contents, { ...context, version: 1 });
        kek = prf ? await passkeyKek(prf.prfOutput) : keys.passwordKey.slice();
        const wrapper = await makeWrapper({ vaultKey: held, kek, ...context,
          type: prf ? "passkey" : "password",
          params: prf ? { credentialId: prf.credentialId, prfSalt: prf.prfSalt } : passwordParams(keys) });
        try {
          await api.upload({ expectedVersion: 0, ciphertext, wrappers: [wrapper] });
          return { created: true, wrapper: wrapper.type };
        } catch (error) {
          // Another of the member's devices made it first: open theirs.
          if (error?.code !== "vault_version_conflict") throw error;
          download = await api.download();
        }
      } finally {
        wipe(kek, asked?.second);
        wipeVaultContents(contents);
      }
    }
    // A vault exists: this device's key opens it, or one of its wrappers does.
    if (held && await opens(held, download.vault, context)) return { created: false };
    const vaultKey = await openThroughWrapper({ download, keys, context, request, credentials, signal, prf });
    try {
      if (!await opens(vaultKey, download.vault, context)) throw new VaultError("Kin couldn't open your account's vault.", "vault_unlock_failed");
      await keyStore.setAccountVaultKey(deviceId, vaultKey);
    } finally {
      wipe(vaultKey);
    }
    return { created: false };
  } finally {
    wipe(held);
  }
}

async function opens(vaultKey, vault, context) {
  try {
    wipeVaultContents(await openVault(vaultKey, vault.ciphertext, { ...context, version: vault.version }));
    return true;
  } catch {
    return false;
  }
}

/** VK through the vault's password wrapper, or through a passkey wrapper of
 * one of the member's passkeys (one touch). */
async function openThroughWrapper({ download, keys, context, request, credentials, signal, prf }) {
  const wrappers = download.wrappers ?? [];
  const unwrap = (wrapper, kek) => unwrapVaultKey(wrapper.wrapped, kek, { ...context, type: wrapper.type, wrapperId: wrapper.wrapperId, version: wrapper.version });
  const password = wrappers.find((wrapper) => wrapper.type === "password");
  if (password) {
    try { return await unwrap(password, keys.passwordKey); } catch { /* try a passkey next */ }
  }
  const passkeyWrappers = wrappers.filter((wrapper) => wrapper.type === "passkey" || wrapper.type === "password-passkey");
  if (!passkeyWrappers.length)
    throw new VaultError("Your account opens only with its backup code right now. Sign in with it on this device, or set up your passkey again from a device that has your account.", "wrapper_unavailable");
  const asked = await assertPasskeyPrf({ evalByCredential: Object.fromEntries(passkeyWrappers.map((wrapper) => [wrapper.params.credentialId, { first: wrapper.params.prfSalt }])), request, credentials, signal });
  let kek = null;
  try {
    const wrapper = passkeyWrappers.find((entry) => entry.params.credentialId === asked.credentialId);
    if (!wrapper) throw new VaultError("That passkey doesn't open your account.", "authentication_failed");
    kek = wrapper.type === "password-passkey" ? await combinedKek(asked.first, keys.passwordKey) : await passkeyKek(asked.first);
    return await unwrap(wrapper, kek);
  } finally {
    wipe(kek, asked.first, asked.second, prf?.prfOutput);
  }
}

/**
 * Step 5: a password wrapper of this device's local root, unless it has
 * one. Resolves to the manifest to save, or null.
 */
export async function addLocalPassword({ localVault, keys }) {
  if (localVault.manifest.wrappers.some((wrapper) => wrapper.type === "password")) return null;
  return localVault.addPasswordWrapper(keys.localKek, { salt: toBase64Url(keys.salt), iterations: keys.iterations, username: keys.username });
}

/**
 * The whole move, as the security panel runs it. `security` is the account
 * summary; `username` is used only when the member has no password yet.
 * `endorse()` endorses the certification key from this device. Resolves to
 * `{ manifest, created, wrapper }`: the local manifest to save (or null),
 * whether this run made the vault, and the type of its first wrapper.
 */
export async function migrateAccount({ username = "", password, security, identity, keyStore, localVault, endorse = async () => {}, request = signInRequest, credentials = globalThis.navigator?.credentials, signal, onStep = () => {} }) {
  let step = null;
  try {
    onStep("password");
    step = security?.password
      ? await confirmAccountPassword({ password, security, request })
      : await setAccountPassword({ username, password, request, credentials, signal });
    onStep("vault");
    const vault = await ensureAccountVault({ identity, keyStore, keys: step.keys, prf: step.prf ?? null,
      passkeys: security?.passkeys ?? [], request, credentials, signal });
    onStep("endorse");
    await endorse();
    onStep("local");
    const manifest = await addLocalPassword({ localVault, keys: step.keys });
    return { manifest, ...vault };
  } finally {
    wipeSignUp(step?.keys);
    wipe(step?.keys?.passwordKey, step?.keys?.localKek, step?.prf?.prfOutput);
  }
}
