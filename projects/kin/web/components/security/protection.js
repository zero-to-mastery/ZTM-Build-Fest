// Setting up and replacing local protection: the backup-key setup and
// replacement flows, the root rotation they run, and adding a passkey.
// The person sees "backup key for this device"; internally it is still the
// recovery wrapper, and no stored name or format changed (#578).
// Part of <kin-security>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-security.js lists them).
import { getActiveVault, LocalVault, randomRecoverySecret } from "../../security/local-vault.js";
import { authenticatePrf } from "../../security/passkey-unlock.js";
import { EventStore } from "../../storage/event-store.js";
import { commitRootRotationKeys, prepareRootRotationKeys } from "../../sync/key-store.js";
import { loadKinEngine } from "../../wasm/kin-engine.js";
import { manifestRecoveryLabels, recoveryKeyLabel } from "../../security/key-label.js";
import { backupKeyEntryName, rememberEntry } from "../../security/backup-key-entry.js";
import { automaticDeviceName, currentPlatform } from "../../platform.js";

// A field only a password manager reads: off screen, out of the tab order,
// hidden from assistive technology.
export function passwordManagerField(type, autocomplete, value) {
  const input = document.createElement("input");
  input.type = type;
  input.autocomplete = autocomplete;
  input.value = value;
  input.tabIndex = -1;
  input.className = "visually-hidden";
  input.setAttribute("aria-hidden", "true");
  return input;
}

export class SecurityProtection {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  // The new key's label ("backup key K-7F3A"), shown with the key so it can
  // be written down next to it. The wrapper ID is chosen here for that.
  keyLabelLine(wrapperId, rootVersion, onLabel = () => {}) {
    const line = this.host.text("");
    line.className = "recovery-key-label";
    void recoveryKeyLabel(wrapperId, rootVersion).then((label) => {
      line.textContent = `This is backup key ${label}. Write the label down with the key: exports made on this device name the key they need by its label.`;
      onLabel(label);
    }, () => line.remove());
    return line;
  }

  // Shows the key's label and names the off-screen username field
  // "Kin backup key — Chrome on Android (K-7F3A)" once the label is known.
  // Each device has its own key: under one shared name, saving a second
  // device's key (or a replacement) would overwrite the first in a synced
  // password manager, and the device name says which entry is whose. Returns a
  // function, called on submit, that remembers the name so the unlock form
  // asks for the same entry.
  //
  // The name is the device's automatic one (#579), not a nickname: nicknames
  // are encrypted household data, and the remembered entry name lives in
  // browser storage, which never holds household plaintext (STORAGE.md).
  offerToPasswordManager(account, wrapperId, rootVersion) {
    let entryLabel = null;
    this.keyLabelLine(wrapperId, rootVersion, (label) => {
      entryLabel = label;
      account.value = backupKeyEntryName(label, automaticDeviceName(currentPlatform()));
    });
    return () => rememberEntry(entryLabel, account.value);
  }

  showSetup() {
    if (this.host.busy) return;
    const secret = randomRecoverySecret();
    const wrapperId = LocalVault.newWrapperId();
    this.host.render({ frameOnly: true });
    this.host.heading.textContent = "Save your backup key for this device";
    this.host.text("This key is your backup way into Kin on this device if the passkey is ever lost. Each device has its own, so it won't open Kin anywhere else. Save it somewhere safe outside Kin, such as a password manager. You won't need to type it now.");
    const warning = this.host.text("Anyone with the key can unlock this device's copy of the household. If every unlock method is lost, Kin cannot recover the data.");
    warning.className = "security-note";
    const output = document.createElement("code");
    output.textContent = secret;
    output.className = "recovery-key";
    this.host.append(output);
    const account = passwordManagerField("text", "username", backupKeyEntryName(null, null));
    const rememberAccount = this.offerToPasswordManager(account, wrapperId, 1);
    if (navigator.clipboard?.writeText) {
      this.host.button("Copy key", async () => {
        try {
          await navigator.clipboard.writeText(secret);
          this.host.message.textContent = "Backup key copied. Paste it somewhere safe before continuing.";
        } catch {
          this.host.message.textContent = "Copy is unavailable. Select the key and copy it manually.";
        }
      });
    }
    const tip = this.host.text("Tap Copy key and paste it into your password manager or a private note now. If your browser also offers to save it as a password when you continue, you can accept, but don't count on it: this is the only time Kin shows the key.");
    tip.className = "security-note";
    // No retyping (#163): the person confirms they saved the key. The hidden
    // username and new-password fields let the browser offer to save the key
    // in its password manager on submit, as "Kin backup key — <device>
    // (K-XXXX)"; the unlock form asks for the same entry, so it can autofill
    // there later.
    const form = document.createElement("form");
    form.append(account, passwordManagerField("password", "new-password", secret));
    const saved = document.createElement("label");
    saved.className = "recovery-saved";
    const confirmation = document.createElement("input");
    confirmation.type = "checkbox";
    confirmation.id = "confirm-recovery";
    confirmation.required = true;
    saved.append(confirmation, "I've saved this key somewhere safe, like a password manager.");
    const button = document.createElement("button");
    button.type = "submit";
    button.className = "primary-action";
    button.textContent = "Encrypt and continue";
    form.append(saved, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!confirmation.checked) return this.host.error(new Error("Save the backup key first, then tick the box."));
      rememberAccount();
      output.textContent = "";
      void this.host.run(() => this.host.establishProtection(secret, { recoveryWrapperId: wrapperId }));
    });
    this.host.append(form);
    this.host.button("Back", () => this.host.render(), "secondary");
    // Start at the heading, so a screen reader reads the key and warning first.
    this.host.heading.focus();
  }

  showReplacement() {
    if (this.host.busy || this.host.phase !== "unlocked") return;
    const secret = randomRecoverySecret();
    const wrapperId = LocalVault.newWrapperId();
    const rootVersion = (getActiveVault()?.rootVersion ?? this.host.manifest?.rootVersion ?? 0) + 1;
    this.host.render();
    this.host.heading.textContent = "Replace backup key";
    this.host.text("Save this new backup key for this device outside Kin. It replaces your current backup key for this browser. Add passkey unlock again afterward. Exports you already made still open only with the key they name.");
    const output = document.createElement("code");
    output.className = "recovery-key";
    output.textContent = secret;
    const form = document.createElement("form");
    const label = document.createElement("label");
    label.htmlFor = "confirm-replacement";
    label.textContent = "Re-enter the saved new backup key";
    const confirmation = document.createElement("input");
    confirmation.id = label.htmlFor;
    confirmation.type = "password";
    // The new key is offered to the password manager under its own label, so
    // the entry for the old key isn't overwritten until this one is in use.
    confirmation.autocomplete = "new-password";
    confirmation.spellcheck = false;
    confirmation.required = true;
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Confirm saved key";
    form.append(label, confirmation, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (confirmation.value.trim() !== secret)
        return this.host.error(new Error("The backup keys do not match. Save and re-enter the complete new key."));
      rememberAccount();
      confirmation.value = "";
      output.textContent = "";
      void this.host.run(() => this.host.replaceProtection(secret, { recoveryWrapperId: wrapperId }));
    });
    const account = passwordManagerField("text", "username", backupKeyEntryName(null, null));
    form.prepend(account);
    this.host.append(output);
    const rememberAccount = this.offerToPasswordManager(account, wrapperId, rootVersion);
    this.host.append(form);
    this.host.button("Cancel", () => this.host.render());
    confirmation.focus();
  }

  async replaceProtection(secret, { recoveryWrapperId } = {}) {
    const operation = this.host.operation;
    const signal = this.host.operationAbort.signal;
    const active = getActiveVault();
    await EventStore.checkSecurityEpoch(active);
    this.host.assertCurrentOperation(operation);
    // The operation owns these capabilities; clearing the application disposes
    // its event/sync adapters and projection before rotation fences peer tabs.
    const source = new LocalVault(active.vaultId, active.root, active.manifest);
    source.securityEpoch = active.securityEpoch;
    let candidate, engine;
    const cancel = () => { source.lock(); candidate?.lock(); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      ({ vault: candidate } = await LocalVault.createRotation(source, secret, { recoveryWrapperId }));
      this.host.assertCurrentOperation(operation);
      // Read below, during the rotation, to tell peer tabs the new epoch.
      const app = this.host.closest("kin-app");
      this.host.services.notifyPeerLock(source.securityEpoch + 1);
      this.host.services.lockHousehold(false, { preserveSecurityOperation: true });
      this.host.phase = "protecting";
      this.host.render();
      engine = await loadKinEngine();
      this.host.assertCurrentOperation(operation);
      await EventStore.rotateProtection({ sourceVault: source, candidateVault: candidate, engine,
        prepareKeys: prepareRootRotationKeys, commitKeys: commitRootRotationKeys,
        onPhase: async (phase) => {
          this.host.assertCurrentOperation(operation);
          if (phase === "begun") {
            const status = await EventStore.securityStatus();
            this.host.assertCurrentOperation(operation);
            this.host.manifest = status;
            app.channel?.postMessage({ type: "household-locked", lockEpoch: status.lockEpoch });
          }
        },
      });
      this.host.assertCurrentOperation(operation);
      const [label] = await manifestRecoveryLabels(candidate.manifest);
      await this.ctx.unlock.finishUnlock(candidate, operation);
      this.host.message.textContent = `Backup key replaced. Use your new backup key${label ? ` (${label})` : ""} and add passkey unlock again if needed.`;
    } catch (error) {
      candidate?.lock();
      if (operation === this.host.operation) this.host.phase = "locked";
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      source.lock();
      engine?.dispose();
    }
  }

  async establishProtection(secret, { recoveryWrapperId } = {}) {
    const operation = this.host.operation;
    const { vault, manifest } = await LocalVault.create(secret, { recoveryWrapperId });
    try {
      this.host.assertCurrentOperation(operation);
      await EventStore.prepareSecurity(manifest);
      this.host.assertCurrentOperation(operation);
      const current = await EventStore.securityStatus();
      this.host.assertCurrentOperation(operation);
      this.host.manifest = current;
      // The unlocked shell offers passkey unlock as the next step (#577).
      this.host.justSetUp = true;
      await this.ctx.unlock.finishUnlock(vault, operation);
    } catch (error) { this.host.justSetUp = false; vault.lock(); throw error; }
  }

  async addPasskey() {
    const operation = this.host.operation;
    const vault = getActiveVault();
    const { secret, credentialId, prfSalt } = await authenticatePrf(null, {
      signal: this.host.operationAbort.signal,
    });
    try {
      this.host.assertCurrentOperation(operation);
      const manifest = await vault.addCredentialWrapper(secret, { credentialId, prfSalt });
      this.host.assertCurrentOperation(operation);
      await EventStore.updateSecurityManifest(manifest, vault);
      this.host.assertCurrentOperation(operation);
      const current = await EventStore.securityStatus();
      this.host.assertCurrentOperation(operation);
      this.host.manifest = current;
      if (this.host.phase === "unlocked") this.host.render();
      const types = new Set((current?.wrappers ?? []).map((wrapper) => wrapper.type));
      this.host.message.textContent = `Passkey unlock is on for this device.${types.has("recovery") ? " Your backup key still works if you need it." : types.has("password") ? " Your password still works too." : ""}`;
      this.host.dispatchEvent(new CustomEvent("kin:security-changed", { bubbles: true, composed: true }));
    } finally { secret.fill(0); }
  }
}
