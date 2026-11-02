import {
  idToHex, idFromHex, randomId, eventMetadata, eventMetadataBatch,
} from "../wasm/kin-engine.js";
import { recordDiagnostic } from "../diagnostics/ring-buffer.js";
import { errorName } from "../diagnostics/global.js";
import {
  encryptedDatabase, snapshotStores, protectRows, valuesEqual, compareStoreRows,
} from "./encrypted-idb.js";
import { projectionContext } from "../browser-time.js";
import { choreWeek } from "../wasm/kin-chores.js";
import { hasFinalUnlockPath } from "../security/local-vault.js";
import { bumpEventGeneration as bumpGeneration, EventArena, EVENT_GENERATION_KEY, historyWith } from "./event-arena.js";
import { rotateEventProtection, resumeEventProtection } from "./root-rotation.js";
import { nextQuarantine, quarantineRetryItems } from "./quarantine.js";
import { MAX_HOUSEHOLD_ATTACHMENT_BYTES, MAX_HOUSEHOLD_ATTACHMENTS } from "../attachments/attachment-crypto.js";

const DATABASE_NAME = "kin";
const DATABASE_VERSION = 5;
const SECURITY_STORE = "security_state";
const SECURITY_KEY = "vault";
export const EVENT_STORE_DEFINITIONS = {
  events: { keyPath: "local_sequence", indexes: { event_id: "event_id" } },
  local_context: { keyPath: "key" },
  sync_state: { keyPath: "key" },
  sync_outbox: { keyPath: "event_id" },
  sync_bindings: { keyPath: "legacy_key" },
  attachment_records: { keyPath: "attachment_id" },
  // Protected, member-bound, device-local presentation. Never enters events,
  // the sync outbox, attachment records, catch-up, or portable exports.
  personal_appearance: { keyPath: "owner" },
};
const EVENT_STORE = "events";
const CONTEXT_STORE = "local_context";
const SYNC_STATE_STORE = "sync_state";
const SYNC_OUTBOX_STORE = "sync_outbox";
const SYNC_BINDING_STORE = "sync_bindings";
const CONTEXT_KEY = "installation";
const MAX_EVENT_COUNT = 10_000;
// Must match rust/src/state.rs and server/sync-contract.mjs.
const MAX_LOGICAL_TIME = 9_007_199_254_740_991n;

export class EventStoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "EventStoreError";
    this.userMessage = message;
    this.code = cause?.code;
  }
}

export function validateAttachmentAggregate(records, candidate) {
  const existing = records.find((row) => row.attachment_id === candidate.attachment_id);
  const count = records.length + (existing ? 0 : 1);
  const bytes = records.reduce((total, row) => total +
    (row.attachment_id === candidate.attachment_id ? 0 : row.ciphertext?.byteLength ?? 0), 0) +
    (candidate.ciphertext?.byteLength ?? existing?.ciphertext?.byteLength ?? 0);
  if (count > MAX_HOUSEHOLD_ATTACHMENTS || bytes > MAX_HOUSEHOLD_ATTACHMENT_BYTES)
    throw new EventStoreError("Kin reached its 50 MiB encrypted attachment limit.");
}

/** Admit only replayable remote events; report rejected ciphertext so callers
 * can advance the relay cursor and keep it for a later retry (see
 * quarantine.js). `quarantined` counts the refusals; `quarantinedItems` holds
 * `{ eventId, encoded, reason }` for each (`eventId` is null when the bytes
 * could not be decoded at all). An item marked `retry` (a kept event replayed
 * from the quarantine) never stops the batch: any engine refusal of it is
 * reported as a refusal, so one kept event can't stall sync on every poll.
 * `history` is the HistoryView the batch validates against (`rows`, a plain
 * row array, is accepted for tests). Each candidate is replayed as the history
 * plus the admitted additions, without copying the history per candidate.
 * Returns the admitted rows (with Rust metadata and their local sequence) and
 * `candidates`, a replay source for history plus additions. */
export function reconcileRemoteEvents({ history, rows, received, engine, context, asOf, civilDate }) {
  let temporary = null;
  if (!history) {
    temporary = historyFromRows(rows ?? []);
    history = temporary.view;
  }
  try {
    const additions = [];
    const added = new Map();
    const duplicateEventIds = [];
    const quarantinedItems = [];
    const projection = projectionContext();
    const candidates = [];
    for (const item of received) {
      let canonical;
      let candidate;
      try {
        canonical = asBytes(item.encodedEvent).slice();
        candidate = eventRowFromCanonical(canonical);
      } catch {
        quarantinedItems.push({ eventId: null, encoded: null, reason: "unreadable" });
        continue;
      }
      candidates.push({ candidate, canonical, retry: item.retry === true });
    }
    candidates.sort((left, right) =>
      left.candidate.logical_time < right.candidate.logical_time ? -1 :
        left.candidate.logical_time > right.candidate.logical_time ? 1 :
          compareByteArrays(left.candidate.device_id, right.candidate.device_id) ||
          compareByteArrays(left.candidate.event_id, right.candidate.event_id),
    );
    for (const { candidate, canonical, retry } of candidates) {
      const eventId = idToHex(candidate.event_id);
      const index = history.indexOfEventId(candidate.event_id);
      const existing = index >= 0 ? history.record(index) : added.get(eventId)?.encoded_event;
      if (existing) {
        if (!bytesEqual(existing, canonical))
          throw new EventStoreError("Kin found conflicting synchronized bytes for an existing event ID.");
        duplicateEventIds.push(eventId);
        continue;
      }
      try {
        engine.applyEvents(
          historyWith(history, [...additions.map((row) => row.encoded_event), candidate.encoded_event]),
          asOf ?? projection.asOf,
          context.last_looked_event_id === null ? null : idToHex(context.last_looked_event_id),
          civilDate ?? projection.civilDate,
          syncIdentityFromContext(context),
        );
      } catch (error) {
        if (error?.code !== 4 && !retry) throw error;
        quarantinedItems.push({ eventId, encoded: canonical, reason: error?.code === 4 ? "not-applicable" : "unsupported" });
        continue;
      }
      candidate.local_sequence = history.tail + additions.length + 1;
      additions.push(candidate);
      added.set(eventId, candidate);
    }
    const extras = additions.map((row) => row.encoded_event);
    return {
      additions,
      // A temporary arena is wiped below, so its callers get detached copies.
      candidates: temporary
        ? [...history.records().map((record) => record.slice()), ...extras]
        : historyWith(history, extras),
      quarantined: quarantinedItems.length,
      quarantinedItems,
      duplicateEventIds,
    };
  } finally {
    temporary?.arena.wipe();
  }
}

function compareByteArrays(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1)
    if (left[index] !== right[index]) return left[index] - right[index];
  return left.length - right.length;
}

export class EventStore {
  constructor(database) {
    this.database = database;
    // Session plaintext history; derived, discardable, wiped on close.
    this.arena = new EventArena();
  }

  static rotateProtection(options) {
    return rotateEventProtection(options, {
      openDatabase: openEventDatabase, definitions: EVENT_STORE_DEFINITIONS,
      validateRows: validateRotationRows,
    });
  }

  static resumeRotation(options) {
    return resumeEventProtection(options, {
      openDatabase: openEventDatabase, definitions: EVENT_STORE_DEFINITIONS,
      validateRows: validateRotationRows,
    });
  }

  static async securityStatus() {
    const database = await openEventDatabase();
    try { return await readSecurity(database); }
    finally { database.close(); }
  }

  /**
   * Validates archive parts (see archivePartsFromSnapshot) against `vault`,
   * which must open their local attachment data, and returns their counts.
   */
  static async validateArchiveParts({ parts, engine, vault, bindings = null }) {
    vault.assertUnlocked();
    // `bindings` from an earlier check of the same history and context
    // (validateArchiveParts' result) saves a second replay; every other
    // check still runs.
    bindings = validateArchiveParts(parts, engine, bindings);
    await validateAttachmentArchivePayloads(
      parts.attachments,
      bindings,
      (id, sealed) => vault.open(sealed, { store: "attachment-file", id }),
    );
    vault.assertUnlocked();
    return {
      bindings,
      eventCount: parts.history.length,
      attachmentCount: parts.attachments.length,
      attachmentBytes: parts.attachments.reduce(
        (total, row) => total + (row.ciphertext?.byteLength ?? 0),
        0,
      ),
    };
  }

  /**
   * An empty history for an archive being read, and `append(sequences,
   * records)`, which checks one chunk of it (local order, the event limit,
   * Rust-derived metadata) and copies it in. The caller wipes `arena`.
   */
  static archiveHistory(engine) {
    const arena = new EventArena();
    arena.reset(null);
    return {
      arena,
      append: (sequences, records) => appendRecords(arena, sequences, records, engine),
      // Room for `records` records of at most `bytes` bytes in all, so the
      // arena is allocated once instead of doubling past its size.
      reserve: (records, bytes) => arena.reserve(Math.min(records, MAX_EVENT_COUNT), Math.min(bytes, 64 * 1024 * 1024)),
    };
  }

  /** Archive parts from the historical snapshot shape (package format 2). */
  static archivePartsFromSnapshot(snapshot, engine) {
    return archivePartsFromSnapshot(snapshot, engine, { owned: true });
  }

  static async prepareSecurity(manifest) {
    const database = await openEventDatabase();
    try {
      const transaction = database.transaction(SECURITY_STORE, "readwrite");
      const store = transaction.objectStore(SECURITY_STORE);
      const request = store.get(SECURITY_KEY);
      return await transactionResult(transaction, (finish) => {
        request.onsuccess = () => {
          if (request.result) { abortWith(transaction, new EventStoreError("Kin already has a local security setup. Unlock the existing store.")); return; }
          if (manifest?.formatVersion !== 1 || !/^[a-f0-9]{32}$/.test(manifest.vaultId ?? "") || !manifest.verifier || !hasFinalUnlockPath(manifest)) {
            abortWith(transaction, new EventStoreError("Kin requires a verified recovery path before migration.")); return;
          }
          const record = { ...structuredClone(manifest), key: SECURITY_KEY, phase: "preparing", lockEpoch: 0, configRevision: 0 };
          store.add(record);
          finish(record);
        };
      });
    } finally { database.close(); }
  }

  static async updateSecurityManifest(manifest, vault) {
    vault.assertUnlocked();
    if (manifest.vaultId !== vault.vaultId || !hasFinalUnlockPath(manifest))
      throw new EventStoreError("Kin requires the current vault and a verified recovery path.");
    const database = await openEventDatabase();
    try {
      const transaction = database.transaction(SECURITY_STORE, "readwrite");
      const store = transaction.objectStore(SECURITY_STORE);
      const request = store.get(SECURITY_KEY);
      const committed = await transactionResult(transaction, (finish) => {
        request.onsuccess = () => {
          try {
            vault.assertUnlocked();
            const existing = request.result;
            if (!existing || existing.vaultId !== manifest.vaultId || existing.phase !== "encrypted" ||
                existing.formatVersion !== manifest.formatVersion || existing.rootVersion !== manifest.rootVersion ||
                !valuesEqual(existing.verifier, manifest.verifier) || (existing.lockEpoch ?? 0) !== vault.securityEpoch)
              throw new EventStoreError("Kin cannot update this security configuration.");
            const revision = existing.configRevision ?? 0;
            if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER ||
                revision !== (manifest.configRevision ?? 0)) {
              const error = new EventStoreError("Unlock paths changed in another tab. Unlock again before changing them.");
              error.code = "security_changed";
              throw error;
            }
            const removedWrapper = existing.wrappers.some((wrapper) => !manifest.wrappers.some((candidate) => candidate.id === wrapper.id));
            const epoch = existing.lockEpoch ?? 0;
            if (removedWrapper && epoch >= Number.MAX_SAFE_INTEGER)
              throw new EventStoreError("Kin could not safely revoke this unlock path.");
            const updated = { ...manifest, key: SECURITY_KEY, phase: existing.phase,
              configRevision: revision + 1, lockEpoch: epoch + Number(removedWrapper) };
            store.put(updated);
            finish(updated);
          } catch (error) { abortWith(transaction, error); }
        };
      });
      vault.manifest = structuredClone(committed);
      return committed;
    } catch (error) {
      // LocalVault prepares candidate wrappers in memory. An aborted/stale write
      // must never leave that candidate eligible for a later accidental commit.
      try {
        const current = await readSecurity(database);
        if (!vault.locked && current?.vaultId === vault.vaultId && current.phase === "encrypted" &&
            (current.lockEpoch ?? 0) === vault.securityEpoch && error.code !== "security_changed")
          vault.manifest = structuredClone(current);
        else vault.lock();
      } catch { vault.lock(); }
      throw error;
    } finally { database.close(); }
  }

  static async lockAll() {
    const database = await openEventDatabase();
    try {
      const transaction = database.transaction(SECURITY_STORE, "readwrite");
      const store = transaction.objectStore(SECURITY_STORE);
      const request = store.get(SECURITY_KEY);
      return await transactionResult(transaction, (finish) => {
        request.onsuccess = () => {
          const current = request.result;
          if (!current) { finish(0); return; }
          const epoch = current.lockEpoch ?? 0;
          if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) {
            abortWith(transaction, new EventStoreError("Kin could not advance the local lock generation.")); return;
          }
          const updated = { ...current, lockEpoch: epoch + 1 };
          if (current.phase === "root-rotating" && current.rotation?.candidateManifest) {
            updated.rotation = { ...current.rotation,
              candidateManifest: { ...current.rotation.candidateManifest, lockEpoch: epoch + 1 } };
          }
          store.put(updated);
          finish(epoch + 1);
        };
      });
    } finally { database.close(); }
  }

  static async checkSecurityEpoch(vault) {
    vault.assertUnlocked();
    const marker = await EventStore.securityStatus();
    if (!marker || marker.vaultId !== vault.vaultId || marker.phase !== "encrypted" ||
        marker.rootVersion !== vault.manifest.rootVersion || (marker.lockEpoch ?? 0) !== vault.securityEpoch) {
      vault.lock();
      const error = new EventStoreError("Kin was locked in another tab. Unlock before continuing.");
      error.code = "locked";
      throw error;
    }
    vault.assertUnlocked();
  }

  static async migrate({ vault, engine, prepareKeys, finalizeKeys }) {
    vault.assertUnlocked();
    if (typeof prepareKeys !== "function" || typeof finalizeKeys !== "function")
      throw new EventStoreError("Kin requires complete sync-key migration before protecting this household.");
    const migrate = async () => {
      const database = await openEventDatabase();
      try {
        let manifest = await readSecurity(database);
        if (!manifest || manifest.vaultId !== vault.vaultId)
          throw new EventStoreError("Kin could not match this household's security setup.");
        const capabilityEpoch = vault.securityEpoch ?? vault.manifest.lockEpoch ?? 0;
        if (manifest.rootVersion !== vault.manifest.rootVersion || !valuesEqual(manifest.verifier, vault.manifest.verifier) ||
            !Number.isSafeInteger(capabilityEpoch) || capabilityEpoch < 0 || capabilityEpoch !== (manifest.lockEpoch ?? 0)) {
          vault.lock();
          const error = new EventStoreError("Kin was locked before migration began. Unlock again to resume safely."); error.code = "locked"; throw error;
        }
        if (manifest.phase === "encrypted") return manifest;
        if (!["preparing", "cleanup-pending"].includes(manifest.phase))
          throw new EventStoreError("Kin found an unsupported migration state.");
        const checkMigration = async () => {
          vault.assertUnlocked();
          const current = await readSecurity(database);
          if (!current || !["preparing", "cleanup-pending"].includes(current.phase) || current.vaultId !== manifest.vaultId ||
              current.rootVersion !== manifest.rootVersion || !valuesEqual(current.verifier, manifest.verifier) ||
              (current.configRevision ?? 0) !== (manifest.configRevision ?? 0) || (current.lockEpoch ?? 0) !== (manifest.lockEpoch ?? 0)) {
            vault.lock();
            const error = new EventStoreError("Kin was locked during migration. Unlock to resume safely."); error.code = "locked"; throw error;
          }
          vault.assertUnlocked();
        };
        if (manifest.phase === "preparing") {
          const names = Object.keys(EVENT_STORE_DEFINITIONS);
          const original = await snapshotStores(database, names);
          // IDB owns the source snapshot. Canonical bytes stay immutable; only
          // context defaults and pending transport seals may change in migration.
          const rows = { ...original, local_context: structuredClone(original.local_context),
            sync_state: structuredClone(original.sync_state) };
          const events = validateEventRows(rows.events);
          validateLegacyOutbox(rows.sync_outbox, events);
          const { arena: historyArena, view: history } = historyFromRows(events);
          try {
          let context = rows.local_context.find((row) => row.key === CONTEXT_KEY);
          if (!context && events.length) throw invalidCatchUpState();
          if (!context) {
            context = { key: CONTEXT_KEY, household_id: randomId(), actor_id: randomId(), device_id: randomId(), next_logical_time: 1n, last_looked_event_id: null, last_looked_local_sequence: 0, last_looked_at: Date.now() };
            rows.local_context.push(context);
          }
          validateContext(context);
          validateCursorBoundary(context, history);
          const { asOf, civilDate } = projectionContext();
          engine.applyEvents(history, asOf, cursorEventId(context), civilDate, syncIdentityFromContext(context));
          const keys = await prepareKeys(vault, { check: checkMigration });
          if (keys?.rewrapEventRows) await keys.rewrapEventRows(rows);
          else if (keys?.rewrapSyncState) {
            for (let i = 0; i < rows.sync_state.length; i += 1) rows.sync_state[i] = await keys.rewrapSyncState(rows.sync_state[i]);
          }
          const protectedRows = await protectRows(vault, EVENT_STORE_DEFINITIONS, rows, { check: checkMigration });
          // protectRows decrypts and compares every complete candidate record.
          // Replaying the proven-equal canonical source preserves the complete
          // post-verification replay without another recovered plaintext graph.
          engine.applyEvents(history, asOf, cursorEventId(context), civilDate, syncIdentityFromContext(context));
          vault.assertUnlocked();
          manifest = { ...manifest, phase: "cleanup-pending" };
          await replaceVerifiedSnapshot(database, original, protectedRows, manifest, vault);
          } finally { historyArena.wipe(); }
        }
        await finalizeKeys(vault, { check: checkMigration });
        vault.assertUnlocked();
        manifest = { ...manifest, phase: "encrypted" };
        await writeSecurity(database, manifest, vault);
        return manifest;
      } finally { database.close(); }
    };
    // Schema upgrade closes the old application's connections. The browser lock
    // serializes resumed migrations; the final transaction also compares source.
    if (!globalThis.navigator?.locks?.request)
      throw new EventStoreError("This browser cannot safely coordinate household migration. Use a browser with Web Locks support; saved information was preserved.");
    return navigator.locks.request("kin-security-migration", migrate);
  }

  static async open({ vault, engine } = {}) {
    vault?.assertUnlocked();
    if (!vault) throw new EventStoreError("Kin is locked. Unlock before reading household data.");
    const database = await openEventDatabase();
    let store;
    try {
      const manifest = await readSecurity(database);
      if (manifest?.phase !== "encrypted" || manifest.vaultId !== vault.vaultId || manifest.rootVersion !== vault.manifest.rootVersion)
        throw new EventStoreError("Kin must finish protecting this household before opening it.");
      const epoch = vault.securityEpoch ?? vault.manifest.lockEpoch ?? 0;
      if (!Number.isSafeInteger(epoch) || epoch < 0 || (manifest.lockEpoch ?? 0) !== epoch) {
        vault.lock();
        const error = new EventStoreError("Kin was locked while opening this household. Unlock again."); error.code = "locked"; throw error;
      }
      vault.securityEpoch = epoch;
      vault.checkSecurityEpoch = () => EventStore.checkSecurityEpoch(vault);
      store = new EventStore(encryptedDatabase(database, vault, EVENT_STORE_DEFINITIONS, {
        securityGuard: { store: SECURITY_STORE, key: SECURITY_KEY, epoch, rootVersion: manifest.rootVersion },
      }));
      store.vault = vault;
      store.engine = engine;
      // Any lock (local, peer-tab, epoch mismatch) discards session plaintext,
      // even before the application closes this store.
      store.removeLockListener = vault.onLock(() => store.arena.wipe());
      const context = await store.ensureContext();
      store.actorId = idToHex(context.sync_member_id ?? context.actor_id);
      // Names this device's family-album database (#673, album/album-store.js).
      store.localHouseholdId = context.household_id ? idToHex(context.household_id) : null;
      return store;
    } catch (error) {
      if (store) store.close();
      else database.close();
      throw error;
    }
  }

  static async openLegacyForMigration() {
    const database = await openEventDatabase();
    if (await readSecurity(database)) { database.close(); throw new EventStoreError("Legacy writes are disabled after security setup."); }
    const store = new EventStore(database);
    const context = await store.ensureContext();
    store.actorId = idToHex(context.sync_member_id ?? context.actor_id);
    return store;
  }

  /** The current history as detached row objects (copies). Prefer
   * loadHistory() unless the rows must outlive the next append. */
  async loadEvents() {
    const transaction = this.database.transaction(EVENT_STORE, "readonly");
    const history = historyRequest(this, transaction);
    return transactionResult(transaction, (finish) => {
      history.onsuccess = () => finish(history.result.rows());
    });
  }

  /** The current history as a HistoryView over the session arena. */
  async loadHistory() {
    const transaction = this.database.transaction(EVENT_STORE, "readonly");
    const history = historyRequest(this, transaction);
    return transactionResult(transaction, (finish) => {
      history.onsuccess = () => finish(history.result);
    });
  }

  async loadAttachments() {
    const transaction = this.database.transaction("attachment_records", "readonly");
    const request = transaction.objectStore("attachment_records").getAll();
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => { try { finish(validateAttachmentRows(request.result)); } catch (error) { abortWith(transaction, error); } };
      request.onerror = () => abortWith(transaction, storageError(request.error));
    });
  }

  async saveAttachment(record) {
    const [validated] = validateAttachmentRows([record]);
    const transaction = this.database.transaction("attachment_records", "readwrite");
    const store = transaction.objectStore("attachment_records"), request = store.getAll();
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        try {
          const current = validateAttachmentRows(request.result);
          const existing = current.find((row) => row.attachment_id === validated.attachment_id);
          validateAttachmentAggregate(current, validated);
          if (existing?.ciphertext && validated.ciphertext && (!bytesEqual(existing.ciphertext, validated.ciphertext) || existing.digest !== validated.digest || existing.keyEpoch !== validated.keyEpoch)) throw new EventStoreError("Kin found conflicting encrypted content for this attachment.");
          const row = existing ? { ...existing, ...validated, state: validated.ciphertext ? validated.state : existing.state } : validated;
          const put = store.put(row);
          put.onsuccess = () => finish(validated.attachment_id);
          put.onerror = () => abortWith(transaction, storageError(put.error));
        } catch (error) { abortWith(transaction, error); }
      };
      request.onerror = () => abortWith(transaction, storageError(request.error));
    });
  }

  async sealAttachmentData(attachmentId, data) {
    if (!this.vault || !/^[a-f0-9]{32}$/.test(attachmentId)) throw new EventStoreError("Kin could not protect this attachment locally.");
    return this.vault.seal(data, { store: "attachment-file", id: attachmentId });
  }

  async openAttachmentData(attachmentId, sealed) {
    if (!this.vault || !/^[a-f0-9]{32}$/.test(attachmentId) || !sealed) throw new EventStoreError("This attachment is unavailable on this device.");
    return this.vault.open(sealed, { store: "attachment-file", id: attachmentId });
  }

  async updateAttachmentState(attachmentId, state) {
    if (!/^[a-f0-9]{32}$/.test(attachmentId) || !["local", "queued", "uploading", "synced", "failed", "removed"].includes(state)) throw new EventStoreError("Kin could not update this attachment.");
    const transaction = this.database.transaction("attachment_records", "readwrite");
    const store = transaction.objectStore("attachment_records"), request = store.get(attachmentId);
    return transactionResult(transaction, (finish) => { request.onsuccess = () => { if (!request.result) { finish(false); return; } store.put({ ...request.result, state }); finish(true); }; request.onerror = () => abortWith(transaction, storageError(request.error)); });
  }

  async deleteAttachment(attachmentId) {
    if (!/^[a-f0-9]{32}$/.test(attachmentId)) throw new EventStoreError("Kin could not remove this attachment.");
    const transaction = this.database.transaction("attachment_records", "readwrite");
    const store = transaction.objectStore("attachment_records"), request = store.get(attachmentId);
    return transactionResult(transaction, (finish) => { request.onsuccess = () => { if (request.result) store.delete(attachmentId); finish(Boolean(request.result)); }; request.onerror = () => abortWith(transaction, storageError(request.error)); });
  }

  /**
   * What an export holds, read in one transaction: the context and
   * attachment records, and the history as a view of the session arena
   * (`history`), so nothing is decrypted a second time. The view stays valid
   * while the arena is only appended to; a rebuild (another tab's restore or
   * rotation) makes it throw StaleHistoryError.
   */
  async readArchiveParts() {
    const transaction = this.database.transaction([EVENT_STORE, CONTEXT_STORE, "attachment_records"], "readonly");
    const history = historyRequest(this, transaction);
    const contexts = transaction.objectStore(CONTEXT_STORE).getAll();
    const attachments = transaction.objectStore("attachment_records").getAll();
    return transactionResult(transaction, (finish) => {
      let waiting = 3;
      const ready = () => {
        if (--waiting) return;
        finish({ formatVersion: 2, history: history.result, local_context: contexts.result, attachments: attachments.result });
      };
      history.onsuccess = ready;
      contexts.onsuccess = ready;
      attachments.onsuccess = ready;
    });
  }

  /**
   * The household's archive parts, validated for export. A given
   * `portableMembership` (the server's membership directory) replaces the
   * context's membership snapshot.
   */
  async archiveParts({ portableMembership } = {}) {
    const parts = await this.readArchiveParts();
    if (portableMembership !== undefined) {
      validatePortableMembership(portableMembership);
      parts.local_context[0].portable_membership = structuredClone(portableMembership);
    }
    const bindings = validateArchiveParts(parts, this.engine);
    await validateAttachmentArchivePayloads(parts.attachments, bindings, (id, sealed) => this.openAttachmentData(id, sealed));
    return parts;
  }

  /** archiveParts() in the historical row shape, for tests and diagnostics. */
  async snapshotForArchive(options) {
    const parts = await this.archiveParts(options);
    return { formatVersion: 2, events: parts.history.rows(), local_context: parts.local_context, attachments: parts.attachments };
  }

  async containsSameHouseholdArchive(parts, { engine, vault }) {
    vault.assertUnlocked();
    this.engine = engine;
    const incomingContext = parts?.local_context?.[0];
    const current = await this.readArchiveParts();
    const currentContext = current.local_context?.[0];
    const incomingHousehold = incomingContext?.sync_household_id ?? incomingContext?.household_id;
    const currentHousehold = currentContext?.sync_household_id ?? currentContext?.household_id;
    if (!incomingHousehold || !currentHousehold || !bytesEqual(incomingHousehold, currentHousehold))
      return false;
    const incoming = parts.history, held = current.history;
    for (let index = 0; index < incoming.length; index += 1) {
      const at = held.indexOfEventId(incoming.id(index, "event_id"));
      if (at < 0 || !bytesEqual(held.record(at), incoming.record(index))) return false;
    }
    const currentAttachments = new Map((current.attachments ?? []).map((row) => [row.attachment_id, row]));
    for (const row of parts.attachments ?? []) {
      const existing = currentAttachments.get(row.attachment_id);
      if (!existing) return false;
      if (row.ciphertext || existing.ciphertext) {
        if (!row.ciphertext || !existing.ciphertext || row.digest !== existing.digest ||
            row.keyEpoch !== existing.keyEpoch || !bytesEqual(row.ciphertext, existing.ciphertext)) return false;
        continue;
      }
      if (!row.localSealed || !existing.localSealed) return false;
      const [incomingPayload, currentPayload] = await Promise.all([
        vault.open(row.localSealed, { store: "attachment-file", id: row.attachment_id }),
        vault.open(existing.localSealed, { store: "attachment-file", id: row.attachment_id }),
      ]);
      try {
        if (!valuesEqual(incomingPayload, currentPayload)) return false;
      } finally {
        incomingPayload?.bytes?.fill?.(0);
        currentPayload?.bytes?.fill?.(0);
      }
    }
    vault.assertUnlocked();
    return true;
  }

  /** Restores an empty household from a snapshot in the historical row
   * shape (tests and fixtures); see restoreArchive. */
  static async restoreEmpty({ vault, engine, snapshot, manifest, ownedSnapshot = false }) {
    vault.assertUnlocked();
    // The history is copied into a new arena either way; the context and
    // attachment rows are cloned unless the caller hands them over.
    const parts = archivePartsFromSnapshot(snapshot, engine, { owned: ownedSnapshot });
    try { return await EventStore.restoreArchive({ vault, engine, parts, manifest }); }
    finally { parts.arena.wipe(); }
  }

  /**
   * Replaces an empty household with archive parts, which this takes over
   * (the context row is rewritten). Every row is protected before one native
   * transaction checks that the household is still empty and writes them, so
   * a failure changes nothing. The history is protected 256 events at a time
   * from its arena; `onProgress({ done, total })` reports events protected.
   */
  static async restoreArchive({ vault, engine, parts, manifest, bindings = null, onProgress }) {
    vault.assertUnlocked();
    // Staged parts pass the bindings their check found (see
    // validateArchiveParts); the rewritten context below is replayed again.
    await validateAttachmentArchivePayloads(parts.attachments, validateArchiveParts(parts, engine, bindings), (id, sealed) => vault.open(sealed, { store: "attachment-file", id }));
    const context = parts.local_context[0];
    // An archive contains history, not device authorization. New local actions
    // use fresh anonymous IDs while the historical replay household stays stable.
    const householdId = randomId(), actorId = randomId(), deviceId = randomId();
    const replayHousehold = context.sync_household_id ?? context.household_id;
    Object.assign(context, {
      household_id: householdId, actor_id: actorId, device_id: deviceId,
      sync_household_id: replayHousehold, sync_member_id: actorId, sync_device_id: deviceId,
      sync_identity_bindings: [...(context.sync_identity_bindings ?? [])],
      archive_imported: true,
    });
    await validateAttachmentArchivePayloads(parts.attachments, validateArchiveParts(parts, engine), (id, sealed) => vault.open(sealed, { store: "attachment-file", id }));
    const check = () => EventStore.checkSecurityEpoch(vault);
    const history = parts.history;
    const events = [];
    for (let from = 0; from < history.length; from += ARCHIVE_CHUNK_EVENTS) {
      const to = Math.min(from + ARCHIVE_CHUNK_EVENTS, history.length);
      const rows = [];
      for (let index = from; index < to; index += 1) rows.push(history.row(index));
      try { events.push(...(await protectRows(vault, EVENT_STORE_DEFINITIONS, { events: rows }, { check })).events); }
      finally { zeroRows(rows); }
      onProgress?.({ done: to, total: history.length });
    }
    const protectedRows = {
      events,
      ...await protectRows(vault, EVENT_STORE_DEFINITIONS,
        { local_context: parts.local_context, attachment_records: parts.attachments }, { check }),
    };
    const database = await openEventDatabase();
    try {
      const names = [...Object.keys(EVENT_STORE_DEFINITIONS), SECURITY_STORE];
      const transaction = database.transaction(names, "readwrite");
      abortOnVaultLock(transaction, vault);
      return await transactionResult(transaction, (finish) => {
        let current;
        let remaining = names.length;
        let occupied = false;
        const complete = () => {
          remaining -= 1;
          if (remaining) return;
          try {
            vault.assertUnlocked();
            if (occupied) throw new EventStoreError("Restore requires an empty local household. Existing information was not changed.");
            if (current?.phase !== "encrypted" || current.vaultId !== vault.vaultId ||
                current.rootVersion !== vault.manifest.rootVersion || !valuesEqual(current.verifier, vault.manifest.verifier) ||
                (current.lockEpoch ?? 0) !== vault.securityEpoch ||
                (manifest && (manifest.vaultId !== current.vaultId || !valuesEqual(manifest.verifier, current.verifier))))
              throw new EventStoreError("Unlock and finish protecting the empty household before restoring an archive.");
            for (const [name, records] of Object.entries(protectedRows)) {
              const store = transaction.objectStore(name);
              store.clear();
              for (const record of records) store.put(record);
            }
            bumpEventGeneration(transaction);
            finish({ eventCount: history.length, localOnly: true });
          } catch (error) { abortWith(transaction, error); }
        };
        for (const name of names) {
          if (name === SECURITY_STORE) {
            const request = transaction.objectStore(name).get(SECURITY_KEY);
            request.onsuccess = () => { current = request.result; complete(); };
          } else {
            const request = transaction.objectStore(name).count();
            request.onsuccess = () => {
              // The empty installation singleton is replaced; all history and
              // transport stores must be empty inside this committing transaction.
              if (name !== CONTEXT_STORE && request.result !== 0) occupied = true;
              if (name === CONTEXT_STORE && request.result > 1) occupied = true;
              complete();
            };
          }
        }
      });
    } finally { database.close(); }
  }

  append(command, engine) {
    const transaction = this.database.transaction(
      [EVENT_STORE, CONTEXT_STORE, SYNC_STATE_STORE, SYNC_OUTBOX_STORE],
      "readwrite",
    );
    const events = transaction.objectStore(EVENT_STORE);
    const contextStore = transaction.objectStore(CONTEXT_STORE);
    const syncStates = transaction.objectStore(SYNC_STATE_STORE);
    const outbox = transaction.objectStore(SYNC_OUTBOX_STORE);
    const history = historyRequest(this, transaction);
    const contextRequest = contextStore.get(CONTEXT_KEY);
    const syncStateRequest = syncStates.get("active");

    // Filled once the new row has a key; applied to the arena after commit.
    let committed = null;

    const result = transactionResult(transaction, (finish) => {
      let view;
      let context;
      let syncState;
      let eventsReady = false;
      let contextReady = false;
      let syncStateReady = false;
      let candidateState;

      const prepareCandidate = () => {
        if (!eventsReady || !contextReady || !syncStateReady) {
          return;
        }
        try {
          validateContext(context);
          validateCursorBoundary(context, view);
          if (view.length >= MAX_EVENT_COUNT) {
            throw new EventStoreError(
              "Kin has reached its local event limit. Your saved information was not deleted.",
            );
          }
          if (syncState && syncState.pendingCount >= MAX_EVENT_COUNT)
            throw new EventStoreError(
              "Kin's sync queue is full. Sync this device before adding more household changes.",
            );

          const logicalTime = BigInt(context.next_logical_time);
          if (logicalTime <= 0n || logicalTime > MAX_LOGICAL_TIME) {
            throw new EventStoreError(
              "Kin has reached a supported event-order limit. Your saved information was not deleted.",
            );
          }
          const eventId = randomId();
          const { asOf, civilDate } = projectionContext();
          const timestamp =
            command.type === "set-pulse" ? command.timestamp : asOf;
          const identity = {
            eventId,
            householdId: context.sync_household_id ?? context.household_id,
            actorId: context.sync_member_id ?? context.actor_id,
            deviceId: context.sync_device_id ?? context.device_id,
            timestamp,
            logicalTime,
          };
          const syncIdentity = syncIdentityFromContext(context);
          const result = engine.executeCommand(
            command,
            { ...identity, entityId: randomId() },
            view,
            asOf,
            cursorEventId(context),
            civilDate,
            syncIdentity,
          );
          const encodedEvent = result.encodedEvent;
          const kind = result.metadata.kind;
          candidateState = result.state;

          const existingRequest = events.index("event_id").get(eventId);
          existingRequest.onsuccess = () => {
            const existing = existingRequest.result;
            if (existing) {
              if (!bytesEqual(existing.encoded_event, encodedEvent)) {
                abortWith(
                  transaction,
                  new EventStoreError(
                    "Kin found a conflicting local event identifier. Your saved information was not deleted.",
                  ),
                );
                return;
              }
              const currentState = engine.applyEvents(
                view,
                asOf,
                cursorEventId(context),
                civilDate,
                syncIdentity,
              );
              finish({
                state: currentState,
                snapshotBoundary: snapshotBoundary(view),
              });
              return;
            }

            const row = {
              event_id: eventId,
              household_id: identity.householdId,
              actor_id: identity.actorId,
              device_id: identity.deviceId,
              timestamp,
              logical_time: logicalTime,
              kind,
              event_version: result.metadata.eventVersion,
              encoded_event: encodedEvent,
            };
            try {
              const appendResult = {
                state: candidateState,
                snapshotBoundary: null,
              };
              const addRequest = events.add(row);
              addRequest.onsuccess = () => {
                appendResult.snapshotBoundary = {
                  eventId: idToHex(eventId),
                  localSequence: addRequest.result,
                  snapshotThroughEventId: idToHex(eventId),
                  snapshotThroughLocalSequence: addRequest.result,
                };
                committed = { view, localSequence: addRequest.result, encodedEvent, metadata: result.metadata };
              };
              const contextWrite = contextStore.put({
                ...context,
                next_logical_time: logicalTime + 1n,
              });
              if (syncState) {
                const deviceSequence = syncState.nextDeviceSequence;
                const outboxWrite = outbox.add({
                  event_id: idToHex(eventId),
                  householdId: idToHex(identity.householdId),
                  deviceId: idToHex(identity.deviceId),
                  deviceSequence,
                  keyEpoch: syncState.rotationPending
                    ? null
                    : syncState.currentEpoch,
                  canonical_event: encodedEvent.slice(),
                  envelope: null,
                  accepted: false,
                });
                syncState.nextDeviceSequence += 1;
                syncState.pendingCount += 1;
                const syncStateWrite = syncStates.put(syncState);
                outboxWrite.onerror = () =>
                  abortWith(transaction, storageError(outboxWrite.error));
                syncStateWrite.onerror = () =>
                  abortWith(transaction, storageError(syncStateWrite.error));
              }
              addRequest.onerror = () =>
                abortWith(transaction, storageError(addRequest.error));
              contextWrite.onerror = () =>
                abortWith(transaction, storageError(contextWrite.error));
              finish(appendResult);
            } catch (error) {
              // Request creation can throw before an onerror handler exists.
              abortWith(transaction, storageError(error));
            }
          };
          existingRequest.onerror = () =>
            abortWith(transaction, storageError(existingRequest.error));
        } catch (error) {
          abortWith(
            transaction,
            error instanceof EventStoreError
              ? error
              : new EventStoreError(
                  error.userMessage ??
                    "Kin could not validate that household change.",
                  error,
                ),
          );
        }
      };

      history.onsuccess = () => {
        view = history.result;
        eventsReady = true;
        prepareCandidate();
      };
      contextRequest.onsuccess = () => {
        context = contextRequest.result;
        contextReady = true;
        prepareCandidate();
      };
      syncStateRequest.onsuccess = () => {
        syncState = syncStateRequest.result ?? null;
        syncStateReady = true;
        prepareCandidate();
      };
      contextRequest.onerror = () =>
        abortWith(transaction, storageError(contextRequest.error));
      syncStateRequest.onerror = () =>
        abortWith(transaction, storageError(syncStateRequest.error));
    });
    return result.then((value) => {
      this.#appendCommitted(committed);
      return value;
    });
  }

  // Extends the arena with an event this tab just committed, using the
  // plaintext it already holds. Only a direct successor of the view the write
  // validated against is appended; anything else is left for the next read.
  #appendCommitted(committed) {
    if (!committed) return;
    const { view, localSequence, encodedEvent, metadata } = committed;
    if (view.epoch !== this.arena.epoch || this.arena.length !== view.length) return;
    this.arena.append(localSequence, encodedEvent, metadata);
  }

  getCatchUpState() {
    const transaction = this.database.transaction(
      [EVENT_STORE, CONTEXT_STORE],
      "readonly",
    );
    const history = historyRequest(this, transaction);
    const contextRequest = transaction
      .objectStore(CONTEXT_STORE)
      .get(CONTEXT_KEY);

    return transactionResult(transaction, (finish) => {
      let loadedEvents;
      let context;
      let eventsReady = false;
      let contextReady = false;
      const complete = () => {
        if (!eventsReady || !contextReady) return;
        try {
          validateContext(context);
          validateCursorBoundary(context, loadedEvents);
          const boundary = snapshotBoundary(loadedEvents);
          // Meals views reuse this (see meals()), with the arena it names.
          this.recentSyncIdentity = { epoch: loadedEvents.epoch, value: syncIdentityFromContext(context) };
          finish({
            // A HistoryView, not an array: pass it to the engine directly;
            // `.rows()` gives detached row objects.
            events: loadedEvents,
            // `cursor` is where this person last looked ("Caught up"), so the
            // summary lists what came after it. `through` is the newest event
            // in this snapshot, which a later "Caught up" may commit.
            syncIdentity: syncIdentityFromContext(context),
            cursor: {
              eventId: context.last_looked_event_id
                ? idToHex(context.last_looked_event_id)
                : null,
              localSequence: context.last_looked_local_sequence,
              lastLookedAt: context.last_looked_at,
            },
            through: boundary
              ? { eventId: boundary.eventId, localSequence: boundary.localSequence }
              : null,
          });
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      history.onsuccess = () => {
        loadedEvents = history.result;
        eventsReady = true;
        complete();
      };
      contextRequest.onsuccess = () => {
        context = contextRequest.result;
        contextReady = true;
        complete();
      };
      contextRequest.onerror = () =>
        abortWith(transaction, storageError(contextRequest.error));
    });
  }

  initializeSync({
    identity,
    serverStatus,
    identityBindings = [],
    legacyBindingEnvelope = null,
  }) {
    const transaction = this.database.transaction(
      [
        EVENT_STORE,
        CONTEXT_STORE,
        SYNC_STATE_STORE,
        SYNC_OUTBOX_STORE,
        SYNC_BINDING_STORE,
      ],
      "readwrite",
    );
    const eventsStore = transaction.objectStore(EVENT_STORE);
    const contextStore = transaction.objectStore(CONTEXT_STORE);
    const syncStates = transaction.objectStore(SYNC_STATE_STORE);
    const outbox = transaction.objectStore(SYNC_OUTBOX_STORE);
    const bindings = transaction.objectStore(SYNC_BINDING_STORE);
    const history = historyRequest(this, transaction);
    const contextRequest = contextStore.get(CONTEXT_KEY);
    const syncStateRequest = syncStates.get("active");

    return transactionResult(transaction, (finish) => {
      let loadedEvents;
      let context;
      let state;
      let ready = 0;
      const initialize = () => {
        ready += 1;
        if (ready !== 3) return;
        try {
          validateContext(context);
          validateCursorBoundary(context, loadedEvents);
          loadedEvents = loadedEvents.rows();
          for (const field of ["householdId", "memberId", "deviceId"])
            idFromHex(identity?.[field]);
          if (context.archive_imported && context.sync_household_id &&
              idToHex(context.sync_household_id) !== identity.householdId)
            throw new EventStoreError("This export belongs to another household. Its history was kept on this device and was not synced.");
          if (state) {
            if (
              state.householdId !== identity.householdId ||
              state.memberId !== identity.memberId ||
              state.deviceId !== identity.deviceId
            )
              throw new EventStoreError(
                "This browser's saved sync identity does not match the signed-in device.",
              );
            finish({ state, syncIdentity: syncIdentityFromContext(context) });
            return;
          }
          if (loadedEvents.length > MAX_EVENT_COUNT)
            throw new EventStoreError(
              "Kin reached its local sync queue limit.",
            );
          const identityTuple = {
            legacyHouseholdId: idToHex(context.household_id),
            legacyActorId: idToHex(context.actor_id),
            legacyDeviceId: idToHex(context.device_id),
            householdId: identity.householdId,
            actorId: identity.memberId,
            deviceId: identity.deviceId,
          };
          const requiresBinding = loadedEvents.some(
            (row) =>
              !bytesEqual(row.household_id, idFromHex(identity.householdId)) ||
              !bytesEqual(row.actor_id, idFromHex(identity.memberId)) ||
              !bytesEqual(row.device_id, idFromHex(identity.deviceId)),
          );
          const legacyTupleIsKnown =
            (context.sync_identity_bindings ?? []).some(
              (binding) =>
                binding.legacyHouseholdId === idToHex(context.household_id) &&
                binding.legacyActorId === idToHex(context.actor_id) &&
                binding.legacyDeviceId === idToHex(context.device_id),
            ) ||
            identityBindings.some((record) =>
              sameLegacyTupleForContext(record.binding, context),
            );
          if (requiresBinding && !legacyTupleIsKnown && !legacyBindingEnvelope)
            throw new EventStoreError(
              "Kin could not safely bind this local history to the trusted household.",
            );
          const bindingRecords = [...identityBindings];
          if (requiresBinding && !legacyTupleIsKnown)
            bindingRecords.push({
              binding: identityTuple,
              envelope: legacyBindingEnvelope,
            });
          const combinedBindings = new Map();
          for (const record of [
            ...(context.sync_identity_bindings ?? []).map((binding) => ({
              binding,
            })),
            ...bindingRecords,
          ]) {
            const binding = record.binding;
            const legacyKey = `${binding.legacyHouseholdId}:${binding.legacyActorId}:${binding.legacyDeviceId}`;
            const existing = combinedBindings.get(legacyKey);
            if (
              existing &&
              canonicalJson(existing.binding) !== canonicalJson(binding)
            )
              throw new EventStoreError(
                "Kin found conflicting household identity bindings.",
              );
            combinedBindings.set(legacyKey, record);
          }
          const verifiedBindings = [...combinedBindings.values()].map(
            (record) => record.binding,
          );
          const updatedContext = {
            ...context,
            sync_household_id: idFromHex(identity.householdId),
            sync_member_id: idFromHex(identity.memberId),
            sync_device_id: idFromHex(identity.deviceId),
            sync_identity_bindings: verifiedBindings,
          };
          const maxLogicalTime = loadedEvents.reduce(
            (maximum, row) =>
              row.logical_time > maximum ? row.logical_time : maximum,
            0n,
          );
          const newState = {
            key: "active",
            householdId: identity.householdId,
            memberId: identity.memberId,
            deviceId: identity.deviceId,
            currentEpoch: serverStatus.currentEpoch,
            pendingEpoch: serverStatus.pendingEpoch,
            rotationPending: serverStatus.rotationPending === true,
            syncCursor: "",
            cursorHighWater: "",
            relayHighWater: "",
            nextDeviceSequence: loadedEvents.length + 1,
            maxLogicalTime,
            pendingCount: loadedEvents.length,
            initialized: false,
          };
          // The sync identity or bindings may change: meals and names read again (recentHistory).
          this.recentSyncIdentity = null;
          const contextWrite = contextStore.put(updatedContext);
          const stateWrite = syncStates.add(newState);
          contextWrite.onerror = () =>
            abortWith(transaction, storageError(contextWrite.error));
          stateWrite.onerror = () =>
            abortWith(transaction, storageError(stateWrite.error));
          for (const record of bindingRecords) {
            const binding = record.binding;
            const legacyKey = `${binding.legacyHouseholdId}:${binding.legacyActorId}:${binding.legacyDeviceId}`;
            const bindingWrite = bindings.put({
              legacy_key: legacyKey,
              ...binding,
              controlEnvelope: structuredClone(record.envelope ?? null),
              uploaded:
                Boolean(record.uploaded) ||
                (record.envelope?.deviceId != null &&
                  record.envelope.deviceId !== identity.deviceId),
            });
            bindingWrite.onerror = () =>
              abortWith(transaction, storageError(bindingWrite.error));
          }
          loadedEvents.forEach((row, index) => {
            const eventId = idToHex(row.event_id);
            const write = outbox.add({
              event_id: eventId,
              householdId: identity.householdId,
              deviceId: identity.deviceId,
              deviceSequence: index + 1,
              // Like a new local change (append), history queued while a key
              // rotation is pending waits for the new epoch: sealing it under
              // the epoch being retired would let a removed device read it
              // and hide it from a member who joins at the new epoch.
              keyEpoch: serverStatus.rotationPending === true
                ? null
                : serverStatus.currentEpoch,
              canonical_event: asBytes(row.encoded_event).slice(),
              envelope: null,
              accepted: false,
            });
            write.onerror = () =>
              abortWith(transaction, storageError(write.error));
          });
          finish({
            state: newState,
            syncIdentity: syncIdentityFromContext(updatedContext),
          });
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      history.onsuccess = () => {
        loadedEvents = history.result;
        initialize();
      };
      contextRequest.onsuccess = () => {
        context = contextRequest.result;
        initialize();
      };
      syncStateRequest.onsuccess = () => {
        state = syncStateRequest.result;
        initialize();
      };
      contextRequest.onerror = () =>
        abortWith(transaction, storageError(contextRequest.error));
      syncStateRequest.onerror = () =>
        abortWith(transaction, storageError(syncStateRequest.error));
    });
  }

  getSyncState() {
    const transaction = this.database.transaction(SYNC_STATE_STORE, "readonly");
    const request = transaction.objectStore(SYNC_STATE_STORE).get("active");
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => finish(request.result ?? null);
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  async projectCurrent() {
    if (!this.engine) throw new EventStoreError("Kin could not rebuild the household view.");
    const { events, cursor, syncIdentity } = await this.getCatchUpState();
    const { asOf, civilDate } = projectionContext();
    return this.engine.applyEvents(events, asOf, cursor.eventId, civilDate, syncIdentity);
  }

  /** The household's named devices (#71), replayed from the current history
   * under its sync identity: [{ deviceId, memberId, autoName, nickname }]. */
  async deviceNames() {
    if (!this.engine) throw new EventStoreError("Kin could not read device names.");
    const { events, syncIdentity } = await this.getCatchUpState();
    const { asOf, civilDate } = projectionContext();
    return this.engine.deviceNames(events, asOf, civilDate, syncIdentity);
  }

  /** Members' preferred display names (#224), replayed from the current
   * history under its sync identity: [{ memberId, name }]. */
  async memberNames() {
    if (!this.engine) throw new EventStoreError("Kin could not read member names.");
    const { events, syncIdentity } = await this.recentHistory();
    const { asOf, civilDate } = projectionContext();
    return this.engine.memberNames(events, asOf, civilDate, syncIdentity);
  }

  /** Meals (#333), replayed from the current history: { recipes, dinners }
   * (kin-meals.js decodeMeals), dinners around the projection date. */
  async meals() {
    if (!this.engine) throw new EventStoreError("Kin could not read meals.");
    const { events, syncIdentity } = await this.recentHistory();
    const { asOf, civilDate } = projectionContext();
    return this.engine.meals(events, asOf, civilDate, syncIdentity);
  }

  /** Item emoji (#344): a Map itemId -> emoji. */
  /** The seven days from `startCivilDate` (#417): items, routines, dinners
   * and maintenance by day, from Rust. */
  async week(startCivilDate) {
    if (!this.engine) throw new EventStoreError("Kin could not read the week.");
    const { events, syncIdentity } = await this.recentHistory();
    const { asOf, civilDate } = projectionContext();
    return this.engine.week(startCivilDate, events, asOf, civilDate, syncIdentity);
  }

  async itemEmojis() {
    if (!this.engine) throw new EventStoreError("Kin could not read item pictures.");
    const { events, syncIdentity } = await this.recentHistory();
    const { asOf, civilDate } = projectionContext();
    return this.engine.itemEmojis(events, asOf, civilDate, syncIdentity);
  }

  /** Store sections (#411, ADR 0015): { sections: [{ sectionId, name }],
   * itemSections: Map itemId -> sectionId }. */
  async shoppingSections() {
    if (!this.engine) throw new EventStoreError("Kin could not read store sections.");
    const { events, syncIdentity } = await this.recentHistory();
    const { asOf, civilDate } = projectionContext();
    return this.engine.shoppingSections(events, asOf, civilDate, syncIdentity);
  }

  /** Taking turns (#429, ADR 0016): [{ routineId, memberIds, current, next }]
   * for each rotating routine; kin-rotations.js turnAmong() passes over
   * members who aren't active. */
  async routineRotations() {
    if (!this.engine) throw new EventStoreError("Kin could not read whose turn it is.");
    const { events, syncIdentity } = await this.recentHistory();
    const { asOf, civilDate } = projectionContext();
    return this.engine.routineRotations(events, asOf, civilDate, syncIdentity);
  }
  /** The sitter page (#442, ADR 0017): { intro, entries: [{ kind, id }] },
   * the entries whose record exists and isn't archived, in the page's order.
   * Changing it is Adult-only; the command append path checks that
   * (kin-sitter.js). */
  async sitterPage() {
    if (!this.engine) throw new EventStoreError("Kin could not read the sitter page.");
    const { events, syncIdentity } = await this.recentHistory();
    const { asOf, civilDate } = projectionContext();
    return this.engine.sitterPage(events, asOf, civilDate, syncIdentity);
  }

  /** The family album (#673, ADR 0022 §5): { photos, removed }, both
   * newest first (kin-album.js). Removing a photo is for whoever added it or
   * a household admin; the command append path checks that. */
  async album() {
    if (!this.engine) throw new EventStoreError("Kin could not read the family photos.");
    const { events, syncIdentity } = await this.recentHistory();
    const { asOf, civilDate } = projectionContext();
    return this.engine.album(events, asOf, civilDate, syncIdentity);
  }

  /** The calendar from `from` to `to` (#656, ADR 0022; civil dates, at most
   * 400 days): event occurrences merged with dated items, routines and
   * meals, the next countdown and member colours (kin-calendar.js
   * decodeCalendarRange). Options: { allEvents, includeCancelled }. */
  async calendarRange(from, to, options = {}) {
    if (!this.engine) throw new EventStoreError("Kin could not read the calendar.");
    const { events, syncIdentity } = await this.recentHistory();
    const { asOf, civilDate } = projectionContext();
    return this.engine.calendarRange(from, to, events, asOf, civilDate, syncIdentity, options);
  }

  /** Members' chosen calendar colours (#656): a Map memberId -> 0–11. Members
   * without one use kin-calendar.js defaultMemberColour by join order. */
  async memberColours() {
    const { civilDate } = projectionContext();
    return (await this.calendarRange(civilDate, civilDate)).colours;
  }

  /** An .ics file's events, parsed on this device (#666; kin-calendar.js
   * decodeICalendar). Reads no history; saving them is the caller's job. */
  parseICalendar(bytes) {
    if (!this.engine) throw new EventStoreError("Kin could not read that calendar file.");
    return this.engine.parseICalendar(bytes);
  }

  /** The chore chart for this week (#676, ADR 0022 §6): `members` are the
   * household's children and Adults in join order ([{ memberId, kind:
   * "child" | "adult" }]) and `adultsAllowed` the admin's setting. The week
   * is Monday to Sunday in this device's time zone (kin-chores.js). */
  async choreChart({ members = [], adultsAllowed = false } = {}) {
    if (!this.engine) throw new EventStoreError("Kin could not read the chore chart.");
    const { events, syncIdentity } = await this.recentHistory();
    const { asOf, civilDate } = projectionContext();
    const { start, bounds } = choreWeek(civilDate);
    return this.engine.choreChart({ start, bounds, adultsAllowed, members }, events, asOf, civilDate, syncIdentity);
  }

  /** `memberId`'s things today (#344, ADR 0013), in Rust's order. */
  async myThings(memberId) {
    if (!this.engine) throw new EventStoreError("Kin could not read your things for today.");
    const { events, syncIdentity } = await this.recentHistory();
    const { asOf, civilDate } = projectionContext();
    return this.engine.myThings(memberId, events, asOf, civilDate, syncIdentity);
  }

  /**
   * The history for a view that is read after every render (meals, names).
   * The session arena already holds what the last read loaded plus this
   * tab's appends since, so it's used as it is; another tab's changes arrive
   * through the peer refresh, which reads and then renders. When the arena
   * isn't known to be current (locked, rebuilt, never read), this reads.
   */
  async recentHistory() {
    const recent = this.recentSyncIdentity;
    if (recent && recent.epoch === this.arena.epoch && this.arena.generation !== null && this.arena.length > 0)
      return { events: this.arena.view(), syncIdentity: recent.value };
    return this.getCatchUpState();
  }

  /** What adding a recipe's ({ recipeId }) or a date's dinner's ({ date })
   * ingredients to Shopping would do now (#333). */
  async mealShoppingPlan(source) {
    if (!this.engine) throw new EventStoreError("Kin could not plan the ingredients.");
    const { events, syncIdentity } = await this.getCatchUpState();
    const { asOf, civilDate } = projectionContext();
    return this.engine.mealShoppingPlan(source, events, asOf, civilDate, syncIdentity);
  }

  updateSyncServerState(status) {
    const transaction = this.database.transaction(
      [SYNC_STATE_STORE, SYNC_OUTBOX_STORE],
      "readwrite",
    );
    const store = transaction.objectStore(SYNC_STATE_STORE);
    const outbox = transaction.objectStore(SYNC_OUTBOX_STORE);
    const stateRequest = store.get("active");
    const outboxRequest = outbox.getAll();
    return transactionResult(transaction, (finish) => {
      let state;
      let rows;
      let ready = 0;
      const complete = () => {
        ready += 1;
        if (ready !== 2) return;
        if (!state) {
          finish(null);
          return;
        }
        if (status.currentEpoch < state.currentEpoch) {
          abortWith(
            transaction,
            new EventStoreError("Kin rejected a household key epoch rollback."),
          );
          return;
        }
        state.currentEpoch = status.currentEpoch;
        state.pendingEpoch = status.pendingEpoch;
        state.rotationPending = status.rotationPending === true;
        if (
          status.latestCursor != null &&
          cursorValue(status.latestCursor) >=
            cursorValue(state.relayHighWater ?? "")
        )
          state.relayHighWater = status.latestCursor;
        if (!state.rotationPending) {
          for (const row of rows) {
            if (row.keyEpoch == null && !row.envelope) {
              row.keyEpoch = status.currentEpoch;
              const write = outbox.put(row);
              write.onerror = () =>
                abortWith(transaction, storageError(write.error));
            }
          }
        }
        const write = store.put(state);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(state);
      };
      stateRequest.onsuccess = () => {
        state = stateRequest.result;
        complete();
      };
      outboxRequest.onsuccess = () => {
        rows = outboxRequest.result;
        complete();
      };
      stateRequest.onerror = () =>
        abortWith(transaction, storageError(stateRequest.error));
      outboxRequest.onerror = () =>
        abortWith(transaction, storageError(outboxRequest.error));
    });
  }

  requeueAfterRelayReset(serverCursor) {
    const transaction = this.database.transaction(
      [SYNC_STATE_STORE, SYNC_OUTBOX_STORE],
      "readwrite",
    );
    const states = transaction.objectStore(SYNC_STATE_STORE);
    const outbox = transaction.objectStore(SYNC_OUTBOX_STORE);
    const stateRequest = states.get("active");
    const outboxRequest = outbox.getAll();
    return transactionResult(transaction, (finish) => {
      let state;
      let rows;
      let ready = 0;
      const complete = () => {
        ready += 1;
        if (ready !== 2) return;
        try {
          const localHighWater =
            cursorValue(state?.cursorHighWater ?? "") >=
            cursorValue(state?.relayHighWater ?? "")
              ? (state?.cursorHighWater ?? "")
              : (state?.relayHighWater ?? "");
          if (
            !state ||
            cursorValue(serverCursor) >= cursorValue(localHighWater)
          ) {
            finish(false);
            return;
          }
          for (const row of rows) {
            if (row.remote_present) {
              delete row.remote_present;
              delete row.remote_device_sequence;
            }
            if (row.accepted && row.envelope) {
              row.accepted = false;
            }
            if (!row.accepted || row.envelope) {
              const write = outbox.put(row);
              write.onerror = () => abortWith(transaction, storageError(write.error));
            }
          }
          state.pendingCount = rows.filter((row) => !row.accepted).length;
          state.syncCursor = "";
          state.cursorHighWater = "";
          state.relayHighWater = "";
          const write = states.put(state);
          write.onerror = () =>
            abortWith(transaction, storageError(write.error));
          finish(true);
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      stateRequest.onsuccess = () => {
        state = stateRequest.result;
        complete();
      };
      outboxRequest.onsuccess = () => {
        rows = outboxRequest.result;
        complete();
      };
      stateRequest.onerror = () =>
        abortWith(transaction, storageError(stateRequest.error));
      outboxRequest.onerror = () =>
        abortWith(transaction, storageError(outboxRequest.error));
    });
  }

  savePendingRotation(rotation) {
    const transaction = this.database.transaction(
      SYNC_STATE_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(SYNC_STATE_STORE);
    const request = store.get("active");
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        const state = request.result;
        if (!state) {
          abortWith(
            transaction,
            new EventStoreError("Kin has not initialized encrypted sync."),
          );
          return;
        }
        if (
          state.pendingRotation &&
          canonicalJson(state.pendingRotation) !== canonicalJson(rotation)
        ) {
          abortWith(
            transaction,
            new EventStoreError("Kin found conflicting pending key rotations."),
          );
          return;
        }
        state.pendingRotation ??= structuredClone(rotation);
        const write = store.put(state);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(state.pendingRotation);
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  replacePendingRotationPackages({ expected, packages, issuerFingerprint }) {
    const transaction = this.database.transaction(SYNC_STATE_STORE, "readwrite");
    const store = transaction.objectStore(SYNC_STATE_STORE);
    const request = store.get("active");
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        const state = request.result;
        if (!state?.pendingRotation || state.currentEpoch !== expected.expectedEpoch ||
            canonicalJson(state.pendingRotation) !== canonicalJson(expected)) {
          abortWith(transaction, new EventStoreError("The pending key rotation changed. Retry synchronization."));
          return;
        }
        // Only packages change: the proposal ID and sealed epoch key survive an
        // ambiguous request, so an earlier accepted submission remains usable.
        state.pendingRotation = { ...state.pendingRotation, packages: structuredClone(packages), issuerFingerprint };
        const write = store.put(state);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(state.pendingRotation);
      };
      request.onerror = () => abortWith(transaction, storageError(request.error));
    });
  }

  commitPendingRotation({ expectedEpoch, currentEpoch, proposalId }) {
    const transaction = this.database.transaction(
      SYNC_STATE_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(SYNC_STATE_STORE);
    const request = store.get("active");
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        const state = request.result;
        if (
          !state ||
          !state.pendingRotation ||
          state.pendingRotation.expectedEpoch !== expectedEpoch ||
          state.pendingRotation.epoch !== currentEpoch ||
          state.pendingRotation.proposalId !== proposalId ||
          state.currentEpoch > currentEpoch
        ) {
          abortWith(
            transaction,
            new EventStoreError(
              "Kin could not match the accepted key rotation.",
            ),
          );
          return;
        }
        state.currentEpoch = currentEpoch;
        // A later access change may already require the following rotation.
        // Only a fresh server-status update can release queued local events.
        state.pendingRotation = null;
        const write = store.put(state);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(state);
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  clearPendingRotation(proposalId) {
    const transaction = this.database.transaction(
      SYNC_STATE_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(SYNC_STATE_STORE);
    const request = store.get("active");
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        const state = request.result;
        if (!state || state.pendingRotation?.proposalId !== proposalId) {
          finish(false);
          return;
        }
        state.pendingRotation = null;
        const write = store.put(state);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(true);
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  getProvisioningRequest(recipientDeviceId, keyEpoch) {
    const transaction = this.database.transaction(
      SYNC_STATE_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(SYNC_STATE_STORE);
    const request = store.get("active");
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        const state = request.result;
        if (!state) {
          abortWith(
            transaction,
            new EventStoreError("Kin has not initialized encrypted sync."),
          );
          return;
        }
        state.provisioningRequests ??= {};
        const key = `${recipientDeviceId}:${keyEpoch}`;
        let entry = state.provisioningRequests[key];
        if (!entry) {
          if (Object.keys(state.provisioningRequests).length >= 2048) {
            abortWith(
              transaction,
              new EventStoreError(
                "Kin reached its device key-transfer history limit.",
              ),
            );
            return;
          }
          entry = {
            requestId: idToHex(randomId()),
            recipientDeviceId,
            keyEpoch,
            package: null,
            accepted: false,
          };
          state.provisioningRequests[key] = entry;
        }
        const write = store.put(state);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(structuredClone(entry));
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  updateProvisioningRequest(requestId, update) {
    const transaction = this.database.transaction(
      SYNC_STATE_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(SYNC_STATE_STORE);
    const request = store.get("active");
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        const state = request.result;
        const entry = Object.values(state?.provisioningRequests ?? {}).find(
          (value) => value.requestId === requestId,
        );
        if (!entry) {
          abortWith(
            transaction,
            new EventStoreError(
              "Kin could not find the pending device key transfer.",
            ),
          );
          return;
        }
        Object.assign(entry, structuredClone(update));
        const write = store.put(state);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(structuredClone(entry));
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  getSyncBootstrap() {
    const transaction = this.database.transaction(
      [EVENT_STORE, CONTEXT_STORE],
      "readonly",
    );
    const history = historyRequest(this, transaction);
    const contextRequest = transaction
      .objectStore(CONTEXT_STORE)
      .get(CONTEXT_KEY);
    return transactionResult(transaction, (finish) => {
      let events;
      let context;
      let ready = 0;
      const complete = () => {
        ready += 1;
        if (ready !== 2) return;
        try {
          validateContext(context);
          const maxLogicalTime = events.maxLogicalTime();
          events = events.rows();
          finish({
            events,
            legacyIdentity: {
              householdId: idToHex(context.household_id),
              actorId: idToHex(context.actor_id),
              deviceId: idToHex(context.device_id),
            },
            maxLogicalTime,
          });
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      history.onsuccess = () => {
        events = history.result;
        complete();
      };
      contextRequest.onsuccess = () => {
        context = contextRequest.result;
        complete();
      };
      contextRequest.onerror = () =>
        abortWith(transaction, storageError(contextRequest.error));
    });
  }

  getPendingBindings() {
    const transaction = this.database.transaction(
      SYNC_BINDING_STORE,
      "readonly",
    );
    const request = transaction.objectStore(SYNC_BINDING_STORE).getAll();
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () =>
        finish(
          request.result.filter(
            (record) => !record.uploaded && record.controlEnvelope,
          ),
        );
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  // Replaces the sealed envelope of this device's not-yet-uploaded identity
  // binding (re-sealed under a newer key epoch). False if it was uploaded or
  // another tab already replaced the envelope this one re-sealed.
  replacePendingBindingEnvelope(legacyKey, expectedEventId, envelope) {
    const transaction = this.database.transaction(
      SYNC_BINDING_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(SYNC_BINDING_STORE);
    const request = store.get(legacyKey);
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        const record = request.result;
        if (!record || record.uploaded || record.controlEnvelope?.eventId !== expectedEventId) {
          finish(false);
          return;
        }
        record.controlEnvelope = structuredClone(envelope);
        const write = store.put(record);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(true);
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  markBindingUploaded(legacyKey) {
    const transaction = this.database.transaction(
      SYNC_BINDING_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(SYNC_BINDING_STORE);
    const request = store.get(legacyKey);
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        const record = request.result;
        if (!record) {
          finish(false);
          return;
        }
        record.uploaded = true;
        const write = store.put(record);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(true);
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  installIdentityBindings(records, identity) {
    if (!Array.isArray(records) || records.length > 256)
      throw new EventStoreError("Kin received too many identity bindings.");
    const transaction = this.database.transaction(
      [CONTEXT_STORE, SYNC_BINDING_STORE],
      "readwrite",
    );
    const contextStore = transaction.objectStore(CONTEXT_STORE);
    const bindingStore = transaction.objectStore(SYNC_BINDING_STORE);
    const contextRequest = contextStore.get(CONTEXT_KEY);
    return transactionResult(transaction, (finish) => {
      contextRequest.onsuccess = () => {
        try {
          const context = contextRequest.result;
          validateContext(context);
          const bindingsByKey = new Map(
            (context.sync_identity_bindings ?? []).map((binding) => [
              `${binding.legacyHouseholdId}:${binding.legacyActorId}:${binding.legacyDeviceId}`,
              binding,
            ]),
          );
          for (const record of records) {
            const binding = record.binding;
            if (
              binding.householdId !== identity.householdId ||
              binding.deviceId !== record.envelope.deviceId
            )
              throw new EventStoreError(
                "Kin received an identity binding for another household or device.",
              );
            const key = `${binding.legacyHouseholdId}:${binding.legacyActorId}:${binding.legacyDeviceId}`;
            const existing = bindingsByKey.get(key);
            if (existing && canonicalJson(existing) !== canonicalJson(binding))
              throw new EventStoreError(
                "Kin found conflicting household identity bindings.",
              );
            bindingsByKey.set(key, binding);
            const write = bindingStore.put({
              legacy_key: key,
              ...binding,
              controlEnvelope: structuredClone(record.envelope),
              uploaded: true,
            });
            write.onerror = () =>
              abortWith(transaction, storageError(write.error));
          }
          context.sync_identity_bindings = [...bindingsByKey.values()];
          // The sync identity or bindings may change: meals and names read again (recentHistory).
          this.recentSyncIdentity = null;
          const contextWrite = contextStore.put(context);
          contextWrite.onerror = () =>
            abortWith(transaction, storageError(contextWrite.error));
          finish(context.sync_identity_bindings);
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      contextRequest.onerror = () =>
        abortWith(transaction, storageError(contextRequest.error));
    });
  }

  getPendingOutbox(limit = 20) {
    const transaction = this.database.transaction(
      SYNC_OUTBOX_STORE,
      "readonly",
    );
    const request = transaction.objectStore(SYNC_OUTBOX_STORE).getAll();
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () =>
        finish(
          request.result
            .filter((row) => !row.accepted)
            .sort((left, right) => left.deviceSequence - right.deviceSequence)
            .slice(0, limit),
        );
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  getRemoteDuplicateOutbox(limit = MAX_EVENT_COUNT) {
    const transaction = this.database.transaction(SYNC_OUTBOX_STORE, "readonly");
    const request = transaction.objectStore(SYNC_OUTBOX_STORE).getAll();
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => finish(request.result
        .filter((row) => row.remote_present === true && !row.accepted)
        .sort((left, right) => left.deviceSequence - right.deviceSequence)
        .slice(0, limit));
      request.onerror = () => abortWith(transaction, storageError(request.error));
    });
  }

  compactArchiveOutboxSequences() {
    const transaction = this.database.transaction(
      [CONTEXT_STORE, SYNC_STATE_STORE, SYNC_OUTBOX_STORE], "readwrite",
    );
    const contexts = transaction.objectStore(CONTEXT_STORE);
    const states = transaction.objectStore(SYNC_STATE_STORE);
    const outbox = transaction.objectStore(SYNC_OUTBOX_STORE);
    const contextRequest = contexts.get(CONTEXT_KEY);
    const stateRequest = states.get("active");
    const rowsRequest = outbox.getAll();
    return transactionResult(transaction, (finish) => {
      let context, state, rows, ready = 0;
      const complete = () => {
        ready += 1;
        if (ready !== 3) return;
        try {
          validateContext(context);
          if (!context.archive_imported || !state || state.initialized) {
            finish(false);
            return;
          }
          let nextSequence = rows.reduce((maximum, row) =>
            row.remote_present && Number.isSafeInteger(row.remote_device_sequence) &&
              row.deviceId === state.deviceId
              ? Math.max(maximum, row.remote_device_sequence) : maximum, 0);
          const pending = rows.filter((row) => !row.accepted && !row.remote_present)
            .sort((left, right) => left.deviceSequence - right.deviceSequence);
          for (const row of pending) {
            row.deviceSequence = ++nextSequence;
            row.envelope = null;
            outbox.put(row);
          }
          state.nextDeviceSequence = nextSequence + 1;
          state.pendingCount = pending.length;
          states.put(state);
          finish({ pendingCount: pending.length, nextDeviceSequence: state.nextDeviceSequence });
        } catch (error) { abortWith(transaction, error); }
      };
      contextRequest.onsuccess = () => { context = contextRequest.result; complete(); };
      stateRequest.onsuccess = () => { state = stateRequest.result; complete(); };
      rowsRequest.onsuccess = () => { rows = rowsRequest.result; complete(); };
      contextRequest.onerror = () => abortWith(transaction, storageError(contextRequest.error));
      stateRequest.onerror = () => abortWith(transaction, storageError(stateRequest.error));
      rowsRequest.onerror = () => abortWith(transaction, storageError(rowsRequest.error));
    });
  }

  storeOutboxEnvelope(eventId, envelope, keyEpoch) {
    const transaction = this.database.transaction(
      SYNC_OUTBOX_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(SYNC_OUTBOX_STORE);
    const request = store.get(eventId);
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        const row = request.result;
        if (!row) {
          abortWith(
            transaction,
            new EventStoreError(
              "Kin could not find the local event to synchronize.",
            ),
          );
          return;
        }
        if (
          (row.envelope &&
            canonicalJson(row.envelope) !== canonicalJson(envelope)) ||
          (row.keyEpoch != null && row.keyEpoch !== keyEpoch)
        ) {
          abortWith(
            transaction,
            new EventStoreError(
              "Kin found conflicting encrypted retries for one event ID.",
            ),
          );
          return;
        }
        row.envelope ??= structuredClone(envelope);
        row.keyEpoch ??= keyEpoch;
        const write = store.put(row);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(row);
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  markOutboxAccepted(eventId, relayCursor = null) {
    const transaction = this.database.transaction(
      [SYNC_STATE_STORE, SYNC_OUTBOX_STORE],
      "readwrite",
    );
    const states = transaction.objectStore(SYNC_STATE_STORE);
    const outbox = transaction.objectStore(SYNC_OUTBOX_STORE);
    const stateRequest = states.get("active");
    const rowRequest = outbox.get(eventId);
    return transactionResult(transaction, (finish) => {
      let state;
      let row;
      let ready = 0;
      const complete = () => {
        ready += 1;
        if (ready !== 2) return;
        if (!row) {
          finish(false);
          return;
        }
        if (!row.envelope) {
          abortWith(
            transaction,
            new EventStoreError(
              "Kin cannot acknowledge an event without its persisted encrypted envelope.",
            ),
          );
          return;
        }
        const wasAccepted = row.accepted;
        row.accepted = true;
        const outboxWrite = outbox.put(row);
        outboxWrite.onerror = () =>
          abortWith(transaction, storageError(outboxWrite.error));
        if (state && !wasAccepted) {
          state.pendingCount = Math.max(0, state.pendingCount - 1);
        }
        if (state && relayCursor != null) {
          if (
            cursorValue(relayCursor) < cursorValue(state.relayHighWater ?? "")
          ) {
            abortWith(
              transaction,
              new EventStoreError(
                "Kin rejected a relay acknowledgement rollback.",
              ),
            );
            return;
          }
          state.relayHighWater = relayCursor;
        }
        if (state) {
          const stateWrite = states.put(state);
          stateWrite.onerror = () =>
            abortWith(transaction, storageError(stateWrite.error));
        }
        finish(true);
      };
      stateRequest.onsuccess = () => {
        state = stateRequest.result;
        complete();
      };
      rowRequest.onsuccess = () => {
        row = rowRequest.result;
        complete();
      };
      stateRequest.onerror = () =>
        abortWith(transaction, storageError(stateRequest.error));
      rowRequest.onerror = () =>
        abortWith(transaction, storageError(rowRequest.error));
    });
  }

  commitRemoteBatch({ received, nextCursor, engine, asOf, civilDate }) {
    if (
      !Array.isArray(received) ||
      received.length > 20 ||
      typeof nextCursor !== "string" ||
      (nextCursor !== "" && !/^[A-Za-z0-9_-]{11}$/.test(nextCursor))
    )
      throw new EventStoreError(
        "Kin received a sync batch outside its supported bounds.",
      );
    const transaction = this.database.transaction(
      [EVENT_STORE, CONTEXT_STORE, SYNC_STATE_STORE, SYNC_OUTBOX_STORE],
      "readwrite",
    );
    const eventsStore = transaction.objectStore(EVENT_STORE);
    const contextStore = transaction.objectStore(CONTEXT_STORE);
    const syncStates = transaction.objectStore(SYNC_STATE_STORE);
    const outbox = transaction.objectStore(SYNC_OUTBOX_STORE);
    const history = historyRequest(this, transaction);
    const contextRequest = contextStore.get(CONTEXT_KEY);
    const stateRequest = syncStates.get("active");
    const outboxRequest = outbox.getAll();
    let committed = null;
    const result = transactionResult(transaction, (finish) => {
      let rows;
      let context;
      let syncState;
      let outboxRows;
      let ready = 0;
      const complete = () => {
        ready += 1;
        if (ready !== 4) return;
        try {
          validateContext(context);
          if (!syncState || !context.sync_household_id)
            throw new EventStoreError(
              "Kin has not initialized encrypted sync for this device.",
            );
          if (cursorValue(nextCursor) < cursorValue(syncState.cursorHighWater))
            throw new EventStoreError("Kin rejected a sync cursor rollback.");
          validateCursorBoundary(context, rows);
          // Validate each event independently. One poison event advances the
          // relay cursor without entering durable canonical history; its
          // bytes stay in the encrypted sync state and are retried with every
          // later page that brings events, in case it arrived before an event
          // it depends on (#153).
          // Retrying replays history, so only a page carrying an event this
          // device doesn't have yet (something a kept event might need)
          // triggers it.
          const previousQuarantine = syncState.quarantine ?? [];
          const pageIds = new Set();
          let fresh = false;
          if (previousQuarantine.length > 0) {
            for (const item of received) {
              let eventId;
              try { eventId = engine.eventMetadata(item.encodedEvent).eventId; } catch { continue; /* reconcile counts unreadable bytes */ }
              pageIds.add(idToHex(eventId));
              if (rows.indexOfEventId(eventId) < 0) fresh = true;
            }
          }
          const retried = fresh;
          const retryItems = retried
            ? quarantineRetryItems(previousQuarantine, {
                isKnown: (eventId) => pageIds.has(eventId) || rows.indexOfEventId(idFromHex(eventId)) >= 0,
              })
            : [];
          const { additions, candidates, quarantinedItems, duplicateEventIds } = reconcileRemoteEvents({
            history: rows,
            received: [...retryItems, ...received],
            engine, context, asOf, civilDate,
          });
          const quarantine = nextQuarantine(previousQuarantine, quarantinedItems, {
            now: asOf ?? Date.now(), retried,
          });
          const remoteIds = new Set(duplicateEventIds);
          const remoteInfo = new Map();
          for (const item of received) {
            if (!item.sourceDeviceId || !Number.isSafeInteger(item.sourceDeviceSequence)) continue;
            const metadata = engine.eventMetadata(item.encodedEvent);
            remoteInfo.set(idToHex(metadata.eventId), item);
          }
          for (const row of outboxRows) {
            if (remoteIds.has(row.event_id)) {
              let changed = row.remote_present !== true;
              row.remote_present = true;
              const remote = remoteInfo.get(row.event_id);
              if (remote?.sourceDeviceId === syncState.deviceId &&
                  remote.sourceDeviceSequence !== row.remote_device_sequence) {
                row.remote_device_sequence = remote.sourceDeviceSequence;
                changed = true;
              }
              if (changed) outbox.put(row);
            }
          }
          const { asOf: projectionAsOf, civilDate: projectionDate } =
            projectionContext();
          const state = engine.applyEvents(
            candidates,
            asOf ?? projectionAsOf,
            context.last_looked_event_id === null
              ? null
              : idToHex(context.last_looked_event_id),
            civilDate ?? projectionDate,
            syncIdentityFromContext(context),
          );
          for (const row of additions) {
            const { local_sequence, ...storedRow } = row;
            const write = eventsStore.add(storedRow);
            write.onsuccess = () => {
              if (write.result !== local_sequence)
                abortWith(
                  transaction,
                  new EventStoreError(
                    "Kin could not preserve local event order during sync.",
                  ),
                );
            };
            write.onerror = () =>
              abortWith(transaction, storageError(write.error));
          }
          const maximumLogicalTime = additions.reduce(
            (maximum, row) =>
              row.logical_time > maximum ? row.logical_time : maximum,
            rows.maxLogicalTime(),
          );
          context.next_logical_time =
            context.next_logical_time > maximumLogicalTime
              ? context.next_logical_time
              : maximumLogicalTime + 1n;
          syncState.maxLogicalTime = maximumLogicalTime;
          // Events older clients only counted, and refusals beyond the bound,
          // stay counted; kept rows are counted while they remain.
          if (syncState.quarantineDropped === undefined)
            syncState.quarantineDropped = syncState.quarantinedEventCount ?? 0;
          syncState.quarantineDropped += quarantine.dropped;
          syncState.quarantine = quarantine.quarantine;
          syncState.quarantinedEventCount =
            syncState.quarantine.length + syncState.quarantineDropped;
          syncState.syncCursor = nextCursor;
          syncState.cursorHighWater = nextCursor;
          // The sync identity or bindings may change: meals and names read again (recentHistory).
          this.recentSyncIdentity = null;
          const contextWrite = contextStore.put(context);
          const stateWrite = syncStates.put(syncState);
          contextWrite.onerror = () =>
            abortWith(transaction, storageError(contextWrite.error));
          stateWrite.onerror = () =>
            abortWith(transaction, storageError(stateWrite.error));
          const tail = additions.at(-1);
          committed = { view: rows, additions };
          finish({
            state,
            added: additions.length,
            // Only refusals new to this device, so a kept event that is
            // retried and refused again doesn't alert on every poll.
            quarantined: quarantine.added,
            duplicateEventIds: [...remoteIds],
            snapshotBoundary: tail
              ? {
                  eventId: idToHex(tail.event_id),
                  localSequence: tail.local_sequence,
                  snapshotThroughEventId: idToHex(tail.event_id),
                  snapshotThroughLocalSequence: tail.local_sequence,
                }
              : snapshotBoundary(rows),
          });
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      history.onsuccess = () => {
        rows = history.result;
        complete();
      };
      contextRequest.onsuccess = () => {
        context = contextRequest.result;
        complete();
      };
      stateRequest.onsuccess = () => {
        syncState = stateRequest.result;
        complete();
      };
      outboxRequest.onsuccess = () => { outboxRows = outboxRequest.result; complete(); };
      contextRequest.onerror = () =>
        abortWith(transaction, storageError(contextRequest.error));
      stateRequest.onerror = () =>
        abortWith(transaction, storageError(stateRequest.error));
      outboxRequest.onerror = () => abortWith(transaction, storageError(outboxRequest.error));
    });
    return result.then((value) => {
      // Remote rows were validated and committed; extend the arena in order.
      if (committed && committed.view.epoch === this.arena.epoch && this.arena.length === committed.view.length) {
        for (const row of committed.additions)
          this.arena.append(row.local_sequence, row.encoded_event, row.metadata);
      }
      return value;
    });
  }

  markSyncInitialized() {
    const transaction = this.database.transaction(
      SYNC_STATE_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(SYNC_STATE_STORE);
    const request = store.get("active");
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        const state = request.result;
        if (!state) {
          abortWith(
            transaction,
            new EventStoreError("Kin has not initialized encrypted sync."),
          );
          return;
        }
        state.initialized = true;
        const write = store.put(state);
        write.onerror = () => abortWith(transaction, storageError(write.error));
        finish(state);
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  markCaughtUpThrough(snapshotBoundary) {
    const transaction = this.database.transaction(
      [EVENT_STORE, CONTEXT_STORE],
      "readwrite",
    );
    const eventsStore = transaction.objectStore(EVENT_STORE);
    const history = historyRequest(this, transaction);
    const contextStore = transaction.objectStore(CONTEXT_STORE);
    const contextRequest = contextStore.get(CONTEXT_KEY);

    return transactionResult(transaction, (finish) => {
      let loadedEvents;
      let context;
      let eventsReady = false;
      let contextReady = false;
      const complete = () => {
        if (!eventsReady || !contextReady) return;
        try {
          validateContext(context);
          validateCursorBoundary(context, loadedEvents);
          const boundary = validateSnapshotBoundary(snapshotBoundary);
          const snapshotTail =
            boundary.snapshotThroughLocalSequence === 0
              ? -1
              : loadedEvents.indexOfSequence(boundary.snapshotThroughLocalSequence);
          if (
            snapshotTail < 0 ||
            idToHex(loadedEvents.id(snapshotTail, "event_id")) !==
              boundary.snapshotThroughEventId ||
            boundary.localSequence > boundary.snapshotThroughLocalSequence
          ) {
            throw invalidCatchUpState();
          }
          const requestedIndex = loadedEvents.indexOfSequence(boundary.localSequence);
          if (requestedIndex < 0 || idToHex(loadedEvents.id(requestedIndex, "event_id")) !== boundary.eventId) {
            throw invalidCatchUpState();
          }
          if (boundary.localSequence <= context.last_looked_local_sequence) {
            finish({
              advanced: false,
              cursor: catchUpCursor(context),
            });
            return;
          }

          const updatedContext = {
            ...context,
            last_looked_event_id: loadedEvents.id(requestedIndex, "event_id").slice(),
            last_looked_local_sequence: boundary.localSequence,
            last_looked_at: Date.now(),
          };
          // The sync identity or bindings may change: meals and names read again (recentHistory).
          this.recentSyncIdentity = null;
          const write = contextStore.put(updatedContext);
          write.onerror = () =>
            abortWith(transaction, storageError(write.error));
          finish({
            advanced: true,
            cursor: catchUpCursor(updatedContext),
          });
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      history.onsuccess = () => {
        loadedEvents = history.result;
        eventsReady = true;
        complete();
      };
      contextRequest.onsuccess = () => {
        context = contextRequest.result;
        contextReady = true;
        complete();
      };
      contextRequest.onerror = () =>
        abortWith(transaction, storageError(contextRequest.error));
    });
  }

  ensureContext() {
    const transaction = this.database.transaction(
      [EVENT_STORE, CONTEXT_STORE],
      "readwrite",
    );
    const history = historyRequest(this, transaction);
    const contexts = transaction.objectStore(CONTEXT_STORE);
    const request = contexts.get(CONTEXT_KEY);
    let loadedEvents;
    let context;
    let eventsReady = false;
    let contextReady = false;

    return transactionResult(transaction, (finish) => {
      const initialize = () => {
        if (!eventsReady || !contextReady) return;
        try {
          if (!context) {
            if (loadedEvents.length) throw invalidCatchUpState();
            context = {
              key: CONTEXT_KEY,
              household_id: randomId(),
              actor_id: randomId(),
              device_id: randomId(),
              next_logical_time: 1n,
              last_looked_event_id: null,
              last_looked_local_sequence: 0,
              last_looked_at: Date.now(),
            };
            const write = contexts.add(context);
            write.onerror = () =>
              abortWith(transaction, storageError(write.error));
            finish(context);
            return;
          }

          validateContext(context);
          validateCursorBoundary(context, loadedEvents);
          finish(context);
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      request.onsuccess = () => {
        context = request.result;
        contextReady = true;
        initialize();
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
      history.onsuccess = () => {
        loadedEvents = history.result;
        eventsReady = true;
        initialize();
      };
    });
  }

  close() {
    this.removeLockListener?.();
    this.removeLockListener = null;
    this.arena.wipe();
    this.database.close();
  }
}

function validateAttachmentRows(rows) {
  const fields = ["attachment_id", "ciphertext", "localSealed", "keyEpoch", "digest", "state"];
  if (!Array.isArray(rows) || rows.length > 64) throw new EventStoreError("Kin found invalid local attachment records.");
  const ids = new Set(); let total = 0;
  for (const row of rows) {
    if (!row || Object.keys(row).some((key) => !fields.includes(key)) || Object.keys(row).length !== fields.length || !/^[a-f0-9]{32}$/.test(row.attachment_id ?? "") || ids.has(row.attachment_id) || !["local", "queued", "uploading", "synced", "failed", "removed"].includes(row.state))
      throw new EventStoreError("Kin found an invalid local attachment record.");
    if (row.ciphertext) {
      const bytes = asBytes(row.ciphertext);
      if (bytes.length < 29 || bytes.length > 4 * 1024 * 1024 + 4096 || !Number.isSafeInteger(row.keyEpoch) || row.keyEpoch < 1 || row.keyEpoch > 128 || !/^[a-f0-9]{64}$/.test(row.digest ?? "")) throw new EventStoreError("Kin found an attachment outside its supported size.");
      total += bytes.length;
    } else if (!row.localSealed || row.keyEpoch !== null || row.digest !== null) throw new EventStoreError("Kin found an attachment without protected local content.");
    if (total > MAX_HOUSEHOLD_ATTACHMENT_BYTES) throw new EventStoreError("Kin found attachment data above the 50 MiB household storage limit.");
    ids.add(row.attachment_id);
  }
  return rows;
}

function transactionResult(transaction, schedule) {
  return new Promise((resolve, reject) => {
    let failure;
    let result;
    let hasResult = false;
    const finish = (value) => {
      result = value;
      hasResult = true;
    };
    transaction.oncomplete = () => {
      if (hasResult) {
        resolve(result);
      } else {
        reject(storageError(transaction.error));
      }
    };
    transaction.onerror = () => {
      failure ??= transaction.__kinFailure ?? storageError(transaction.error);
    };
    transaction.onabort = () =>
      reject(
        failure ?? transaction.__kinFailure ?? storageError(transaction.error),
      );
    try {
      schedule(finish);
    } catch (error) {
      abortWith(transaction, error);
    }
  });
}

function abortWith(transaction, error) {
  try {
    transaction.__kinFailure ??= error;
    transaction.abort();
  } catch {
    transaction.__kinFailure ??= error;
  }
}

function storageError(cause) {
  const message =
    cause?.name === "QuotaExceededError"
      ? "Kin couldn't save because local browser storage is full. Free some space, then try again. Your saved information was not deleted."
      : "Kin could not safely access local household storage. Your saved information was not intentionally deleted.";
  const error = new EventStoreError(message, cause);
  recordDiagnostic("storage_failed", { store: "events", name: errorName(cause) });
  return error;
}

/**
 * Reads the transaction's event history into the store's session arena and
 * returns a request-like object whose result is a HistoryView of exactly the
 * rows this transaction observes.
 *
 * Inside one native transaction it reads the persisted store generation and
 * the row count, then either decrypts only rows after the arena tail (same
 * generation, consistent count) or rebuilds the arena from every row. A raw
 * pre-protection database has no generation and always rebuilds.
 *
 * Why callbacks and not a Promise: an IndexedDB transaction commits as soon
 * as no request is pending at the end of a task. Awaiting a Promise between
 * requests can let it commit early, so every follow-up request is issued
 * from inside the previous request's callback, and callers attach their own
 * `onsuccess` the same way.
 */
function historyRequest(store, transaction) {
  const request = { result: undefined, error: null, onsuccess: null, onerror: null };
  const arena = store.arena;
  const events = transaction.objectStore(EVENT_STORE);
  const fail = (error) => {
    request.error = error;
    if (request.onerror) request.onerror();
    else abortWith(transaction, error);
  };
  const succeed = (view) => {
    request.result = view;
    request.onsuccess?.();
  };
  const rebuild = (generation) => {
    const all = events.getAll();
    all.onsuccess = () => {
      try {
        arena.reset(generation);
        appendRows(arena, all.result, store.engine);
        succeed(arena.view());
      } catch (error) { arena.reset(null); fail(error); }
      // The arena holds the only kept copy; these decrypted rows go either way.
      finally { zeroRows(all.result); }
    };
    all.onerror = () => fail(storageError(all.error));
  };
  // `securityValue` reads plaintext security metadata inside this same
  // transaction (encrypted-idb.js). Only databases opened without a security
  // guard lack it (setup and migration); they cannot track a generation.
  if (typeof transaction.securityValue !== "function") {
    rebuild(null);
    return request;
  }
  const generationRequest = transaction.securityValue(EVENT_GENERATION_KEY);
  const countRequest = events.count();
  // IndexedDB completes requests in the order they were made, so `generation`
  // is set before countRequest.onsuccess below runs.
  let generation;
  generationRequest.onsuccess = () => { generation = generationRequest.result?.generation ?? 0; };
  generationRequest.onerror = () => fail(storageError(generationRequest.error));
  countRequest.onerror = () => fail(storageError(countRequest.error));
  countRequest.onsuccess = () => {
    try {
      const total = countRequest.result;
      if (!Number.isSafeInteger(generation) || generation < 0) throw invalidEventHistory();
      // A different generation means the corpus was replaced (restore,
      // migration, root rotation); fewer rows than the arena holds cannot come
      // from appends. Either way the arena is rebuilt from storage.
      if (arena.generation !== generation || total < arena.length) { rebuild(generation); return; }
      if (total === arena.length) { succeed(arena.view(total)); return; }
      const known = arena.length;
      const delta = events.getAll(IDBKeyRange.lowerBound(arena.tail, true));
      delta.onsuccess = () => {
        try {
          // While this read waited, a commit in this tab may already have added
          // rows to the shared arena (#appendCommitted), so the filter skips
          // rows at or below the tail. Any other mismatch rebuilds.
          if (arena.generation !== generation || known + delta.result.length !== total) { rebuild(generation); return; }
          appendRows(arena, delta.result.filter((row) => row.local_sequence > arena.tail), store.engine);
          succeed(arena.view(total));
        } catch (error) { arena.reset(null); fail(error); }
        finally { zeroRows(delta.result); }
      };
      delta.onerror = () => fail(storageError(delta.error));
    } catch (error) { fail(error); }
  };
  return request;
}

// Decrypted row copies are this read's own; zero them once the arena holds
// their bytes so the session keeps one plaintext copy.
// Zero-fills decrypted row bytes once the arena holds its copy. A row that
// failed validation may not hold bytes at all, so failures are ignored.
function zeroRows(rows) {
  for (const row of rows) {
    try { asBytes(row.encoded_event).fill(0); } catch { /* Rejected row. */ }
  }
}

/**
 * Validates rows in ascending local order and appends them to `arena`.
 * `engine` is the store's own engine. Without one (snapshot helpers used
 * before a store exists) the module-level codec, the last engine created,
 * reads the metadata.
 */
function appendRows(arena, rows, engine = null) {
  if (!Array.isArray(rows) || arena.length + rows.length > MAX_EVENT_COUNT) throw invalidEventHistory();
  let previousSequence = arena.tail;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        !Number.isSafeInteger(row.local_sequence) || row.local_sequence <= previousSequence)
      throw new EventStoreError("Kin found an invalid local event order. The stored data was preserved.");
    previousSequence = row.local_sequence;
  }
  if (!rows.length) return;
  const records = rows.map((row) => asBytes(row.encoded_event));
  const metadata = engine ? engine.eventMetadataBatch(records) : eventMetadataBatch(records);
  rows.forEach((row, index) => validateEventRow(row, metadata[index]));
  rows.forEach((row, index) => arena.append(row.local_sequence, asBytes(row.encoded_event), metadata[index]));
}

/** A validated history view over plain rows, for snapshot-based operations
 * (migration, rotation, archives). The caller wipes the returned arena. */
function historyFromRows(rows) {
  const arena = new EventArena();
  arena.reset(null);
  try { appendRows(arena, rows); }
  catch (error) { arena.wipe(); throw error; }
  return { arena, view: arena.view() };
}

function invalidEventHistory() {
  return new EventStoreError("Kin found an invalid local event history. The stored data was preserved.");
}

function bumpEventGeneration(transaction) {
  bumpGeneration(transaction.objectStore(SECURITY_STORE),
    (error) => abortWith(transaction, error ? storageError(error) : invalidEventHistory()));
}

function snapshotBoundary(view) {
  if (!view.length) return null;
  const eventId = idToHex(view.id(view.length - 1, "event_id"));
  return { eventId, localSequence: view.tail, snapshotThroughEventId: eventId, snapshotThroughLocalSequence: view.tail };
}

function cursorEventId(context) {
  return context.last_looked_event_id === null ? null : idToHex(context.last_looked_event_id);
}

function validateEventRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_EVENT_COUNT) {
    throw new EventStoreError(
      "Kin found an invalid local event history. The stored data was preserved.",
    );
  }
  let previousSequence = 0;
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      !Number.isSafeInteger(row.local_sequence) ||
      row.local_sequence <= previousSequence
    ) {
      throw new EventStoreError(
        "Kin found an invalid local event order. The stored data was preserved.",
      );
    }
    previousSequence = row.local_sequence;
  }
  const metadata = eventMetadataBatch(rows.map((row) => asBytes(row.encoded_event)));
  rows.forEach((row, index) => validateEventRow(row, metadata[index]));
  return rows;
}

function validateEventRow(row, metadata = eventMetadata(asBytes(row.encoded_event))) {
  const canonical = eventRowFromMetadata(row.encoded_event, metadata);
  for (const field of ["event_id", "household_id", "actor_id", "device_id"])
    if (!bytesEqual(canonical[field], row[field]))
      throw new EventStoreError("Kin found inconsistent local event data. The stored data was preserved.");
  for (const field of ["timestamp", "logical_time", "kind", "event_version"])
    if (canonical[field] !== row[field])
      throw new EventStoreError("Kin found inconsistent local event data. The stored data was preserved.");
}

function validateLegacyOutbox(outboxRows, eventRows) {
  if (!Array.isArray(outboxRows))
    throw new EventStoreError("Kin found invalid pending sync data. The stored data was preserved.");
  const events = new Map(eventRows.map((row) => [idToHex(row.event_id), asBytes(row.encoded_event)]));
  for (const row of outboxRows) {
    const eventId = row?.event_id;
    const authoritative = typeof eventId === "string" ? events.get(eventId) : undefined;
    let candidate;
    try { candidate = asBytes(row?.canonical_event); }
    catch { candidate = null; }
    if (!authoritative || !candidate || !bytesEqual(authoritative, candidate))
      throw new EventStoreError(
        "Kin found pending sync data that does not match its event history. The stored data was preserved.",
      );
  }
}

function validateContext(context) {
  if (
    context?.key !== CONTEXT_KEY ||
    !isId(context.household_id) ||
    !isId(context.actor_id) ||
    !isId(context.device_id) ||
    typeof context.next_logical_time !== "bigint" ||
    context.next_logical_time < 1n ||
    context.next_logical_time > MAX_LOGICAL_TIME + 1n
  ) {
    throw new EventStoreError(
      "Kin found invalid local household identity data. The stored data was preserved.",
    );
  }
  const syncFields = [
    "sync_household_id",
    "sync_member_id",
    "sync_device_id",
    "sync_identity_bindings",
  ];
  const syncFieldsPresent = syncFields.filter((field) =>
    Object.prototype.hasOwnProperty.call(context, field),
  );
  if (
    syncFieldsPresent.length !== 0 &&
    (syncFieldsPresent.length !== syncFields.length ||
      !isId(context.sync_household_id) ||
      !isId(context.sync_member_id) ||
      !isId(context.sync_device_id) ||
      !Array.isArray(context.sync_identity_bindings) ||
      context.sync_identity_bindings.length > 256)
  ) {
    throw new EventStoreError(
      "Kin found invalid sync identity data. The stored data was preserved.",
    );
  }
  const catchUpFields = [
    "last_looked_event_id",
    "last_looked_local_sequence",
    "last_looked_at",
  ];
  const presentFields = catchUpFields.filter((field) =>
    Object.prototype.hasOwnProperty.call(context, field),
  );
  if (
    presentFields.length !== catchUpFields.length ||
    !Number.isSafeInteger(context.last_looked_local_sequence) ||
    context.last_looked_local_sequence < 0 ||
    !Number.isSafeInteger(context.last_looked_at) ||
    Math.abs(context.last_looked_at) > 8_640_000_000_000_000 ||
    (context.last_looked_local_sequence === 0
      ? context.last_looked_event_id !== null
      : !isId(context.last_looked_event_id))
  ) {
    throw invalidCatchUpState();
  }
}

function validateEventHousehold(context, view) {
  if (context.sync_household_id) {
    const syncHousehold = asBytes(context.sync_household_id);
    let bindings;
    for (let index = 0; index < view.length; index += 1) {
      if (bytesEqual(view.id(index, "household_id"), syncHousehold)) continue;
      bindings ??= new Set(context.sync_identity_bindings.map((binding) =>
        `${binding.legacyHouseholdId}:${binding.legacyActorId}:${binding.legacyDeviceId}`));
      const key = `${idToHex(view.id(index, "household_id"))}:${idToHex(view.id(index, "actor_id"))}:${idToHex(view.id(index, "device_id"))}`;
      if (!bindings.has(key)) throw invalidCatchUpState();
    }
    return;
  }
  const household = asBytes(context.household_id);
  for (let index = 0; index < view.length; index += 1)
    if (!bytesEqual(view.id(index, "household_id"), household)) throw invalidCatchUpState();
}

function syncIdentityFromContext(context) {
  return context.sync_household_id
    ? {
        householdId: idToHex(context.sync_household_id),
        memberId: idToHex(context.sync_member_id),
        deviceId: idToHex(context.sync_device_id),
        bindings: context.sync_identity_bindings,
      }
    : null;
}

function sameLegacyTupleForContext(binding, context) {
  return (
    binding?.legacyHouseholdId === idToHex(context.household_id) &&
    binding?.legacyActorId === idToHex(context.actor_id) &&
    binding?.legacyDeviceId === idToHex(context.device_id)
  );
}

function eventRowFromCanonical(encodedEvent) {
  const bytes = asBytes(encodedEvent).slice();
  const metadata = eventMetadata(bytes);
  // The Rust metadata travels with the row so the arena can append it later.
  return Object.defineProperty(eventRowFromMetadata(bytes, metadata), "metadata", { value: metadata });
}

function eventRowFromMetadata(bytes, metadata) {
  return {
    event_id: metadata.eventId,
    household_id: metadata.householdId,
    actor_id: metadata.actorId,
    device_id: metadata.deviceId,
    timestamp: metadata.timestamp,
    logical_time: metadata.logicalTime,
    kind: metadata.kind,
    event_version: metadata.eventVersion,
    encoded_event: bytes,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function cursorValue(value) {
  if (value === "") return 0n;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(value))
    throw new EventStoreError("Kin received an invalid sync cursor.");
  let bytes;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    throw new EventStoreError("Kin received an invalid sync cursor.", error);
  }
  if (bytes.length !== 8)
    throw new EventStoreError("Kin received an invalid sync cursor.");
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function validateCursorBoundary(context, view) {
  validateEventHousehold(context, view);
  if (context.last_looked_local_sequence === 0) return;
  const index = view.indexOfSequence(context.last_looked_local_sequence);
  if (index < 0 || !bytesEqual(view.id(index, "event_id"), context.last_looked_event_id)) {
    throw invalidCatchUpState();
  }
}

function catchUpCursor(context) {
  return {
    eventId: context.last_looked_event_id
      ? idToHex(context.last_looked_event_id)
      : null,
    localSequence: context.last_looked_local_sequence,
    lastLookedAt: context.last_looked_at,
  };
}

function validateSnapshotBoundary(boundary) {
  if (
    !boundary ||
    !/^[0-9a-f]{32}$/.test(boundary.eventId) ||
    !/^[0-9a-f]{32}$/.test(boundary.snapshotThroughEventId) ||
    !Number.isSafeInteger(boundary.localSequence) ||
    boundary.localSequence < 1 ||
    !Number.isSafeInteger(boundary.snapshotThroughLocalSequence) ||
    boundary.snapshotThroughLocalSequence < boundary.localSequence
  ) {
    throw invalidCatchUpState();
  }
  return boundary;
}

function invalidCatchUpState() {
  return new EventStoreError(
    "Kin found invalid local catch-up data. Your household events were preserved.",
  );
}

function isId(value) {
  try {
    return asBytes(value).length === 16;
  } catch {
    return false;
  }
}

function asBytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new EventStoreError(
    "Kin could not read a local event record. The stored data was preserved.",
  );
}

function bytesEqual(left, right) {
  try {
    const leftBytes = asBytes(left);
    const rightBytes = asBytes(right);
    if (leftBytes.length !== rightBytes.length) {
      return false;
    }
    for (let index = 0; index < leftBytes.length; index += 1)
      if (leftBytes[index] !== rightBytes[index]) return false;
    return true;
  } catch {
    return false;
  }
}

async function openEventDatabase() {
  if (!globalThis.indexedDB) throw new EventStoreError("Kin could not access local household storage. Your information was not intentionally deleted.");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, definition] of Object.entries(EVENT_STORE_DEFINITIONS)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: definition.keyPath, ...(name === EVENT_STORE ? { autoIncrement: true } : {}) });
        for (const [index, path] of Object.entries(definition.indexes ?? {})) store.createIndex(index, path, { unique: true });
      }
      if (!db.objectStoreNames.contains(SECURITY_STORE)) db.createObjectStore(SECURITY_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => { if (!settled) { settled = true; reject(storageError(request.error)); } };
    request.onblocked = () => { if (!settled) { settled = true; reject(new EventStoreError("Close other Kin tabs and retry the storage upgrade. Your saved information was preserved.")); } };
  });
}

function validateRotationRows(rows, engine) {
  const events = validateEventRows(rows.events);
  validateLegacyOutbox(rows.sync_outbox, events);
  if (rows.local_context.length !== 1) throw invalidCatchUpState();
  const context = rows.local_context[0];
  validateContext(context);
  const { arena, view } = historyFromRows(events);
  try {
    validateCursorBoundary(context, view);
    if (events.some((row) => row.logical_time >= context.next_logical_time))
      throw new EventStoreError("Kin found an invalid event counter. The saved history was preserved.");
    const { asOf, civilDate } = projectionContext();
    engine.applyEvents(view, asOf, cursorEventId(context), civilDate, syncIdentityFromContext(context));
  } finally { arena.wipe(); }
}

const onlyFields = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => names.includes(key));
// Archive histories are read, protected and written this many events at a
// time (security/archive-stream.js CHUNK_EVENTS).
const ARCHIVE_CHUNK_EVENTS = 256;

/**
 * Archive parts from the historical snapshot shape ({ formatVersion, events,
 * local_context, attachments }): package-format-2 archives and test fixtures.
 * The event rows are checked like stored rows and copied into a new arena,
 * which the caller wipes (`parts.arena`). Context and attachment rows are
 * cloned unless `owned`.
 */
function archivePartsFromSnapshot(snapshot, engine, { owned = false } = {}) {
  if (!engine || !onlyFields(snapshot, ["formatVersion", "events", "local_context", "attachments"]) || snapshot.formatVersion !== 2 || !Array.isArray(snapshot.attachments) ||
      !Array.isArray(snapshot.local_context) || snapshot.local_context.length !== 1 || !Array.isArray(snapshot.events))
    throw new EventStoreError("Kin could not validate this archive's household records.");
  const eventFields = ["local_sequence", "event_id", "household_id", "actor_id", "device_id", "timestamp", "logical_time", "kind", "event_version", "encoded_event"];
  if (snapshot.events.some((row) => !onlyFields(row, eventFields)))
    throw new EventStoreError("Kin found unsupported archive event fields or size.");
  const arena = new EventArena();
  arena.reset(null);
  try { appendRows(arena, snapshot.events, engine); }
  catch (error) { arena.wipe(); throw error; }
  return {
    formatVersion: 2, history: arena.view(), arena,
    local_context: owned ? snapshot.local_context : structuredClone(snapshot.local_context),
    attachments: owned ? snapshot.attachments : structuredClone(snapshot.attachments),
  };
}

/** Appends one checked chunk of archive records (local sequences and
 * canonical bytes) to `arena`; see EventStore.archiveHistory. */
function appendRecords(arena, sequences, records, engine) {
  if (records.length !== sequences.length || arena.length + records.length > MAX_EVENT_COUNT) throw invalidEventHistory();
  let previous = arena.tail;
  for (const sequence of sequences) {
    if (!Number.isSafeInteger(sequence) || sequence <= previous)
      throw new EventStoreError("Kin found an invalid local event order. The stored data was preserved.");
    previous = sequence;
  }
  const metadata = engine.eventMetadataBatch(records);
  records.forEach((record, index) => arena.append(sequences[index], record, metadata[index]));
}

/**
 * Checks archive parts ({ formatVersion: 2, history, local_context,
 * attachments }, plus `arena` when they own one) and returns the attachment
 * bindings of Rust's import plan. The history is a HistoryView whose records
 * were checked when they entered its arena; the plan replays it from the
 * engine's own history. Given `bindings` from an earlier check of the same
 * history and context, the replay is skipped and the other checks run.
 */
function validateArchiveParts(parts, engine, bindings = null) {
  if (!engine || !onlyFields(parts, ["formatVersion", "history", "local_context", "attachments", "arena"]) || parts.formatVersion !== 2 ||
      typeof parts.history?.copyRecordsTo !== "function" || !Array.isArray(parts.attachments) ||
      !Array.isArray(parts.local_context) || parts.local_context.length !== 1)
    throw new EventStoreError("Kin could not validate this archive's household records.");
  const view = parts.history;
  const attachments = validateAttachmentRows(parts.attachments);
  if (view.length > MAX_EVENT_COUNT || view.byteLength > 64 * 1024 * 1024)
    throw new EventStoreError("Kin found unsupported archive event fields or size.");
  const context = parts.local_context[0];
  if (!onlyFields(context, ["key", "household_id", "actor_id", "device_id", "next_logical_time", "last_looked_event_id", "last_looked_local_sequence", "last_looked_at", "sync_household_id", "sync_member_id", "sync_device_id", "sync_identity_bindings", "archive_imported", "portable_membership"]))
    throw new EventStoreError("Kin found unsupported archive context fields.");
  if (context.portable_membership !== undefined) validatePortableMembership(context.portable_membership);
  if (context.archive_imported !== undefined && context.archive_imported !== true)
    throw new EventStoreError("Kin found an invalid archive restore marker.");
  validateContext(context);
  validateCursorBoundary(context, view);
  if (view.length && view.maxLogicalTime() >= context.next_logical_time)
    throw new EventStoreError("The archive logical counter cannot safely continue its history.");
  const bindingFields = ["legacyHouseholdId", "legacyActorId", "legacyDeviceId", "householdId", "actorId", "deviceId"];
  if ((context.sync_identity_bindings ?? []).some((binding) => !onlyFields(binding, bindingFields) || Object.keys(binding).length !== bindingFields.length))
    throw new EventStoreError("Kin found unsupported archive identity bindings.");
  const { asOf, civilDate } = projectionContext();
  bindings ??= engine.importBindings(view, asOf,
    context.last_looked_event_id === null ? null : idToHex(context.last_looked_event_id), civilDate, syncIdentityFromContext(context)).attachments;
  const bound = new Set(bindings.map((attachment) => attachment.attachmentId));
  if (attachments.some((attachment) => !bound.has(attachment.attachment_id))) throw new EventStoreError("Kin found attachment data without matching household history.");
  const included = new Set(attachments.map((attachment) => attachment.attachment_id));
  if (bindings.some((attachment) => !attachment.removed && !included.has(attachment.attachmentId))) throw new EventStoreError("Kin cannot export this household yet because an attachment needs to be downloaded to this device.");
  return bindings;
}

export function validatePortableMembership(members) {
  if (!Array.isArray(members) || members.length > 12)
    throw new EventStoreError("Kin found invalid household membership in this export.");
  const ids = new Set();
  for (const member of members) {
    const keys = Object.keys(member ?? {}).sort().join(",");
    const expected = member?.expiresAt === undefined
      ? "memberId,memberKind,status"
      : "expiresAt,memberId,memberKind,status";
    if (keys !== expected || !/^[a-f0-9]{32}$/.test(member.memberId ?? "") ||
        ids.has(member.memberId) || !["adult", "limited", "temporary"].includes(member.memberKind) ||
        !["active", "removed", "expired"].includes(member.status) ||
        (member.memberKind === "temporary"
          ? !Number.isSafeInteger(member.expiresAt) || Math.abs(member.expiresAt) > 8_640_000_000_000_000
          : member.expiresAt !== undefined || member.status === "expired"))
      throw new EventStoreError("Kin found invalid household membership in this export.");
    ids.add(member.memberId);
  }
}

async function validateAttachmentArchivePayloads(rows, bindings, openSealed) {
  const byId = new Map(bindings.map((entry) => [entry.attachmentId, entry]));
  for (const row of rows) {
    const binding = byId.get(row.attachment_id);
    if (!binding) throw new EventStoreError("Kin found attachment data without matching household history.");
    if (row.ciphertext) {
      const bytes = asBytes(row.ciphertext);
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (digest !== row.digest) throw new EventStoreError("Kin found an attachment archive with damaged file data.");
      continue;
    }
    let saved;
    try { saved = await openSealed(row.attachment_id, row.localSealed); }
    catch { throw new EventStoreError("Kin could not open protected attachment data in this archive."); }
    try {
      if (!(saved?.bytes instanceof Uint8Array) || saved.bytes.length < 1 || saved.bytes.length > 4 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(saved.type) || typeof saved.name !== "string" || saved.name.length > 240 || saved.parentKind !== binding.parentKind || saved.parentId !== binding.parentId)
        throw new EventStoreError("Kin found attachment data that does not match its household binding.");
    } finally { saved?.bytes?.fill(0); }
  }
}

async function readSecurity(database) {
  const transaction = database.transaction(SECURITY_STORE, "readonly");
  const request = transaction.objectStore(SECURITY_STORE).get(SECURITY_KEY);
  return transactionResult(transaction, (finish) => { request.onsuccess = () => finish(request.result ?? null); });
}

function abortOnVaultLock(transaction, vault) {
  const unsubscribe = vault.onLock(() => {
    const error = new EventStoreError("Kin locked before local storage could commit."); error.code = "locked";
    abortWith(transaction, error);
  });
  transaction.addEventListener("complete", unsubscribe, { once: true });
  transaction.addEventListener("abort", unsubscribe, { once: true });
}

async function writeSecurity(database, record, vault) {
  const transaction = database.transaction(SECURITY_STORE, "readwrite");
  abortOnVaultLock(transaction, vault);
  return transactionResult(transaction, (finish) => {
    const store = transaction.objectStore(SECURITY_STORE);
    const request = store.get(SECURITY_KEY);
    request.onsuccess = () => {
      try { vault.assertUnlocked(); }
      catch (error) { abortWith(transaction, error); return; }
      const current = request.result;
      if (!current || current.phase !== "cleanup-pending" || current.vaultId !== record.vaultId ||
          current.rootVersion !== record.rootVersion || !valuesEqual(current.verifier, record.verifier) ||
          (current.configRevision ?? 0) !== (record.configRevision ?? 0) || (current.lockEpoch ?? 0) !== (record.lockEpoch ?? 0)) {
        const error = new EventStoreError("Kin was locked during migration. Unlock to resume safely."); error.code = "locked";
        abortWith(transaction, error); return;
      }
      store.put(record);
      finish(record);
    };
  });
}

async function replaceVerifiedSnapshot(database, original, protectedRows, manifest, vault) {
  const names = [...Object.keys(EVENT_STORE_DEFINITIONS), SECURITY_STORE];
  const transaction = database.transaction(names, "readwrite");
  abortOnVaultLock(transaction, vault);
  return transactionResult(transaction, (finish) => {
    let remaining = names.length;
    let current;
    const securityRequest = transaction.objectStore(SECURITY_STORE).get(SECURITY_KEY);
    securityRequest.onsuccess = () => { current = securityRequest.result; complete(); };
    function complete() {
      remaining -= 1;
      if (remaining) return;
      try {
        vault.assertUnlocked();
        if (!current || current.vaultId !== manifest.vaultId || current.phase !== "preparing" || (current.lockEpoch ?? 0) !== (manifest.lockEpoch ?? 0)) {
          vault.lock();
          const error = new EventStoreError("Kin was locked during migration. Unlock to resume safely."); error.code = "locked"; throw error;
        }
        for (const [storeName, rows] of Object.entries(protectedRows)) {
          const store = transaction.objectStore(storeName);
          store.clear();
          for (const row of rows) store.put(row);
        }
        transaction.objectStore(SECURITY_STORE).put(manifest);
        bumpEventGeneration(transaction);
        finish(manifest);
      } catch (error) { abortWith(transaction, error); }
    }
    for (const name of names.filter((value) => value !== SECURITY_STORE)) {
      compareStoreRows(transaction, name, original[name], {
        check: () => vault.assertUnlocked(), complete,
        fail: (error) => abortWith(transaction, error),
      });
    }
  });
}
