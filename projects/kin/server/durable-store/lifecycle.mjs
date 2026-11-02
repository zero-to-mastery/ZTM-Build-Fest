// DurableStore household lifecycle: deletion requests, cancellation,
// finalization and purge.
import { DurableConflictError, DurableStoreError, isId, isTimestamp } from "./shared.mjs";
import { purgeHouseholdFeedback } from "./feedback.mjs";

export function purgeHouseholdData(database, householdId) {
  database.prepare("UPDATE households SET owner_member_id = NULL WHERE id = ?").run(householdId);
  database.prepare("DELETE FROM household_settings WHERE household_id = ?").run(householdId);
  database.prepare("DELETE FROM household_install_identity WHERE household_id = ?").run(householdId);
  database.prepare("DELETE FROM household_install_identity_revisions WHERE household_id = ?").run(householdId);
  database.prepare("DELETE FROM push_subscriptions WHERE household_id = ?").run(householdId);
  database.prepare("DELETE FROM sync_attachments WHERE household_id = ?").run(householdId);
  // Chat content: freed pages are zeroed, so deleted messages' ciphertext
  // doesn't linger in the database file (the WAL is checkpointed later).
  const secureDelete = database.prepare("PRAGMA secure_delete").get().secure_delete;
  database.exec("PRAGMA secure_delete = ON");
  try {
    database.prepare("DELETE FROM chat_blobs WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM chat_blob_claims WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM chat_blob_usage WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM chat_events WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM chat_device_sequences WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM chat_relay_state WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM chat_hidden WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM chat_receipts WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM chat_key_packages WHERE household_id = ?").run(householdId);
    // The fridge (#317): drawings are household content too.
    database.prepare("DELETE FROM board_events WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM board_device_sequences WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM board_relay_state WHERE household_id = ?").run(householdId);
    // Account vaults (ADR 0018): members' sealed keys and password verifiers.
    database.prepare("DELETE FROM account_vault_wrappers WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM account_vaults WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM account_passwords WHERE household_id = ?").run(householdId);
    // Members' private streams (ADR 0019).
    database.prepare("DELETE FROM private_events WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM private_device_sequences WHERE household_id = ?").run(householdId);
    database.prepare("DELETE FROM private_relay_state WHERE household_id = ?").run(householdId);
    // Members' private blobs: journal photos (#502).
    database.prepare("DELETE FROM private_blobs WHERE household_id = ?").run(householdId);
  } finally {
    database.exec(`PRAGMA secure_delete = ${secureDelete ? "ON" : "OFF"}`);
  }
  // Problem reports and suggestions its members sent (ADR 0021 §3).
  purgeHouseholdFeedback(database, householdId);
  // Invitations an admin prepared and may have printed (#613).
  database.prepare("DELETE FROM prepared_invitations WHERE household_id = ?").run(householdId);
  // Outside calendars members synced, and their links (ADR 0022 §3).
  database.prepare("DELETE FROM calendar_subscriptions WHERE household_id = ?").run(householdId);
  database.prepare("DELETE FROM household_moves WHERE household_id = ?").run(householdId);
  database
    .prepare("DELETE FROM provisioning_grants WHERE household_id = ?")
    .run(householdId);
  database
    .prepare("DELETE FROM sync_events WHERE household_id = ?")
    .run(householdId);
  database
    .prepare("DELETE FROM sync_bindings WHERE household_id = ?")
    .run(householdId);
  database
    .prepare("DELETE FROM sync_device_sequences WHERE household_id = ?")
    .run(householdId);
  database
    .prepare("DELETE FROM sync_households WHERE household_id = ?")
    .run(householdId);
  database
    .prepare("DELETE FROM devices WHERE household_id = ?")
    .run(householdId);
  database
    .prepare(
      "DELETE FROM credentials WHERE member_id IN (SELECT id FROM members WHERE household_id = ?)",
    )
    .run(householdId);
  database.prepare("DELETE FROM members WHERE household_id = ?").run(householdId);
  database
    .prepare("DELETE FROM security_audit WHERE household_id = ?")
    .run(householdId);
}

export const lifecycleMethods = {
  lifecycleInfo(householdId) {
    this.assertAvailable();
    const row = this.statements.getHousehold.get(householdId);
    if (!row) return null;
    return {
      householdId,
      state: row.lifecycle_state,
      requestedAt: row.deletion_requested_at,
      finalizeAt: row.deletion_finalize_at,
      deletedAt: row.deleted_at,
    };
  },

  /** Purge zeroes freed pages; checkpointing the WAL afterwards carries the
   * zeroed pages into the main file at once (outside a transaction only). */
  checkpointAfterPurge(result, purged = true) {
    if (purged && !this.db.isTransaction) this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    return result;
  },

  householdPurgeStatus(householdId) {
    this.assertAvailable();
    if (!isId(householdId))
      throw new DurableStoreError(
        "A Kin household ID must be 32 lowercase hexadecimal characters.",
      );
    const lifecycle = this.lifecycleInfo(householdId);
    if (!lifecycle)
      throw new DurableStoreError("The Kin household does not exist.");
    const count = (sql) => this.db.prepare(sql).get(householdId).count;
    const counts = {
      members: count(
        "SELECT COUNT(*) AS count FROM members WHERE household_id = ?",
      ),
      credentials: count(
        "SELECT COUNT(*) AS count FROM credentials WHERE member_id IN (SELECT id FROM members WHERE household_id = ?)",
      ),
      devices: count(
        "SELECT COUNT(*) AS count FROM devices WHERE household_id = ?",
      ),
      settings: count(
        "SELECT COUNT(*) AS count FROM household_settings WHERE household_id = ?",
      ),
      pushSubscriptions: count(
        "SELECT COUNT(*) AS count FROM push_subscriptions WHERE household_id = ?",
      ),
      installIdentity: count(
        "SELECT (SELECT COUNT(*) FROM household_install_identity WHERE household_id = ?1) + (SELECT COUNT(*) FROM household_install_identity_revisions WHERE household_id = ?1) AS count",
      ),
      attachments: count(
        "SELECT COUNT(*) AS count FROM sync_attachments WHERE household_id = ?",
      ),
      chatEvents: count(
        "SELECT (SELECT COUNT(*) FROM chat_events WHERE household_id = ?1) + (SELECT COUNT(*) FROM chat_device_sequences WHERE household_id = ?1) + (SELECT COUNT(*) FROM chat_relay_state WHERE household_id = ?1) + (SELECT COUNT(*) FROM chat_hidden WHERE household_id = ?1) + (SELECT COUNT(*) FROM chat_receipts WHERE household_id = ?1) + (SELECT COUNT(*) FROM chat_key_packages WHERE household_id = ?1) AS count",
      ),
      boardEvents: count(
        "SELECT (SELECT COUNT(*) FROM board_events WHERE household_id = ?1) + (SELECT COUNT(*) FROM board_device_sequences WHERE household_id = ?1) + (SELECT COUNT(*) FROM board_relay_state WHERE household_id = ?1) AS count",
      ),
      accountVaults: count(
        "SELECT (SELECT COUNT(*) FROM account_vaults WHERE household_id = ?1) + (SELECT COUNT(*) FROM account_vault_wrappers WHERE household_id = ?1) + (SELECT COUNT(*) FROM account_passwords WHERE household_id = ?1) AS count",
      ),
      privateEvents: count(
        "SELECT (SELECT COUNT(*) FROM private_events WHERE household_id = ?1) + (SELECT COUNT(*) FROM private_device_sequences WHERE household_id = ?1) + (SELECT COUNT(*) FROM private_relay_state WHERE household_id = ?1) + (SELECT COUNT(*) FROM private_blobs WHERE household_id = ?1) AS count",
      ),
      chatBlobs: count(
        "SELECT (SELECT COUNT(*) FROM chat_blobs WHERE household_id = ?1) + (SELECT COUNT(*) FROM chat_blob_claims WHERE household_id = ?1) + (SELECT COUNT(*) FROM chat_blob_usage WHERE household_id = ?1) AS count",
      ),
      feedback: count(
        "SELECT COUNT(*) AS count FROM feedback WHERE household_id = ?",
      ),
      calendarSubscriptions: count(
        "SELECT COUNT(*) AS count FROM calendar_subscriptions WHERE household_id = ?",
      ),
      events: count(
        "SELECT COUNT(*) AS count FROM sync_events WHERE household_id = ?",
      ),
      bindings: count(
        "SELECT COUNT(*) AS count FROM sync_bindings WHERE household_id = ?",
      ),
      deviceSequences: count(
        "SELECT COUNT(*) AS count FROM sync_device_sequences WHERE household_id = ?",
      ),
      syncState: count(
        "SELECT COUNT(*) AS count FROM sync_households WHERE household_id = ?",
      ),
      provisioningGrants: count(
        "SELECT COUNT(*) AS count FROM provisioning_grants WHERE household_id = ?",
      ),
      securityAudit: count(
        "SELECT COUNT(*) AS count FROM security_audit WHERE household_id = ?",
      ),
    };
    const ownerRecorded = this.db
      .prepare(
        "SELECT owner_member_id IS NOT NULL AS value FROM households WHERE id = ?",
      )
      .get(householdId).value === 1;
    return {
      ...lifecycle,
      ownerRecorded,
      counts,
      purged:
        lifecycle.state === "deleted" &&
        !ownerRecorded &&
        Object.values(counts).every((value) => value === 0),
    };
  },

  forcePurgeHousehold(householdId, deletedAt) {
    if (!isId(householdId) || !isTimestamp(deletedAt))
      throw new DurableStoreError(
        "Kin forced household deletion metadata is invalid.",
      );
    return this.checkpointAfterPurge(this.transaction(() => {
      const lifecycle = this.lifecycleInfo(householdId);
      if (!lifecycle)
        throw new DurableStoreError("The Kin household does not exist.");
      if (lifecycle.state !== "deleted") {
        purgeHouseholdData(this.db, householdId);
        this.db
          .prepare(
            `UPDATE households
             SET lifecycle_state = 'deleted',
                 deletion_requested_at = NULL,
                 deletion_finalize_at = NULL,
                 deleted_at = ?
             WHERE id = ?`,
          )
          .run(deletedAt, householdId);
      }
      const status = this.householdPurgeStatus(householdId);
      if (!status.purged)
        throw new DurableStoreError("Kin could not verify the household purge.");
      return status;
    }));
  },

  requestHouseholdDeletion(householdId, requestedAt, finalizeAt) {
    if (
      !isId(householdId) ||
      !isTimestamp(requestedAt) ||
      !isTimestamp(finalizeAt) ||
      finalizeAt <= requestedAt
    )
      throw new DurableStoreError("Kin household deletion metadata is invalid.");
    const update = this.db
      .prepare(
        `UPDATE households
         SET lifecycle_state = 'deletion_pending',
             deletion_requested_at = ?,
             deletion_finalize_at = ?
         WHERE id = ? AND lifecycle_state = 'active'`,
      )
      .run(requestedAt, finalizeAt, householdId);
    if (update.changes !== 1)
      throw new DurableConflictError(
        "household_lifecycle_conflict",
        "This household is already being deleted or is no longer available.",
      );
    return this.lifecycleInfo(householdId);
  },

  cancelHouseholdDeletion(householdId, now) {
    if (!isId(householdId) || !isTimestamp(now))
      throw new DurableStoreError("Kin household deletion metadata is invalid.");
    const update = this.db
      .prepare(
        `UPDATE households
         SET lifecycle_state = 'active',
             deletion_requested_at = NULL,
             deletion_finalize_at = NULL
         WHERE id = ? AND lifecycle_state = 'deletion_pending'
           AND deletion_finalize_at > ?`,
      )
      .run(householdId, now);
    if (update.changes !== 1)
      throw new DurableConflictError(
        "household_deletion_final",
        "The household deletion can no longer be cancelled.",
      );
    return this.lifecycleInfo(householdId);
  },

  finalizeExpiredDeletions(now) {
    if (!isTimestamp(now))
      throw new DurableStoreError("Kin household deletion time is invalid.");
    // Runs at the start of every API request: checkpoint only after an
    // actual purge, never on the common nothing-to-do call.
    const purged = this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM households
           WHERE lifecycle_state = 'deletion_pending'
             AND deletion_finalize_at <= ?
           ORDER BY deletion_finalize_at, id`,
        )
        .all(now);
      for (const { id: householdId } of rows) {
        purgeHouseholdData(this.db, householdId);
        this.db
          .prepare(
            `UPDATE households
             SET lifecycle_state = 'deleted',
                 deletion_requested_at = NULL,
                 deletion_finalize_at = NULL,
                 deleted_at = ?
             WHERE id = ? AND lifecycle_state = 'deletion_pending'`,
          )
          .run(now, householdId);
      }
      return rows.map(({ id }) => id);
    });
    return this.checkpointAfterPurge(purged, purged.length > 0);
  },

  loadNonActiveHouseholds() {
    this.assertAvailable();
    return this.db
      .prepare(
        `SELECT id, version, lifecycle_state AS state,
                deletion_requested_at AS requestedAt,
                deletion_finalize_at AS finalizeAt,
                deleted_at AS deletedAt
         FROM households WHERE lifecycle_state <> 'active'`,
      )
      .all();
  },
};
