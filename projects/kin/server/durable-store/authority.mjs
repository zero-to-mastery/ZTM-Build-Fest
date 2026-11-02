// DurableStore active authority: reading it and merging another process's
// authority and lifecycle snapshots (restore).
import { purgeHouseholdData } from "./lifecycle.mjs";
import { DurableConflictError, DurableStoreError, isId, isTimestamp } from "./shared.mjs";

export const authorityMethods = {
  loadActiveAuthority() {
    this.assertAvailable();
    return this.db
      .prepare("SELECT id FROM households WHERE lifecycle_state = 'active'")
      .all()
      .map(({ id: householdId }) => ({
        householdId,
        household: this.db
          .prepare("SELECT * FROM households WHERE id = ?")
          .get(householdId),
        members: this.db
          .prepare("SELECT * FROM members WHERE household_id = ?")
          .all(householdId),
        credentials: this.db
          .prepare(
            "SELECT c.* FROM credentials c JOIN members m ON m.id = c.member_id WHERE m.household_id = ?",
          )
          .all(householdId),
        devices: this.db
          .prepare("SELECT * FROM devices WHERE household_id = ?")
          .all(householdId),
        sync: this.db
          .prepare(
            "SELECT current_epoch, enabled, rotation_pending, last_rotation_json FROM sync_households WHERE household_id = ?",
          )
          .get(householdId),
        grants: this.db
          .prepare("SELECT * FROM provisioning_grants WHERE household_id = ?")
          .all(householdId),
      }));
  },

  mergeActiveAuthority(snapshots) {
    if (!Array.isArray(snapshots))
      throw new DurableStoreError("Kin household authority backup data is invalid.");
    return this.transaction(() => {
      let preserved = 0;
      for (const snapshot of snapshots) {
        const current = this.statements.getHousehold.get(snapshot.householdId);
        if (!current)
          throw new DurableConflictError(
            "restore_missing_active_household",
            "Cannot restore a backup that predates a currently active household.",
          );
        if (
          !snapshot.household ||
          snapshot.household.id !== snapshot.householdId ||
          snapshot.household.lifecycle_state !== "active" ||
          !Array.isArray(snapshot.members) ||
          !Array.isArray(snapshot.credentials) ||
          !Array.isArray(snapshot.devices) ||
          !Array.isArray(snapshot.grants)
        )
          throw new DurableStoreError("Kin household authority backup data is invalid.");

        const restoreOverNonActive = current.lifecycle_state !== "active";
        // Simple view (#343) is an admin's current choice, like the chat and
        // fridge policies: a restore keeps it, never the older backup's.
        const currentSimpleView = new Map(this.db.prepare("SELECT id, simple_view FROM members WHERE household_id = ?")
          .all(snapshot.householdId).map((row) => [row.id, row.simple_view]));
        this.db.prepare("DELETE FROM provisioning_grants WHERE household_id = ?").run(snapshot.householdId);
        if (!restoreOverNonActive)
          this.db.prepare("DELETE FROM devices WHERE household_id = ?").run(snapshot.householdId);
        this.db.prepare("DELETE FROM credentials WHERE member_id IN (SELECT id FROM members WHERE household_id = ?)").run(snapshot.householdId);
        if (!restoreOverNonActive)
          this.db.prepare("DELETE FROM members WHERE household_id = ?").run(snapshot.householdId);
        this.db
          .prepare(
            `UPDATE households SET version = ?, lifecycle_state = 'active',
             deletion_requested_at = NULL, deletion_finalize_at = NULL,
             deleted_at = NULL, chat_limited = ?, chat_temporary = ?, chat_policy_revision = ?,
             board_limited = ?, board_temporary = ?, board_policy_revision = ?,
             private_limited = ?, private_policy_revision = ?,
             features_off = ?, features_revision = ?, chore_adults = ?, chore_adults_revision = ? WHERE id = ?`,
          )
          // The chat access policy (#123) is authority like household_admin:
          // a restore keeps the current one, never the older backup's.
          .run(
            Math.max(current.version, snapshot.household.version),
            snapshot.household.chat_limited ?? "write", snapshot.household.chat_temporary ?? "write",
            snapshot.household.chat_policy_revision ?? 0,
            snapshot.household.board_limited ?? "write", snapshot.household.board_temporary ?? "write",
            snapshot.household.board_policy_revision ?? 0,
            snapshot.household.private_limited ?? 1, snapshot.household.private_policy_revision ?? 0,
            snapshot.household.features_off ?? 0, snapshot.household.features_revision ?? 0,
            snapshot.household.chore_adults ?? 0, snapshot.household.chore_adults_revision ?? 0, snapshot.householdId,
          );
        const insertMember = this.db.prepare(
          `INSERT INTO members(id, household_id, active, credential_ids, kind, expires_at, member_status, household_admin, simple_view, username)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             username = excluded.username,
             household_id = excluded.household_id,
             active = excluded.active,
             credential_ids = excluded.credential_ids,
             kind = excluded.kind,
             expires_at = excluded.expires_at,
             member_status = excluded.member_status,
             household_admin = excluded.household_admin,
             simple_view = excluded.simple_view`,
        );
        for (const row of snapshot.members)
          insertMember.run(row.id, row.household_id, row.active, row.credential_ids, row.kind ?? "adult", row.expires_at ?? null, row.member_status ?? (row.active ? "active" : "removed"), row.household_admin ?? 0, row.kind === "limited" ? currentSimpleView.get(row.id) ?? row.simple_view ?? 0 : 0, row.username ?? null);
        const insertCredential = this.db.prepare(
          "INSERT INTO credentials(id, member_id, credential_json) VALUES (?, ?, ?)",
        );
        for (const row of snapshot.credentials)
          insertCredential.run(row.id, row.member_id, row.credential_json);
        const insertDevice = this.db.prepare(
          `INSERT INTO devices(id, household_id, member_id, token_hash, revoked_at, device_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             household_id = excluded.household_id,
             member_id = excluded.member_id,
             token_hash = excluded.token_hash,
             revoked_at = excluded.revoked_at,
             device_json = excluded.device_json`,
        );
        for (const row of snapshot.devices)
          insertDevice.run(row.id, row.household_id, row.member_id, row.token_hash, row.revoked_at, row.device_json);

        if (snapshot.sync) {
          this.db
            .prepare(
              `INSERT INTO sync_households (
                 household_id, current_epoch, enabled, rotation_pending,
                 next_sequence, last_rotation_json
               ) VALUES (?, ?, ?, ?, 1, ?)
               ON CONFLICT(household_id) DO UPDATE SET
                 current_epoch = excluded.current_epoch,
                 enabled = excluded.enabled,
                 rotation_pending = excluded.rotation_pending,
                 last_rotation_json = excluded.last_rotation_json`,
            )
            .run(
              snapshot.householdId,
              Number(snapshot.sync.current_epoch),
              Number(snapshot.sync.enabled),
              Number(snapshot.sync.rotation_pending),
              snapshot.sync.last_rotation_json,
            );
          const insertGrant = this.db.prepare(
            "INSERT INTO provisioning_grants(household_id, grant_id, sender_device_id, recipient_device_id, request_id, expires_at, grant_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          );
          for (const row of snapshot.grants)
            insertGrant.run(row.household_id, row.grant_id, row.sender_device_id, row.recipient_device_id, row.request_id, row.expires_at, row.grant_json);
          const mergedSync = this.db
            .prepare("SELECT current_epoch, rotation_pending FROM sync_households WHERE household_id = ?")
            .get(snapshot.householdId);
          if (
            !mergedSync ||
            mergedSync.current_epoch !== Number(snapshot.sync.current_epoch) ||
            mergedSync.rotation_pending !== Number(snapshot.sync.rotation_pending)
          )
            throw new DurableStoreError("Kin household authority backup data is invalid.");
        }
        preserved += 1;
      }
      this.validate();
      return preserved;
    });
  },

  mergeHouseholdLifecycle(lifecycleRows) {
    if (!Array.isArray(lifecycleRows))
      throw new DurableStoreError("Kin household lifecycle backup data is invalid.");
    return this.transaction(() => {
      let preserved = 0;
      for (const marker of lifecycleRows) {
        if (
          !isId(marker.id) ||
          !Number.isSafeInteger(marker.version) ||
          marker.version < 1 ||
          !["deletion_pending", "deleted"].includes(marker.state)
        )
          throw new DurableStoreError("Kin household lifecycle backup data is invalid.");
        const current = this.statements.getHousehold.get(marker.id);
        const useMarker =
          !current ||
          (marker.state === "deleted" &&
            current.lifecycle_state !== "deleted") ||
          (marker.state === "deletion_pending" &&
            current.lifecycle_state === "active") ||
          (marker.state === "deletion_pending" &&
            current.lifecycle_state === "deletion_pending" &&
            marker.requestedAt > current.deletion_requested_at);
        if (!useMarker) continue;

        if (marker.state === "deletion_pending") {
          if (
            !isTimestamp(marker.requestedAt) ||
            !isTimestamp(marker.finalizeAt) ||
            marker.finalizeAt <= marker.requestedAt
          )
            throw new DurableStoreError("Kin household lifecycle backup data is invalid.");
          this.db
            .prepare(
              `INSERT INTO households (
                 id, version, lifecycle_state, deletion_requested_at,
                 deletion_finalize_at, deleted_at
               ) VALUES (?, ?, 'deletion_pending', ?, ?, NULL)
               ON CONFLICT(id) DO UPDATE SET
                 lifecycle_state = 'deletion_pending',
                 deletion_requested_at = excluded.deletion_requested_at,
                 deletion_finalize_at = excluded.deletion_finalize_at,
                 deleted_at = NULL`,
            )
            .run(
              marker.id,
              Math.max(marker.version, current?.version ?? 1),
              marker.requestedAt,
              marker.finalizeAt,
            );
        } else {
          if (!isTimestamp(marker.deletedAt))
            throw new DurableStoreError("Kin household lifecycle backup data is invalid.");
          this.db
            .prepare(
              `INSERT INTO households (
                 id, version, lifecycle_state, deleted_at
               ) VALUES (?, ?, 'deleted', ?)
               ON CONFLICT(id) DO UPDATE SET
                 lifecycle_state = 'deleted',
                 deletion_requested_at = NULL,
                 deletion_finalize_at = NULL,
                 deleted_at = excluded.deleted_at`,
            )
            .run(
              marker.id,
              Math.max(marker.version, current?.version ?? 1),
              marker.deletedAt,
            );
          purgeHouseholdData(this.db, marker.id);
        }
        preserved += 1;
      }
      return preserved;
    });
  },
};
