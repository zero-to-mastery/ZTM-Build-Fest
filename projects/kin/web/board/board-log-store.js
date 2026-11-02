// This device's copy of the household fridge's log (#317, ADR 0011).
//
// One IndexedDB database per household ("kin-board-log:<householdId>"),
// apart from the household event store and the chat log. Board events are
// kept exactly as they travel: signed envelopes encrypted under a household
// key epoch. Nothing here is readable without that key, which lives in the
// vault-protected key store, so the log needs no sealing of its own. An
// envelope is authenticated once, when it arrives.
//
//   events  { order, eventId, envelope }   every board event, in the order
//                                          this device stored it; one read
//                                          from an archive (#363) has
//                                          `imported` (the canonical event
//                                          sealed by the local vault) in
//                                          place of `envelope`
//   ids     { eventId, order }             one row per event, so two tabs
//                                          storing the same event keep one
//   outbox  { deviceSequence, eventId }    this device's events the relay
//                                          hasn't accepted yet
//   meta    { key: "state", nextOrder, cursor, deviceSequence, provisional,
//             refused, access }   `access` is the last fridge access the
//                                 service gave this member (#323)
//
// `cursor` is the relay position read up to; `deviceSequence` the last board
// sequence this device used. It starts provisional (an offline first stroke)
// and the first sync renumbers pending events after the relay's count
// (board-room.js). Leaving the household deletes the database.

const DATABASE_VERSION = 1;
const EVENTS = "events";
const IDS = "ids";
const OUTBOX = "outbox";
const META = "meta";
const STATE_KEY = "state";
const MAX_REFUSED = 100;

export const boardLogDatabaseName = (householdId) => `kin-board-log:${householdId}`;

export class BoardLogError extends Error {
  constructor(message, code = "board_log_unavailable") {
    super(message);
    this.name = "BoardLogError";
    this.code = code;
  }
}

const unavailable = (cause) => {
  const error = new BoardLogError("Kin couldn't use this device's fridge storage.");
  error.cause = cause;
  return error;
};

const settle = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(unavailable(request.error));
});

/** Runs `work(stores)` in one transaction and resolves with its result once
 * the transaction commits; a thrown error aborts it. */
function transact(db, names, mode, work) {
  let transaction;
  try {
    transaction = db.transaction(names, mode);
  } catch (cause) {
    return Promise.reject(unavailable(cause));
  }
  const stores = Object.fromEntries(names.map((name) => [name, transaction.objectStore(name)]));
  return new Promise((resolve, reject) => {
    let result, failure = null;
    transaction.oncomplete = () => (failure ? reject(failure) : resolve(result));
    transaction.onerror = () => reject(failure ?? unavailable(transaction.error));
    transaction.onabort = () => reject(failure ?? unavailable(transaction.error));
    Promise.resolve()
      .then(() => work(stores))
      .then((value) => { result = value; }, (error) => {
        failure = error;
        try { transaction.abort?.(); } catch { /* already finished */ }
      });
  });
}

const freshState = () => ({ key: STATE_KEY, nextOrder: 1, cursor: "", deviceSequence: 0, provisional: true, refused: [] });

export class BoardLogStore {
  static async open(householdId, { indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange } = {}) {
    if (typeof householdId !== "string" || !/^[a-f0-9]{32}$/.test(householdId) || !indexedDB || !keyRange) throw unavailable();
    const request = indexedDB.open(boardLogDatabaseName(householdId), DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EVENTS)) db.createObjectStore(EVENTS, { keyPath: "order" });
      if (!db.objectStoreNames.contains(IDS)) db.createObjectStore(IDS, { keyPath: "eventId" });
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: "deviceSequence" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
    };
    const db = await settle(request);
    // Another tab deleting the database (the household leaving this device).
    db.onversionchange = () => db.close();
    return new BoardLogStore(db, { keyRange });
  }

  /** Deletes a household's fridge log from this device (leaving it). */
  static remove(householdId, { indexedDB = globalThis.indexedDB } = {}) {
    if (!indexedDB) return Promise.resolve();
    return new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(boardLogDatabaseName(householdId));
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }

  constructor(db, { keyRange }) {
    this.db = db;
    this.keyRange = keyRange;
  }

  state() {
    return transact(this.db, [META], "readonly", async ({ meta }) => (await settle(meta.get(STATE_KEY))) ?? freshState());
  }

  /** Up to `limit` events stored at or after `fromOrder`, in stored order. */
  eventsFrom(fromOrder = 1, limit = 0) {
    return transact(this.db, [EVENTS], "readonly", ({ events }) =>
      settle(events.getAll(this.keyRange.lowerBound(fromOrder), limit || undefined)));
  }

  eventById(eventId) {
    return transact(this.db, [EVENTS, IDS], "readonly", async ({ events, ids }) => {
      const id = await settle(ids.get(eventId));
      return id ? (await settle(events.get(id.order))) ?? null : null;
    });
  }

  outbox() {
    return transact(this.db, [OUTBOX], "readonly", ({ outbox }) => settle(outbox.getAll()));
  }

  /** Stores relayed events (already authenticated) and the cursor read up
   * to; events already stored are skipped. Resolves with how many were new. */
  addReceived(envelopes, cursor, { refused = [] } = {}) {
    if (typeof cursor !== "string") return Promise.reject(unavailable());
    return transact(this.db, [EVENTS, IDS, META], "readwrite", async ({ events, ids, meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      if (refused.length) state.refused = [...(state.refused ?? []), ...refused].slice(-MAX_REFUSED);
      let added = 0;
      for (const envelope of envelopes) {
        const known = await settle(ids.get(envelope.eventId));
        if (known) {
          // The relay's signed copy of an event read from an export takes
          // its place, so it is authenticated and readable by keys.
          const row = await settle(events.get(known.order));
          if (row?.imported) events.put({ order: known.order, eventId: envelope.eventId, envelope });
          continue;
        }
        const order = state.nextOrder++;
        events.put({ order, eventId: envelope.eventId, envelope });
        ids.put({ eventId: envelope.eventId, order });
        added += 1;
      }
      state.cursor = cursor;
      await settle(meta.put(state));
      return added;
    });
  }

  /** Stores events read from an archive (#363): `entries` are
   * `{ eventId, sealed }`, the canonical event sealed by the local vault. An
   * event already stored from the relay is kept; one an earlier import stored
   * is replaced (so a restore after the vault's root changed puts it right).
   * Resolves with how many rows are new. */
  importEvents(entries) {
    return transact(this.db, [EVENTS, IDS, META], "readwrite", async ({ events, ids, meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      let added = 0;
      for (const { eventId, sealed } of entries) {
        const known = await settle(ids.get(eventId));
        if (known) {
          const row = await settle(events.get(known.order));
          if (row?.imported) events.put({ order: known.order, eventId, imported: sealed });
          continue;
        }
        const order = state.nextOrder++;
        events.put({ order, eventId, imported: sealed });
        ids.put({ eventId, order });
        added += 1;
      }
      await settle(meta.put(state));
      return added;
    });
  }

  /** Stores an event this device just made with its outbox entry. Its
   * sequence must follow the last one this device used, so two tabs drawing
   * at once can't both take it; the loser retries. */
  addLocal(envelope) {
    return transact(this.db, [EVENTS, IDS, OUTBOX, META], "readwrite", async ({ events, ids, outbox, meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      if (envelope.deviceSequence !== state.deviceSequence + 1)
        throw new BoardLogError("Another tab changed the fridge at the same moment. Try again.", "board_sequence_taken");
      if (await settle(ids.get(envelope.eventId)))
        throw new BoardLogError("Kin found a conflicting fridge event identifier.", "board_event_conflict");
      const order = state.nextOrder++;
      events.put({ order, eventId: envelope.eventId, envelope });
      ids.put({ eventId: envelope.eventId, order });
      outbox.put({ deviceSequence: envelope.deviceSequence, eventId: envelope.eventId });
      state.deviceSequence = envelope.deviceSequence;
      await settle(meta.put(state));
      return order;
    });
  }

  /** Replaces pending events after renumbering or resealing them. Each entry
   * is { order, previousSequence, envelope }; only events still in the
   * outbox may be replaced. */
  replacePending(entries, { expectedDeviceSequence, deviceSequence, provisional = false }) {
    return transact(this.db, [EVENTS, OUTBOX, META], "readwrite", async ({ events, outbox, meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      if (state.deviceSequence !== expectedDeviceSequence)
        throw new BoardLogError("The fridge changed meanwhile; retry.", "board_outbox_changed");
      for (const { previousSequence } of entries)
        if (!(await settle(outbox.get(previousSequence))))
          throw new BoardLogError("The fridge changed meanwhile; retry.", "board_outbox_changed");
      for (const { previousSequence } of entries) outbox.delete(previousSequence);
      for (const { order, envelope } of entries) {
        events.put({ order, eventId: envelope.eventId, envelope });
        outbox.put({ deviceSequence: envelope.deviceSequence, eventId: envelope.eventId });
      }
      state.deviceSequence = deviceSequence;
      state.provisional = provisional;
      await settle(meta.put(state));
    });
  }

  /** Remembers this member's fridge access, so the next unlock starts from
   * it rather than from "write" before the first sync (#323). */
  setAccess(access) {
    return transact(this.db, [META], "readwrite", async ({ meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      state.access = access;
      await settle(meta.put(state));
    });
  }

  /** Settles the sequence with the relay's when nothing is pending. */
  settleSequence(deviceSequence) {
    return transact(this.db, [META], "readwrite", async ({ meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      state.deviceSequence = Math.max(state.deviceSequence, deviceSequence);
      state.provisional = false;
      await settle(meta.put(state));
    });
  }

  /** Drops outbox entries the relay accepted, by device sequence. */
  markSent(deviceSequences) {
    if (!deviceSequences.length) return Promise.resolve();
    return transact(this.db, [OUTBOX], "readwrite", ({ outbox }) => {
      for (const sequence of deviceSequences) outbox.delete(sequence);
    });
  }

  close() {
    this.db.close();
  }
}
