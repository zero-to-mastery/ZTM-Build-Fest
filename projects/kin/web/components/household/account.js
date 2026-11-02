// Username and password accounts on the household panel (ADR 0018, #558):
// creating a household or joining one with the password chosen at first
// run, finishing a password claim once it is approved, signing in again
// with the password, keeping the member's account vault current, endorsing
// the member's certification key (#570), and provisioning a device that
// signed in with no other device's help (#568), including with the backup
// code and its new password (#572).
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { currentPlatform, householdDeviceName } from "../../platform.js";
import { createAccountVault, passwordUnlockKeys, passwordWrapper, signUpBody } from "../../security/account-setup.js";
import { derivePasswordKeys, openVault, wipeVaultContents } from "../../security/account-vault.js";
import { EventStore } from "../../storage/event-store.js";
import { vaultApi, VaultKeeper } from "../../security/account-vault-sync.js";
import {
  certificationKeyPair,
  createCertificationEndorsement,
  createMemberCertificate,
  MAX_ENDORSEMENT_ANCHORS,
  verifyOwnEndorsement,
} from "../../security/device-certification.js";
import { fromBase64Url, getActiveVault, localPasswordKek, toBase64Url } from "../../security/local-vault.js";
import { vaultHouseholdEpochs } from "../../security/new-device.js";
import { deviceKeyFingerprint, importVaultEpochKey, verifiedDeviceKeyHistory } from "../../sync/crypto.js";
import { onEpochInstalled } from "../../sync/key-store.js";

export class HouseholdAccount {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
    this.keeper = null;
    this.stopKeeper = null;
  }

  /** This device's password wrapper (the lock screen's), or null. */
  wrapper() {
    try { return passwordWrapper(getActiveVault()?.manifest); } catch { return null; }
  }

  /** Runs `action` as the panel's one operation and hands back its result
   * or its error (host.run reports errors on the panel and swallows them). */
  async guarded(action) {
    const outcome = { done: false, value: undefined, error: null };
    await this.host.run(async () => {
      try {
        outcome.value = await action();
        outcome.done = true;
      } catch (error) {
        outcome.error = error;
        throw error;
      }
    });
    if (outcome.error) throw outcome.error;
    if (!outcome.done) throw new Error("Kin is busy with another household step. Try again in a moment.");
    return outcome.value;
  }

  /**
   * Creates the household with this device as its first trusted device and
   * the new password as the founder's sign-in (`signUp` from
   * account-setup prepareSignUp), creates the account vault, keeps its key
   * here and turns on sync. Resolves to the identity.
   */
  createHousehold(signUp) {
    return this.guarded(async () => {
      await this.ctx.api.openSyncKeyStore();
      // Trying again after a later step failed never creates a second
      // household: a device that already has its identity goes on from there.
      let identity = this.host.identity;
      if (!identity) {
        const pending = await this.host.syncKeyStore.getOrCreatePendingDevice();
        this.host.localFingerprint = pending.fingerprint;
        identity = await this.host.api("/api/account/bootstrap", {
          method: "POST",
          body: JSON.stringify({ ...signUpBody(signUp), deviceLabel: householdDeviceName(currentPlatform()), syncPublicKeys: pending.publicKeys }),
        });
        this.host.localFingerprint = (await this.host.syncKeyStore.bindPendingDevice({
          deviceId: identity.deviceId, householdId: identity.householdId, memberId: identity.memberId,
        })).fingerprint;
      }
      await this.createVault(identity, signUp);
      history.replaceState(null, "", "/");
      await this.host.load();
      // The founder turns sync on for the household; its first key goes into
      // the vault as soon as it is installed (the keeper watches).
      if (!this.host.syncStatus?.enabled) {
        await this.host.api("/api/sync/enable", { method: "POST", body: "{}" });
        this.host.syncStatus = await this.host.api("/api/sync/status");
        this.host.render();
      }
      this.host.dispatchEvent(new CustomEvent("kin:sync-enabled", { bubbles: true, composed: true, detail: this.host.identity }));
      return this.host.identity;
    });
  }

  /**
   * Accepts an invitation with the new password: the claim the inviter
   * approves, as with a passkey. `signUp` is kept (in memory only) so
   * finishing after approval doesn't ask for the password again.
   */
  joinHousehold(signUp, code) {
    return this.guarded(async () => {
      await this.ctx.api.openSyncKeyStore();
      const pending = await this.host.syncKeyStore.getOrCreatePendingDevice();
      this.host.localFingerprint = pending.fingerprint;
      this.host.claimIntent = "join";
      this.host.acknowledgedPathConflict = false;
      // A claim already sent (a retry after a later step failed) stands.
      if (this.host.claim?.state === "Claimed") { this.pendingSignUp = signUp; return; }
      await this.host.api("/api/account/claim", {
        method: "POST",
        body: JSON.stringify({ ...signUpBody(signUp), code, deviceLabel: householdDeviceName(currentPlatform()), syncPublicKeys: pending.publicKeys }),
      });
      this.pendingSignUp = signUp;
      history.replaceState(null, "", "/pair");
      await this.host.load();
    });
  }

  /**
   * Finishes an approved password claim: checks the approving device's key
   * as the passkey activation does, activates with the password, creates
   * the account vault and keeps its key. Uses the sign-up kept from joining
   * when this page still has it; otherwise `password` (typed again).
   */
  activate(password = null) {
    return this.guarded(async () => {
      const claim = this.host.claim;
      if (!this.host.localFingerprint || claim?.syncKeyFingerprint !== this.host.localFingerprint)
        throw new Error("This device key changed. Restart pairing before activating it.");
      if (!this.host.verifiedInviterFingerprint || !claim?.inviterDeviceId || !claim?.inviterKeyFingerprint)
        throw new Error("Compare the approving device fingerprint on both devices before activation.");
      let keys = this.pendingSignUp;
      let derived = null;
      if (!keys) {
        // The joiner's local password wrapper and their account share the
        // salt chosen at sign-up, so the typed password derives both.
        const wrapper = this.wrapper();
        derived = await passwordUnlockKeys(wrapper, password);
        keys = { ...derived, salt: fromBase64Url(wrapper.salt), iterations: wrapper.iterations };
      }
      try {
        const authKey = toBase64Url(keys.authKey);
        const activated = await this.host.api("/api/claim/activate/password", { method: "POST", body: JSON.stringify({ authKey }) });
        await this.ctx.api.openSyncKeyStore();
        const bound = await this.host.syncKeyStore.bindPendingDevice({
          deviceId: activated.deviceId, householdId: activated.householdId, memberId: activated.memberId,
        });
        this.host.localFingerprint = bound.fingerprint;
        const { devices } = await this.host.api("/api/sync/devices");
        const inviter = devices.find((device) => device.deviceId === claim.inviterDeviceId);
        if (!inviter?.publicKeys || inviter.fingerprint !== claim.inviterKeyFingerprint ||
            (await deviceKeyFingerprint(inviter.publicKeys)) !== claim.inviterKeyFingerprint)
          throw new Error("The approving device key does not match the compared fingerprint.");
        await this.host.syncKeyStore.pinTrustedDevice({
          householdId: activated.householdId, memberId: inviter.memberId, deviceId: inviter.deviceId,
          publicKeys: inviter.publicKeys, fingerprint: inviter.fingerprint,
        });
        await this.createVault(activated, keys);
        if (this.pendingSignUp) for (const key of ["authKey", "passwordKey", "localKek"]) this.pendingSignUp[key]?.fill?.(0);
        this.pendingSignUp = null;
        this.host.claim = null;
        history.replaceState(null, "", "/");
        await this.host.load();
        if (this.host.syncStatus?.enabled)
          this.host.dispatchEvent(new CustomEvent("kin:sync-enabled", { bubbles: true, composed: true, detail: this.host.identity }));
        // Joined: on to Today (the router follows the address).
        location.hash = "today";
        return this.host.identity;
      } finally {
        if (derived) for (const key of ["authKey", "passwordKey", "localKek"]) derived[key]?.fill(0);
      }
    });
  }

  /** Signs this device in again with the password (a session ended while
   * Kin stayed unlocked). The password may have changed on another device
   * (#560): the service's current parameters derive the key it checks, and
   * once that signs in, this device's own password wrapper follows the new
   * password (same wrapper ID), so the new password unlocks it from now on. */
  signIn(password) {
    return this.guarded(async () => {
      const wrapper = this.wrapper();
      let parameters = { salt: wrapper.salt, iterations: wrapper.iterations };
      try {
        const current = await this.host.api("/api/account/sign-in/parameters", { method: "POST", body: JSON.stringify({ username: wrapper.username }) });
        if (current?.salt && Number.isSafeInteger(current.iterations)) parameters = { salt: current.salt, iterations: current.iterations };
      } catch { /* Offline or limited: this device's own parameters. */ }
      const keys = await derivePasswordKeys(password, fromBase64Url(parameters.salt), { iterations: parameters.iterations });
      let kek = null;
      try {
        await this.host.api("/api/login/password", { method: "POST",
          body: JSON.stringify({ username: wrapper.username, authKey: toBase64Url(keys.authKey) }) });
        if (parameters.salt !== wrapper.salt || parameters.iterations !== wrapper.iterations) {
          const vault = getActiveVault();
          kek = await localPasswordKek(keys.passwordKey);
          const manifest = await vault.replacePasswordWrapper(kek, { ...parameters, username: wrapper.username });
          await EventStore.updateSecurityManifest(manifest, vault);
          const security = this.host.closest("kin-app")?.security;
          if (security) security.manifest = await EventStore.securityStatus();
        }
      } finally {
        keys.authKey.fill(0);
        keys.passwordKey.fill(0);
        kek?.fill(0);
      }
      history.replaceState(null, "", "/");
      await this.host.load();
    });
  }

  /**
   * Finishes signing in on a new device (#568/#570), once this browser's
   * local storage exists: `signIn` comes from the security panel's sign-in
   * (`{ view, opened: { vaultKey, contents }, endorsement, replaceDeviceId }`).
   * Generates this device's keys, certifies them with the member's
   * certification key from the vault, registers the device with the
   * capability (replacing one of the member's devices if chosen), installs
   * the household's epoch keys from the vault, keeps the vault key, pins the
   * devices the member's account trusts, and turns sync on. A retry after a
   * later step failed goes on from the registered device.
   */
  provisionNewDevice(signIn) {
    return this.guarded(async () => {
      await this.ctx.api.openSyncKeyStore();
      const store = this.host.syncKeyStore;
      const { view, opened, endorsement } = signIn;
      const { householdId, memberId } = view;
      if (!signIn.registered) {
        const certification = await certificationKeyPair(opened.contents.certificationKey);
        // The service's endorsement must be this vault's key, signed by it;
        // only then are its anchors this account's own trusted devices.
        signIn.anchors = await verifyOwnEndorsement(endorsement, { householdId, memberId, certification });
        const pending = await store.getOrCreatePendingDevice();
        this.host.localFingerprint = pending.fingerprint;
        const certificate = await createMemberCertificate({ householdId, memberId, endorsement, certification,
          device: { deviceId: view.deviceId, publicKeys: pending.publicKeys, fingerprint: pending.fingerprint } });
        const registered = await this.host.api("/api/account/sign-in/device", { method: "POST", body: JSON.stringify({
          syncPublicKeys: pending.publicKeys, certificate, replaceDeviceId: signIn.replaceDeviceId ?? null,
          deviceLabel: householdDeviceName(currentPlatform()), vaultEpochs: vaultHouseholdEpochs(opened.contents),
          // After a backup code (#572): the new password, and the vault's
          // password wrappers re-wrapped under it, in the same step.
          ...(signIn.registration ?? {}),
        }) });
        signIn.registration = null;
        const bound = await store.bindPendingDevice({ deviceId: registered.deviceId, householdId: registered.householdId, memberId: registered.memberId });
        this.host.localFingerprint = bound.fingerprint;
        signIn.registered = registered;
      }
      const identity = signIn.registered;
      const device = await store.getDevice(identity.deviceId);
      for (const entry of opened.contents.epochs) {
        const label = entry.family === "chat" ? `chat:${householdId}` : householdId;
        if (await store.getEpoch(label, entry.epoch)) continue;
        await store.saveEpoch({ householdId: label, keyEpoch: entry.epoch,
          ...await importVaultEpochKey({ rawKey: entry.key, householdId: label, keyEpoch: entry.epoch, deviceKeys: device.keys }) });
      }
      await store.setAccountVaultKey(identity.deviceId, opened.vaultKey);
      // The devices the endorsing device trusted become this device's pins,
      // at the key the endorsement named (a later signed key change is
      // followed by sync as for any pin).
      const { devices } = await this.host.api("/api/sync/devices");
      for (const anchor of signIn.anchors) {
        const entry = devices.find((candidate) => candidate.deviceId === anchor.deviceId);
        if (!entry?.publicKeys) continue;
        const key = (await verifiedDeviceKeyHistory(entry)).find((historic) => historic.fingerprint === anchor.fingerprint);
        if (!key) throw new Error("A device your account trusts no longer matches its key. Sign in from one of your devices instead.");
        await store.pinTrustedDevice({ householdId, memberId: entry.memberId, deviceId: entry.deviceId, publicKeys: key.publicKeys, fingerprint: key.fingerprint });
      }
      await store.pinCertificationKey({ householdId, memberId, fingerprint: endorsement.fingerprint });
      globalThis.history.replaceState(null, "", "/");
      await this.host.load();
      this.host.dispatchEvent(new CustomEvent("kin:sync-enabled", { bubbles: true, composed: true, detail: this.host.identity }));
      return this.host.identity;
    });
  }

  /**
   * Endorses the member's certification key from this trusted device when
   * the service has no endorsement yet (#570): the step that lets a new
   * device certify itself later. Runs where this device holds the vault key
   * (after the vault is made, and for members whose vault predates this);
   * the endorsement lists this device's pins as the account's trust anchors.
   */
  async ensureCertificationEndorsement(identity) {
    const store = this.host.syncKeyStore;
    const vaultKey = await store?.accountVaultKey(identity.householdId);
    if (!vaultKey) return { status: "no_vault_key" };
    let contents = null;
    try {
      const value = await this.host.api("/api/account/vault");
      if (value.certificationEndorsement || !value.vault) return { status: value.vault ? "endorsed" : "no_vault" };
      contents = await openVault(vaultKey, fromBase64Url(value.vault.ciphertext),
        { householdId: identity.householdId, memberId: identity.memberId, version: value.vault.version });
      if (!contents.certificationKey) return { status: "no_certification_key" };
      const certification = await certificationKeyPair(contents.certificationKey);
      const device = await store.getDevice(identity.deviceId);
      const pins = (await store.listPinnedDevices(identity.householdId)).filter((pin) => pin.deviceId !== identity.deviceId);
      const endorsement = await createCertificationEndorsement({
        householdId: identity.householdId, memberId: identity.memberId, certification,
        device: { deviceId: identity.deviceId, fingerprint: device.fingerprint, signingKey: device.keys.signingPrivateKey },
        anchors: pins.slice(0, MAX_ENDORSEMENT_ANCHORS - 1),
      });
      await this.host.api("/api/account/certification", { method: "PUT", body: JSON.stringify({ endorsement }) });
      return { status: "endorsed_now" };
    } finally {
      vaultKey.fill(0);
      wipeVaultContents(contents);
    }
  }

  /** The member's first account vault, and its key kept on this device.
   * Done once: a device that keeps the key already has a vault. */
  async createVault(identity, keys) {
    const store = this.host.syncKeyStore;
    const existing = await store.accountVaultKey(identity.householdId);
    if (existing) {
      existing.fill(0);
      this.startKeeper(identity);
      return;
    }
    const api = vaultApi((path, options) => this.host.api(path, options));
    const epochs = await store.vaultEpochKeys(identity.householdId);
    let vaultKey;
    try {
      vaultKey = await createAccountVault({ api, householdId: identity.householdId, memberId: identity.memberId,
        passwordKey: keys.passwordKey, salt: keys.salt, iterations: keys.iterations, epochs });
      await store.setAccountVaultKey(identity.deviceId, vaultKey);
    } catch (error) {
      // The vault was made by an earlier try whose key this device didn't
      // keep: the account still works; opening that vault on a device is
      // the new-device story's (#568).
      if (error?.code !== "vault_version_conflict") throw error;
    } finally {
      vaultKey?.fill(0);
      for (const entry of epochs) entry.key.fill(0);
    }
    this.startKeeper(identity);
  }

  /**
   * Keeps the account vault current from this device (#567): when this
   * device holds the member's vault key, every new household or chat key it
   * installs is merged into the vault. Started once per unlocked panel.
   */
  startKeeper(identity = this.host.identity) {
    if (!identity || this.keeper?.householdId === identity.householdId || !this.host.syncKeyStore) return;
    this.stopKeeper?.();
    const store = this.host.syncKeyStore;
    this.keeper = new VaultKeeper({
      api: vaultApi((path, options) => this.host.api(path, options)),
      householdId: identity.householdId,
      memberId: identity.memberId,
      vaultKey: () => store.accountVaultKey(identity.householdId),
      localContents: async () => ({ epochs: await store.vaultEpochKeys(identity.householdId) }),
    });
    this.stopKeeper = this.keeper.watch(onEpochInstalled);
    // Keys installed while this device was offline or locked.
    void this.keeper.update().catch(() => {});
    // A member whose certification key isn't endorsed yet gets it endorsed
    // here (#570); tried again the next time the panel starts.
    void this.ensureCertificationEndorsement(identity).catch(() => {});
  }

  stop() {
    this.stopKeeper?.();
    this.stopKeeper = null;
    this.keeper = null;
    this.pendingSignUp = null;
  }
}
