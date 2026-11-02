// Unlocking with the backup (recovery) key or a passkey, and the shared steps that
// open the household once the vault is unlocked.
// Part of <kin-security>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-security.js lists them).
import { LocalVault, setActiveVault, toBase64Url, VaultError } from "../../security/local-vault.js";
import { authenticatePrf } from "../../security/passkey-unlock.js";
import { currentPasswordParameters, keysUnder, passwordChangedElsewhere, passwordUnlockKeys, passwordWrapper } from "../../security/account-setup.js";
import { EventStore } from "../../storage/event-store.js";
import { commitRootRotationKeys, finalizeSyncKeyMigration, migrateSyncKeys, prepareRootRotationKeys } from "../../sync/key-store.js";
import { loadKinEngine } from "../../wasm/kin-engine.js";

/**
 * Signs this trusted device in with the member's username and authKey
 * (POST /api/login/password). Best effort: offline, or with a device the
 * service no longer knows, the local unlock still stands and the household
 * panel explains what's missing.
 */
export async function signInWithPassword(username, authKey, signal) {
  if (!username) return false;
  try {
    const response = await fetch("/api/login/password", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal,
      body: JSON.stringify({ username, authKey: toBase64Url(authKey) }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class SecurityUnlock {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  async unlockRecovery(secret) {
    const operation = this.host.operation;
    await this.host.closest("kin-app")?.lockBarrier;
    this.host.assertCurrentOperation(operation);
    const manifest = await EventStore.securityStatus();
    this.host.assertCurrentOperation(operation);
    const unlockManifest = manifest?.phase === "root-rotating" ? manifest.rotation.candidateManifest : manifest;
    const vault = await LocalVault.unlock(unlockManifest, secret);
    await this.finishUnlock(vault, operation);
  }

  /**
   * Unlocks with the password (#558): one PBKDF2 run on this device gives
   * the local wrapper's key (works offline) and the authKey that also signs
   * this device in, so household actions don't ask again. A wrong password
   * gets one calm message; the form stays.
   *
   * A password changed on another device (#560 follow-up): this device's
   * wrapper still opens with the previous one. Online, the service's
   * current parameters say so, and then:
   * - the previous password opened it: Kin asks for the new one before
   *   opening (unlockNewPassword), and switches this device to it;
   * - the new password was typed: it signs in, and Kin asks once for the
   *   previous one, which this device still needs to open its storage, then
   *   switches. Offline, the previous password keeps working (THREAT-MODEL,
   *   "A password changed on another device").
   */
  async unlockPassword(password) {
    const operation = this.host.operation;
    const signal = this.host.operationAbort.signal;
    await this.host.closest("kin-app")?.lockBarrier;
    this.host.assertCurrentOperation(operation);
    const manifest = await EventStore.securityStatus();
    this.host.assertCurrentOperation(operation);
    const wrapper = passwordWrapper(manifest);
    const pending = this.host.passwordChange?.keys ? this.host.passwordChange : null;
    this.host.message.textContent = "Checking your password…";
    const keys = await passwordUnlockKeys(wrapper, password);
    let vault;
    try {
      this.host.assertCurrentOperation(operation);
      vault = await LocalVault.unlock(manifest, keys.localKek, wrapper.id);
    } catch (error) {
      this.host.message.textContent = "";
      keys.authKey.fill(0);
      if (error?.code !== "unlock_failed") throw error;
      // Perhaps the new password, from another device.
      const fresh = pending ? null : await this.newPasswordFromElsewhere(wrapper, password, signal);
      this.host.assertCurrentOperation(operation);
      if (fresh) {
        this.host.passwordChange = { keys: fresh, username: wrapper.username };
        this.host.render();
        this.host.message.textContent = "That's your new password, and it signed you in. This device still opens with your previous password: enter it once more, and Kin switches this device to the new one.";
        return;
      }
      throw new VaultError(pending
        ? "That isn't your previous password. This device needs it once to switch to your new password."
        : "That password didn't work. Check it and try again.", "unlock_failed", error);
    } finally {
      keys.localKek.fill(0);
      keys.passwordKey.fill(0);
    }
    if (pending) {
      // The previous password opened it; the new one already signed in.
      keys.authKey.fill(0);
      this.host.passwordChange = null;
      await this.finishUnlock(vault, operation);
      await this.adoptNewPassword(vault, pending.keys, wrapper.username);
      return;
    }
    const parameters = await currentPasswordParameters(wrapper.username, { signal });
    this.host.assertCurrentOperation(operation);
    if (passwordChangedElsewhere(wrapper, parameters)) {
      keys.authKey.fill(0);
      this.host.passwordChange = { vault, parameters, username: wrapper.username };
      this.host.render();
      return;
    }
    try {
      await signInWithPassword(wrapper.username, keys.authKey, signal);
    } finally {
      keys.authKey.fill(0);
    }
    await this.finishUnlock(vault, operation);
  }

  /** The new password's keys when `password` is the account's current one
   * (it signs in) and not this device's: `{ localKek, salt, iterations }`,
   * or null. */
  async newPasswordFromElsewhere(wrapper, password, signal) {
    const parameters = await currentPasswordParameters(wrapper.username, { signal });
    if (!passwordChangedElsewhere(wrapper, parameters)) return null;
    const keys = await keysUnder(parameters, password);
    let signedIn = false;
    try {
      signedIn = await signInWithPassword(wrapper.username, keys.authKey, signal);
    } finally {
      keys.authKey.fill(0);
      keys.passwordKey.fill(0);
    }
    if (!signedIn) { keys.localKek.fill(0); return null; }
    return { localKek: keys.localKek, salt: parameters.salt, iterations: parameters.iterations };
  }

  /**
   * After the previous password opened this device and the service said the
   * password changed: the new password, which must sign in, then this
   * device's wrapper follows it.
   */
  async unlockNewPassword(password) {
    const operation = this.host.operation;
    const signal = this.host.operationAbort.signal;
    const pending = this.host.passwordChange;
    if (!pending?.vault) throw new VaultError("Unlock with your password first.", "unlock_failed");
    this.host.message.textContent = "Checking your new password…";
    const keys = await keysUnder(pending.parameters, password);
    try {
      this.host.assertCurrentOperation(operation);
      if (!await signInWithPassword(pending.username, keys.authKey, signal)) {
        this.host.message.textContent = "";
        throw new VaultError("That isn't your new password. Check it and try again.", "password_rejected");
      }
      this.host.assertCurrentOperation(operation);
    } catch (error) {
      keys.localKek.fill(0);
      throw error;
    } finally {
      keys.authKey.fill(0);
      keys.passwordKey.fill(0);
    }
    this.host.passwordChange = null;
    await this.finishUnlock(pending.vault, operation);
    await this.adoptNewPassword(pending.vault, keys, pending.username);
  }

  /** Re-wraps this (unlocked) device's password wrapper under the new
   * password; zeroes `keys.localKek`. A failure leaves the old wrapper, and
   * the next online unlock asks again. */
  async adoptNewPassword(vault, keys, username) {
    try {
      const manifest = await vault.replacePasswordWrapper(keys.localKek, { salt: keys.salt, iterations: keys.iterations, username });
      await EventStore.updateSecurityManifest(manifest, vault);
      this.host.manifest = await EventStore.securityStatus();
      this.host.message.textContent = "Your new password unlocks Kin on this device from now on.";
    } catch {
      this.host.message.textContent = "Kin couldn't switch this device to your new password yet. It will ask again next time you unlock.";
    } finally {
      keys.localKek.fill(0);
    }
  }

  /** Locks a vault the previous password opened while the new one was asked
   * for, and forgets pending keys (Cancel, or the panel locking). */
  cancelPasswordChange() {
    const pending = this.host.passwordChange;
    this.host.passwordChange = null;
    pending?.vault?.lock();
    pending?.keys?.localKek?.fill(0);
  }

  async unlockPasskey(wrapper) {
    const operation = this.host.operation;
    const signal = this.host.operationAbort.signal;
    let secret;
    try {
      ({ secret } = await authenticatePrf(wrapper, { signal }));
    } catch (error) {
      // After a failed or unsupported passkey attempt the recovery form must be
      // directly reachable; the re-render after this error reads the flag.
      this.host.recoveryExpanded = true;
      throw error;
    }
    try {
      await this.host.closest("kin-app")?.lockBarrier;
      this.host.assertCurrentOperation(operation);
      const manifest = await EventStore.securityStatus();
      this.host.assertCurrentOperation(operation);
      const vault = await LocalVault.unlock(manifest, secret, wrapper.id);
      await this.finishUnlock(vault, operation);
    } catch (error) {
      this.host.recoveryExpanded = true;
      throw error;
    } finally { secret.fill(0); }
  }

  /** Reopens the household after a refresh with the root a reload-resume
   * ticket returned (#351). A failure just leaves the ordinary lock screen. */
  async resumeAfterReload({ root, manifest }) {
    const operation = this.host.operation;
    let vault = null;
    try {
      await this.host.closest("kin-app")?.lockBarrier;
      this.host.assertCurrentOperation(operation);
      this.host.message.textContent = "Reopening your household…";
      vault = new LocalVault(manifest.vaultId, root, manifest);
    } catch {
      return;
    } finally { root.fill(0); }
    try { await this.finishUnlock(vault, operation); }
    catch {
      if (operation === this.host.operation) this.host.message.textContent = "";
    }
  }

  async finishUnlock(vault, operation) {
    try {
      await this.host.closest("kin-app")?.lockBarrier;
      this.host.assertCurrentOperation(operation);
      setActiveVault(vault);
      this.host.message.textContent = "Unlocking and verifying household data…";
      const status = await EventStore.securityStatus();
      this.host.assertCurrentOperation(operation);
      vault.assertUnlocked();
      if (["root-rotating", "root-cleanup"].includes(status.phase)) {
        this.host.message.textContent = "Finishing the backup key replacement…";
        const engine = await loadKinEngine();
        try {
          this.host.assertCurrentOperation(operation);
          await EventStore.resumeRotation({ candidateVault: vault, engine,
            prepareKeys: prepareRootRotationKeys, commitKeys: commitRootRotationKeys,
            onPhase: () => this.host.assertCurrentOperation(operation),
          });
        } finally { engine.dispose(); }
      } else if (status.phase !== "encrypted") {
        this.host.message.textContent = "Encrypting and verifying saved information. Keep this tab open.";
        const engine = await loadKinEngine();
        try {
          this.host.assertCurrentOperation(operation);
          await EventStore.migrate({ vault, engine,
            prepareKeys: (current, options) => migrateSyncKeys(current, { ...options, prepareOnly: true }),
            finalizeKeys: (current) => finalizeSyncKeyMigration(current),
          });
        } finally { engine.dispose(); }
      }
      vault.assertUnlocked();
      this.host.assertCurrentOperation(operation);
      const manifest = await EventStore.securityStatus();
      this.host.assertCurrentOperation(operation);
      vault.assertUnlocked();
      this.host.manifest = manifest;
      this.host.phase = "unlocked";
      this.host.recoveryExpanded = false;
      this.host.render();
      await this.host.onUnlocked?.(vault);
      this.host.assertCurrentOperation(operation);
    } catch (error) {
      vault.lock();
      // Revoking this result is always required. Only its current operation may
      // update the panel; a later unlock can already own the visible household.
      if (operation === this.host.operation) {
        const manifest = await EventStore.securityStatus().catch(() => this.host.manifest);
        if (operation === this.host.operation) {
          this.host.manifest = manifest;
          this.host.phase = "locked";
          this.host.render();
        }
      }
      throw error;
    }
  }
}
