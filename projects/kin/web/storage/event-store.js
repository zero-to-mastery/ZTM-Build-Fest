import {
  idToHex, idFromHex, randomId, eventMetadata, eventMetadataBatch,
} from "../wasm/kin-engine.js";
import {
  encryptedDatabase, snapshotStores, protectRows, valuesEqual, compareStoreRows,
} from "./encrypted-idb.js";
import { projectionContext } from "../browser-time.js";
import { rotateEventProtection, resumeEventProtection } from "./root-rotation.js";

const DATABASE_NAME = "kin";
const DATABASE_VERSION = 3;
const SECURITY_STORE = "security_state";
const SECURITY_KEY = "vault";
export const EVENT_STORE_DEFINITIONS = {
  events: { keyPath: "local_sequence", indexes: { event_id: "event_id" } },
  local_context: { keyPath: "key" },
  sync_state: { keyPath: "key" },
  sync_outbox: { keyPath: "event_id" },
  sync_bindings: { keyPath: "legacy_key" },
};
const EVENT_STORE = "events";
const CONTEXT_STORE = "local_context";
const SYNC_STATE_STORE = "sync_state";
const SYNC_OUTBOX_STORE = "sync_outbox";
const SYNC_BINDING_STORE = "sync_bindings";
const CONTEXT_KEY = "installation";
const MAX_EVENT_COUNT = 10_000;
const MAX_LOGICAL_TIME = (1n << 64n) - 1n;

export class EventStoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "EventStoreError";
    this.userMessage = message;
    this.code = cause?.code;
  }
}

export class EventStore {
  constructor(database) {
    this.database = database;
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

  static async prepareSecurity(manifest) {
    const database = await openEventDatabase();
    try {
      const transaction = database.transaction(SECURITY_STORE, "readwrite");
      const store = transaction.objectStore(SECURITY_STORE);
      const request = store.get(SECURITY_KEY);
      return await transactionResult(transaction, (finish) => {
        request.onsuccess = () => {
          if (request.result) { abortWith(transaction, new EventStoreError("Kin already has a local security setup. Unlock the existing store.")); return; }
          if (manifest?.formatVersion !== 1 || !/^[a-f0-9]{32}$/.test(manifest.vaultId ?? "") || !manifest.verifier || !manifest.wrappers?.some((wrapper) => wrapper.type === "recovery")) {
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
    if (manifest.vaultId !== vault.vaultId || !manifest.wrappers?.some((wrapper) => wrapper.type === "recovery"))
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
          let context = rows.local_context.find((row) => row.key === CONTEXT_KEY);
          if (!context && events.length) throw invalidCatchUpState();
          if (!context) {
            context = { key: CONTEXT_KEY, household_id: randomId(), actor_id: randomId(), device_id: randomId(), next_logical_time: 1n, last_looked_event_id: null, last_looked_local_sequence: 0, last_looked_at: Date.now() };
            rows.local_context.push(context);
          } else if (!hasCatchUpMetadata(context)) {
            validateContext(context, { allowUninitialized: true });
            const tail = events.at(-1);
            Object.assign(context, { last_looked_event_id: tail ? asBytes(tail.event_id).slice() : null, last_looked_local_sequence: tail?.local_sequence ?? 0, last_looked_at: Date.now() });
          }
          validateContext(context);
          validateCursorBoundary(context, events);
          const { asOf, civilDate } = projectionContext();
          engine.applyEvents(events.map((row) => row.encoded_event), asOf, context.last_looked_event_id === null ? null : idToHex(context.last_looked_event_id), civilDate, syncIdentityFromContext(context));
          const keys = await prepareKeys(vault, { check: checkMigration });
          if (keys?.rewrapEventRows) await keys.rewrapEventRows(rows);
          else if (keys?.rewrapSyncState) {
            for (let i = 0; i < rows.sync_state.length; i += 1) rows.sync_state[i] = await keys.rewrapSyncState(rows.sync_state[i]);
          }
          const protectedRows = await protectRows(vault, EVENT_STORE_DEFINITIONS, rows, { check: checkMigration });
          // protectRows decrypts and compares every complete candidate record.
          // Replaying the proven-equal canonical source preserves the complete
          // post-verification replay without another recovered plaintext graph.
          engine.applyEvents(events.map((row) => row.encoded_event), asOf,
            context.last_looked_event_id === null ? null : idToHex(context.last_looked_event_id), civilDate, syncIdentityFromContext(context));
          vault.assertUnlocked();
          manifest = { ...manifest, phase: "cleanup-pending" };
          await replaceVerifiedSnapshot(database, original, protectedRows, manifest, vault);
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
      const store = new EventStore(encryptedDatabase(database, vault, EVENT_STORE_DEFINITIONS, {
        securityGuard: { store: SECURITY_STORE, key: SECURITY_KEY, epoch, rootVersion: manifest.rootVersion },
      }));
      store.engine = engine;
      const context = await store.ensureContext();
      store.actorId = idToHex(context.sync_member_id ?? context.actor_id);
      return store;
    } catch (error) { database.close(); throw error; }
  }

  static async openLegacyForMigration() {
    const database = await openEventDatabase();
    if (await readSecurity(database)) { database.close(); throw new EventStoreError("Legacy writes are disabled after security setup."); }
    const store = new EventStore(database);
    const context = await store.ensureContext();
    store.actorId = idToHex(context.sync_member_id ?? context.actor_id);
    return store;
  }

  async loadEvents() {
    const transaction = this.database.transaction(EVENT_STORE, "readonly");
    const request = transaction.objectStore(EVENT_STORE).getAll();
    return transactionResult(transaction, (finish) => {
      request.onsuccess = () => {
        try {
          finish(validateEventRows(request.result));
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      request.onerror = () =>
        abortWith(transaction, storageError(request.error));
    });
  }

  async snapshotForArchive() {
    const snapshot = await snapshotStores(this.database, [EVENT_STORE, CONTEXT_STORE]);
    const archive = { formatVersion: 1, events: snapshot.events, local_context: snapshot.local_context };
    validateArchiveSnapshot(archive, this.engine);
    return archive;
  }

  static async restoreEmpty({ vault, engine, snapshot, manifest, ownedSnapshot = false }) {
    vault.assertUnlocked();
    // Authenticated archive decoding can transfer its private result to this
    // operation. Public callers retain defensive cloning against later mutation.
    const source = ownedSnapshot ? snapshot : structuredClone(snapshot);
    validateArchiveSnapshot(source, engine);
    const context = source.local_context[0];
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
    validateArchiveSnapshot(source, engine);
    const rows = { events: source.events, local_context: source.local_context };
    const protectedRows = await protectRows(vault, EVENT_STORE_DEFINITIONS, rows, { check: () => EventStore.checkSecurityEpoch(vault) });
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
            finish({ eventCount: source.events.length, localOnly: true });
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
    const eventRequest = events.getAll();
    const contextRequest = contextStore.get(CONTEXT_KEY);
    const syncStateRequest = syncStates.get("active");

    return transactionResult(transaction, (finish) => {
      let loadedEvents;
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
          loadedEvents = validateEventRows(loadedEvents);
          validateContext(context);
          validateCursorBoundary(context, loadedEvents);
          if (loadedEvents.length >= MAX_EVENT_COUNT) {
            throw new EventStoreError(
              "Kin has reached its local event limit. Your saved information was not deleted.",
            );
          }
          if (syncState && syncState.pendingCount >= MAX_EVENT_COUNT)
            throw new EventStoreError(
              "Kin's sync queue is full. Sync this device before adding more household changes.",
            );

          const logicalTime = BigInt(context.next_logical_time);
          if (logicalTime <= 0n || logicalTime >= MAX_LOGICAL_TIME) {
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
            loadedEvents.map((event) => event.encoded_event),
            asOf,
            context.last_looked_event_id === null ? null : idToHex(context.last_looked_event_id),
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
                loadedEvents.map((storedEvent) => storedEvent.encoded_event),
                asOf,
                context.last_looked_event_id === null
                  ? null
                  : idToHex(context.last_looked_event_id),
                civilDate,
                syncIdentity,
              );
              const tail = loadedEvents.at(-1);
              finish({
                state: currentState,
                snapshotBoundary: tail
                  ? {
                      eventId: idToHex(tail.event_id),
                      localSequence: tail.local_sequence,
                      snapshotThroughEventId: idToHex(tail.event_id),
                      snapshotThroughLocalSequence: tail.local_sequence,
                    }
                  : null,
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

      eventRequest.onsuccess = () => {
        loadedEvents = eventRequest.result;
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
      eventRequest.onerror = () =>
        abortWith(transaction, storageError(eventRequest.error));
      contextRequest.onerror = () =>
        abortWith(transaction, storageError(contextRequest.error));
      syncStateRequest.onerror = () =>
        abortWith(transaction, storageError(syncStateRequest.error));
    });
  }

  getCatchUpState() {
    const transaction = this.database.transaction(
      [EVENT_STORE, CONTEXT_STORE],
      "readonly",
    );
    const eventsRequest = transaction.objectStore(EVENT_STORE).getAll();
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
          loadedEvents = validateEventRows(loadedEvents);
          validateContext(context);
          validateCursorBoundary(context, loadedEvents);
          const tail = loadedEvents.at(-1);
          finish({
            events: loadedEvents,
            syncIdentity: syncIdentityFromContext(context),
            cursor: {
              eventId: context.last_looked_event_id
                ? idToHex(context.last_looked_event_id)
                : null,
              localSequence: context.last_looked_local_sequence,
              lastLookedAt: context.last_looked_at,
            },
            through: tail
              ? {
                  eventId: idToHex(tail.event_id),
                  localSequence: tail.local_sequence,
                }
              : null,
          });
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      eventsRequest.onsuccess = () => {
        loadedEvents = eventsRequest.result;
        eventsReady = true;
        complete();
      };
      contextRequest.onsuccess = () => {
        context = contextRequest.result;
        contextReady = true;
        complete();
      };
      eventsRequest.onerror = () =>
        abortWith(transaction, storageError(eventsRequest.error));
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
    const eventsRequest = eventsStore.getAll();
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
          loadedEvents = validateEventRows(loadedEvents);
          validateContext(context);
          validateCursorBoundary(context, loadedEvents);
          for (const field of ["householdId", "memberId", "deviceId"])
            idFromHex(identity?.[field]);
          if (context.archive_imported)
            throw new EventStoreError("Restored archives are local-only. Kin preserves their history without restoring device trust or uploading it as another device.");
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
              keyEpoch: serverStatus.currentEpoch,
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
      eventsRequest.onsuccess = () => {
        loadedEvents = eventsRequest.result;
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
      eventsRequest.onerror = () =>
        abortWith(transaction, storageError(eventsRequest.error));
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
            if (row.accepted && row.envelope) {
              row.accepted = false;
              const write = outbox.put(row);
              write.onerror = () =>
                abortWith(transaction, storageError(write.error));
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
    const eventsRequest = transaction.objectStore(EVENT_STORE).getAll();
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
          events = validateEventRows(events);
          validateContext(context);
          finish({
            events,
            legacyIdentity: {
              householdId: idToHex(context.household_id),
              actorId: idToHex(context.actor_id),
              deviceId: idToHex(context.device_id),
            },
            maxLogicalTime: events.reduce(
              (maximum, row) =>
                row.logical_time > maximum ? row.logical_time : maximum,
              0n,
            ),
          });
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      eventsRequest.onsuccess = () => {
        events = eventsRequest.result;
        complete();
      };
      contextRequest.onsuccess = () => {
        context = contextRequest.result;
        complete();
      };
      eventsRequest.onerror = () =>
        abortWith(transaction, storageError(eventsRequest.error));
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
      [EVENT_STORE, CONTEXT_STORE, SYNC_STATE_STORE],
      "readwrite",
    );
    const eventsStore = transaction.objectStore(EVENT_STORE);
    const contextStore = transaction.objectStore(CONTEXT_STORE);
    const syncStates = transaction.objectStore(SYNC_STATE_STORE);
    const eventsRequest = eventsStore.getAll();
    const contextRequest = contextStore.get(CONTEXT_KEY);
    const stateRequest = syncStates.get("active");
    return transactionResult(transaction, (finish) => {
      let rows;
      let context;
      let syncState;
      let ready = 0;
      const complete = () => {
        ready += 1;
        if (ready !== 3) return;
        try {
          rows = validateEventRows(rows);
          validateContext(context);
          if (!syncState || !context.sync_household_id)
            throw new EventStoreError(
              "Kin has not initialized encrypted sync for this device.",
            );
          if (cursorValue(nextCursor) < cursorValue(syncState.cursorHighWater))
            throw new EventStoreError("Kin rejected a sync cursor rollback.");
          validateCursorBoundary(context, rows);
          const byId = new Map(rows.map((row) => [idToHex(row.event_id), row]));
          const additions = [];
          for (const item of received) {
            const canonical = asBytes(item.encodedEvent).slice();
            const candidate = eventRowFromCanonical(canonical);
            const eventId = idToHex(candidate.event_id);
            const existing = byId.get(eventId);
            if (existing) {
              if (!bytesEqual(existing.encoded_event, canonical))
                throw new EventStoreError(
                  "Kin found conflicting synchronized bytes for an existing event ID.",
                );
              continue;
            }
            candidate.local_sequence =
              (rows.at(-1)?.local_sequence ?? 0) + additions.length + 1;
            additions.push(candidate);
            byId.set(eventId, candidate);
          }
          const candidateRows = [...rows, ...additions];
          validateEventRows(candidateRows);
          const { asOf: projectionAsOf, civilDate: projectionDate } =
            projectionContext();
          const state = engine.applyEvents(
            candidateRows.map((row) => row.encoded_event),
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
          const maximumLogicalTime = candidateRows.reduce(
            (maximum, row) =>
              row.logical_time > maximum ? row.logical_time : maximum,
            0n,
          );
          context.next_logical_time =
            context.next_logical_time > maximumLogicalTime
              ? context.next_logical_time
              : maximumLogicalTime + 1n;
          syncState.maxLogicalTime = maximumLogicalTime;
          syncState.syncCursor = nextCursor;
          syncState.cursorHighWater = nextCursor;
          const contextWrite = contextStore.put(context);
          const stateWrite = syncStates.put(syncState);
          contextWrite.onerror = () =>
            abortWith(transaction, storageError(contextWrite.error));
          stateWrite.onerror = () =>
            abortWith(transaction, storageError(stateWrite.error));
          const tail = candidateRows.at(-1);
          finish({
            state,
            added: additions.length,
            snapshotBoundary: tail
              ? {
                  eventId: idToHex(tail.event_id),
                  localSequence: tail.local_sequence,
                  snapshotThroughEventId: idToHex(tail.event_id),
                  snapshotThroughLocalSequence: tail.local_sequence,
                }
              : null,
          });
        } catch (error) {
          abortWith(transaction, error);
        }
      };
      eventsRequest.onsuccess = () => {
        rows = eventsRequest.result;
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
      eventsRequest.onerror = () =>
        abortWith(transaction, storageError(eventsRequest.error));
      contextRequest.onerror = () =>
        abortWith(transaction, storageError(contextRequest.error));
      stateRequest.onerror = () =>
        abortWith(transaction, storageError(stateRequest.error));
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
    const eventsRequest = eventsStore.getAll();
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
          loadedEvents = validateEventRows(loadedEvents);
          validateContext(context);
          validateCursorBoundary(context, loadedEvents);
          const boundary = validateSnapshotBoundary(snapshotBoundary);
          const snapshotTail =
            boundary.snapshotThroughLocalSequence === 0
              ? null
              : loadedEvents.find(
                  (row) =>
                    row.local_sequence ===
                    boundary.snapshotThroughLocalSequence,
                );
          if (
            !snapshotTail ||
            idToHex(snapshotTail.event_id) !==
              boundary.snapshotThroughEventId ||
            boundary.localSequence > boundary.snapshotThroughLocalSequence
          ) {
            throw invalidCatchUpState();
          }
          const requested = loadedEvents.find(
            (row) => row.local_sequence === boundary.localSequence,
          );
          if (!requested || idToHex(requested.event_id) !== boundary.eventId) {
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
            last_looked_event_id: requested.event_id,
            last_looked_local_sequence: requested.local_sequence,
            last_looked_at: Date.now(),
          };
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
      eventsRequest.onsuccess = () => {
        loadedEvents = eventsRequest.result;
        eventsReady = true;
        complete();
      };
      contextRequest.onsuccess = () => {
        context = contextRequest.result;
        contextReady = true;
        complete();
      };
      eventsRequest.onerror = () =>
        abortWith(transaction, storageError(eventsRequest.error));
      contextRequest.onerror = () =>
        abortWith(transaction, storageError(contextRequest.error));
    });
  }

  ensureContext() {
    const transaction = this.database.transaction(
      [EVENT_STORE, CONTEXT_STORE],
      "readwrite",
    );
    const eventRequest = transaction.objectStore(EVENT_STORE).getAll();
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
          loadedEvents = validateEventRows(loadedEvents);
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

          validateContext(context, { allowUninitialized: true });
          validateEventHousehold(context, loadedEvents);
          if (!hasCatchUpMetadata(context)) {
            const tail = loadedEvents.at(-1);
            context = {
              ...context,
              last_looked_event_id: tail
                ? Uint8Array.from(asBytes(tail.event_id))
                : null,
              last_looked_local_sequence: tail?.local_sequence ?? 0,
              last_looked_at: Date.now(),
            };
            const write = contexts.put(context);
            write.onerror = () =>
              abortWith(transaction, storageError(write.error));
          } else {
            validateCursorBoundary(context, loadedEvents);
          }
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
      eventRequest.onsuccess = () => {
        loadedEvents = eventRequest.result;
        eventsReady = true;
        initialize();
      };
      eventRequest.onerror = () =>
        abortWith(transaction, storageError(eventRequest.error));
    });
  }

  close() {
    this.database.close();
  }
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
  return error;
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

function validateContext(context, { allowUninitialized = false } = {}) {
  if (
    context?.key !== CONTEXT_KEY ||
    !isId(context.household_id) ||
    !isId(context.actor_id) ||
    !isId(context.device_id) ||
    typeof context.next_logical_time !== "bigint" ||
    context.next_logical_time < 1n ||
    context.next_logical_time > MAX_LOGICAL_TIME
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
  if (presentFields.length === 0 && allowUninitialized) return;
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

function hasCatchUpMetadata(context) {
  return [
    "last_looked_event_id",
    "last_looked_local_sequence",
    "last_looked_at",
  ].some((field) => Object.prototype.hasOwnProperty.call(context, field));
}

function validateEventHousehold(context, events) {
  if (context.sync_household_id) {
    const bindings = new Set(
      context.sync_identity_bindings.map(
        (binding) =>
          `${binding.legacyHouseholdId}:${binding.legacyActorId}:${binding.legacyDeviceId}`,
      ),
    );
    if (
      events.some((event) => {
        if (bytesEqual(event.household_id, context.sync_household_id))
          return false;
        const key = `${idToHex(event.household_id)}:${idToHex(event.actor_id)}:${idToHex(event.device_id)}`;
        return !bindings.has(key);
      })
    )
      throw invalidCatchUpState();
    return;
  }
  if (
    events.some(
      (event) => !bytesEqual(event.household_id, context.household_id),
    )
  ) {
    throw invalidCatchUpState();
  }
}

function syncIdentityFromContext(context) {
  return context.sync_household_id
    ? {
        householdId: idToHex(context.sync_household_id),
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
  return eventRowFromMetadata(bytes, metadata);
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

function validateCursorBoundary(context, events) {
  validateEventHousehold(context, events);
  if (context.last_looked_local_sequence === 0) return;
  const cursor = events.find(
    (event) => event.local_sequence === context.last_looked_local_sequence,
  );
  if (!cursor || !bytesEqual(cursor.event_id, context.last_looked_event_id)) {
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
    return leftBytes.every((byte, index) => byte === rightBytes[index]);
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
  validateCursorBoundary(context, events);
  if (events.some((row) => row.logical_time >= context.next_logical_time))
    throw new EventStoreError("Kin found an invalid event counter. The saved history was preserved.");
  const { asOf, civilDate } = projectionContext();
  engine.applyEvents(events.map((row) => row.encoded_event), asOf,
    context.last_looked_event_id === null ? null : idToHex(context.last_looked_event_id), civilDate, syncIdentityFromContext(context));
}

function validateArchiveSnapshot(snapshot, engine) {
  const onlyFields = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => names.includes(key));
  if (!engine || !onlyFields(snapshot, ["formatVersion", "events", "local_context"]) || snapshot.formatVersion !== 1 ||
      !Array.isArray(snapshot.local_context) || snapshot.local_context.length !== 1)
    throw new EventStoreError("Kin could not validate this archive's household records.");
  const rows = validateEventRows(snapshot.events);
  const eventFields = ["local_sequence", "event_id", "household_id", "actor_id", "device_id", "timestamp", "logical_time", "kind", "event_version", "encoded_event"];
  if (rows.some((row) => !onlyFields(row, eventFields)) || rows.reduce((size, row) => size + asBytes(row.encoded_event).byteLength, 0) > 64 * 1024 * 1024)
    throw new EventStoreError("Kin found unsupported archive event fields or size.");
  const context = snapshot.local_context[0];
  if (!onlyFields(context, ["key", "household_id", "actor_id", "device_id", "next_logical_time", "last_looked_event_id", "last_looked_local_sequence", "last_looked_at", "sync_household_id", "sync_member_id", "sync_device_id", "sync_identity_bindings", "archive_imported"]))
    throw new EventStoreError("Kin found unsupported archive context fields.");
  if (context.archive_imported !== undefined && context.archive_imported !== true)
    throw new EventStoreError("Kin found an invalid archive restore marker.");
  validateContext(context);
  validateCursorBoundary(context, rows);
  if (rows.some((row) => row.logical_time >= context.next_logical_time))
    throw new EventStoreError("The archive logical counter cannot safely continue its history.");
  const bindingFields = ["legacyHouseholdId", "legacyActorId", "legacyDeviceId", "householdId", "actorId", "deviceId"];
  if ((context.sync_identity_bindings ?? []).some((binding) => !onlyFields(binding, bindingFields) || Object.keys(binding).length !== bindingFields.length))
    throw new EventStoreError("Kin found unsupported archive identity bindings.");
  const { asOf, civilDate } = projectionContext();
  engine.planImport(rows.map((row) => row.encoded_event), asOf,
    context.last_looked_event_id === null ? null : idToHex(context.last_looked_event_id), civilDate, syncIdentityFromContext(context));
  return snapshot;
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
