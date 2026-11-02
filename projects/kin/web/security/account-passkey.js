// The WebAuthn ceremonies behind a password account's passkey (ADR 0018,
// #561/#562): registering it for the signed-in member, and asking an
// existing one for its PRF outputs. No storage and no UI; account-security.js
// decides what the outputs wrap. PRF outputs never leave the browser: the
// service verifies the registration and the assertion, and sees neither.
//
// Each ceremony asks the passkey for two PRF values at once (`first` and
// `second`, the WebAuthn PRF extension's two inputs): one for the account
// vault's wrapper and one for this device's local unlock wrapper, so the two
// wrappers never share a key even though one touch gives both.
import { fromBase64Url, toBase64Url, VaultError } from "./local-vault.js";
import { signInRequest } from "./new-device.js";

export const PRF_UNAVAILABLE_MESSAGE =
  "This passkey can't keep your account's keys (it doesn't support the PRF extension). Kin kept it for confirming household changes; try a passkey from your phone's or computer's built-in screen lock.";

function credentialsApi(credentials) {
  if (!globalThis.PublicKeyCredential || !credentials?.get || !credentials?.create)
    throw new VaultError("Passkeys aren't available in this browser.", "unsupported_unlock");
  return credentials;
}

/** Copies a PRF result (32 bytes) and zeroes the browser's buffer, or null. */
function takeResult(value) {
  if (!value || value.byteLength !== 32) return null;
  const view = new Uint8Array(value);
  const copy = view.slice();
  view.fill(0);
  return copy;
}

function prfInputs({ first, second = null }) {
  return second ? { first: fromBase64Url(first), second: fromBase64Url(second) } : { first: fromBase64Url(first) };
}

/**
 * Registers a new passkey for the signed-in member, after their current
 * password (`currentAuthKey`, base64url): the service checks it before the
 * ceremony starts. `salts` is `{ first, second? }` (base64url PRF inputs).
 * Resolves to `{ credentialId, first, second }`, where the PRF outputs are
 * null when the authenticator didn't evaluate PRF while registering (many
 * don't; then assertPasskeyPrf follows). The caller zeroes the outputs.
 */
export async function registerAccountPasskey({ currentAuthKey, salts, request = signInRequest, credentials = globalThis.navigator?.credentials, signal } = {}) {
  const api = credentialsApi(credentials);
  const started = await request("/api/account/passkeys/options", { currentAuthKey });
  const options = started.publicKey;
  const publicKey = {
    ...options,
    challenge: fromBase64Url(options.challenge),
    user: { ...options.user, id: fromBase64Url(options.user.id) },
    // A passkey that can sign in on a new device by itself needs to be
    // discoverable on the person's other devices; the PRF extension is what
    // lets it keep the account's keys.
    authenticatorSelection: { ...(options.authenticatorSelection ?? {}), residentKey: "required", userVerification: "required" },
    extensions: { prf: { eval: prfInputs(salts) } },
  };
  const credential = await api.create({ publicKey, signal });
  if (!credential) throw new VaultError("Adding the passkey was cancelled.", "authentication_failed");
  const prf = credential.getClientExtensionResults?.()?.prf;
  const first = takeResult(prf?.results?.first);
  const second = takeResult(prf?.results?.second);
  try {
    await request("/api/account/passkeys/finish", { flow: started.flow, credential: {
      id: credential.id, type: credential.type, response: {
        clientDataJSON: toBase64Url(new Uint8Array(credential.response.clientDataJSON)),
        attestationObject: toBase64Url(new Uint8Array(credential.response.attestationObject)),
        transports: credential.response.getTransports?.() ?? [],
      },
    } });
  } catch (error) {
    first?.fill(0);
    second?.fill(0);
    throw error;
  }
  return { credentialId: credential.id, first, second, prfEnabled: prf?.enabled !== false };
}

/**
 * Asks one of the member's passkeys for its PRF outputs, through the
 * trusted device's passkey sign-in (/api/login/options and /finish, which
 * also refresh this device's session). `evalByCredential` maps each
 * passkey that may answer to its inputs `{ first, second? }` (base64url);
 * only those are offered. Resolves to `{ credentialId, first, second }`;
 * the caller zeroes the outputs. Refuses a passkey without PRF.
 */
export async function assertPasskeyPrf({ evalByCredential, request = signInRequest, credentials = globalThis.navigator?.credentials, signal } = {}) {
  const api = credentialsApi(credentials);
  const ids = Object.keys(evalByCredential ?? {});
  if (!ids.length) throw new VaultError("Your account has no passkey for this yet.", "credential_unavailable");
  const started = await request("/api/login/options", {});
  const allowed = (started.publicKey.allowCredentials ?? []).filter((entry) => ids.includes(entry.id));
  if (!allowed.length) throw new VaultError("Your passkey isn't registered for this device's account any more.", "credential_unavailable");
  const inputs = {};
  for (const id of ids) inputs[id] = prfInputs(evalByCredential[id]);
  const credential = await api.get({ signal, publicKey: {
    ...started.publicKey,
    challenge: fromBase64Url(started.publicKey.challenge),
    userVerification: "required",
    allowCredentials: allowed.map((entry) => ({ ...entry, type: "public-key", id: fromBase64Url(entry.id) })),
    extensions: { prf: { evalByCredential: inputs } },
  } });
  if (!credential) throw new VaultError("Passkey confirmation was cancelled.", "authentication_failed");
  const results = credential.getClientExtensionResults?.()?.prf?.results;
  const first = takeResult(results?.first);
  const second = evalByCredential[credential.id]?.second ? takeResult(results?.second) : null;
  if (!first) {
    second?.fill(0);
    throw new VaultError(PRF_UNAVAILABLE_MESSAGE, "unsupported_unlock");
  }
  try {
    await request("/api/login/finish", { flow: started.flow, credential: {
      id: credential.id, type: credential.type, response: {
        clientDataJSON: toBase64Url(new Uint8Array(credential.response.clientDataJSON)),
        authenticatorData: toBase64Url(new Uint8Array(credential.response.authenticatorData)),
        signature: toBase64Url(new Uint8Array(credential.response.signature)),
        userHandle: credential.response.userHandle ? toBase64Url(new Uint8Array(credential.response.userHandle)) : null,
      },
    } });
  } catch (error) {
    first.fill(0);
    second?.fill(0);
    throw error;
  }
  return { credentialId: credential.id, first, second };
}
