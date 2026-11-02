// The move package (ADR 0026 §2–§3, #737): one household's server-side
// records, carried from the hosted service to a home server with the same
// household, member and device IDs, so every event, vault and signature
// stays valid there.
//
// A package is a Kin database of the current schema holding only that
// household's rows. The hosted service builds it from its live database
// (ATTACH a fresh, empty Kin database and copy the household's rows into it,
// in one transaction, so it is one consistent snapshot); the home server
// opens it as a Kin database (which migrates an older schema forward,
// refuses a newer one and runs the full validator), checks it, and copies
// its rows into its own database in one transaction.
//
// Every table is in exactly one list below; a test fails when a new table
// isn't, so a later table can't move, or stay behind, by accident.
//
// What doesn't move, and why (ADR 0026 §2): no secret that authenticates
// anything travels. Device tokens are cleared, so every device signs in
// again; passkeys stay behind (bound to the old name), and so do the vault
// wrappers that need one; push subscriptions belong to the old origin's
// service worker; invitations, provisioning grants and pairing flows are
// pending work at the old address; reports and the security audit belong to
// the service that recorded them.
import { randomBytes } from "node:crypto";
import { renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DurableStore } from "./durable-store.mjs";

export const MOVE_PACKAGE_FORMAT = 1;

/** Tables whose rows for the household move, in an order that satisfies
 * their foreign keys. */
export const MOVED_TABLES = Object.freeze([
  "households", "members",
  "account_vaults", "account_vault_wrappers", "account_passwords",
  "devices",
  "sync_households", "sync_device_sequences", "sync_events", "sync_bindings", "sync_attachments",
  "household_settings", "household_install_identity", "household_install_identity_revisions",
  "chat_relay_state", "chat_events", "chat_device_sequences", "chat_blobs", "chat_blob_claims", "chat_blob_usage",
  "chat_hidden", "chat_receipts", "chat_key_packages",
  "board_relay_state", "board_events", "board_device_sequences",
  "private_relay_state", "private_events", "private_device_sequences", "private_blobs",
  "calendar_subscriptions",
]);
/** Household tables whose rows stay with the old service. */
export const STAYING_TABLES = Object.freeze([
  "credentials", "prepared_invitations", "provisioning_grants", "push_subscriptions",
  "feedback", "feedback_screenshots", "security_audit", "household_moves",
]);
/** The server's own tables: never a household's. */
export const SERVER_TABLES = Object.freeze(["push_vapid_keys", "server_migrations"]);
/** Vault wrappers that open a vault at any address (ADR 0018 §2, §6). */
export const MOVING_WRAPPER_TYPES = Object.freeze(["password", "backup-code"]);

export class MoveError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "MoveError";
    this.code = code;
  }
}

const quoted = (name) => `"${name.replaceAll('"', '""')}"`;

/** Every table in `schema` ("main" or an attached name), sorted. */
export function tablesOf(db, schema = "main") {
  return db.prepare(`SELECT name FROM ${quoted(schema)}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(({ name }) => name);
}

function columnsOf(db, schema, table) {
  return db.prepare(`PRAGMA ${quoted(schema)}.table_info(${quoted(table)})`).all().map(({ name }) => name);
}

function copyRows(db, from, to, table, where, parameters) {
  const columns = columnsOf(db, to, table).map(quoted).join(", ");
  db.prepare(`INSERT INTO ${quoted(to)}.${quoted(table)} (${columns}) SELECT ${columns} FROM ${quoted(from)}.${quoted(table)} WHERE ${where}`).run(...parameters);
}

const ALIAS = "kin_move";

function attach(store, path) {
  store.db.prepare(`ATTACH DATABASE ? AS ${ALIAS}`).run(path);
  return () => store.db.exec(`DETACH DATABASE ${ALIAS}`);
}

/**
 * Builds the package for `householdId` from the running service's `store`,
 * at `destination` (absolute; must not exist). Only an active household
 * moves. Resolves with the package's summary (`summarize`).
 */
export function buildMovePackage(store, householdId, destination) {
  if (!isAbsolute(destination)) throw new TypeError("a move package destination must be absolute");
  if (statSync(destination, { throwIfNoEntry: false })) throw new MoveError("move-exists", "A move package is already there.");
  const household = store.statements.getHousehold.get(householdId);
  if (!household) throw new MoveError("move-unknown-household", "Kin doesn't have that household.");
  if (household.lifecycle_state !== "active") throw new MoveError("move-not-active", "Only a household in use can move.");
  const temporary = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    // An empty Kin database of this schema, without a write-ahead log, so
    // the rows written through the attachment are all in the one file.
    const empty = new DurableStore(temporary, { acquireProcessLock: false });
    empty.db.exec("PRAGMA journal_mode = DELETE");
    empty.close();
    const detach = attach(store, temporary);
    try {
      store.transaction(() => {
        for (const table of MOVED_TABLES) {
          if (table === "households") copyRows(store.db, "main", ALIAS, table, "id = ?", [householdId]);
          else if (table === "account_vault_wrappers")
            copyRows(store.db, "main", ALIAS, table, `household_id = ? AND type IN (${MOVING_WRAPPER_TYPES.map(() => "?").join(", ")})`, [householdId, ...MOVING_WRAPPER_TYPES]);
          else copyRows(store.db, "main", ALIAS, table, "household_id = ?", [householdId]);
        }
        // The record's own copy of the token hash must match the column.
        store.db.prepare(`UPDATE ${ALIAS}.devices SET token_hash = NULL, device_json = json_set(device_json, '$.tokenHash', NULL)`).run();
        store.db.prepare(`UPDATE ${ALIAS}.members SET credential_ids = '[]'`).run();
      });
    } finally {
      detach();
    }
    // The package must open as a Kin database and pass the validator.
    new DurableStore(temporary, { acquireProcessLock: false, readonly: true }).close();
    renameSync(temporary, destination);
    return summarizeMovePackage(destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(`${temporary}${suffix}`, { force: true });
    if (error instanceof MoveError) throw error;
    throw new MoveError("move-package-failed", "Kin couldn't make the move package.", { cause: error });
  }
}

/** What a package holds: { householdId, members, devices, events, chatEvents,
 * attachments, schema }. Opens it read-only. */
export function summarizeMovePackage(path) {
  const store = new DurableStore(path, { acquireProcessLock: false, readonly: true });
  try {
    const count = (table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)}`).get().n;
    const households = store.db.prepare("SELECT id FROM households").all();
    return {
      format: MOVE_PACKAGE_FORMAT,
      householdId: households.length === 1 ? households[0].id : null,
      households: households.length,
      members: count("members"),
      devices: count("devices"),
      events: count("sync_events"),
      chatEvents: count("chat_events"),
      attachments: count("sync_attachments") + count("chat_blobs") + count("private_blobs"),
    };
  } finally {
    store.close();
  }
}

/**
 * Checks a received package before anything changes (ADR 0026 §3). It is
 * opened as a Kin database (an older schema migrates forward in the
 * package's own file, a newer one is refused, and the validator runs), and
 * must hold exactly one active household, no row of a staying table, no
 * device token and no passkey. Returns its summary. Throws MoveError.
 */
export function checkMovePackage(path) {
  let store;
  try {
    store = new DurableStore(path, { acquireProcessLock: false });
  } catch (error) {
    if (/newer server version/.test(error?.message ?? "")) throw new MoveError("move-newer", "The household comes from a newer Kin. Update this home server first.");
    throw new MoveError("move-invalid", "What arrived isn't a Kin household that opens.");
  }
  try {
    const households = store.db.prepare("SELECT id, lifecycle_state FROM households").all();
    if (households.length !== 1 || households[0].lifecycle_state !== "active") throw new MoveError("move-invalid", "What arrived isn't one household in use.");
    const tables = tablesOf(store.db);
    for (const table of STAYING_TABLES)
      if (tables.includes(table) && store.db.prepare(`SELECT 1 FROM ${quoted(table)} LIMIT 1`).get()) throw new MoveError("move-invalid", "What arrived holds records that never move.");
    if (store.db.prepare("SELECT 1 FROM devices WHERE token_hash IS NOT NULL LIMIT 1").get()) throw new MoveError("move-invalid", "What arrived holds device tokens.");
    if (store.db.prepare(`SELECT 1 FROM account_vault_wrappers WHERE type NOT IN (${MOVING_WRAPPER_TYPES.map(() => "?").join(", ")}) LIMIT 1`).get(...MOVING_WRAPPER_TYPES))
      throw new MoveError("move-invalid", "What arrived holds passkey wrappers.");
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    store.close();
  }
  return summarizeMovePackage(path);
}

/**
 * Copies a checked package's household into the running service's `store`,
 * in one transaction, and validates the result before it commits. Refuses a
 * household, member, device or username this server already has. Every
 * device that arrives unrevoked is marked `carriedOver` (ADR 0026 §6).
 * Returns the package's summary.
 */
export function importMovePackage(store, path) {
  const summary = checkMovePackage(path);
  const detach = attach(store, path);
  try {
    const clash = (sql) => store.db.prepare(sql).get();
    if (clash(`SELECT 1 FROM main.households WHERE id IN (SELECT id FROM ${ALIAS}.households)`)
      || clash(`SELECT 1 FROM main.members WHERE id IN (SELECT id FROM ${ALIAS}.members)`)
      || clash(`SELECT 1 FROM main.devices WHERE id IN (SELECT id FROM ${ALIAS}.devices)`))
      throw new MoveError("move-clash", "This home server already has that household or one of its members or devices.");
    if (clash(`SELECT 1 FROM main.members m JOIN ${ALIAS}.members p ON m.username IS NOT NULL AND m.username = p.username WHERE m.active = 1`))
      throw new MoveError("move-username-taken", "A username in that household is already used on this home server.");
    const wasFailed = store.failed;
    try {
      store.transaction(() => {
        for (const table of MOVED_TABLES) copyRows(store.db, ALIAS, "main", table, "1 = 1", []);
        // The old address's devices can't sign in here; an admin removes them
        // together once everyone has re-joined (ADR 0026 §6). A revoked one
        // loses any mark left from an earlier move.
        store.db.prepare(`UPDATE main.devices SET device_json = CASE WHEN revoked_at IS NULL
          THEN json_set(device_json, '$.carriedOver', json('true'))
          ELSE json_remove(device_json, '$.carriedOver') END
          WHERE id IN (SELECT id FROM ${ALIAS}.devices)`).run();
        store.validateSnapshot();
      });
    } catch (error) {
      // A failed transaction marks the store failed, but this one rolled back
      // cleanly (an AggregateError would say it didn't): nothing changed, so
      // the server goes on serving what it had.
      if (!(error instanceof AggregateError)) store.failed = wasFailed;
      if (error instanceof MoveError) throw error;
      throw new MoveError("move-import-failed", "Kin couldn't add the household here; nothing changed.", { cause: error });
    }
  } finally {
    detach();
  }
  return summary;
}

