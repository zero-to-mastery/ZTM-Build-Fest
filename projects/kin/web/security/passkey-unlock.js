import { fromBase64Url, toBase64Url, VaultError } from "./local-vault.js";

export async function authenticatePrf(wrapper = null, { signal } = {}) {
  if (!globalThis.PublicKeyCredential || !navigator.credentials?.get)
    throw new VaultError("Secure passkey unlock is unavailable here. Use your recovery key.", "unsupported_unlock");
  const salt = wrapper ? fromBase64Url(wrapper.prfSalt) : crypto.getRandomValues(new Uint8Array(32));
  const response = await fetch("/api/login/options", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", cache: "no-store", signal,
  });
  const started = await response.json();
  if (!response.ok) throw new VaultError(started.message ?? "This device's credential is unavailable. Use recovery.", "credential_unavailable");
  const publicKey = {
    ...started.publicKey,
    challenge: fromBase64Url(started.publicKey.challenge),
    userVerification: "required",
    allowCredentials: started.publicKey.allowCredentials.map((credential) => ({ ...credential, id: fromBase64Url(credential.id) })),
    extensions: { prf: { eval: { first: salt } } },
  };
  if (wrapper) {
    publicKey.allowCredentials = publicKey.allowCredentials.filter((credential) => toBase64Url(credential.id) === wrapper.credentialId);
    if (!publicKey.allowCredentials.length)
      throw new VaultError("This passkey is no longer authorized on this device. Use an authorized recovery path.", "credential_unavailable");
  }
  const credential = await navigator.credentials.get({ publicKey, signal });
  if (!credential) throw new VaultError("Passkey authentication was cancelled.", "authentication_failed");
  const result = credential.getClientExtensionResults()?.prf?.results?.first;
  if (!result || result.byteLength !== 32)
    throw new VaultError("This passkey does not support secure PRF unlock. Your recovery key remains available.", "unsupported_unlock");
  const secret = new Uint8Array(result).slice();
  try {
    // The server verifies RP/origin/challenge/signature/UV; PRF output never leaves the browser.
    const finished = await fetch("/api/login/finish", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      signal,
      body: JSON.stringify({ flow: started.flow, credential: {
        id: credential.id, type: credential.type, response: {
          clientDataJSON: toBase64Url(new Uint8Array(credential.response.clientDataJSON)),
          authenticatorData: toBase64Url(new Uint8Array(credential.response.authenticatorData)),
          signature: toBase64Url(new Uint8Array(credential.response.signature)),
          userHandle: credential.response.userHandle ? toBase64Url(new Uint8Array(credential.response.userHandle)) : null,
        },
      } }),
    });
    if (!finished.ok) throw new VaultError("Kin could not verify the passkey. Household data remains locked.", "authentication_failed");
    return { secret, credentialId: credential.id, prfSalt: toBase64Url(salt) };
  } catch (error) {
    secret.fill(0);
    throw error;
  } finally {
    new Uint8Array(result).fill(0);
  }
}
