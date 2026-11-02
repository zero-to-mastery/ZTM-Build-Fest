// DurableStore account key vaults (ADR 0018, #564): one sealed vault per
// member with a version that only grows, the wrappers that each hold the
// vault key, and the password verifier for password sign-in (#557). The
// service can't read any of it; it keeps the bytes, checks their bounds and
// changes them compare-and-set. server/account-vault-service.mjs decides who
// may; these methods only keep the invariants (a vault always has at least
// one wrapper; versions advance by one).
import {
  DurableConflictError,
  DurableStoreError,
  MAX_ACCOUNT_VAULT_WRAPPERS,
} from "./shared.mjs";

export const accountVaultMethods = {
  /** `{ version, ciphertext, updatedAt, wrappers }` for the member, or null. */
  accountVault(householdId, memberId) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT version, ciphertext, updated_at FROM account_vaults WHERE member_id = ? AND household_id = ?")
      .get(memberId, householdId);
    if (!row) return null;
    const wrappers = this.db.prepare(`SELECT wrapper_id, type, version, params, wrapped, updated_at FROM account_vault_wrappers
      WHERE member_id = ? AND household_id = ? ORDER BY wrapper_id`).all(memberId, householdId).map((wrapper) => {
      let params;
      try { params = JSON.parse(wrapper.params); } catch { throw new DurableStoreError("Kin's stored vault wrappers are invalid."); }
      return { wrapperId: wrapper.wrapper_id, type: wrapper.type, version: wrapper.version, params,
        wrapped: new Uint8Array(wrapper.wrapped), updatedAt: wrapper.updated_at };
    });
    if (!wrappers.length) throw new DurableStoreError("Kin's stored vault has no wrapper.");
    return { version: row.version, ciphertext: new Uint8Array(row.ciphertext), updatedAt: row.updated_at, wrappers };
  },

  /**
   * Stores a new vault version compare-and-set: `expectedVersion` must be the
   * stored version (0 for none). Creating a vault needs its first wrappers in
   * the same transaction, so no vault ever exists that nothing can open.
   * Returns the new version.
   */
  putAccountVault(householdId, memberId, { expectedVersion, ciphertext, wrappers = [], now }) {
    this.assertAvailable();
    return this.transaction(() => {
      const current = this.db.prepare("SELECT version FROM account_vaults WHERE member_id = ? AND household_id = ?").get(memberId, householdId)?.version ?? 0;
      if (current !== expectedVersion)
        throw new DurableConflictError("vault_version_conflict", "The vault changed on another device meanwhile.");
      if (current === 0 && (wrappers.length < 1 || wrappers.length > MAX_ACCOUNT_VAULT_WRAPPERS))
        throw new DurableStoreError("A new vault needs its first wrapper.");
      if (current !== 0 && wrappers.length)
        throw new DurableStoreError("Vault wrappers change on their own.");
      if (current === 0 && this.db.prepare("SELECT 1 FROM account_vaults WHERE member_id = ?").get(memberId))
        throw new DurableStoreError("That member's vault belongs to another household.");
      const version = expectedVersion + 1;
      this.db.prepare(`INSERT INTO account_vaults (member_id, household_id, version, updated_at, ciphertext) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (member_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, ciphertext = excluded.ciphertext`)
        .run(memberId, householdId, version, now, ciphertext);
      for (const wrapper of wrappers) insertWrapper(this.db, householdId, memberId, wrapper, now);
      return version;
    });
  },

  /**
   * Adds a wrapper (version 1) or replaces one (its stored version plus one,
   * same type). Returns `{ version, added }`.
   */
  putAccountVaultWrapper(householdId, memberId, wrapper, now) {
    this.assertAvailable();
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM account_vaults WHERE member_id = ? AND household_id = ?").get(memberId, householdId))
        throw new DurableConflictError("vault_not_found", "There is no vault to add this to.");
      const existing = this.db.prepare("SELECT type, version FROM account_vault_wrappers WHERE member_id = ? AND household_id = ? AND wrapper_id = ?")
        .get(memberId, householdId, wrapper.wrapperId);
      if (!existing) {
        const count = this.db.prepare("SELECT COUNT(*) AS count FROM account_vault_wrappers WHERE member_id = ? AND household_id = ?").get(memberId, householdId).count;
        if (count >= MAX_ACCOUNT_VAULT_WRAPPERS)
          throw new DurableConflictError("vault_wrapper_limit", "This vault already has as many ways to open it as Kin allows.");
        if (wrapper.version !== 1)
          throw new DurableConflictError("vault_wrapper_conflict", "That way of opening the vault changed meanwhile.");
        insertWrapper(this.db, householdId, memberId, wrapper, now);
        return { version: 1, added: true };
      }
      if (existing.type !== wrapper.type || wrapper.version !== existing.version + 1)
        throw new DurableConflictError("vault_wrapper_conflict", "That way of opening the vault changed meanwhile.");
      this.db.prepare(`UPDATE account_vault_wrappers SET version = ?, params = ?, wrapped = ?, updated_at = ?
        WHERE member_id = ? AND household_id = ? AND wrapper_id = ?`)
        .run(wrapper.version, JSON.stringify(wrapper.params), wrapper.wrapped, now, memberId, householdId, wrapper.wrapperId);
      return { version: wrapper.version, added: false };
    });
  },

  /** Removes a wrapper, never the last one. Returns how many remain. */
  removeAccountVaultWrapper(householdId, memberId, wrapperId) {
    this.assertAvailable();
    return this.transaction(() => {
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM account_vault_wrappers WHERE member_id = ? AND household_id = ?").get(memberId, householdId).count;
      const exists = this.db.prepare("SELECT 1 FROM account_vault_wrappers WHERE member_id = ? AND household_id = ? AND wrapper_id = ?").get(memberId, householdId, wrapperId);
      if (!exists) throw new DurableConflictError("vault_wrapper_not_found", "That way of opening the vault was not found.");
      if (count <= 1) throw new DurableConflictError("vault_last_wrapper", "Keep at least one way to open your vault.");
      this.db.prepare("DELETE FROM account_vault_wrappers WHERE member_id = ? AND household_id = ? AND wrapper_id = ?").run(memberId, householdId, wrapperId);
      return count - 1;
    });
  },

  /**
   * Removes the wrappers `remove` names and then adds or replaces `put`
   * (each as putAccountVaultWrapper would), in one transaction (#561):
   * `check(wrappers)` sees the resulting set (`[{ wrapperId, type,
   * version, params }]`) before anything commits and throws to refuse it.
   * A vault always keeps at least one wrapper. Returns the resulting set.
   */
  changeAccountVaultWrappers(householdId, memberId, { put = [], remove = [] }, now, check = () => {}) {
    this.assertAvailable();
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM account_vaults WHERE member_id = ? AND household_id = ?").get(memberId, householdId))
        throw new DurableConflictError("vault_not_found", "There is no vault to add this to.");
      for (const wrapperId of remove) {
        const deleted = this.db.prepare("DELETE FROM account_vault_wrappers WHERE member_id = ? AND household_id = ? AND wrapper_id = ?")
          .run(memberId, householdId, wrapperId).changes;
        if (!deleted) throw new DurableConflictError("vault_wrapper_not_found", "That way of opening the vault was not found.");
      }
      for (const wrapper of put) this.putAccountVaultWrapper(householdId, memberId, wrapper, now);
      const wrappers = this.db.prepare(`SELECT wrapper_id, type, version, params FROM account_vault_wrappers
        WHERE member_id = ? AND household_id = ? ORDER BY wrapper_id`).all(memberId, householdId)
        .map((row) => ({ wrapperId: row.wrapper_id, type: row.type, version: row.version, params: JSON.parse(row.params) }));
      if (!wrappers.length) throw new DurableConflictError("vault_last_wrapper", "Keep at least one way to open your vault.");
      check(wrappers);
      return wrappers;
    });
  },

  /** Removes a member's vault, wrappers and password verifier (the member
   * was removed or left). Returns whether anything was there. */
  removeAccountKeys(householdId, memberId) {
    this.assertAvailable();
    return this.transaction(() => {
      let removed = 0;
      for (const table of ["account_vault_wrappers", "account_vaults", "account_passwords"])
        removed += this.db.prepare(`DELETE FROM ${table} WHERE member_id = ? AND household_id = ?`).run(memberId, householdId).changes;
      return removed > 0;
    });
  },

  /** The member's password parameters and verifier (#557), or null. */
  accountPassword(householdId, memberId) {
    this.assertAvailable();
    const row = this.db.prepare("SELECT kdf_salt, kdf_iterations, verifier, updated_at FROM account_passwords WHERE member_id = ? AND household_id = ?")
      .get(memberId, householdId);
    return row ? { salt: new Uint8Array(row.kdf_salt), iterations: row.kdf_iterations, verifier: row.verifier, updatedAt: row.updated_at } : null;
  },

  /** Sets or replaces the member's password verifier (#557 adds the route). */
  putAccountPassword(householdId, memberId, { salt, iterations, verifier, now }) {
    this.assertAvailable();
    this.db.prepare(`INSERT INTO account_passwords (member_id, household_id, kdf_salt, kdf_iterations, verifier, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (member_id) DO UPDATE SET kdf_salt = excluded.kdf_salt, kdf_iterations = excluded.kdf_iterations,
        verifier = excluded.verifier, updated_at = excluded.updated_at WHERE account_passwords.household_id = excluded.household_id`)
      .run(memberId, householdId, salt, iterations, verifier, now);
  },
};

function insertWrapper(database, householdId, memberId, wrapper, now) {
  database.prepare(`INSERT INTO account_vault_wrappers (member_id, household_id, wrapper_id, type, version, params, wrapped, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(memberId, householdId, wrapper.wrapperId, wrapper.type, wrapper.version, JSON.stringify(wrapper.params), wrapper.wrapped, now);
}
