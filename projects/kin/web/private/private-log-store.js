// This device's copy of one member's private log (#492, ADR 0019),
// modelled on the fridge's board log store.
//
// One IndexedDB database per member ("kin-private-log:<householdId>:<memberId>"),
// apart from the household event store, chat and the fridge. Private events
// are kept exactly as they travel: signed envelopes sealed under a member-key
// epoch. Nothing here is readable without the member key, which only the
// member's account vault holds (member-key.js), so the log needs no sealing
// of its own. An envelope is authenticated once, when it arrives.
//
//   events  { order, eventId, envelope }   every private event, in the order
//                                          this device stored it
//   ids     { eventId, order }             one row per event, so two tabs
//                                          storing the same event keep one
//   outbox  { deviceSequence, eventId }    this device's events the relay
//                                          hasn't accepted yet
//   meta    { key: "state", nextOrder, cursor, deviceSequence, provisional,
//             refused, vault }   `vault` is the last sealed account vault
//                                seen ({ version, ciphertext }, ciphertext
//                                under the vault key, as the service holds
//                                it), so an offline unlock can still open
//                                the member key
//
// `cursor` is the relay position read up to; `deviceSequence` the last
// private sequence this device used. It starts provisional (something
// written offline before the first sync) and the first sync renumbers
// pending events after the relay's count (private-log.js).

const DATABASE_VERSION = 1;
const EVENTS = "events";
const IDS = "ids";
const OUTBOX = "outbox";
const META = "meta";
const STATE_KEY = "state";
const MAX_REFUSED = 100;
const ID = /^[a-f0-9]{32}$/;

export const privateLogDatabaseName = (householdId, memberId) => `kin-private-log:${householdId}:${memberId}`;

export class PrivateLogError extends Error {
  constructor(message, code = "private_log_unavailable") {
    super(message);
    this.name = "PrivateLogError";
    this.code = code;
  }
}

const unavailable = (cause) => {
  const error = new PrivateLogError("Kin couldn't use this device's private storage.");
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

export class PrivateLogStore {
  static async open(householdId, memberId, { indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange } = {}) {
    if (!ID.test(householdId ?? "") || !ID.test(memberId ?? "") || !indexedDB || !keyRange) throw unavailable();
    const request = indexedDB.open(privateLogDatabaseName(householdId, memberId), DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EVENTS)) db.createObjectStore(EVENTS, { keyPath: "order" });
      if (!db.objectStoreNames.contains(IDS)) db.createObjectStore(IDS, { keyPath: "eventId" });
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: "deviceSequence" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
    };
    const db = await settle(request);
    db.onversionchange = () => db.close();
    return new PrivateLogStore(db, { keyRange });
  }

  /** Deletes a member's private log from this device. */
  static remove(householdId, memberId, { indexedDB = globalThis.indexedDB } = {}) {
    if (!indexedDB) return Promise.resolve();
    return new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(privateLogDatabaseName(householdId, memberId));
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
        if (await settle(ids.get(envelope.eventId))) continue;
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

  /** Stores envelopes from the member's own export (#495), already checked
   * against their member key; events already stored are skipped, and the
   * relay cursor is left as it is. Resolves with how many were new. */
  addImported(envelopes) {
    return transact(this.db, [EVENTS, IDS, META], "readwrite", async ({ events, ids, meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      let added = 0;
      for (const envelope of envelopes) {
        if (await settle(ids.get(envelope.eventId))) continue;
        const order = state.nextOrder++;
        events.put({ order, eventId: envelope.eventId, envelope });
        ids.put({ eventId: envelope.eventId, order });
        added += 1;
      }
      await settle(meta.put(state));
      return added;
    });
  }

  /** Stores an event this device just made with its outbox entry. Its
   * sequence must follow the last one this device used, so two tabs writing
   * at once can't both take it; the loser retries. */
  addLocal(envelope) {
    return transact(this.db, [EVENTS, IDS, OUTBOX, META], "readwrite", async ({ events, ids, outbox, meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      if (envelope.deviceSequence !== state.deviceSequence + 1)
        throw new PrivateLogError("Another tab saved something private at the same moment. Try again.", "private_sequence_taken");
      if (await settle(ids.get(envelope.eventId)))
        throw new PrivateLogError("Kin found a conflicting private event identifier.", "private_event_conflict");
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
        throw new PrivateLogError("Your private things changed meanwhile; retry.", "private_outbox_changed");
      for (const { previousSequence } of entries)
        if (!(await settle(outbox.get(previousSequence))))
          throw new PrivateLogError("Your private things changed meanwhile; retry.", "private_outbox_changed");
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

  /** The member-key ring's vault cache (member-key.js `cache`). */
  vaultCache() {
    return {
      load: async () => {
        const vault = (await this.state()).vault;
        return vault && Number.isSafeInteger(vault.version) && vault.ciphertext instanceof Uint8Array ? { version: vault.version, ciphertext: vault.ciphertext.slice() } : null;
      },
      save: (known) => transact(this.db, [META], "readwrite", async ({ meta }) => {
        const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
        if ((state.vault?.version ?? 0) <= known.version) state.vault = { version: known.version, ciphertext: known.ciphertext.slice() };
        await settle(meta.put(state));
      }),
    };
  }

  close() {
    this.db.close();
  }
}
