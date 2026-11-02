// Exclusive lock files beside the database: one for the serving process, one
// for maintenance (backup, restore, purge).
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DurableStoreError, exists } from "./shared.mjs";

export function acquireDatabaseProcessLock(
  databasePath,
  { operation = "service" } = {},
) {
  return acquireExclusiveLock(databaseLockPath(databasePath), operation);
}

export function acquireDatabaseMaintenanceLock(databasePath, operation) {
  return acquireExclusiveLock(databaseMaintenanceLockPath(databasePath), operation);
}

export function acquireExclusiveLock(lockPath, operation) {
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
    // The exclusive create ("wx") is the lock; its content only helps a person
    // inspect it, so durability is best effort. Node's permission model, which
    // the service runs under (server/permissions.mjs), disables fsync.
    if (!process.permission) fsyncSync(descriptor);
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
  const release = () => {
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
  // `using lock = acquire…()` releases it at the end of the block (#106).
  release[Symbol.dispose] = release;
  return release;
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
