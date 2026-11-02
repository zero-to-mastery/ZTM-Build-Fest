// Passkey registration and login, the device sync key, and logout. Also the
// WebAuthn JSON conversions the other parts use for passkey confirmations.
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { currentPlatform, householdDeviceName } from "../../platform.js";

const decode = (value) =>
  Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );
const encode = (value) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const registrationOptions = (options) => ({
  ...options,
  extensions: { ...(options.extensions ?? {}), prf: {} },
  challenge: decode(options.challenge),
  user: { ...options.user, id: decode(options.user.id) },
  excludeCredentials: (options.excludeCredentials ?? []).map((item) => ({
    ...item,
    id: decode(item.id),
  })),
});
export const authenticationOptions = (options) => ({
  ...options,
  challenge: decode(options.challenge),
  allowCredentials: options.allowCredentials.map((item) => ({
    ...item,
    id: decode(item.id),
  })),
});
export const credentialJson = (credential) => ({
  id: credential.id,
  type: credential.type,
  response: {
    clientDataJSON: encode(credential.response.clientDataJSON),
    attestationObject: credential.response.attestationObject
      ? encode(credential.response.attestationObject)
      : undefined,
    authenticatorData: credential.response.authenticatorData
      ? encode(credential.response.authenticatorData)
      : undefined,
    signature: credential.response.signature
      ? encode(credential.response.signature)
      : undefined,
    userHandle: credential.response.userHandle
      ? encode(credential.response.userHandle)
      : null,
    transports: credential.response.getTransports?.() ?? [],
  },
});

export class HouseholdAuth {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  async register(purpose, values) {
    await this.host.run(async () => {
      await this.ctx.api.openSyncKeyStore();
      const pendingKeys = await this.host.syncKeyStore.getOrCreatePendingDevice();
      this.host.localFingerprint = pendingKeys.fingerprint;
      const started = await this.host.api("/api/passkeys/register/options", {
        method: "POST",
        body: JSON.stringify({
          purpose,
          deviceLabel: values.deviceLabel ?? householdDeviceName(currentPlatform()),
          code: values.code,
        }),
      });
      const credential = await navigator.credentials.create({
        publicKey: registrationOptions(started.publicKey),
        signal: this.host.connectionAbort.signal,
      });
      const registered = await this.host.api("/api/passkeys/register/finish", {
        method: "POST",
        body: JSON.stringify({
          flow: started.flow,
          credential: credentialJson(credential),
          syncPublicKeys: pendingKeys.publicKeys,
        }),
      });
      if (purpose === "bootstrap")
        this.host.localFingerprint = (
          await this.host.syncKeyStore.bindPendingDevice({
            deviceId: registered.deviceId,
            householdId: registered.householdId,
            memberId: registered.memberId,
          })
        ).fingerprint;
      history.replaceState(null, "", purpose === "claim" ? "/pair" : "/");
      await this.host.load();
    });
  }

  async ensureSyncDeviceKey(identity) {
    this.host.assertConnection();
    await this.ctx.api.openSyncKeyStore();
    const existing = await this.host.syncKeyStore.getDevice(identity.deviceId);
    if (existing) return this.host.syncKeyStore.completePendingTransition(identity.deviceId, { signal: this.host.connectionAbort.signal });
    const pending = await this.host.syncKeyStore.getOrCreatePendingDevice();
    await this.host.api("/api/sync/device-keys", {
      method: "POST",
      body: JSON.stringify({ publicKeys: pending.publicKeys }),
    });
    return this.host.syncKeyStore.bindPendingDevice({
      deviceId: identity.deviceId,
      householdId: identity.householdId,
      memberId: identity.memberId,
    });
  }

  async login() {
    await this.host.run(async () => {
      const started = await this.host.api("/api/login/options", {
        method: "POST",
        body: "{}",
      });
      const credential = await navigator.credentials.get({
        publicKey: authenticationOptions(started.publicKey),
        signal: this.host.connectionAbort.signal,
      });
      await this.host.api("/api/login/finish", {
        method: "POST",
        body: JSON.stringify({
          flow: started.flow,
          credential: credentialJson(credential),
        }),
      });
      history.replaceState(null, "", "/");
      await this.host.load();
    });
  }

  async logout() {
    // Local lock is immediate and independent of network availability.
    // Logging out ends the session: nothing (such as reminders) resumes.
    this.host.dispatchEvent(new CustomEvent("kin:lock", { bubbles: true, composed: true, detail: { endSession: true } }));
    await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  }
}
