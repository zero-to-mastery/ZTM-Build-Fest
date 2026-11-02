// The durable SQLite store behind the identity service and sync relay.
// This file holds the DurableStore class core: opening (locks, pragmas,
// migration, validation), transactions, backup and restore. Its method
// groups live in durable-store/ and are attached below with addMethods:
// schema.mjs (migrations), validation.mjs, identity.mjs (households,
// members, devices, sessions, settings), lifecycle.mjs (deletion and
// purge), authority.mjs (merging authority snapshots) and envelopes.mjs
// (sync state, event envelopes, attachments). lock.mjs and shared.mjs hold
// the lock files, constants, errors and helpers; their public names are
// re-exported here, so importers keep using "./durable-store.mjs".
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authorityMethods } from "./durable-store/authority.mjs";
import { envelopeMethods } from "./durable-store/envelopes.mjs";
import { identityMethods } from "./durable-store/identity.mjs";
import { installIdentityMethods } from "./durable-store/install-identity.mjs";
import { pushMethods } from "./durable-store/push.mjs";
import { chatBlobMethods } from "./durable-store/chat-blobs.mjs";
import { chatEventMethods } from "./durable-store/chat-events.mjs";
import { boardEventMethods } from "./durable-store/board-events.mjs";
import { privateEventMethods } from "./durable-store/private-events.mjs";
import { privateBlobMethods } from "./durable-store/private-blobs.mjs";
import { chatHiddenMethods } from "./durable-store/chat-hidden.mjs";
import { chatKeyMethods } from "./durable-store/chat-keys.mjs";
import { chatReceiptMethods } from "./durable-store/chat-receipts.mjs";
import { accountVaultMethods } from "./durable-store/account-vault.mjs";
import { lifecycleMethods } from "./durable-store/lifecycle.mjs";
import { feedbackMethods } from "./durable-store/feedback.mjs";
import { preparedInvitationMethods } from "./durable-store/prepared-invitations.mjs";
import { calendarSubscriptionMethods } from "./durable-store/calendar-subscriptions.mjs";
import { householdMoveMethods } from "./durable-store/household-moves.mjs";
import {
  acquireDatabaseMaintenanceLock,
  acquireDatabaseProcessLock,
} from "./durable-store/lock.mjs";
import { schemaMethods } from "./durable-store/schema.mjs";
import {
  BUSY_TIMEOUT_MS,
  DurableConflictError,
  DurableStoreError,
  exists,
  isSqliteError,
  samePath,
  sqlitePragma,
} from "./durable-store/shared.mjs";
import { validationMethods } from "./durable-store/validation.mjs";
import { addMethods } from "./mixins.mjs";

export {
  acquireDatabaseMaintenanceLock,
  acquireDatabaseProcessLock,
  databaseLockPath,
  databaseMaintenanceLockPath,
  hasDatabaseMaintenanceLock,
  hasDatabaseProcessLock,
} from "./durable-store/lock.mjs";
export {
  DurableConflictError,
  DurableStoreError,
  HOUSEHOLD_DELETION_GRACE_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_HOUSEHOLD_ATTACHMENT_BYTES,
  MAX_HOUSEHOLD_ATTACHMENTS,
  ALBUM_ATTACHMENT_PREFIX,
  MAX_HOUSEHOLD_ALBUM_ATTACHMENTS,
  MAX_HOUSEHOLD_ALBUM_BYTES,
  isAlbumAttachmentId,
  MAX_CHAT_BLOB_BYTES,
  MAX_HOUSEHOLD_CHAT_BLOB_BYTES,
  MAX_HOUSEHOLD_CHAT_BLOBS,
  MAX_HOUSEHOLD_CHAT_EVENTS,
  MAX_CHAT_HIDDEN_RECORD_BYTES,
  MAX_CHAT_RECEIPT_BYTES,
  MAX_MEMBER_CHAT_CLAIMS,
  MAX_MEMBER_PRIVATE_EVENTS,
  MAX_MEMBER_PRIVATE_BLOB_BYTES,
  MAX_MEMBER_PRIVATE_BLOBS,
  MAX_PRIVATE_BLOB_BYTES,
  MIN_PRIVATE_BLOB_BYTES,
  MAX_ACCOUNT_VAULT_BYTES,
  MAX_ACCOUNT_VAULT_WRAPPERS,
  MIN_ACCOUNT_VAULT_BYTES,
  ACCOUNT_VAULT_WRAPPED_KEY_BYTES,
  ACCOUNT_VAULT_WRAPPER_TYPES,
  MAX_ACCOUNT_VAULT_WRAPPER_PARAMS_BYTES,
  MIN_ACCOUNT_PASSWORD_ITERATIONS,
  MAX_HOUSEHOLD_CHAT_TOMBSTONES,
  MIN_CHAT_BLOB_BYTES,
  sqlitePragma,
} from "./durable-store/shared.mjs";

export class DurableStore {
  static async createBackup(databasePath, destination) {
    const source = resolve(databasePath);
    if (!exists(source))
      throw new DurableStoreError("The Kin database does not exist.");
    const releaseMaintenanceLock = acquireDatabaseMaintenanceLock(
      source,
      "backup",
    );
    let store;
    try {
      store = new DurableStore(source, { acquireProcessLock: false });
      return await store.backup(destination, { maintenanceLockHeld: true });
    } finally {
      try {
        store?.close();
      } finally {
        releaseMaintenanceLock();
      }
    }
  }

  static async restoreBackup(
    sourcePath,
    targetPath,
    { acknowledgeDeletionHistory = false } = {},
  ) {
    if (!acknowledgeDeletionHistory)
      throw new DurableStoreError(
        "Restoring a backup requires explicit acknowledgement that it may predate household deletions.",
      );
    const source = resolve(sourcePath);
    const target = resolve(targetPath);
    if (samePath(source, target))
      throw new DurableStoreError(
        "A Kin backup cannot be restored over its own source.",
      );
    const releaseMaintenanceLock = acquireDatabaseMaintenanceLock(
      target,
      "restore",
    );
    let releaseServiceLock;
    const temporary = `${target}.${randomBytes(8).toString("hex")}.restore`;
    const lifecycleSnapshot = `${target}.${randomBytes(8).toString("hex")}.lifecycle`;
    const previous = `${target}.pre-restore-${Date.now()}-${randomBytes(4).toString("hex")}`;
    let sourceStore;
    let targetStore;
    let restoredStore;
    let currentAuthority = [];
    let movedDatabase = false;
    const movedSidecars = [];
    try {
      releaseServiceLock = acquireDatabaseProcessLock(target, {
        operation: "restore",
      });
      if (!exists(source) || !statSync(source).isFile())
        throw new DurableStoreError(
          "The Kin restore source must be an existing database file.",
        );
      const currentDeletions = [];
      if (exists(target)) {
        if (!statSync(target).isFile())
          throw new DurableStoreError(
            "The Kin restore target must be a database file.",
          );
        copyFileSync(target, lifecycleSnapshot);
        for (const suffix of ["-wal", "-shm"])
          if (exists(`${target}${suffix}`))
            copyFileSync(`${target}${suffix}`, `${lifecycleSnapshot}${suffix}`);
        targetStore = new DurableStore(lifecycleSnapshot, {
          acquireProcessLock: false,
          readonly: true,
        });
        currentDeletions.push(...targetStore.loadNonActiveHouseholds());
        if (currentDeletions.some((household) => household.state === "deletion_pending"))
          throw new DurableConflictError(
            "restore_blocked_deletion_pending",
            "Cannot restore over a household with a pending deletion. Cancel the deletion using current household authority or allow it to finalize first.",
          );
        currentAuthority = targetStore.loadActiveAuthority();
        targetStore.close();
        targetStore = undefined;
      }
      // The same startup validator checks the source without creating,
      // migrating or changing it before replacement.
      sourceStore = new DurableStore(source, {
        acquireProcessLock: false,
        readonly: true,
      });
      await sourceStore.backup(temporary, { maintenanceLockHeld: true });
      restoredStore = new DurableStore(temporary, {
        acquireProcessLock: false,
      });
      const preservedDeletionCount =
        restoredStore.mergeHouseholdLifecycle(currentDeletions);
      const preservedAuthorityCount =
        restoredStore.mergeActiveAuthority(currentAuthority);
      // The temporary database is published by renaming only its main file.
      // Checkpoint every merged lifecycle/authority write before that rename.
      sqlitePragma(restoredStore.db, "wal_checkpoint(TRUNCATE)");
      restoredStore.close();
      restoredStore = undefined;

      if (exists(target)) {
        renameSync(target, previous);
        movedDatabase = true;
      }
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${target}${suffix}`;
        if (!exists(sidecar)) continue;
        const previousSidecar = `${previous}${suffix}`;
        renameSync(sidecar, previousSidecar);
        movedSidecars.push([sidecar, previousSidecar]);
      }
      renameSync(temporary, target);
      return {
        databasePath: target,
        preservedDeletionCount,
        preservedAuthorityCount,
        previousDatabasePath:
          movedDatabase || movedSidecars.length ? previous : null,
      };
    } catch (error) {
      if (exists(target) && movedDatabase) rmSync(target, { force: true });
      for (const [sidecar, previousSidecar] of movedSidecars)
        if (exists(previousSidecar)) renameSync(previousSidecar, sidecar);
      if (movedDatabase && exists(previous)) renameSync(previous, target);
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError("Kin could not restore the verified backup.", {
        cause: error,
      });
    } finally {
      try {
        restoredStore?.close();
      } finally {
        try {
          targetStore?.close();
        } finally {
          try {
            sourceStore?.close();
          } finally {
            try {
              rmSync(lifecycleSnapshot, { force: true });
              rmSync(`${lifecycleSnapshot}-wal`, { force: true });
              rmSync(`${lifecycleSnapshot}-shm`, { force: true });
              rmSync(temporary, { force: true });
            } finally {
              try {
                releaseServiceLock?.();
              } finally {
                releaseMaintenanceLock();
              }
            }
          }
        }
      }
    }
  }

  constructor(
    databasePath,
    { migrationFault, acquireProcessLock = true, readonly = false } = {},
  ) {
    this.databasePath =
      databasePath === ":memory:" ? databasePath : resolve(databasePath);
    this.failed = false;
    this.closed = false;
    this.transactionDepth = 0;

    this.releaseProcessLock =
      acquireProcessLock && !readonly && this.databasePath !== ":memory:"
        ? acquireDatabaseProcessLock(this.databasePath)
        : null;
    this.processLockAcquired = Boolean(this.releaseProcessLock);
    if (!readonly && this.databasePath !== ":memory:") {
      try {
        mkdirSync(dirname(this.databasePath), {
          recursive: true,
          mode: 0o700,
        });
        if (process.platform !== "win32")
          chmodSync(dirname(this.databasePath), 0o700);
      } catch (error) {
        this.releaseProcessLock?.();
        throw new DurableStoreError(
          "Kin could not secure the durable data directory.",
          { cause: error },
        );
      }
    }

    try {
      // node:sqlite's own busy timeout replaces the earlier busy_timeout
      // pragma: a locked database is retried for this long (#106).
      this.db = new DatabaseSync(this.databasePath, {
        readOnly: readonly,
        enableForeignKeyConstraints: true,
        timeout: BUSY_TIMEOUT_MS,
      });
      sqlitePragma(this.db, "foreign_keys = ON");
      sqlitePragma(this.db, "trusted_schema = OFF");
      if (!readonly && this.databasePath !== ":memory:") {
        sqlitePragma(this.db, "journal_mode = WAL");
        sqlitePragma(this.db, "synchronous = FULL");
      }
      if (!readonly) this.migrate(migrationFault);
      if (!readonly && this.databasePath !== ":memory:" && process.platform !== "win32")
        chmodSync(this.databasePath, 0o600);
      this.prepareStatements();
      this.validate();
    } catch (error) {
      this.db?.close();
      this.releaseProcessLock?.();
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError(
        "Kin could not open or validate its durable data store.",
        { cause: error },
      );
    }
  }

  prepareStatements() {
    this.statements = {
      getHousehold: this.db.prepare("SELECT * FROM households WHERE id = ?"),
      getMember: this.db.prepare("SELECT * FROM members WHERE id = ?"),
      getCredential: this.db.prepare("SELECT * FROM credentials WHERE id = ?"),
      getDevice: this.db.prepare("SELECT * FROM devices WHERE id = ?"),
      getSyncHousehold: this.db.prepare(
        "SELECT * FROM sync_households WHERE household_id = ?",
      ),
      getEvent: this.db.prepare(
        "SELECT event_id, relay_sequence, canonical_envelope AS canonical FROM sync_events WHERE household_id = ? AND event_id = ?",
      ),
      countEvents: this.db.prepare(
        "SELECT COUNT(*) AS count FROM sync_events WHERE household_id = ?",
      ),
      eventsAfter: this.db.prepare(
        "SELECT household_id, relay_sequence, event_id, device_id, device_sequence, key_epoch, canonical_envelope FROM sync_events WHERE household_id = ? AND relay_sequence > ? ORDER BY relay_sequence LIMIT ?",
      ),
      eventAfterExists: this.db.prepare(
        "SELECT 1 FROM sync_events WHERE household_id = ? AND relay_sequence > ? LIMIT 1",
      ),
    };
  }

  assertAvailable() {
    if (this.closed || this.failed)
      throw new DurableStoreError(
        "Kin durable storage is unavailable; restart the service before retrying.",
      );
  }

  /** `using store = new DurableStore(…)` closes it at the end of the block. */
  [Symbol.dispose]() {
    this.close();
  }

  transaction(operation) {
    this.assertAvailable();
    const depth = this.transactionDepth;
    const savepoint = `kin_transaction_${depth}`;
    // SQLite's own view must agree with the nesting count: an outer call
    // opens the only transaction. Anything else is a leaked transaction,
    // and continuing could commit someone else's partial work.
    if (this.db.isTransaction !== depth > 0) {
      this.failed = true;
      throw new DurableStoreError("Kin found an unexpected open database transaction.");
    }
    let began = false;
    this.transactionDepth += 1;
    try {
      this.db.exec(
        depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`,
      );
      began = true;
      const result = operation();
      this.db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          this.db.exec(
            depth === 0
              ? "ROLLBACK"
              : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
          );
        } catch (rollbackError) {
          this.failed = true;
          throw new AggregateError(
            [error, rollbackError],
            "Kin could not roll back its durable transaction.",
          );
        }
      }
      if (
        isSqliteError(error) ||
        (error instanceof DurableStoreError &&
          !(error instanceof DurableConflictError))
      )
        this.failed = true;
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  health() {
    return this.validate();
  }

  async backup(destination, { maintenanceLockHeld = false } = {}) {
    const releaseMaintenanceLock =
      maintenanceLockHeld || this.databasePath === ":memory:"
        ? null
        : acquireDatabaseMaintenanceLock(this.databasePath, "backup");
    try {
      this.validate();
      if (!isAbsolute(destination))
        throw new DurableStoreError("A backup destination must be absolute.");
      const target = resolve(destination);
      if (this.databasePath !== ":memory:" && samePath(target, this.databasePath))
        throw new DurableStoreError(
          "A backup cannot replace the active database.",
        );
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (exists(target))
        throw new DurableStoreError("The backup destination already exists.");
      const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
      let createdTarget = false;
      try {
        await new Promise((resolve) => setImmediate(resolve));
        this.db.prepare("VACUUM INTO ?").run(temporary);
        const verification = new DurableStore(temporary, {
          acquireProcessLock: false,
          readonly: true,
        });
        verification.close();
        if (process.platform !== "win32") chmodSync(temporary, 0o600);
        // Publish without overwriting a destination created during the backup.
        linkSync(temporary, target);
        createdTarget = true;
        unlinkSync(temporary);
        return target;
      } catch (error) {
        try {
          if (createdTarget) rmSync(target, { force: true });
          rmSync(temporary, { force: true });
        } catch (cleanupError) {
          throw new DurableStoreError(
            "Kin could not clean up the temporary backup file.",
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
        if (error instanceof DurableStoreError) throw error;
        throw new DurableStoreError("Kin could not create a verified backup.", {
          cause: error,
        });
      }
    } finally {
      try {
        releaseMaintenanceLock?.();
      } catch (error) {
        throw error;
      }
    }
  }

  close() {
    if (!this.closed) {
      try {
        this.db.close();
        this.closed = true;
      } finally {
        this.releaseProcessLock?.();
      }
    }
  }
}

addMethods(DurableStore, schemaMethods, validationMethods, identityMethods, installIdentityMethods, pushMethods, chatBlobMethods, chatEventMethods, boardEventMethods, privateEventMethods, privateBlobMethods, chatHiddenMethods, chatKeyMethods, chatReceiptMethods, accountVaultMethods, lifecycleMethods, authorityMethods, envelopeMethods, feedbackMethods, preparedInvitationMethods, calendarSubscriptionMethods, householdMoveMethods);
