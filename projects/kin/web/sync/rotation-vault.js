// A household key rotation and the account vault in one step (#791, ADR
// 0018).
//
// The device that commits a rotation is, until its vault keeper runs, the
// only holder of the new household key. If it is lost or reset in that
// window, signing in on another device with a backup code, a password or a
// passkey downloads a vault without that key, and sync stays paused. So the
// committing device sends its own vault, re-sealed with the proposal's key,
// in the same request (POST /api/sync/epochs `vaultChange`), and the service
// stores both or neither.
//
// The vault only ever receives the key of the exact proposal this request
// commits: a proposal that loses (stale_key_epoch) rolls its vault change
// back with it, so the vault never holds a wrong key for an epoch. On a
// vault conflict (another device or tab wrote the vault first) the change is
// rebuilt from a fresh download and the same proposal is sent again, which is
// safe until it commits. When the vault can't be part of it (no vault key on
// this device, no vault, a vault this key doesn't open, a full write window,
// a server that doesn't take it), the rotation is committed as before and the
// keeper adds the key after it is installed.
import { recordDiagnostic } from "../diagnostics/ring-buffer.js";
import { AccountVaultError, wipeVaultContents } from "../security/account-vault.js";
import { sealVaultUpdate, vaultApi } from "../security/account-vault-sync.js";
import { toBase64Url } from "../security/local-vault.js";
import { exportStoredEpochKey } from "./crypto.js";

/** Requests that carry the vault change, at most, before committing without it. */
export const ROTATION_VAULT_ATTEMPTS = 3;

/** Refusals of the vault change that leave the rotation itself uncommitted:
 * the rotation is then sent once without it. */
const FALLBACKS = new Set(["vault_version_conflict", "vault_not_found", "vault_rate_limited", "vault_invalid", "request_too_large"]);

/** Download errors that stop the pass, as they would on the commit itself:
 * the connection, this device's request budget, a locked device, and a
 * session or household that is gone. Any other download trouble skips the
 * vault change rather than holding up household sync. */
const PASS_STOPS = new Set([
  "connection_unavailable", "timeout", "sync_client_rate_budget", "sync_rate_limited", "locked",
  "authentication_required", "device_not_trusted", "membership_removed",
  "household_deleted", "household_deletion_pending", "household_moved", "household_moving",
]);

/**
 * The vault change for committing `pending` (a saved rotation proposal):
 * `{ expectedVersion, ciphertext }`, the member's vault at its stored version
 * with the proposal's household key merged in and sealed for the next
 * version, or `{ skip: reason }` when there is none to send. `vaultKey` is
 * borrowed (the caller zeroes it); the proposal's key and the opened
 * contents are wiped here.
 *
 * Reasons: "no_vault"; "current" (the vault already holds this exact key,
 * so the proposal committed); "vault_epoch_conflict" (a different key for
 * that epoch, so another proposal committed); "vault_unreadable" (this key
 * doesn't open the vault); otherwise the download's error code.
 */
export async function rotationVaultChange({ api, vaultKey, householdId, memberId, pending, deviceKeys }) {
  let downloaded;
  try {
    downloaded = await api.download();
  } catch (error) {
    if (!error?.code || PASS_STOPS.has(error.code)) throw error;
    return { skip: error.code };
  }
  for (const wrapper of downloaded.wrappers ?? []) wrapper.wrapped?.fill?.(0);
  const known = downloaded.vault;
  if (!known) return { skip: "no_vault" };
  const key = await exportStoredEpochKey({
    record: { householdId, keyEpoch: pending.epoch, sealed: pending.sealed, fingerprint: pending.fingerprint },
    deviceKeys,
  });
  const local = { epochs: [{ family: "household", epoch: pending.epoch, key }] };
  try {
    const { changed, sealed } = await sealVaultUpdate({ vaultKey, householdId, memberId, known, local });
    if (!changed) return { skip: "current" };
    return { expectedVersion: known.version, ciphertext: sealed };
  } catch (error) {
    if (!(error instanceof AccountVaultError)) throw error;
    return { skip: error.code === "vault_epoch_conflict" ? "vault_epoch_conflict" : "vault_unreadable" };
  } finally {
    wipeVaultContents(local);
  }
}

/** Outcomes kept for the next pass: the vault's own state, not a passing fault. */
const KEPT_SKIPS = new Set(["no_vault", "current", "vault_epoch_conflict", "vault_unreadable"]);

/** Reasons not worth a diagnostic: nothing was lost. */
const QUIET_SKIPS = new Set(["no_vault", "current"]);

// The last proposal's vault change (or why it has none), kept in this tab
// from one pass to the next. Vault downloads share the member's window with
// a new device's backup-code, password or passkey sign-in, and the service
// can refuse a rotation for its own reasons for a long time (the epoch limit,
// capacity, recipients) while each sync pass tries again. So a proposal
// downloads the vault once, plus once more for each vault conflict, which
// means another device really wrote the vault. The change is sealed vault
// ciphertext and holds nothing the device doesn't send anyway.
let kept = null;

/**
 * POSTs `pending` to /api/sync/epochs and resolves to the service's answer,
 * carrying the member's vault change when this device holds the vault key.
 * `request(path, options)` is SyncCoordinator.request; `vaultKey()` resolves
 * to a fresh copy of the vault key or null (zeroed here). The same proposal
 * (ID, packages, key) is sent every time, and so is its vault change until
 * the vault is found to have moved on. Why the vault was left out of a
 * rotation that then committed goes to the diagnostic ring buffer as
 * `rotation_vault_skipped` (a reason from a fixed list, nothing else).
 */
export async function submitRotation({ request, vaultKey: getVaultKey, identity, pending, deviceKeys }) {
  const base = { expectedEpoch: pending.expectedEpoch, packages: pending.packages, proposalId: pending.proposalId };
  const post = (body) => request("/api/sync/epochs", { method: "POST", body: JSON.stringify(body) });
  const vaultKey = await getVaultKey();
  if (!vaultKey) return post(base);
  const plain = async (reason) => {
    const result = await post(base);
    if (!QUIET_SKIPS.has(reason)) recordDiagnostic("rotation_vault_skipped", { reason });
    return result;
  };
  const slot = [identity.householdId, identity.memberId, pending.proposalId, pending.fingerprint].join(":");
  try {
    const api = vaultApi(request);
    for (let attempt = 1; ; attempt += 1) {
      let change = kept?.slot === slot ? kept.change : null;
      if (!change) {
        change = await rotationVaultChange({ api, vaultKey, householdId: identity.householdId,
          memberId: identity.memberId, pending, deviceKeys });
        kept = !change.skip || KEPT_SKIPS.has(change.skip) ? { slot, change } : null;
      }
      if (change.skip) {
        const result = await plain(change.skip);
        kept = null;
        return result;
      }
      let result;
      try {
        result = await post({ ...base, vaultChange: { expectedVersion: change.expectedVersion, ciphertext: toBase64Url(change.ciphertext) } });
      } catch (error) {
        // The service checks the rotation before the vault, so any other
        // refusal leaves the kept change good for the next pass.
        if (!FALLBACKS.has(error?.code)) throw error;
        kept = null;
        if (error.code === "vault_version_conflict" && attempt < ROTATION_VAULT_ATTEMPTS) continue;
        return plain(error.code);
      }
      kept = null;
      // An older service ignores the field and answers without `vault`. A
      // retried answer means an earlier request committed (with its change).
      if (!result.retried && result.vault?.version !== change.expectedVersion + 1)
        recordDiagnostic("rotation_vault_skipped", { reason: "not_applied" });
      return result;
    }
  } finally {
    vaultKey.fill(0);
  }
}
