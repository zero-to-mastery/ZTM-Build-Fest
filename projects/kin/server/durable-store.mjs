import Database from "better-sqlite3";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  CANONICAL_ENVELOPE_FIELDS,
  isDurableGrantValid,
  isDurableRotationValid,
  isEventEnvelopeValid,
  MAX_BINDINGS,
  MAX_HOUSEHOLD_EVENTS,
  MAX_KEY_EPOCHS,
} from "./sync-contract.mjs";
import { MAX_ACTIVE_MEMBERS, MAX_TRUSTED_DEVICES } from "./identity-limits.mjs";
import {
  validCredentialId,
  validStoredCredential,
  validStoredDevice,
} from "./durable-identity.mjs";

const SERVER_SCHEMA_VERSION = 1;
const MAX_AUDIT_ROWS = 10_000;
const BUSY_TIMEOUT_MS = 5_000;

export class DurableStoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DurableStoreError";
  }
}

export class DurableConflictError extends DurableStoreError {
  constructor(code, message) {
    super(message);
    this.name = "DurableConflictError";
    this.code = code;
  }
}

export function acquireDatabaseProcessLock(
  databasePath,
  { operation = "service" } = {},
) {
  return acquireExclusiveLock(databaseLockPath(databasePath), operation);
}

export function acquireDatabaseMaintenanceLock(databasePath, operation) {
  return acquireExclusiveLock(databaseMaintenanceLockPath(databasePath), operation);
}

function acquireExclusiveLock(lockPath, operation) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(
      descriptor,
      JSON.stringify({
        pid: process.pid,
        token,
        operation,
        startedAt: Date.now(),
      }),
      "utf8",
    );
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      try {
        unlinkSync(lockPath);
      } catch (cleanupError) {
        throw new DurableStoreError(
          "Kin could not clean up a failed service lock.",
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
    }
    if (error.code === "EEXIST") {
      const lockError = new DurableStoreError(
        `A Kin service or maintenance lock already exists at ${JSON.stringify(lockPath)}. Inspect its PID, operation and start time, and confirm no Kin service, backup or restore operation is using this database. Only after confirming all such processes have stopped, remove this lock file manually and retry. Never remove an active lock.`,
        { cause: error },
      );
      lockError.code = "durable_lock_exists";
      throw lockError;
    }
    throw new DurableStoreError("Kin could not acquire its exclusive lock.", {
      cause: error,
    });
  }
  closeSync(descriptor);
  return () => {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      if (lock.token === token) unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new DurableStoreError("Kin could not release its exclusive lock.", {
          cause: error,
        });
    }
  };
}

export function databaseLockPath(databasePath) {
  return `${resolve(databasePath)}.service.lock`;
}

export function databaseMaintenanceLockPath(databasePath) {
  return `${resolve(databasePath)}.maintenance.lock`;
}

export function hasDatabaseProcessLock(databasePath) {
  return exists(databaseLockPath(databasePath));
}

export function hasDatabaseMaintenanceLock(databasePath) {
  return exists(databaseMaintenanceLockPath(databasePath));
}

function decodeCanonicalEnvelope(value) {
  const pairs = parseJson(value);
  if (
    !Array.isArray(pairs) ||
    pairs.length !== CANONICAL_ENVELOPE_FIELDS.length ||
    pairs.some(
      (pair, index) =>
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair[0] !== CANONICAL_ENVELOPE_FIELDS[index],
    )
  )
    throw new DurableStoreError("Kin encrypted relay data is invalid.");
  const envelope = Object.fromEntries(pairs);
  if (!isEventEnvelopeValid(envelope))
    throw new DurableStoreError("Kin encrypted relay data is invalid.");
  return envelope;
}

function validateEventRow(row, householdId) {
  const envelope = decodeCanonicalEnvelope(row.canonical_envelope);
  if (
    envelope.eventId !== row.event_id ||
    envelope.householdId !== householdId ||
    row.household_id !== householdId ||
    envelope.deviceId !== row.device_id ||
    envelope.deviceSequence !== row.device_sequence ||
    envelope.keyEpoch !== row.key_epoch ||
    !Number.isSafeInteger(row.relay_sequence) ||
    row.relay_sequence < 1
  )
    throw new DurableStoreError("Kin encrypted relay data is invalid.");
  return {
    sequence: row.relay_sequence,
    keyEpoch: row.key_epoch,
    envelope,
  };
}

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

  static async restoreBackup(sourcePath, targetPath) {
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
    const previous = `${target}.pre-restore-${Date.now()}-${randomBytes(4).toString("hex")}`;
    let sourceStore;
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
      // The same startup validator checks the source without creating,
      // migrating or changing it before replacement.
      sourceStore = new DurableStore(source, {
        acquireProcessLock: false,
        readonly: true,
      });
      await sourceStore.backup(temporary, { maintenanceLockHeld: true });

      if (exists(target)) {
        if (!statSync(target).isFile())
          throw new DurableStoreError(
            "The Kin restore target must be a database file.",
          );
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
        sourceStore?.close();
      } finally {
        try {
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

  constructor(
    databasePath,
    { migrationFault, acquireProcessLock = true, readonly = false } = {},
  ) {
    this.databasePath =
      databasePath === ":memory:" ? databasePath : resolve(databasePath);
    this.failed = false;
    this.closed = false;

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
      this.db = new Database(this.databasePath, { readonly, fileMustExist: readonly });
      this.db.pragma("foreign_keys = ON");
      this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      this.db.pragma("trusted_schema = OFF");
      if (!readonly && this.databasePath !== ":memory:") {
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = FULL");
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

  migrate(migrationFault) {
    const version = this.db.pragma("user_version", { simple: true });
    if (!Number.isSafeInteger(version) || version < 0)
      throw new DurableStoreError("Kin server schema metadata is invalid.");
    if (version > SERVER_SCHEMA_VERSION)
      throw new DurableStoreError(
        "The Kin database was created by a newer server version.",
      );
    if (version === SERVER_SCHEMA_VERSION) {
      const migrations = this.db
        .prepare("SELECT version FROM server_migrations ORDER BY version")
        .all();
      if (
        migrations.length !== SERVER_SCHEMA_VERSION ||
        migrations[0]?.version !== SERVER_SCHEMA_VERSION
      )
        throw new DurableStoreError("Kin server migration metadata is invalid.");
      return;
    }

    const existingTables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    if (existingTables.length)
      throw new DurableStoreError(
        "The Kin database has unversioned data and cannot be migrated safely.",
      );

    try {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE server_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
          );
          CREATE TABLE households (
            id TEXT PRIMARY KEY,
            version INTEGER NOT NULL CHECK (version >= 1)
          );
          CREATE TABLE members (
            id TEXT PRIMARY KEY,
            household_id TEXT NOT NULL REFERENCES households(id),
            active INTEGER NOT NULL CHECK (active IN (0, 1)),
            credential_ids TEXT NOT NULL,
            UNIQUE (id, household_id)
          );
          CREATE INDEX members_by_household ON members(household_id);
          CREATE TRIGGER members_active_limit_insert
          BEFORE INSERT ON members
          WHEN NEW.active = 1 AND (
            SELECT COUNT(*) FROM members
            WHERE household_id = NEW.household_id AND active = 1
              AND id <> NEW.id
          ) >= 2
          BEGIN
            SELECT RAISE(ABORT, 'household active member limit');
          END;
          CREATE TRIGGER members_active_limit_update
          BEFORE UPDATE OF active, household_id ON members
          WHEN NEW.active = 1 AND (
            SELECT COUNT(*) FROM members
            WHERE household_id = NEW.household_id AND active = 1
              AND id <> NEW.id
          ) >= 2
          BEGIN
            SELECT RAISE(ABORT, 'household active member limit');
          END;
          CREATE TABLE credentials (
            id TEXT PRIMARY KEY,
            member_id TEXT NOT NULL REFERENCES members(id),
            credential_json TEXT NOT NULL
          );
          CREATE INDEX credentials_by_member ON credentials(member_id);
          CREATE TABLE devices (
            id TEXT PRIMARY KEY,
            household_id TEXT NOT NULL REFERENCES households(id),
            member_id TEXT NOT NULL,
            token_hash TEXT UNIQUE,
            revoked_at INTEGER,
            device_json TEXT NOT NULL,
            FOREIGN KEY (member_id, household_id)
              REFERENCES members(id, household_id),
            UNIQUE (id, household_id)
          );
          CREATE INDEX devices_by_household ON devices(household_id);
          CREATE INDEX devices_by_member ON devices(member_id);
          CREATE TRIGGER devices_active_limit_insert
          BEFORE INSERT ON devices
          WHEN NEW.revoked_at IS NULL AND (
            SELECT COUNT(*) FROM devices
            WHERE household_id = NEW.household_id AND revoked_at IS NULL
              AND id <> NEW.id
          ) >= 16
          BEGIN
            SELECT RAISE(ABORT, 'household trusted device limit');
          END;
          CREATE TRIGGER devices_active_limit_update
          BEFORE UPDATE OF revoked_at, household_id ON devices
          WHEN NEW.revoked_at IS NULL AND (
            SELECT COUNT(*) FROM devices
            WHERE household_id = NEW.household_id AND revoked_at IS NULL
              AND id <> NEW.id
          ) >= 16
          BEGIN
            SELECT RAISE(ABORT, 'household trusted device limit');
          END;
          CREATE TABLE sync_households (
            household_id TEXT PRIMARY KEY REFERENCES households(id),
            current_epoch INTEGER NOT NULL CHECK (current_epoch BETWEEN 1 AND 128),
            enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
            rotation_pending INTEGER NOT NULL CHECK (rotation_pending IN (0, 1)),
            next_sequence INTEGER NOT NULL CHECK (next_sequence BETWEEN 1 AND 100000001),
            last_rotation_json TEXT
          );
          CREATE TABLE sync_device_sequences (
            household_id TEXT NOT NULL REFERENCES sync_households(household_id),
            device_id TEXT NOT NULL,
            last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
            PRIMARY KEY (household_id, device_id),
            FOREIGN KEY (device_id, household_id)
              REFERENCES devices(id, household_id)
          );
          CREATE TABLE sync_events (
            household_id TEXT NOT NULL REFERENCES sync_households(household_id),
            relay_sequence INTEGER NOT NULL CHECK (relay_sequence BETWEEN 1 AND 100000000),
            event_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            device_sequence INTEGER NOT NULL CHECK (device_sequence >= 1),
            key_epoch INTEGER NOT NULL CHECK (key_epoch BETWEEN 1 AND 128),
            canonical_envelope TEXT NOT NULL,
            PRIMARY KEY (household_id, relay_sequence),
            UNIQUE (household_id, event_id),
            UNIQUE (household_id, device_id, device_sequence),
            FOREIGN KEY (device_id, household_id)
              REFERENCES devices(id, household_id)
          );
          CREATE INDEX sync_events_by_device_sequence
            ON sync_events(household_id, device_id, device_sequence);
          CREATE TABLE sync_bindings (
            household_id TEXT NOT NULL REFERENCES sync_households(household_id),
            event_id TEXT NOT NULL,
            canonical_envelope TEXT NOT NULL,
            PRIMARY KEY (household_id, event_id)
          );
          CREATE TABLE provisioning_grants (
            household_id TEXT NOT NULL REFERENCES sync_households(household_id),
            grant_id TEXT NOT NULL,
            sender_device_id TEXT NOT NULL,
            recipient_device_id TEXT NOT NULL,
            request_id TEXT,
            expires_at INTEGER NOT NULL,
            grant_json TEXT NOT NULL,
            PRIMARY KEY (household_id, grant_id),
            UNIQUE (household_id, sender_device_id, request_id),
            FOREIGN KEY (sender_device_id, household_id)
              REFERENCES devices(id, household_id),
            FOREIGN KEY (recipient_device_id, household_id)
              REFERENCES devices(id, household_id)
          );
          CREATE INDEX provisioning_by_expiry
            ON provisioning_grants(household_id, expires_at);
          CREATE TABLE security_audit (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            household_id TEXT NOT NULL REFERENCES households(id),
            created_at INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            details_json TEXT NOT NULL
          );
          CREATE INDEX security_audit_by_household
            ON security_audit(household_id, sequence);
        `);
        migrationFault?.();
        this.db
          .prepare(
            "INSERT INTO server_migrations(version, applied_at) VALUES (?, ?)",
          )
          .run(SERVER_SCHEMA_VERSION, Date.now());
        this.db.pragma(`user_version = ${SERVER_SCHEMA_VERSION}`);
      })();
    } catch (error) {
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError(
        "Kin could not complete the server schema migration.",
        { cause: error },
      );
    }
  }

  verify() {
    if (this.db.pragma("user_version", { simple: true }) !== SERVER_SCHEMA_VERSION)
      throw new DurableStoreError("Kin server schema metadata is invalid.");
    const migrations = this.db
      .prepare("SELECT version, applied_at FROM server_migrations ORDER BY version")
      .all();
    if (
      migrations.length !== SERVER_SCHEMA_VERSION ||
      migrations[0]?.version !== SERVER_SCHEMA_VERSION ||
      !Number.isSafeInteger(migrations[0]?.applied_at) ||
      migrations[0].applied_at < 0
    )
      throw new DurableStoreError("Kin server migration metadata is invalid.");
    const integrity = this.db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok")
      throw new DurableStoreError("Kin server database integrity check failed.");
    if (this.db.pragma("foreign_key_check").length)
      throw new DurableStoreError(
        "Kin server database relationships are inconsistent.",
      );
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

  transaction(operation) {
    this.assertAvailable();
    try {
      return this.db.transaction(operation).immediate();
    } catch (error) {
      // The SQLite wrapper completes rollback before rethrowing a conflict.
      // Rollback failures surface as SQLite errors and still fail closed.
      if (
        isSqliteError(error) ||
        (error instanceof DurableStoreError &&
          !(error instanceof DurableConflictError))
      )
        this.failed = true;
      throw error;
    }
  }

  loadIdentity() {
    this.assertAvailable();
    try {
      const households = new Map();
      const members = new Map();
      const credentials = new Map();
      const devices = new Map();
      const activeMemberCounts = new Map();
      const trustedDeviceCounts = new Map();
      for (const row of this.db.prepare("SELECT * FROM households").all()) {
        if (
          !isId(row.id) ||
          !Number.isSafeInteger(row.version) ||
          row.version < 1
        )
          throw new DurableStoreError("Kin server household data is invalid.");
        households.set(row.id, {
          id: row.id,
          members: new Set(),
          version: row.version,
        });
      }
      for (const row of this.db.prepare("SELECT * FROM members").all()) {
        const credentialIds = parseJson(row.credential_ids);
        if (
          !isId(row.id) ||
          !isId(row.household_id) ||
          ![0, 1].includes(row.active) ||
          !Array.isArray(credentialIds) ||
          credentialIds.some((id) => !validCredentialId(id)) ||
          new Set(credentialIds).size !== credentialIds.length
        )
          throw new DurableStoreError("Kin server membership data is invalid.");
        const member = {
          id: row.id,
          householdId: row.household_id,
          active: Boolean(row.active),
          credentials: new Set(credentialIds),
        };
        members.set(member.id, member);
        const household = households.get(member.householdId);
        if (!household)
          throw new DurableStoreError("Kin server membership data is invalid.");
        household.members.add(member.id);
        const activeCount =
          (activeMemberCounts.get(household.id) ?? 0) + row.active;
        if (activeCount > MAX_ACTIVE_MEMBERS)
          throw new DurableStoreError("Kin server membership data is invalid.");
        activeMemberCounts.set(household.id, activeCount);
      }
      for (const row of this.db.prepare("SELECT * FROM credentials").all()) {
        const credential = parseStoredJson(row.credential_json);
        if (
          !validStoredCredential(credential) ||
          !validCredentialId(row.id) ||
          credential.id !== row.id ||
          credential.memberId !== row.member_id ||
          !members.get(row.member_id)?.credentials.has(row.id)
        )
          throw new DurableStoreError("Kin server credential data is invalid.");
        credentials.set(row.id, credential);
      }
      for (const row of this.db.prepare("SELECT * FROM devices").all()) {
        const device = parseStoredJson(row.device_json);
        if (
          !validStoredDevice(device) ||
          !isId(row.id) ||
          !isId(row.household_id) ||
          !isId(row.member_id) ||
          device.id !== row.id ||
          device.memberId !== row.member_id ||
          device.householdId !== row.household_id ||
          device.tokenHash !== row.token_hash ||
          device.revokedAt !== row.revoked_at ||
          !households.has(row.household_id) ||
          members.get(row.member_id)?.householdId !== row.household_id
        )
          throw new DurableStoreError("Kin server device data is invalid.");
        devices.set(row.id, device);
        const trustedCount =
          (trustedDeviceCounts.get(row.household_id) ?? 0) +
          Number(row.revoked_at === null);
        if (trustedCount > MAX_TRUSTED_DEVICES)
          throw new DurableStoreError("Kin server device data is invalid.");
        trustedDeviceCounts.set(row.household_id, trustedCount);
      }
      for (const device of devices.values()) {
        const certificate = device.deviceAuthorizationCertificate;
        if (
          certificate &&
          devices.get(certificate.issuerDeviceId)?.householdId !== device.householdId
        )
          throw new DurableStoreError("Kin server device data is invalid.");
      }
      for (const member of members.values())
        for (const credentialId of member.credentials)
          if (credentials.get(credentialId)?.memberId !== member.id)
            throw new DurableStoreError(
              "Kin server credential data is invalid.",
            );
      return { households, members, credentials, devices };
    } catch (error) {
      this.failed = true;
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError("Kin server identity data is invalid.", {
        cause: error,
      });
    }
  }

  saveIdentityHousehold(householdId, service) {
    const household = service.households.get(householdId);
    if (!household)
      throw new DurableStoreError("Kin server household data is unavailable.");
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO households(id, version) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
        )
        .run(household.id, household.version);

      for (const memberId of household.members) {
        const member = service.members.get(memberId);
        if (!member || member.householdId !== householdId)
          throw new DurableStoreError("Kin server membership data is invalid.");
        this.db
          .prepare(
            "INSERT INTO members(id, household_id, active, credential_ids) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET active = excluded.active, credential_ids = excluded.credential_ids",
          )
          .run(
            member.id,
            householdId,
            Number(member.active),
            JSON.stringify([...member.credentials]),
          );
        for (const credentialId of member.credentials) {
          const credential = service.credentials.get(credentialId);
          if (!credential || credential.memberId !== memberId)
            throw new DurableStoreError("Kin server credential data is invalid.");
          this.db
            .prepare(
              "INSERT INTO credentials(id, member_id, credential_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET member_id = excluded.member_id, credential_json = excluded.credential_json",
            )
            .run(credentialId, memberId, stringifyStored(credential));
        }
      }

      const devices = [...service.devices.values()].filter(
        (device) => device.householdId === householdId,
      );
      for (const device of devices) {
        this.db
          .prepare(
            "INSERT INTO devices(id, household_id, member_id, token_hash, revoked_at, device_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, revoked_at = excluded.revoked_at, device_json = excluded.device_json",
          )
          .run(
            device.id,
            householdId,
            device.memberId,
            device.tokenHash,
            device.revokedAt,
            stringifyStored(device),
          );
      }

      const pendingAudit = service.events.filter(
        (event) => event.persisted !== true && event.householdId === householdId,
      );
      const insertAudit = this.db.prepare(
        "INSERT INTO security_audit(household_id, created_at, event_type, details_json) VALUES (?, ?, ?, ?)",
      );
      for (const event of pendingAudit) {
        insertAudit.run(
          householdId,
          event.at,
          event.type,
          JSON.stringify(auditDetails(event)),
        );
        event.persisted = true;
      }
      this.db
        .prepare(
          "DELETE FROM security_audit WHERE sequence <= COALESCE((SELECT MAX(sequence) - ? FROM security_audit), 0)",
        )
        .run(MAX_AUDIT_ROWS);
    });
  }

  loadSyncState(householdId, identity) {
    this.assertAvailable();
    try {
      if (
        !isId(householdId) ||
        !(identity?.households.has(householdId) ??
          Boolean(this.statements.getHousehold.get(householdId)))
      )
        throw new DurableStoreError("Kin synchronization data is invalid.");
      const devices = new Map();
      const getDevice = (deviceId) => {
        if (devices.has(deviceId)) return devices.get(deviceId);
        const stored = identity ? null : this.statements.getDevice.get(deviceId);
        const device = identity
          ? identity.devices.get(deviceId)
          : stored && parseStoredJson(stored.device_json);
        const member = device && (identity
          ? identity.members.get(device.memberId)
          : this.statements.getMember.get(device.memberId));
        if (
          !device ||
          !member ||
          device.id !== deviceId ||
          device.householdId !== householdId ||
          (identity ? member.householdId : member.household_id) !== householdId ||
          (!identity &&
            (stored.household_id !== householdId ||
              stored.member_id !== device.memberId))
        )
          throw new DurableStoreError("Kin synchronization data is invalid.");
        devices.set(deviceId, device);
        return device;
      };
      const row = this.statements.getSyncHousehold.get(householdId);
      if (
        row &&
        (row.household_id !== householdId ||
          !Number.isSafeInteger(row.current_epoch) ||
          row.current_epoch < 1 ||
          row.current_epoch > MAX_KEY_EPOCHS ||
          ![0, 1].includes(row.enabled) ||
          ![0, 1].includes(row.rotation_pending) ||
          !Number.isSafeInteger(row.next_sequence) ||
          row.next_sequence < 1 ||
          row.next_sequence > MAX_HOUSEHOLD_EVENTS + 1)
      )
        throw new DurableStoreError("Kin synchronization state is invalid.");
      const state = {
        currentEpoch: row?.current_epoch ?? 1,
        enabled: Boolean(row?.enabled ?? false),
        rotationPending: Boolean(row?.rotation_pending ?? false),
        nextSequence: row?.next_sequence ?? 1,
        records: [],
        eventCount: this.statements.countEvents.get(householdId).count,
        byEventId: new Map(),
        deviceSequence: new Map(),
        grants: new Map(),
        bindings: new Map(),
        lastRotation: row && row.last_rotation_json !== null
          ? parseJson(row.last_rotation_json)
          : null,
        grantRequests: new Map(),
      };
      for (const value of this.db
        .prepare(
          "SELECT household_id, device_id, last_sequence FROM sync_device_sequences WHERE household_id = ?",
        )
        .iterate(householdId)) {
        if (
          value.household_id !== householdId ||
          !isId(value.device_id) ||
          !Number.isSafeInteger(value.last_sequence) ||
          value.last_sequence < 0 ||
          value.last_sequence > MAX_HOUSEHOLD_EVENTS ||
          !getDevice(value.device_id)
        )
          throw new DurableStoreError("Kin synchronization data is invalid.");
        state.deviceSequence.set(value.device_id, value.last_sequence);
      }
      for (const value of this.db
        .prepare(
          "SELECT * FROM provisioning_grants WHERE household_id = ?",
        )
        .iterate(householdId)) {
        const grant = parseJson(value.grant_json);
        if (!isDurableGrantValid(grant, value, state.currentEpoch, getDevice))
          throw new DurableStoreError("Kin provisioning data is invalid.");
        state.grants.set(value.grant_id, grant);
        if (grant.requestId != null) {
          if (state.grantRequests.has(`${grant.senderDeviceId}:${grant.requestId}`))
            throw new DurableStoreError("Kin provisioning data is invalid.");
          state.grantRequests.set(
            `${grant.senderDeviceId}:${grant.requestId}`,
            grant.grantId,
          );
        }
      }
      for (const value of this.db
        .prepare(
          "SELECT household_id, event_id, canonical_envelope FROM sync_bindings WHERE household_id = ?",
        )
        .iterate(householdId)) {
        const binding = decodeCanonicalEnvelope(value.canonical_envelope);
        if (
          binding.eventId !== value.event_id ||
          binding.householdId !== value.household_id ||
          binding.householdId !== householdId ||
          binding.keyEpoch > state.currentEpoch ||
          binding.keyEpoch < (getDevice(binding.deviceId).syncHistoryFromEpoch ?? 1) ||
          state.bindings.size >= MAX_BINDINGS
        )
          throw new DurableStoreError("Kin identity-binding data is invalid.");
        state.bindings.set(value.event_id, {
          canonical: value.canonical_envelope,
          envelope: binding,
        });
      }
      if (
        !Number.isSafeInteger(state.eventCount) ||
        state.eventCount < 0 ||
        state.eventCount > MAX_HOUSEHOLD_EVENTS ||
        state.nextSequence !== state.eventCount + 1 ||
        !isDurableRotationValid(
          state.lastRotation,
          householdId,
          state.currentEpoch,
          getDevice,
        )
      )
        throw new DurableStoreError("Kin synchronization state is invalid.");
      return state;
    } catch (error) {
      this.failed = true;
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError("Kin synchronization data is invalid.", {
        cause: error,
      });
    }
  }

  saveSyncState(householdId, state, pairingService) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO sync_households(household_id, current_epoch, enabled, rotation_pending, next_sequence, last_rotation_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(household_id) DO UPDATE SET current_epoch = excluded.current_epoch, enabled = excluded.enabled, rotation_pending = excluded.rotation_pending, next_sequence = excluded.next_sequence, last_rotation_json = excluded.last_rotation_json",
        )
        .run(
          householdId,
          state.currentEpoch,
          Number(state.enabled),
          Number(state.rotationPending),
          state.nextSequence,
          state.lastRotation ? JSON.stringify(state.lastRotation) : null,
        );

      this.db
        .prepare("DELETE FROM sync_device_sequences WHERE household_id = ?")
        .run(householdId);
      const insertSequence = this.db.prepare(
        "INSERT INTO sync_device_sequences(household_id, device_id, last_sequence) VALUES (?, ?, ?)",
      );
      for (const [deviceId, sequence] of state.deviceSequence)
        insertSequence.run(householdId, deviceId, sequence);

      this.db
        .prepare("DELETE FROM provisioning_grants WHERE household_id = ?")
        .run(householdId);
      const insertGrant = this.db.prepare(
        "INSERT INTO provisioning_grants(household_id, grant_id, sender_device_id, recipient_device_id, request_id, expires_at, grant_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const grant of state.grants.values()) {
        insertGrant.run(
          householdId,
          grant.grantId,
          grant.senderDeviceId,
          grant.recipientDeviceId,
          grant.requestId ?? null,
          grant.expiresAt,
          JSON.stringify(grant),
        );
      }

      this.db
        .prepare("DELETE FROM sync_bindings WHERE household_id = ?")
        .run(householdId);
      const insertBinding = this.db.prepare(
        "INSERT INTO sync_bindings(household_id, event_id, canonical_envelope) VALUES (?, ?, ?)",
      );
      for (const [eventId, binding] of state.bindings)
        insertBinding.run(householdId, eventId, binding.canonical);

      const updateDevice = this.db.prepare(
        "UPDATE devices SET device_json = ?, token_hash = ?, revoked_at = ? WHERE id = ?",
      );
      for (const row of this.db
        .prepare("SELECT id FROM devices WHERE household_id = ?")
        .all(householdId)) {
        const device = pairingService.devices.get(row.id);
        if (!device)
          throw new DurableStoreError("Kin server device data is invalid.");
        updateDevice.run(
          stringifyStored(device),
          device.tokenHash,
          device.revokedAt,
          device.id,
        );
      }
    });
  }

  findEvent(householdId, eventId) {
    this.assertAvailable();
    return this.statements.getEvent.get(householdId, eventId);
  }

  eventCount(householdId) {
    this.assertAvailable();
    return this.statements.countEvents.get(householdId).count;
  }

  commitEvents(
    householdId,
    expectedNextSequence,
    deviceId,
    expectedDeviceSequence,
    entries,
  ) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO sync_households(household_id, current_epoch, enabled, rotation_pending, next_sequence) VALUES (?, 1, 0, 0, 1) ON CONFLICT(household_id) DO NOTHING",
        )
        .run(householdId);
      const current = this.statements.getSyncHousehold.get(householdId);
      if (current.next_sequence !== expectedNextSequence)
        throw new DurableConflictError(
          "sync_cursor_conflict",
          "Kin synchronization state changed; retry from the current cursor.",
        );
      const deviceState = this.db
        .prepare(
          "SELECT last_sequence FROM sync_device_sequences WHERE household_id = ? AND device_id = ?",
        )
        .get(householdId, deviceId);
      if ((deviceState?.last_sequence ?? 0) !== expectedDeviceSequence)
        throw new DurableConflictError(
          "sync_device_sequence_conflict",
          "Kin device sequence changed; retry after reauthentication.",
        );

      const insert = this.db.prepare(
        "INSERT INTO sync_events(household_id, relay_sequence, event_id, device_id, device_sequence, key_epoch, canonical_envelope) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      let sequence = expectedNextSequence;
      for (const entry of entries) {
        insert.run(
          householdId,
          sequence++,
          entry.envelope.eventId,
          deviceId,
          entry.envelope.deviceSequence,
          entry.envelope.keyEpoch,
          entry.canonical,
        );
      }
      if (entries.length) {
        this.db
          .prepare(
            "INSERT INTO sync_device_sequences(household_id, device_id, last_sequence) VALUES (?, ?, ?) ON CONFLICT(household_id, device_id) DO UPDATE SET last_sequence = excluded.last_sequence",
          )
          .run(
            householdId,
            deviceId,
            entries.at(-1).envelope.deviceSequence,
          );
        this.db
          .prepare(
            "UPDATE sync_households SET next_sequence = ? WHERE household_id = ?",
          )
          .run(sequence, householdId);
      }
    });
  }

  readEvents(householdId, cursor, limit, minimumEpoch) {
    this.assertAvailable();
    try {
      const scanned = this.statements.eventsAfter.all(
        householdId,
        cursor,
        limit,
      );
      const records = scanned.map((row) =>
        validateEventRow(row, householdId),
      );
      const lastScanned = records.at(-1)?.sequence ?? cursor;
      return {
        events: records
          .filter((record) => record.keyEpoch >= minimumEpoch)
          .map((record) => ({
            cursor: encodeCursor(record.sequence),
            envelope: record.envelope,
          })),
        nextCursor: encodeCursor(lastScanned),
        hasMore: Boolean(
          this.statements.eventAfterExists.get(householdId, lastScanned),
        ),
      };
    } catch (error) {
      this.failed = true;
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError("Kin encrypted relay data is invalid.", {
        cause: error,
      });
    }
  }

  health() {
    return this.validate();
  }

  validate() {
    this.assertAvailable();
    try {
      // One read transaction gives all cross-table checks the same snapshot,
      // even during an online backup while another connection is committing.
      return this.db.transaction(() => this.validateSnapshot())();
    } catch (error) {
      this.failed = true;
      if (error instanceof DurableStoreError) throw error;
      throw new DurableStoreError("Kin durable service data is invalid.", {
        cause: error,
      });
    }
  }

  validateSnapshot() {
    this.verify();
    const identity = this.loadIdentity();
    const currentEpochs = new Map();
    for (const householdId of identity.households.keys()) {
      const state = this.loadSyncState(householdId, identity);
      currentEpochs.set(householdId, state.currentEpoch);
      let cursor = 0;
      let scanned = 0;
      // Schema v1 has no relay pruning: retained history must be gap-free,
      // including events from devices that have since been revoked.
      let nextRelaySequence = 1;
      const deviceSequences = new Map();
      while (true) {
        const rows = this.statements.eventsAfter.all(householdId, cursor, 20);
        if (!rows.length) break;
        for (const row of rows) {
          const { envelope, sequence } = validateEventRow(row, householdId);
          const device = identity.devices.get(envelope.deviceId);
          if (
            sequence !== nextRelaySequence++ ||
            device?.householdId !== householdId ||
            envelope.keyEpoch > state.currentEpoch ||
            envelope.keyEpoch < (device.syncHistoryFromEpoch ?? 1)
          ) {
            throw new DurableStoreError("Kin encrypted relay data is invalid.");
          }
          const expectedDeviceSequence =
            (deviceSequences.get(envelope.deviceId) ?? 0) + 1;
          if (envelope.deviceSequence !== expectedDeviceSequence) {
            throw new DurableStoreError("Kin encrypted relay data is invalid.");
          }
          deviceSequences.set(envelope.deviceId, envelope.deviceSequence);
        }
        cursor = rows.at(-1).relay_sequence;
        scanned += rows.length;
      }
      if (
        scanned !== state.eventCount ||
        state.nextSequence !== nextRelaySequence ||
        [...state.deviceSequence].some(
          ([deviceId, sequence]) => (deviceSequences.get(deviceId) ?? 0) !== sequence,
        ) ||
        [...deviceSequences].some(
          ([deviceId, sequence]) =>
            state.deviceSequence.get(deviceId) !== sequence,
        )
      ) {
        throw new DurableStoreError("Kin encrypted relay data is invalid.");
      }
    }
    for (const device of identity.devices.values()) {
      const currentEpoch = currentEpochs.get(device.householdId);
      if (
        (device.syncHistoryFromEpoch ?? 1) > currentEpoch + 1 ||
        device.syncProvisionedEpochs?.some((epoch) => epoch > currentEpoch)
      )
        throw new DurableStoreError("Kin synchronization data is invalid.");
    }
    for (const row of this.db
      .prepare("SELECT * FROM security_audit ORDER BY sequence")
      .iterate()) {
      const details = parseJson(row.details_json);
      if (
        !identity.households.has(row.household_id) ||
        !Number.isSafeInteger(row.sequence) ||
        row.sequence < 1 ||
        !Number.isSafeInteger(row.created_at) ||
        row.created_at < 0 ||
        typeof row.event_type !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(row.event_type) ||
        !validAuditDetails(details)
      )
        throw new DurableStoreError("Kin security audit data is invalid.");
    }
    return true;
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
        await this.db.backup(temporary);
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

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new DurableStoreError("Kin server data is malformed.", {
      cause: error,
    });
  }
}

function parseStoredJson(value) {
  try {
    return JSON.parse(value, (_key, entry) =>
      entry &&
      typeof entry === "object" &&
      Object.keys(entry).length === 1 &&
      typeof entry.$kinBuffer === "string"
        ? Buffer.from(entry.$kinBuffer, "base64")
        : entry,
    );
  } catch (error) {
    throw new DurableStoreError("Kin server data is malformed.", {
      cause: error,
    });
  }
}

function stringifyStored(value) {
  return JSON.stringify(value, (_key, entry) =>
    entry?.type === "Buffer" && Array.isArray(entry.data)
      ? { $kinBuffer: Buffer.from(entry.data).toString("base64") }
      : entry,
  );
}

function auditDetails(event) {
  const { type, at, persisted, ...details } = event;
  return details;
}

function validAuditDetails(details) {
  // Audit details are a bounded metadata object, never arbitrary household
  // content. Permit optional fields without coupling validation to event types.
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const entries = Object.entries(details);
  return entries.length <= 32 && entries.every(([key, value]) =>
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) &&
    (value === null || typeof value === "boolean" ||
      (typeof value === "string" && value.length <= 1024) ||
      (typeof value === "number" && Number.isSafeInteger(value))),
  );
}

function isId(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function encodeCursor(sequence) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(sequence));
  return bytes.toString("base64url");
}

function isSqliteError(error) {
  return typeof error?.code === "string" && error.code.startsWith("SQLITE_");
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
