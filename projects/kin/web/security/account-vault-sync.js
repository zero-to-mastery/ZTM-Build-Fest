// Keeping a member's account vault current (ADR 0018, #567), and the
// client for the service's vault routes (#566).
//
// When this device installs a household or chat epoch key it didn't have (a
// rotation after a revocation or a removal, or a chat key change), and the
// member has a vault whose key this device holds, the device seals a new
// vault version with the key added and uploads it compare-and-set. If
// another device wrote first (409), it downloads that version, merges by
// (family, epoch) and tries once more; a second conflict is left for the
// next install or the next device. Merging only ever adds keys, so two
// devices racing converge.
//
// Nothing here creates a vault or decides where a device keeps the vault
// key: `vaultKey` is supplied by the caller (the first-run and sign-in
// stories). Without it, the keeper does nothing.
import {
  AccountVaultError,
  mergeVaultContents,
  openVault,
  sealVault,
  wipeVaultContents,
} from "./account-vault.js";
import { fromBase64Url, toBase64Url } from "./local-vault.js";

const ID = /^[a-f0-9]{32}$/;

/**
 * The service's vault routes over `request(path, options)`, which returns
 * the parsed JSON or throws an Error whose `code` is the service's error
 * (the shape of HouseholdApi.api and SyncCoordinator.request).
 */
export function vaultApi(request = fetchJson) {
  return {
    /** `{ vault: { version, ciphertext: Uint8Array, updatedAt } | null, wrappers }` */
    async download() {
      const value = await request("/api/account/vault", { method: "GET" });
      return {
        vault: value.vault ? { version: value.vault.version, ciphertext: fromBase64Url(value.vault.ciphertext), updatedAt: value.vault.updatedAt } : null,
        wrappers: (value.wrappers ?? []).map((wrapper) => ({ ...wrapper, wrapped: fromBase64Url(wrapper.wrapped) })),
      };
    },
    /** Stores `ciphertext` as `expectedVersion + 1`; `wrappers` only when creating. */
    async upload({ expectedVersion, ciphertext, wrappers }) {
      const body = { expectedVersion, ciphertext: toBase64Url(ciphertext) };
      if (wrappers) body.wrappers = wrappers.map((wrapper) => ({ ...wrapper, wrapped: toBase64Url(wrapper.wrapped) }));
      return request("/api/account/vault", { method: "PUT", body: JSON.stringify(body) });
    },
    /** Adds (version 1) or replaces (version + 1) one wrapper. `confirm` is
     * the fresh confirmation the service asks for: `{ currentAuthKey }`
     * (base64url), or `{ flow, credential }` from a passkey assertion for
     * /api/account/confirm/options. */
    putWrapper({ wrapperId, type, version, params, wrapped }, confirm = {}) {
      if (!ID.test(wrapperId ?? "")) throw new AccountVaultError("The vault wrapper is invalid.");
      return request(`/api/account/vault/wrappers/${wrapperId}`, { method: "PUT",
        body: JSON.stringify({ ...confirmation(confirm), type, version, params, wrapped: toBase64Url(wrapped) }) });
    },
    /** Removes one wrapper, after the same fresh confirmation; the service
     * keeps the last one. */
    removeWrapper(wrapperId, confirm = {}) {
      if (!ID.test(wrapperId ?? "")) throw new AccountVaultError("The vault wrapper is invalid.");
      return request(`/api/account/vault/wrappers/${wrapperId}`, { method: "DELETE", body: JSON.stringify(confirmation(confirm)) });
    },
  };
}

/**
 * The next version of a known vault with `local` merged in, sealed but not
 * stored: `known` is `{ version, ciphertext }`. Resolves to `{ changed,
 * sealed }`, where `sealed` (for `known.version + 1`) is null when `local`
 * adds nothing. Throws AccountVaultError when the vault doesn't open with
 * `vaultKey` or holds a different key for one of `local`'s epochs
 * (`vault_epoch_conflict`). The opened contents are wiped either way.
 */
export async function sealVaultUpdate({ vaultKey, householdId, memberId, known, local }) {
  const context = { householdId, memberId };
  const stored = await openVault(vaultKey, known.ciphertext, { ...context, version: known.version });
  try {
    const { contents, changed } = mergeVaultContents(stored, local);
    if (!changed) return { changed: false, sealed: null };
    return { changed: true, sealed: await sealVault(vaultKey, contents, { ...context, version: known.version + 1 }) };
  } finally {
    wipeVaultContents(stored);
  }
}

/**
 * Merges `local` (vault contents: `{ epochs, certificationKey?,
 * memberKeys? }`) into the member's vault and uploads a new version
 * when that adds anything. `current` is a known `{ version, ciphertext }`
 * (from an earlier download or upload) to start from instead of
 * downloading. Returns `{ status, version, ciphertext }`, where status is
 * "no_vault", "current" (nothing to add) or "updated".
 */
export async function refreshVault({ api, vaultKey, householdId, memberId, local, current = null }) {
  let known = current ?? (await api.download()).vault;
  for (let attempt = 0; ; attempt += 1) {
    if (!known) return { status: "no_vault", version: 0, ciphertext: null };
    const { changed, sealed } = await sealVaultUpdate({ vaultKey, householdId, memberId, known, local });
    if (!changed) return { status: "current", version: known.version, ciphertext: known.ciphertext };
    try {
      const { version } = await api.upload({ expectedVersion: known.version, ciphertext: sealed });
      return { status: "updated", version, ciphertext: sealed };
    } catch (error) {
      if (error?.code !== "vault_version_conflict" || attempt >= 1) throw error;
      known = (await api.download()).vault;
    }
  }
}

/**
 * Re-seals the member's vault whenever this device installs a new epoch
 * key. `vaultKey()` resolves to a fresh copy of the vault key this device
 * holds for the member (zeroed here after use), or null when it holds none
 * (then nothing happens);
 * `localContents()` resolves to the keys to merge in (for example
 * `{ epochs: await keyStore.vaultEpochKeys(householdId) }`). Updates run
 * one at a time; one that fails is retried by the next install.
 */
export class VaultKeeper {
  constructor({ api, householdId, memberId, vaultKey, localContents }) {
    if (!ID.test(householdId ?? "") || !ID.test(memberId ?? ""))
      throw new AccountVaultError("The vault keeper needs this device's household and member.");
    Object.assign(this, { api, householdId, memberId, vaultKey, localContents });
    this.current = null;
    this.queue = Promise.resolve();
  }

  /** Runs one update after any already queued; resolves to its result. */
  update() {
    const run = this.queue.then(() => this.runUpdate());
    this.queue = run.catch(() => {});
    return run;
  }

  async runUpdate() {
    const vaultKey = await this.vaultKey();
    if (!vaultKey) return { status: "no_vault_key" };
    let local;
    try {
      local = await this.localContents();
      const result = await refreshVault({ api: this.api, vaultKey, householdId: this.householdId,
        memberId: this.memberId, local, current: this.current });
      this.current = result.ciphertext ? { version: result.version, ciphertext: result.ciphertext } : null;
      return result;
    } catch (error) {
      // A stale cached version can't be trusted next time.
      this.current = null;
      throw error;
    } finally {
      wipeVaultContents(local);
      vaultKey.fill(0);
    }
  }

  /**
   * Updates the vault after each epoch key installed for this household
   * (either family), through `subscribe` (key-store.js onEpochInstalled).
   * Returns the unsubscribe function.
   */
  watch(subscribe) {
    return subscribe(({ householdId }) => {
      if (householdId !== this.householdId && householdId !== `chat:${this.householdId}`) return undefined;
      return this.update();
    });
  }
}

/** Only the confirmation's own fields, so nothing else rides along. */
function confirmation({ currentAuthKey, flow, credential } = {}) {
  if (typeof currentAuthKey === "string") return { currentAuthKey };
  if (typeof flow === "string" && credential) return { flow, credential };
  return {};
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
  const value = await response.json().catch(() => ({ message: "Kin could not read the server response." }));
  if (!response.ok) {
    const error = new Error(value.message);
    error.code = value.error;
    throw error;
  }
  return value;
}
