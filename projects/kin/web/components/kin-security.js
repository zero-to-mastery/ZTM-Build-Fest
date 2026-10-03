import { LocalVault, getActiveVault, setActiveVault, randomRecoverySecret } from "../security/local-vault.js";
import { authenticatePrf } from "../security/passkey-unlock.js";
import { EventStore } from "../storage/event-store.js";
import { migrateSyncKeys, finalizeSyncKeyMigration, prepareRootRotationKeys, commitRootRotationKeys } from "../sync/key-store.js";
import { loadKinEngine } from "../wasm/kin-engine.js";
import { exportHouseholdArchive, importHouseholdArchive } from "../security/archive.js";

export function clearLegacyDrafts() {
  for (const key of ["kin.compose.draft", "kin.compose.classification", "kin.handoff.draft", "kin.talk.draft", "kin.routine.draft"]) {
    try { sessionStorage.removeItem(key); } catch { /* No fallback persistence. */ }
  }
}

class KinSecurity extends HTMLElement {
  constructor() {
    super();
    this.phase = "locked";
    this.manifest = null;
    this.busy = false;
    this.operation = 0;
    this.operationAbort = new AbortController();
    this.onUnlocked = null;
    this.onLockRequested = null;
  }

  async initialize() {
    const operation = this.operation;
    clearLegacyDrafts();
    try {
      const manifest = await EventStore.securityStatus();
      if (operation !== this.operation) return;
      this.manifest = manifest;
      this.render();
    } catch (error) {
      if (operation === this.operation) { this.render(); this.error(error); }
    }
  }

  render() {
    this.replaceChildren();
    this.className = "security-panel";
    const heading = document.createElement("h2");
    heading.tabIndex = -1;
    heading.textContent = this.phase === "unlocked" ? "Household unlocked" : this.manifest ? "Household locked" : "Protect this household";
    this.heading = heading;
    this.append(heading);
    this.message = document.createElement("p");
    this.message.setAttribute("role", "status");
    this.message.setAttribute("aria-live", "polite");
    this.alert = document.createElement("p");
    this.alert.setAttribute("role", "alert");
    this.alert.className = "error-message";
    this.append(this.message, this.alert);
    if (this.phase === "protecting") {
      this.message.textContent = "Protecting household… Keep this tab open.";
      this.button("Lock household", () => this.onLockRequested?.());
      return;
    }
    if (this.phase === "unlocked") {
      this.text("Household data is encrypted in this browser. Drafts last only while unlocked.");
      this.button("Lock household", () => this.onLockRequested?.());
      this.button("Add passkey unlock", () => this.run(() => this.addPasskey()));
      this.button("Replace recovery protection", () => this.showReplacement());
      for (const wrapper of this.manifest?.wrappers ?? []) {
        if (wrapper.type !== "prf") continue;
        this.button("Remove passkey unlock", () => this.run(async (operation) => {
          if (!confirm("Remove this local passkey unlock path? Your recovery key will still work. Previously copied keys cannot be recalled.")) return;
          const vault = getActiveVault();
          const manifest = vault.removeWrapper(wrapper.id);
          await EventStore.updateSecurityManifest(manifest, vault);
          this.assertCurrentOperation(operation);
          const current = await EventStore.securityStatus();
          this.assertCurrentOperation(operation);
          this.manifest = current;
          this.onLockRequested?.();
        }));
      }
      this.button("Download encrypted backup", () => this.run(() => this.downloadArchive()));
      this.button("Restore encrypted backup", () => this.showRestore());
      if (navigator.storage?.persist) this.button("Request persistent storage", () => this.run(async (operation) => {
        const granted = await navigator.storage.persist();
        this.assertCurrentOperation(operation);
        this.message.textContent = granted ? "This browser granted persistent storage. Keep encrypted backups too." : "Persistent storage was not granted. Keep encrypted backups to protect against browser data loss.";
      }));
      this.text("A backup preserves household history. Keep its recovery key separately. Restore uses an empty household and does not restore device trust.");
      return;
    }
    if (!this.manifest) {
      this.text("Save a recovery key outside this browser before encrypting your household. Existing information is preserved until migration is verified. Close other old Kin tabs first.");
      this.button("Create recovery key", () => this.showSetup());
      return;
    }
    const rotating = ["root-rotating", "root-cleanup"].includes(this.manifest.phase);
    if (rotating)
      this.text("Recovery protection is being replaced. Enter the new recovery key you saved to resume safely.");
    else if (this.manifest.phase !== "encrypted")
      this.text("Security setup is incomplete. Unlock to resume migration. Existing legacy data is not yet fully protected.");
    else this.text("Unlock with an authorized passkey or the household recovery key. Reloading always locks Kin.");
    for (const wrapper of rotating ? [] : this.manifest.wrappers ?? []) {
      if (wrapper.type === "prf") this.button("Unlock with passkey", () => this.run(() => this.unlockPasskey(wrapper)));
    }
    const form = document.createElement("form");
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "password";
    input.id = "recovery-unlock";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.required = true;
    label.htmlFor = input.id;
    label.textContent = "Recovery key";
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Unlock with recovery key";
    form.append(label, input, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const secret = input.value;
      input.value = "";
      void this.run(() => this.unlockRecovery(secret));
    });
    this.append(form);
  }

  showSetup() {
    if (this.busy) return;
    const secret = randomRecoverySecret();
    this.render();
    this.text("Keep this key somewhere safe outside Kin. Anyone with it can unlock the household. If all unlock paths are lost, Kin cannot recover the data.");
    const output = document.createElement("code");
    output.textContent = secret;
    output.className = "recovery-key";
    const form = document.createElement("form");
    const label = document.createElement("label");
    const confirmation = document.createElement("input");
    confirmation.type = "password";
    confirmation.id = "confirm-recovery";
    confirmation.autocomplete = "off";
    confirmation.required = true;
    label.htmlFor = confirmation.id;
    label.textContent = "Re-enter the saved recovery key";
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Encrypt household";
    form.append(label, confirmation, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (confirmation.value.trim() !== secret) return this.error(new Error("The recovery keys do not match. Save and re-enter the complete key."));
      confirmation.value = "";
      output.textContent = "";
      void this.run(() => this.establishProtection(secret));
    });
    this.append(output, form);
    confirmation.focus();
  }

  showReplacement() {
    if (this.busy || this.phase !== "unlocked") return;
    const secret = randomRecoverySecret();
    this.render();
    this.text("Save this new recovery key outside Kin. It replaces your current recovery key for this browser. Add passkey unlock again afterward. Old backups still need their original recovery keys.");
    const output = document.createElement("code");
    output.className = "recovery-key";
    output.textContent = secret;
    const form = document.createElement("form");
    const label = document.createElement("label");
    label.htmlFor = "confirm-replacement";
    label.textContent = "Re-enter the saved new recovery key";
    const confirmation = document.createElement("input");
    confirmation.id = label.htmlFor;
    confirmation.type = "password";
    confirmation.autocomplete = "off";
    confirmation.spellcheck = false;
    confirmation.required = true;
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Confirm saved key";
    form.append(label, confirmation, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (confirmation.value.trim() !== secret)
        return this.error(new Error("The recovery keys do not match. Save and re-enter the complete new key."));
      confirmation.value = "";
      output.textContent = "";
      void this.run(() => this.replaceProtection(secret));
    });
    this.append(output, form);
    confirmation.focus();
  }

  async replaceProtection(secret) {
    const operation = this.operation;
    const signal = this.operationAbort.signal;
    const active = getActiveVault();
    await EventStore.checkSecurityEpoch(active);
    this.assertCurrentOperation(operation);
    // The operation owns these capabilities; clearing the application disposes
    // its event/sync adapters and projection before rotation fences peer tabs.
    const source = new LocalVault(active.vaultId, active.root, active.manifest);
    source.securityEpoch = active.securityEpoch;
    let candidate, engine;
    const cancel = () => { source.lock(); candidate?.lock(); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      ({ vault: candidate } = await LocalVault.createRotation(source, secret));
      this.assertCurrentOperation(operation);
      const app = this.closest("kin-app");
      app.notifyPeerLock(source.securityEpoch + 1);
      app.lockHousehold(false, { preserveSecurityOperation: true });
      this.phase = "protecting";
      this.render();
      engine = await loadKinEngine();
      this.assertCurrentOperation(operation);
      await EventStore.rotateProtection({ sourceVault: source, candidateVault: candidate, engine,
        prepareKeys: prepareRootRotationKeys, commitKeys: commitRootRotationKeys,
        onPhase: async (phase) => {
          this.assertCurrentOperation(operation);
          if (phase === "begun") {
            const status = await EventStore.securityStatus();
            this.assertCurrentOperation(operation);
            this.manifest = status;
            app.channel?.postMessage({ type: "household-locked", lockEpoch: status.lockEpoch });
          }
        },
      });
      this.assertCurrentOperation(operation);
      await this.finishUnlock(candidate, operation);
      this.message.textContent = "Recovery protection updated. Use your new recovery key and add passkey unlock again if needed.";
    } catch (error) {
      candidate?.lock();
      if (operation === this.operation) this.phase = "locked";
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      source.lock();
      engine?.dispose();
    }
  }

  async establishProtection(secret) {
    const operation = this.operation;
    const { vault, manifest } = await LocalVault.create(secret);
    try {
      this.assertCurrentOperation(operation);
      await EventStore.prepareSecurity(manifest);
      this.assertCurrentOperation(operation);
      const current = await EventStore.securityStatus();
      this.assertCurrentOperation(operation);
      this.manifest = current;
      await this.finishUnlock(vault, operation);
    } catch (error) { vault.lock(); throw error; }
  }

  async unlockRecovery(secret) {
    const operation = this.operation;
    await this.closest("kin-app")?.lockBarrier;
    this.assertCurrentOperation(operation);
    const manifest = await EventStore.securityStatus();
    this.assertCurrentOperation(operation);
    const unlockManifest = manifest?.phase === "root-rotating" ? manifest.rotation.candidateManifest : manifest;
    const vault = await LocalVault.unlock(unlockManifest, secret);
    await this.finishUnlock(vault, operation);
  }

  async unlockPasskey(wrapper) {
    const operation = this.operation;
    const signal = this.operationAbort.signal;
    const { secret } = await authenticatePrf(wrapper, { signal });
    try {
      await this.closest("kin-app")?.lockBarrier;
      this.assertCurrentOperation(operation);
      const manifest = await EventStore.securityStatus();
      this.assertCurrentOperation(operation);
      const vault = await LocalVault.unlock(manifest, secret, wrapper.id);
      await this.finishUnlock(vault, operation);
    } finally { secret.fill(0); }
  }

  async finishUnlock(vault, operation) {
    try {
      await this.closest("kin-app")?.lockBarrier;
      this.assertCurrentOperation(operation);
      setActiveVault(vault);
      this.message.textContent = "Unlocking and verifying household data…";
      const status = await EventStore.securityStatus();
      this.assertCurrentOperation(operation);
      vault.assertUnlocked();
      if (["root-rotating", "root-cleanup"].includes(status.phase)) {
        this.message.textContent = "Resuming recovery protection…";
        const engine = await loadKinEngine();
        try {
          this.assertCurrentOperation(operation);
          await EventStore.resumeRotation({ candidateVault: vault, engine,
            prepareKeys: prepareRootRotationKeys, commitKeys: commitRootRotationKeys,
            onPhase: () => this.assertCurrentOperation(operation),
          });
        } finally { engine.dispose(); }
      } else if (status.phase !== "encrypted") {
        this.message.textContent = "Encrypting and verifying saved information. Keep this tab open.";
        const engine = await loadKinEngine();
        try {
          this.assertCurrentOperation(operation);
          await EventStore.migrate({ vault, engine,
            prepareKeys: (current, options) => migrateSyncKeys(current, { ...options, prepareOnly: true }),
            finalizeKeys: (current) => finalizeSyncKeyMigration(current),
          });
        } finally { engine.dispose(); }
      }
      vault.assertUnlocked();
      this.assertCurrentOperation(operation);
      const manifest = await EventStore.securityStatus();
      this.assertCurrentOperation(operation);
      vault.assertUnlocked();
      this.manifest = manifest;
      this.phase = "unlocked";
      this.render();
      await this.onUnlocked?.(vault);
      this.assertCurrentOperation(operation);
    } catch (error) {
      vault.lock();
      // Revoking this result is always required. Only its current operation may
      // update the panel; a later unlock can already own the visible household.
      if (operation === this.operation) {
        const manifest = await EventStore.securityStatus().catch(() => this.manifest);
        if (operation === this.operation) {
          this.manifest = manifest;
          this.phase = "locked";
          this.render();
        }
      }
      throw error;
    }
  }

  async addPasskey() {
    const operation = this.operation;
    const vault = getActiveVault();
    const { secret, credentialId, prfSalt } = await authenticatePrf(null, {
      signal: this.operationAbort.signal,
    });
    try {
      this.assertCurrentOperation(operation);
      const manifest = await vault.addCredentialWrapper(secret, { credentialId, prfSalt });
      this.assertCurrentOperation(operation);
      await EventStore.updateSecurityManifest(manifest, vault);
      this.assertCurrentOperation(operation);
      const current = await EventStore.securityStatus();
      this.assertCurrentOperation(operation);
      this.manifest = current;
      this.message.textContent = "Passkey unlock added. Your recovery key still works.";
    } finally { secret.fill(0); }
  }

  async downloadArchive() {
    const operation = this.operation;
    const app = this.closest("kin-app");
    const bytes = await exportHouseholdArchive({ store: app.store, engine: app.engine, vault: getActiveVault() });
    this.assertCurrentOperation(operation);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "kin-household.kin";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.message.textContent = "Encrypted backup prepared. Keep it and its recovery key safe.";
  }

  showRestore() {
    if (this.busy) return;
    this.render();
    const form = document.createElement("form");
    const file = document.createElement("input");
    file.id = "archive-file"; file.type = "file"; file.accept = ".kin"; file.required = true;
    const fileLabel = document.createElement("label"); fileLabel.htmlFor = file.id; fileLabel.textContent = "Encrypted Kin backup";
    const recovery = document.createElement("input");
    recovery.id = "archive-recovery"; recovery.type = "password"; recovery.autocomplete = "off"; recovery.required = true;
    const recoveryLabel = document.createElement("label"); recoveryLabel.htmlFor = recovery.id; recoveryLabel.textContent = "Backup recovery key";
    const confirmLabel = document.createElement("label");
    const confirmation = document.createElement("input"); confirmation.type = "checkbox"; confirmation.required = true;
    confirmLabel.append(confirmation, document.createTextNode(" Restore into this empty local household. Device trust and sync access will not be restored."));
    const button = document.createElement("button"); button.type = "submit"; button.textContent = "Verify and restore";
    form.append(fileLabel, file, recoveryLabel, recovery, confirmLabel, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = file.files[0]; const secret = recovery.value; recovery.value = "";
      void this.run(async (operation) => {
        if (!selected || selected.size > 64 * 1024 * 1024) throw new Error("Choose a Kin archive smaller than 64 MiB.");
        const app = this.closest("kin-app");
        const engine = app.engine, vault = getActiveVault();
        const bytes = new Uint8Array(await selected.arrayBuffer());
        this.assertCurrentOperation(operation);
        await importHouseholdArchive({ bytes, recoverySecret: secret, engine, vault });
        this.assertCurrentOperation(operation);
        await app.refreshFromEvents();
        this.assertCurrentOperation(operation);
        app.broadcastEventChange();
        this.render();
        this.message.textContent = "Household history restored locally. Device trust has not been restored.";
      });
    });
    this.append(form); file.focus();
  }

  locked() {
    this.operation++;
    this.operationAbort.abort();
    this.operationAbort = new AbortController();
    this.phase = "locked";
    this.busy = false;
    this.setAttribute("aria-busy", "false");
    clearLegacyDrafts();
    this.render();
    this.heading.focus();
  }

  async run(action) {
    if (this.busy) return;
    const operation = ++this.operation;
    this.busy = true;
    this.setAttribute("aria-busy", "true");
    this.alert.textContent = "";
    for (const element of this.querySelectorAll("button,input")) element.disabled = true;
    try { await action(operation); }
    catch (error) {
      if (operation !== this.operation) return;
      if (this.phase !== "unlocked") {
        const manifest = await EventStore.securityStatus().catch(() => this.manifest);
        if (operation !== this.operation) return;
        this.manifest = manifest;
        this.render();
      }
      this.error(error);
    } finally {
      if (operation === this.operation) {
        this.busy = false;
        this.setAttribute("aria-busy", "false");
        for (const element of this.querySelectorAll("button,input")) element.disabled = false;
      }
    }
  }

  assertCurrentOperation(operation) {
    if (operation !== this.operation) throw new Error("This security operation was cancelled.");
  }

  error(error) {
    this.alert.textContent = ["AbortError", "NotAllowedError"].includes(error.name)
      ? "Authentication was cancelled or the credential was unavailable. Your saved data was not changed."
      : error.userMessage ?? error.message ?? "Kin could not complete security setup.";
  }
  text(value) { const p = document.createElement("p"); p.textContent = value; this.append(p); }
  button(label, action) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = label;
    button.addEventListener("click", action); this.append(button);
  }
}

customElements.define("kin-security", KinSecurity);
