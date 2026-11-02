// The member key (MK) on this device (ADR 0019, #486/#488): the AES-256-GCM
// key a member's private envelopes are sealed under, one per epoch.
//
// MK lives only in the member's account vault (web/security/account-vault.js,
// contents format 2) and, while Kin is unlocked, in memory here as
// non-extractable CryptoKeys. A device gets it by opening the vault, which it
// can already do (ADR 0018), so there is no separate provisioning protocol:
// the member's other devices, and a new one signed in with their password,
// passkey or backup code, all read the same epochs. Locking drops every key.
//
// Epochs. Each vault entry records `revokedThrough`: the latest revocation
// time of the member's own devices it was made after. When a device sees one
// of its member's devices revoked later than that (the device directory each
// sync pass reads), it re-reads the vault, and if no other device has
// already started a newer epoch, it creates epoch n+1 and uploads the vault
// compare-and-set. Two devices racing both try; the second's merge finds a
// different key for the same epoch (`vault_member_key_conflict`) and it
// adopts the first's. New envelopes use the newest epoch; old epochs stay in
// the vault so old envelopes stay readable. A revoked device keeps whatever
// it already had.
//
// INTEGRATION POINT (#557): `vaultKey()` resolves to a fresh copy of the
// vault key (VK) this device holds for its member, or null when it holds
// none. Story #557 keeps VK on the device after password sign-up; until it
// is wired, the app passes a provider that resolves null, so private storage
// stays off (status "no_vault_key") and nothing private is created. Tests
// pass a double.
import { AccountVaultError, MAX_MEMBER_KEY_EPOCH, generateMemberKey, openVault, wipeVaultContents } from "../security/account-vault.js";
import { refreshVault } from "../security/account-vault-sync.js";

const ID = /^[a-f0-9]{32}$/;

export class MemberKeyError extends Error {
  constructor(message, code = "private_key_unavailable", cause) {
    super(message, { cause });
    this.name = "MemberKeyError";
    this.code = code;
  }
}

/**
 * The latest revocation time among `memberId`'s own devices in a device
 * directory (`/api/sync/devices` entries), or 0 when none is revoked.
 */
export function memberRevocationMark(devices, memberId) {
  let mark = 0;
  for (const device of devices ?? [])
    if (device?.memberId === memberId && Number.isSafeInteger(device.revokedAt) && device.revokedAt > mark) mark = device.revokedAt;
  return mark;
}

/**
 * One member's member-key epochs on this device.
 *
 * - `api`: the service's vault routes (account-vault-sync.js `vaultApi`).
 * - `vaultKey()`: the integration point above.
 * - `cache`: optional `{ load(), save({ version, ciphertext }) }` holding the
 *   last sealed vault seen (ciphertext under VK, as the service holds it), so
 *   an offline unlock still opens private storage. A cached version newer
 *   than the service's is preferred: the service can't roll the vault back.
 */
export class MemberKeyRing {
  constructor({ api, householdId, memberId, vaultKey, cache = null }) {
    if (!ID.test(householdId ?? "") || !ID.test(memberId ?? ""))
      throw new MemberKeyError("Private storage needs this device's household and member.");
    if (typeof vaultKey !== "function") throw new MemberKeyError("Private storage needs a vault key provider.");
    Object.assign(this, { api, householdId, memberId, vaultKey, cache });
    this.keys = new Map();
    this.missing = new Set();
    this.version = 0;
    this.status = "locked";
    this.queue = Promise.resolve();
  }

  /** Whether this device holds a member key now. */
  get available() {
    return this.keys.size > 0;
  }

  /** The newest epoch: `{ epoch, key, revokedThrough }`. */
  current() {
    if (!this.available) throw new MemberKeyError("Open your account on this device to use private storage.", "private_key_unavailable");
    let newest = null;
    for (const [epoch, entry] of this.keys) if (!newest || epoch > newest.epoch) newest = { epoch, ...entry };
    return newest;
  }

  /** The CryptoKey of one epoch, re-reading the vault once when this device
   * doesn't have it yet (another device rotated). */
  async key(epoch) {
    // At most one re-read per missing epoch per unlock: vault downloads are
    // rate-limited per member, and a relay can't make this loop.
    if (!this.keys.has(epoch) && !this.missing.has(epoch)) {
      this.missing.add(epoch);
      await this.serial(() => this.read({ prefer: "service" }));
    }
    const entry = this.keys.get(epoch);
    if (!entry) throw new MemberKeyError(`This device is missing private key epoch ${epoch}; private storage is paused.`, "private_key_missing");
    return entry.key;
  }

  /** The `revokedThrough` an epoch was made after, or null. */
  revokedThrough(epoch) {
    return this.keys.get(epoch)?.revokedThrough ?? null;
  }

  /** Reads the member's keys from the vault. Resolves to the status:
   * "ready", "no_member_key" (a vault without one yet), "no_vault" (the
   * member hasn't set up an account, ADR 0018) or "no_vault_key". */
  load() {
    return this.serial(() => this.read({ prefer: "service" }));
  }

  /**
   * Creates the member's first key (epoch 1) when their vault has none:
   * on their first device, the first time they use something private.
   * `revokedThrough` is the current revocation mark, so revocations from
   * before the key existed never start a needless epoch 2. Resolves to the
   * status.
   */
  create({ revokedThrough = 0 } = {}) {
    return this.serial(async () => {
      const status = await this.read({ prefer: "service" });
      if (status !== "no_member_key") return status;
      const written = await this.write(1, revokedThrough);
      return written === "written" || written === "adopted" ? this.status : written;
    });
  }

  /**
   * Starts epoch n+1 after one of the member's devices was revoked at
   * `revokedThrough`, unless the vault already has an epoch made after it.
   * Resolves to "current" (nothing to do), "rotated" or "adopted" (another
   * device rotated first).
   */
  rotate({ revokedThrough }) {
    if (!Number.isSafeInteger(revokedThrough) || revokedThrough < 0)
      return Promise.reject(new MemberKeyError("The revocation time is invalid."));
    return this.serial(async () => {
      if (this.available && this.current().revokedThrough >= revokedThrough) return "current";
      const status = await this.read({ prefer: "service" });
      if (status !== "ready") return status;
      const current = this.current();
      if (current.revokedThrough >= revokedThrough) return "adopted";
      if (current.epoch >= MAX_MEMBER_KEY_EPOCH)
        throw new MemberKeyError("Private storage has used every key epoch Kin supports.", "private_key_limit");
      const written = await this.write(current.epoch + 1, revokedThrough);
      return written === "written" ? "rotated" : written;
    });
  }

  /** Drops every key (lock, stop). */
  lock() {
    this.keys.clear();
    this.missing.clear();
    this.version = 0;
    this.status = "locked";
  }

  serial(work) {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Opens the newest vault this device can get and installs its member keys. */
  async read({ prefer }) {
    const vaultKey = await this.vaultKey();
    if (!vaultKey) {
      this.lock();
      this.status = "no_vault_key";
      return this.status;
    }
    try {
      let known = null, failure = null;
      if (prefer === "service") {
        try { known = (await this.api.download()).vault; } catch (error) { failure = error; }
      }
      const cached = await this.cached();
      if (cached && (!known || cached.version > known.version)) known = cached;
      if (!known) {
        if (failure) throw failure;
        this.lock();
        this.status = "no_vault";
        return this.status;
      }
      await this.install(vaultKey, known);
      if (!failure) await this.remember(known);
      return this.status;
    } finally {
      vaultKey.fill(0);
    }
  }

  async install(vaultKey, known) {
    const contents = await openVault(vaultKey, known.ciphertext, { householdId: this.householdId, memberId: this.memberId, version: known.version });
    try {
      const keys = new Map();
      for (const entry of contents.memberKeys) {
        const key = await crypto.subtle.importKey("raw", entry.key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
        keys.set(entry.epoch, { key, revokedThrough: entry.revokedThrough });
      }
      this.keys = keys;
      this.version = known.version;
      this.status = keys.size ? "ready" : "no_member_key";
    } finally {
      wipeVaultContents(contents);
    }
  }

  async cached() {
    try { return (await this.cache?.load?.()) ?? null; } catch { return null; }
  }

  /** Best effort: the next offline unlock falls back to an older copy. */
  async remember(known) {
    try { await this.cache?.save?.(known); } catch { /* kept for next time */ }
  }

  /** Seals a new epoch into the vault (compare-and-set). Resolves to
   * "written", "adopted" (another device started the same epoch first, and
   * its key is installed instead), "no_vault" or "no_vault_key". */
  async write(epoch, revokedThrough) {
    const vaultKey = await this.vaultKey();
    if (!vaultKey) {
      this.lock();
      this.status = "no_vault_key";
      return this.status;
    }
    const key = generateMemberKey();
    try {
      let result;
      try {
        result = await refreshVault({
          api: this.api, vaultKey, householdId: this.householdId, memberId: this.memberId,
          local: { memberKeys: [{ epoch, key, revokedThrough }] },
        });
      } catch (error) {
        if (!(error instanceof AccountVaultError) || error.code !== "vault_member_key_conflict") throw error;
        // Another device started this epoch first: theirs is the one.
        key.fill(0);
        vaultKey.fill(0);
        const status = await this.read({ prefer: "service" });
        return status === "ready" ? "adopted" : status;
      }
      if (result.status === "no_vault") {
        this.lock();
        this.status = "no_vault";
        return this.status;
      }
      const known = { version: result.version, ciphertext: result.ciphertext };
      await this.install(vaultKey, known);
      await this.remember(known);
      return "written";
    } finally {
      key.fill(0);
      vaultKey.fill(0);
    }
  }
}
