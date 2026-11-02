// This device's chat blobs (#110): sealed message content kept apart from
// the immutable event log, so deleting a message can delete its content.
//
// One IndexedDB database per household ("kin-chat-blobs:<householdId>"),
// separate from the event store, whose schema stays frozen. It holds:
//   blobs    { ref, ciphertext, storedAt, parts }  sealed bytes, by content
//                                           hash; parts: an attachment
//                                           manifest's part references (#114)
//   retired  { ref, retiredAt }             blobs this device deleted: never
//                                           stored or fetched again
// Blobs are ciphertext; their keys live only in the encrypted chat events,
// so this store holds nothing readable on its own. Removing the household
// from the device deletes the whole database.
import { ChatBlobError, isRef } from "./chat-blob-crypto.js";

const DATABASE_VERSION = 1;
const BLOBS = "blobs";
const RETIRED = "retired";

export const chatBlobDatabaseName = (householdId) => `kin-chat-blobs:${householdId}`;

const unavailable = (cause) => {
  const error = new ChatBlobError("Kin couldn't use this device's chat storage.", "chat_storage_unavailable");
  error.cause = cause;
  return error;
};

const settle = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(unavailable(request.error));
});

const done = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(unavailable(transaction.error));
  transaction.onabort = () => reject(unavailable(transaction.error));
});

export class ChatBlobStore {
  /** Opens (creating if needed) a household's chat blob database. */
  static async open(householdId, { indexedDB = globalThis.indexedDB, now = () => Date.now() } = {}) {
    if (typeof householdId !== "string" || !/^[a-f0-9]{32}$/.test(householdId)) throw unavailable();
    if (!indexedDB) throw unavailable();
    const request = indexedDB.open(chatBlobDatabaseName(householdId), DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: "ref" });
      if (!db.objectStoreNames.contains(RETIRED)) db.createObjectStore(RETIRED, { keyPath: "ref" });
    };
    const db = await settle(request);
    // Another tab deleting or upgrading the database: let it, rather than
    // hold it open and block it.
    db.onversionchange = () => db.close();
    return new ChatBlobStore(db, { householdId, indexedDB, now });
  }

  constructor(db, { householdId, indexedDB, now }) {
    this.db = db;
    this.householdId = householdId;
    this.indexedDB = indexedDB;
    this.now = now;
  }

  async get(ref) {
    if (!isRef(ref)) return null;
    const transaction = this.db.transaction([BLOBS], "readonly");
    const row = await settle(transaction.objectStore(BLOBS).get(ref));
    return row ? new Uint8Array(row.ciphertext) : null;
  }

  /** What this device holds, without keeping the bytes: for each blob its
   * reference, size, when it was stored and the parts a manifest names.
   * Reads one blob at a time, so memory stays at one blob (#136). */
  async inventory() {
    const transaction = this.db.transaction([BLOBS], "readonly");
    const store = transaction.objectStore(BLOBS);
    const refs = await settle(store.getAllKeys());
    const found = [];
    for (const ref of refs) {
      const row = await settle(store.get(ref));
      if (row) found.push({ ref, size: row.ciphertext.byteLength, storedAt: row.storedAt ?? 0, parts: Array.isArray(row.parts) ? [...row.parts] : null });
    }
    return found;
  }

  async isRetired(ref) {
    const transaction = this.db.transaction([RETIRED], "readonly");
    return Boolean(await settle(transaction.objectStore(RETIRED).get(ref)));
  }

  /** The references in `refs` this device hasn't deleted yet, in one read. */
  async unretired(refs) {
    const transaction = this.db.transaction([RETIRED], "readonly");
    const store = transaction.objectStore(RETIRED);
    const rows = await Promise.all(refs.map((ref) => settle(store.get(ref))));
    return refs.filter((_, index) => !rows[index]);
  }

  /** The parts an attachment's manifest names, by manifest reference (only
   * for blobs kept with them). */
  async partsOf(refs) {
    const found = new Map();
    const valid = refs.filter(isRef);
    if (!valid.length) return found;
    const transaction = this.db.transaction([BLOBS], "readonly");
    const store = transaction.objectStore(BLOBS);
    const rows = await Promise.all(valid.map((ref) => settle(store.get(ref))));
    rows.forEach((row, index) => { if (Array.isArray(row?.parts)) found.set(valid[index], row.parts); });
    return found;
  }

  /** Records the parts a kept manifest names (a manifest opened here). */
  async keepParts(ref, parts) {
    if (!isRef(ref)) throw unavailable();
    const transaction = this.db.transaction([BLOBS], "readwrite");
    const finished = done(transaction);
    const store = transaction.objectStore(BLOBS);
    const row = await settle(store.get(ref)).catch(async (error) => { await finished.catch(() => {}); throw error; });
    if (row) store.put({ ...row, parts: [...parts] });
    await finished;
  }

  /** Keeps a sealed blob, unless this device already deleted it. The
   * caller has checked it against its reference (openChatBlob does). `parts`
   * (an attachment manifest's blob references) is kept with it; without
   * it, a blob kept before keeps its parts. */
  async put(ref, ciphertext, { parts = null } = {}) {
    if (!isRef(ref) || !(ciphertext instanceof Uint8Array)) throw unavailable();
    const transaction = this.db.transaction([BLOBS, RETIRED], "readwrite");
    const finished = done(transaction);
    // If a read fails, `finished` rejects too; it is awaited (or its
    // rejection handled) on every path, so nothing goes unhandled.
    let retired, existing;
    try {
      [retired, existing] = await Promise.all([
        settle(transaction.objectStore(RETIRED).get(ref)),
        settle(transaction.objectStore(BLOBS).get(ref)),
      ]);
    } catch (error) {
      await finished.catch(() => {});
      throw error;
    }
    if (!retired) {
      transaction.objectStore(BLOBS).put({ ref, ciphertext: ciphertext.slice(), storedAt: this.now(), parts: parts ?? existing?.parts ?? null });
    }
    await finished;
    return !retired;
  }

  /**
   * Drops the bytes of blobs stored before `cutoff` (ms), except those in
   * `keep`, to bound what this device caches (#125). Unlike `retire`, this
   * deletes nothing for good: no tombstone is written, the message stays, and
   * opening it fetches the blob from the service again (and stores it
   * afresh). Returns how many were dropped.
   */
  async evictOlderThan(cutoff, { keep = new Set() } = {}) {
    if (!Number.isFinite(cutoff)) return 0;
    const transaction = this.db.transaction([BLOBS], "readwrite");
    const finished = done(transaction);
    const store = transaction.objectStore(BLOBS);
    let dropped = 0;
    try {
      const rows = await settle(store.getAll());
      for (const { ref, storedAt } of rows) {
        if (Number.isFinite(storedAt) && storedAt < cutoff && !keep.has(ref)) {
          store.delete(ref);
          dropped += 1;
        }
      }
    } catch (error) {
      await finished.catch(() => {});
      throw error;
    }
    await finished;
    return dropped;
  }

  /** Deletes blobs and remembers that they were deleted, in one transaction. */
  async retire(refs) {
    const valid = [...new Set(refs)].filter(isRef);
    if (!valid.length) return 0;
    const transaction = this.db.transaction([BLOBS, RETIRED], "readwrite");
    const finished = done(transaction);
    const blobs = transaction.objectStore(BLOBS), retired = transaction.objectStore(RETIRED);
    const at = this.now();
    for (const ref of valid) {
      blobs.delete(ref);
      retired.put({ ref, retiredAt: at });
    }
    await finished;
    return valid.length;
  }

  close() {
    this.db.close();
  }

  /** Removes the household's whole chat blob database from this device.
   * Other tabs close their connections when asked; one that doesn't (an
   * old version still open) blocks the deletion, which then fails rather
   * than wait forever. */
  async destroy() {
    this.close();
    const request = this.indexedDB.deleteDatabase(chatBlobDatabaseName(this.householdId));
    await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve();
      request.onerror = () => reject(unavailable(request.error));
      request.onblocked = () => {
        const error = new ChatBlobError("Close Kin in your other tabs to finish removing this household's chat from this device.", "chat_storage_blocked");
        reject(error);
      };
    });
  }
}
