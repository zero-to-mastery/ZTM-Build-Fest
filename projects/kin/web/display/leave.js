// Leaving kitchen display mode (#670, ADR 0022 §4), and changing a child's
// reward there (#705), need the adult whose device it is: their password
// or their passkey, checked on this device
// against the same unlock paths that open Kin here, so it works offline and
// for a household that doesn't sync. Proving it is opening this device's
// vault once more with that secret; the copy that opens is locked again at
// once and nothing is kept.
//
// A device set up before accounts unlocks with its backup key only; there
// the backup key is what leaving asks for, as unlocking does.
//
// askAdult is the one way the display asks (leave and rewards alike): it
// reads this device's unlock manifest, offers the methods it has, and
// resolves true only once one of them opened the vault. Cancelling, or a
// device with no way to confirm, resolves false: the caller writes nothing.
import { LocalVault } from "../security/local-vault.js";
import { authenticatePrf } from "../security/passkey-unlock.js";
import { passwordUnlockKeys, passwordWrapper } from "../security/account-setup.js";

/** The manifest that opens this device now (mid key replacement, the new
 * one, as unlocking uses). */
export function unlockManifest(manifest) {
  return manifest?.phase === "root-rotating" ? manifest.rotation?.candidateManifest ?? manifest : manifest;
}

/**
 * The ways this device's owner can confirm, in the order offered:
 * "passkey" (a passkey wrapper), "password" (a password wrapper), and
 * "backup-key" only when neither exists.
 */
export function leaveMethods(manifest) {
  const wrappers = unlockManifest(manifest)?.wrappers ?? [];
  const methods = [];
  if (wrappers.some((wrapper) => wrapper?.type === "prf")) methods.push("passkey");
  if (wrappers.some((wrapper) => wrapper?.type === "password")) methods.push("password");
  if (!methods.length && wrappers.some((wrapper) => wrapper?.type === "recovery")) methods.push("backup-key");
  return methods;
}

/** "your passkey or password", for the dialog's lead. */
export function methodsText(methods) {
  const words = { passkey: "your passkey", password: "your password", "backup-key": "this household's backup key" };
  const named = methods.map((method) => words[method]).filter(Boolean);
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} or ${named.at(-1)}` : named[0] ?? "";
}

/**
 * Checks the owner's secret against `manifest` (EventStore.securityStatus()).
 * `method` is one of leaveMethods; `secret` is the typed password or backup
 * key (the passkey asks the authenticator itself). Resolves true, or throws
 * a VaultError (wrong secret: code "unlock_failed"; a cancelled passkey:
 * NotAllowedError). `vaultId`, when given, must be the vault this device
 * has open.
 */
export async function confirmOwner({ manifest, method, secret = null, vaultId = null, signal } = {},
  { unlock = (...args) => LocalVault.unlock(...args), prf = authenticatePrf, passwordKeys = passwordUnlockKeys } = {}) {
  const opened = unlockManifest(manifest);
  if (!opened || (vaultId && opened.vaultId !== vaultId)) throw Object.assign(new Error("This isn't the household open on this device."), { code: "wrong_vault" });
  let vault = null;
  if (method === "password") {
    const wrapper = passwordWrapper(opened);
    const keys = await passwordKeys(wrapper, secret);
    try {
      vault = await unlock(opened, keys.localKek, wrapper.id);
    } finally {
      keys.localKek?.fill?.(0);
      keys.authKey?.fill?.(0);
      keys.passwordKey?.fill?.(0);
    }
  } else if (method === "passkey") {
    const wrappers = opened.wrappers.filter((wrapper) => wrapper?.type === "prf");
    let lastError = null;
    for (const wrapper of wrappers) {
      let result = null;
      try {
        result = await prf(wrapper, { signal });
        vault = await unlock(opened, result.secret, wrapper.id);
        break;
      } catch (error) {
        lastError = error;
        if (error?.name === "NotAllowedError" || error?.name === "AbortError") throw error;
      } finally {
        result?.secret?.fill?.(0);
      }
    }
    if (!vault) throw lastError ?? Object.assign(new Error("No passkey opens this device."), { code: "unlock_failed" });
  } else if (method === "backup-key") {
    vault = await unlock(opened, secret);
  } else {
    throw Object.assign(new Error("Choose how to confirm."), { code: "unlock_failed" });
  }
  // Only proof was wanted: the copy that opened is closed again.
  vault?.lock?.();
  return true;
}

/**
 * What each check says (#705): `title`, `lead` (followed by the methods),
 * `none` (when the device has no way to confirm), `stay` (the cancel
 * button) and `canceled` (a cancelled passkey). Leaving display mode, and a
 * child's reward (saving, removing, or Undo and Redo of one) on the display.
 */
export const ADULT_CHECKS = Object.freeze({
  leave: Object.freeze({
    title: "Leave kitchen display",
    lead: "Only the adult this device belongs to can leave.",
    none: "This device has no way to confirm who you are, so it can't leave display mode here.",
    stay: "Stay in display mode",
    canceled: "Canceled. Kin is still a kitchen display.",
  }),
  reward: Object.freeze({
    title: "Change a reward",
    lead: "Only the adult this device belongs to can change a child's reward.",
    none: "This device has no way to confirm who you are, so rewards can't be changed here.",
    stay: "Don't change it",
    canceled: "Canceled. The reward wasn't changed.",
  }),
});

/**
 * Asks the device's adult to confirm `purpose` (a key of ADULT_CHECKS).
 * `readManifest()` resolves EventStore.securityStatus(); `ask(options)`
 * shows the dialog (components/display/leave-dialog.js askAdultDialog) with
 * { ...ADULT_CHECKS[purpose], methods, check } and resolves whether it was
 * confirmed. `confirm` is confirmOwner (a test's stand-in otherwise).
 * Resolves true only when a method opened this device's vault.
 */
export async function askAdult(purpose, { readManifest, vaultId = null, ask, confirm = confirmOwner } = {}) {
  const text = ADULT_CHECKS[purpose];
  if (!text || typeof ask !== "function") return false;
  let manifest;
  try { manifest = await readManifest(); } catch { manifest = null; }
  const methods = leaveMethods(manifest);
  const confirmed = await ask({ ...text, purpose, methods, check: (method, secret) => confirm({ manifest, method, secret, vaultId }) });
  return confirmed === true && methods.length > 0;
}
