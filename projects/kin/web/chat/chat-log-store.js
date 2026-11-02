// This device's copy of the household chat log (#111).
//
// One IndexedDB database per household ("kin-chat-log:<householdId>"),
// apart from the household event store (whose schema stays frozen) and the
// chat blob store. Chat events are kept exactly as they travel: the signed
// envelopes, encrypted under a household key epoch. Nothing here is
// readable without that key, which lives in the vault-protected key store,
// so the log needs no sealing of its own and survives root rotation as is.
// An envelope is authenticated (its signature checked against its author's
// device key) once, when it arrives; reopening only decrypts it.
//
//   events  { order, eventId, envelope }   every chat event, in the order
//                                          this device stored it; one read
//                                          from an archive (#136) has
//                                          `imported` (the canonical event
//                                          sealed by the local vault) in
//                                          place of `envelope`
//   ids     { eventId, order }             one row per event: the log
//                                          stores each event once, even when
//                                          two tabs store it at the same time
//   outbox  { deviceSequence, eventId, blobRef, retireRef, retireParts, messageId }
//                                          this device's events not yet
//                                          accepted by the relay, the content
//                                          blob each must upload first, and
//                                          the blob it replaced, which the
//                                          service deletes once it's accepted,
//                                          and the message it concerns
//   meta    { key: "state", nextOrder, cursor, deviceSequence, provisional,
//             admins, members, membersSignature, retiredThrough, refused,
//             hidden, hiddenRevision, hiddenDirty, hiddenSealedFor, read,
//             readers, presence }
//
// `cursor` is the relay position read up to. `deviceSequence` is the last
// chat sequence this device used. It starts provisional when the log is new
// and the relay hasn't been asked yet (an offline first message); the first
// sync then renumbers those events after the relay's count (chat-room.js).
// `admins` and `members` are the household admins and members last known, `retiredThrough` how many
// events' replaced blobs this device already deleted, and `refused` the
// relay events it skipped because they failed authentication. `hidden` are
// the messages this member hid for themselves (#119; chat-hidden.js).
// `readers` are the members who can read chat (#130), for who can be
// mentioned. `read` is this member's private read position, { postedAt, messageId } (#133):
// unread tracking that works with read receipts off, synced in the same
// sealed record as `hidden`. `presence` is this member's read cursor and receipt and typing settings,
// with the revision of their slot on the service (#121; chat-presence.js).
// Removing the household from the device deletes the whole database.

import { compareCursors, mergeCursors } from "./chat-presence.js";

const DATABASE_VERSION = 1;
const EVENTS = "events";
const IDS = "ids";
const OUTBOX = "outbox";
const META = "meta";
const STATE_KEY = "state";

export const chatLogDatabaseName = (householdId) => `kin-chat-log:${householdId}`;

export class ChatLogError extends Error {
  constructor(message, code = "chat_log_unavailable") {
    super(message);
    this.name = "ChatLogError";
    this.code = code;
  }
}

const unavailable = (cause) => {
  const error = new ChatLogError("Kin couldn't use this device's chat storage.");
  error.cause = cause;
  return error;
};

const settle = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(unavailable(request.error));
});

/** Runs `work(stores)` in one transaction and resolves with its result once
 * the transaction commits. `work` may return a promise of requests settled
 * inside the transaction; a thrown error aborts it. */
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

/** Refused relay events remembered for the view to report. */
const MAX_REFUSED = 100;

const freshState = () => ({ key: STATE_KEY, nextOrder: 1, cursor: "", deviceSequence: 0, provisional: true, admins: [], members: [], membersSignature: null, retiredThrough: 0, refused: [], hidden: [], hiddenRevision: 0, hiddenDirty: false, hiddenSealedFor: [] });

export class ChatLogStore {
  /** Opens (creating if needed) a household's chat log database. */
  static async open(householdId, { indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange } = {}) {
    if (typeof householdId !== "string" || !/^[a-f0-9]{32}$/.test(householdId)) throw unavailable();
    if (!indexedDB || !keyRange) throw unavailable();
    const request = indexedDB.open(chatLogDatabaseName(householdId), DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EVENTS)) db.createObjectStore(EVENTS, { keyPath: "order" });
      if (!db.objectStoreNames.contains(IDS)) db.createObjectStore(IDS, { keyPath: "eventId" });
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: "deviceSequence" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
    };
    const db = await settle(request);
    // Another tab deleting the database (the household leaving this device):
    // let it, rather than hold it open and block it.
    db.onversionchange = () => db.close();
    return new ChatLogStore(db, { householdId, keyRange });
  }

  constructor(db, { householdId, keyRange }) {
    this.db = db;
    this.householdId = householdId;
    this.keyRange = keyRange;
  }

  async state() {
    return transact(this.db, [META], "readonly", async ({ meta }) =>
      (await settle(meta.get(STATE_KEY))) ?? freshState());
  }

  /** Up to `limit` events stored at or after `fromOrder`, in stored order
   * (all of them when `limit` is 0). */
  async eventsFrom(fromOrder = 1, limit = 0) {
    return transact(this.db, [EVENTS], "readonly", ({ events }) =>
      settle(events.getAll(this.keyRange.lowerBound(fromOrder), limit || undefined)));
  }

  /** One stored event by its event ID, or null. */
  async eventById(eventId) {
    return transact(this.db, [EVENTS, IDS], "readonly", async ({ events, ids }) => {
      const id = await settle(ids.get(eventId));
      return id ? (await settle(events.get(id.order))) ?? null : null;
    });
  }

  /** This device's events the relay hasn't accepted, in sequence order. */
  async outbox() {
    return transact(this.db, [OUTBOX], "readonly", ({ outbox }) => settle(outbox.getAll()));
  }

  /**
   * Stores events the relay sent (already authenticated) and the cursor
   * they were read up to. Events already stored are skipped. Resolves with
   * how many were new.
   */
  async addReceived(envelopes, cursor, { refused = [] } = {}) {
    if (typeof cursor !== "string") throw unavailable();
    return transact(this.db, [EVENTS, IDS, META], "readwrite", async ({ events, ids, meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      if (refused.length) state.refused = [...(state.refused ?? []), ...refused].slice(-MAX_REFUSED);
      let added = 0;
      for (const envelope of envelopes) {
        const known = await settle(ids.get(envelope.eventId));
        if (known) {
          // The relay's signed copy of an event read from an export takes
          // its place (#136), so it is authenticated and readable by keys.
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

  /**
   * Stores events read from an archive (#136). Unlike a relay event these
   * have no envelope: `entries` are `{ eventId, sealed }`, the canonical
   * event sealed by the local vault (chat-archive.js). An event already stored
   * from the relay is kept as it is. One this import stored earlier is
   * replaced in place, so a restore after the vault's root changed (when the
   * earlier rows can no longer be opened) puts them right. `hidden` are the
   * messages the restored member hid for themselves. Resolves with how many
   * rows are new.
   */
  async importEvents(entries, { hidden = [] } = {}) {
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
      if (hidden.length) {
        state.hidden = [...new Set([...(state.hidden ?? []), ...hidden])].sort().slice(0, 10_000);
        state.hiddenDirty = true;
      }
      await settle(meta.put(state));
      return added;
    });
  }

  /**
   * Stores an event this device just made, with its outbox entry. Its
   * sequence must follow the last one this device used, so two tabs sending
   * at once can't both take the same one; the loser retries.
   */
  async addLocal(envelope, { blobRef = null, retireRef = null, retireParts = [], messageId = null } = {}) {
    return transact(this.db, [EVENTS, IDS, OUTBOX, META], "readwrite", async ({ events, ids, outbox, meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      if (envelope.deviceSequence !== state.deviceSequence + 1)
        throw new ChatLogError("Another tab sent a message at the same moment. Try again.", "chat_sequence_taken");
      if (await settle(ids.get(envelope.eventId)))
        throw new ChatLogError("Kin found a conflicting chat event identifier.", "chat_event_conflict");
      const order = state.nextOrder++;
      events.put({ order, eventId: envelope.eventId, envelope });
      ids.put({ eventId: envelope.eventId, order });
      outbox.put({ deviceSequence: envelope.deviceSequence, eventId: envelope.eventId, blobRef, retireRef, retireParts, messageId });
      state.deviceSequence = envelope.deviceSequence;
      await settle(meta.put(state));
      return order;
    });
  }

  /**
   * Replaces pending events' envelopes after renumbering or resealing them
   * (chat-room.js), and records the relay's sequence as settled. Each entry
   * is { order, previousSequence, envelope, blobRef, retireRef, retireParts }. Only events still in
   * the outbox may be replaced: the relay has never accepted them.
   */
  async replacePending(entries, { expectedDeviceSequence, deviceSequence, provisional = false }) {
    return transact(this.db, [EVENTS, OUTBOX, META], "readwrite", async ({ events, outbox, meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      // A message stored meanwhile (a tab without Web Locks) took a sequence
      // this renumbering didn't account for.
      if (state.deviceSequence !== expectedDeviceSequence)
        throw new ChatLogError("Chat changed meanwhile; retry.", "chat_outbox_changed");
      for (const { previousSequence } of entries)
        if (!(await settle(outbox.get(previousSequence))))
          throw new ChatLogError("Chat changed meanwhile; retry.", "chat_outbox_changed");
      for (const { previousSequence } of entries) outbox.delete(previousSequence);
      for (const { order, envelope, blobRef, retireRef, retireParts = [], messageId = null } of entries) {
        events.put({ order, eventId: envelope.eventId, envelope });
        outbox.put({ deviceSequence: envelope.deviceSequence, eventId: envelope.eventId, blobRef, retireRef, retireParts, messageId });
      }
      state.deviceSequence = deviceSequence;
      state.provisional = provisional;
      await settle(meta.put(state));
    });
  }

  /** Settles the sequence with the relay's when nothing is pending. */
  async settleSequence(deviceSequence) {
    return transact(this.db, [META], "readwrite", async ({ meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      state.deviceSequence = Math.max(state.deviceSequence, deviceSequence);
      state.provisional = false;
      await settle(meta.put(state));
    });
  }

  /** Records the household admins and members last known (from the
   * verified device directory), so admin removals and author labels show
   * while offline. */
  async saveDirectory({ admins, members, membersSignature = null, readers = null }) {
    return transact(this.db, [META], "readwrite", async ({ meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      state.admins = [...admins];
      state.members = members.map(({ id, kind, active }) => ({ id, kind, active }));
      state.membersSignature = membersSignature;
      if (readers) state.readers = [...readers];
      await settle(meta.put(state));
    });
  }

  /** Records the chat access level the service last gave this member
   * (#123), so a read-only member never sees a composer while offline. */
  async saveAccess(access) {
    return transact(this.db, [META], "readwrite", async ({ meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      state.access = ["write", "read", "none"].includes(access) ? access : "write";
      await settle(meta.put(state));
    });
  }

  /** Records that every blob retired by the first `count` events was
   * deleted on this device, so reopening doesn't delete them again. */
  async saveRetiredThrough(count) {
    return transact(this.db, [META], "readwrite", async ({ meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      state.retiredThrough = count;
      await settle(meta.put(state));
    });
  }

  /** This device's read cursor and receipt and typing settings (#121). */
  async presence() {
    return transact(this.db, [META], "readonly", async ({ meta }) =>
      ((await settle(meta.get(STATE_KEY))) ?? freshState()).presence ?? null);
  }

  async savePresence(presence) {
    return transact(this.db, [META], "readwrite", async ({ meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      state.presence = presence;
      await settle(meta.put(state));
    });
  }

  /** Hides messages here ("delete for me", #119), to be written to the
   * member's record on the next pass. */
  async addHidden(ids) {
    return transact(this.db, [META], "readwrite", async ({ meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      state.hidden = [...new Set([...(state.hidden ?? []), ...ids])].sort();
      state.hiddenDirty = true;
      await settle(meta.put(state));
      return state.hidden;
    });
  }

  /** Moves this member's private read position forward (#133), to be written
   * to the member's record on the next pass. Returns the position held. */
  async markReadPosition(cursor) {
    return transact(this.db, [META], "readwrite", async ({ meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      if (compareCursors(cursor, state.read ?? null) > 0) {
        state.read = { postedAt: cursor.postedAt, messageId: cursor.messageId };
        state.hiddenDirty = true;
        await settle(meta.put(state));
      }
      return state.read ?? null;
    });
  }

  /**
   * After a pass read (and maybe wrote) the member's record at `revision`:
   * keeps `ids` plus anything hidden here meanwhile (hiding only adds, so a
   * union never undoes one), minus `dropped` (messages since deleted for
   * everyone). Still due for writing when something hidden here isn't in
   * `ids` (or `dirty` says so).
   */
  async settleHidden({ ids, revision, dirty = false, dropped = [], sealedFor = null, read = null }) {
    return transact(this.db, [META], "readwrite", async ({ meta }) => {
      const state = (await settle(meta.get(STATE_KEY))) ?? freshState();
      const gone = new Set(dropped);
      const written = new Set(ids);
      const merged = [...new Set([...(state.hidden ?? []), ...ids])].filter((id) => !gone.has(id)).sort();
      state.hidden = merged;
      state.hiddenRevision = revision;
      // The read position only moves forward; one read here since the record
      // was built is still due for writing.
      state.read = mergeCursors(state.read ?? null, read);
      state.hiddenDirty = dirty || merged.some((id) => !written.has(id)) || compareCursors(state.read, read) > 0;
      if (sealedFor) state.hiddenSealedFor = sealedFor;
      await settle(meta.put(state));
      return { ids: state.hidden, revision, dirty: state.hiddenDirty, read: state.read ?? null };
    });
  }

  /** Drops outbox entries the relay accepted, by device sequence. */
  async markSent(deviceSequences) {
    if (!deviceSequences.length) return;
    return transact(this.db, [OUTBOX], "readwrite", ({ outbox }) => {
      for (const sequence of deviceSequences) outbox.delete(sequence);
    });
  }

  close() {
    this.db.close();
  }
}
