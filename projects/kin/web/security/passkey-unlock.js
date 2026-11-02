import { fromBase64Url, toBase64Url, VaultError } from "./local-vault.js";

export const PASSKEY_UNSUPPORTED_MESSAGE =
  "Secure passkey unlock is unavailable here. Use your backup key.";
export const PASSKEY_OFFLINE_MESSAGE =
  "Kin can't reach your household service to confirm the passkey. Use your backup key while offline; the passkey works again once you're connected.";
export const PASSKEY_NOT_ENROLLED_MESSAGE =
  "This device isn't signed in to a household yet, so it can't confirm a passkey. Use your backup key, then create or join your household.";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
// authenticatorData flags (WebAuthn §6.1): user present, user verified.
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

// Browser capability only. It never proves that a credential is enrolled or
// that the identity service will accept it.
export function passkeyUnlockSupported() {
  return Boolean(globalThis.PublicKeyCredential && navigator.credentials?.get);
}

async function loginRequest(path, body, signal) {
  try {
    return await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body, cache: "no-store", signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    // A network failure is not a credential failure; recovery still works offline.
    throw new VaultError(PASSKEY_OFFLINE_MESSAGE, "connection_unavailable", error);
  }
}

/** Whether this browser says it has no connection right now. */
function browserOffline() {
  return globalThis.navigator?.onLine === false;
}

/**
 * Unlocks with a passkey (the PRF output for `wrapper`'s salt).
 *
 * Online, nothing changed (V0.41.0): the identity service issues the
 * challenge, checks the assertion (RP, origin, challenge, signature, user
 * verification) and refreshes this device's session.
 *
 * Offline (#552): when the browser says it is offline, or the service can't
 * be reached (no connection, or a 5xx from a proxy in front of it), a
 * device-local challenge unlocks with the same passkey instead
 * (authenticatePrfLocally). Only an unlock of an existing wrapper does this;
 * enrolling a new passkey (`wrapper` null) still needs the service. A
 * refusal from a reachable service (401/403: this device isn't trusted
 * there) is not bypassed: it is said, as before.
 */
export async function authenticatePrf(wrapper = null, { signal, credentials = globalThis.navigator?.credentials } = {}) {
  if (!passkeyUnlockSupported())
    throw new VaultError(PASSKEY_UNSUPPORTED_MESSAGE, "unsupported_unlock");
  if (wrapper && browserOffline()) return authenticatePrfLocally(wrapper, { signal, credentials });
  const salt = wrapper ? fromBase64Url(wrapper.prfSalt) : crypto.getRandomValues(new Uint8Array(32));
  let response;
  try {
    response = await loginRequest("/api/login/options", "{}", signal);
  } catch (error) {
    if (wrapper && error?.code === "connection_unavailable") return authenticatePrfLocally(wrapper, { signal, credentials });
    throw error;
  }
  if (wrapper && response.status >= 500) return authenticatePrfLocally(wrapper, { signal, credentials });
  const started = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 401/403 mean this device holds no trusted-device credential for a household.
    const message = [401, 403].includes(response.status)
      ? PASSKEY_NOT_ENROLLED_MESSAGE
      : "Kin couldn't start passkey unlock right now. Use your backup key.";
    throw new VaultError(message, "credential_unavailable", new Error(started.message ?? `HTTP ${response.status}`));
  }
  const challenge = fromBase64Url(started.publicKey.challenge);
  const publicKey = {
    ...started.publicKey,
    challenge,
    userVerification: "required",
    allowCredentials: started.publicKey.allowCredentials.map((credential) => ({ ...credential, id: fromBase64Url(credential.id) })),
    extensions: { prf: { eval: { first: salt } } },
  };
  if (wrapper) {
    publicKey.allowCredentials = publicKey.allowCredentials.filter((credential) => toBase64Url(credential.id) === wrapper.credentialId);
    if (!publicKey.allowCredentials.length)
      throw new VaultError("This passkey is no longer authorized on this device. Use your backup key.", "credential_unavailable");
  }
  const credential = await credentials.get({ publicKey, signal });
  if (!credential) throw new VaultError("Passkey authentication was cancelled.", "authentication_failed");
  const result = credential.getClientExtensionResults()?.prf?.results?.first;
  if (!result || result.byteLength !== 32)
    throw new VaultError("This passkey does not support secure PRF unlock. Your backup key remains available.", "unsupported_unlock");
  const secret = new Uint8Array(result).slice();
  try {
    // The server verifies RP/origin/challenge/signature/UV; PRF output never leaves the browser.
    let finished;
    try {
      finished = await loginRequest("/api/login/finish", JSON.stringify({ flow: started.flow, credential: {
        id: credential.id, type: credential.type, response: {
          clientDataJSON: toBase64Url(new Uint8Array(credential.response.clientDataJSON)),
          authenticatorData: toBase64Url(new Uint8Array(credential.response.authenticatorData)),
          signature: toBase64Url(new Uint8Array(credential.response.signature)),
          userHandle: credential.response.userHandle ? toBase64Url(new Uint8Array(credential.response.userHandle)) : null,
        },
      } }), signal);
    } catch (error) {
      // The connection dropped after the touch: the same local checks as an
      // offline unlock, against the challenge this ceremony used.
      if (!wrapper || error?.code !== "connection_unavailable") throw error;
      await checkLocalAssertion(credential.response, { challenge, origin: location.origin, rpId: publicKey.rpId ?? location.hostname });
      return { secret, credentialId: credential.id, prfSalt: toBase64Url(salt), offline: true };
    }
    if (!finished.ok) throw new VaultError("Kin could not verify the passkey. Household data remains locked.", "authentication_failed");
    return { secret, credentialId: credential.id, prfSalt: toBase64Url(salt), offline: false };
  } catch (error) {
    secret.fill(0);
    throw error;
  } finally {
    new Uint8Array(result).fill(0);
  }
}

/**
 * Offline passkey unlock (#552): a WebAuthn assertion with a challenge made
 * here, for exactly the wrapper's passkey, with user verification required
 * and the wrapper's PRF salt. Nothing is sent anywhere.
 *
 * What unlocks Kin is the PRF output: only the authenticator holding the
 * passkey can compute it for that salt, and only it unwraps the local root
 * (CRYPTOGRAPHY, "Offline passkey unlock"). The checks here
 * (checkLocalAssertion) make sure the ceremony was this one, for this site,
 * with the person verified; the signature isn't checked, because a forged
 * assertion can't come with the PRF output. Resolves like authenticatePrf,
 * with `offline: true`.
 */
export async function authenticatePrfLocally(wrapper, { signal, credentials = globalThis.navigator?.credentials, origin = globalThis.location?.origin, rpId = globalThis.location?.hostname } = {}) {
  if (!wrapper?.credentialId || !wrapper.prfSalt)
    throw new VaultError("This passkey unlock is incomplete. Use your backup key.", "credential_unavailable");
  if (!globalThis.PublicKeyCredential || !credentials?.get)
    throw new VaultError(PASSKEY_UNSUPPORTED_MESSAGE, "unsupported_unlock");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const salt = fromBase64Url(wrapper.prfSalt);
  const credential = await credentials.get({ signal, publicKey: {
    challenge,
    rpId,
    timeout: 60_000,
    userVerification: "required",
    allowCredentials: [{ type: "public-key", id: fromBase64Url(wrapper.credentialId) }],
    extensions: { prf: { eval: { first: salt } } },
  } });
  if (!credential) throw new VaultError("Passkey authentication was cancelled.", "authentication_failed");
  const result = credential.getClientExtensionResults?.()?.prf?.results?.first;
  try {
    if (credential.id !== wrapper.credentialId)
      throw new VaultError("That wasn't the passkey that unlocks Kin on this device. Try again.", "authentication_failed");
    await checkLocalAssertion(credential.response, { challenge, origin, rpId });
    if (!result || result.byteLength !== 32)
      throw new VaultError("This passkey does not support secure PRF unlock. Your backup key remains available.", "unsupported_unlock");
    return { secret: new Uint8Array(result).slice(), credentialId: credential.id, prfSalt: wrapper.prfSalt, offline: true };
  } finally {
    if (result) new Uint8Array(result).fill(0);
  }
}

/**
 * The checks an offline unlock makes of an assertion's `clientDataJSON` and
 * `authenticatorData` (ArrayBuffers or byte arrays): a `webauthn.get`
 * ceremony for `challenge` on `origin`, for `rpId` (its SHA-256 opens the
 * authenticator data), with the user present and verified. Throws a
 * VaultError ("authentication_failed") otherwise.
 */
export async function checkLocalAssertion({ clientDataJSON, authenticatorData }, { challenge, origin, rpId }) {
  const refuse = (message = "Kin couldn't confirm that passkey. Try again.") => new VaultError(message, "authentication_failed");
  let client;
  try { client = JSON.parse(decoder.decode(bytes(clientDataJSON))); } catch { throw refuse(); }
  if (client?.type !== "webauthn.get" || client.challenge !== toBase64Url(challenge) || client.origin !== origin) throw refuse();
  const data = bytes(authenticatorData);
  if (data.length < 37) throw refuse();
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(rpId)));
  for (let index = 0; index < 32; index += 1) if (data[index] !== rpIdHash[index]) throw refuse();
  if (!(data[32] & FLAG_UP) || !(data[32] & FLAG_UV))
    throw refuse("Your device didn't confirm it's you (fingerprint, face or screen lock). Try again.");
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array();
}
