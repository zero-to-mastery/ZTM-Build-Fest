// This device's family-album photos (#673, ADR 0022 §5): the encrypted image
// blobs, kept apart from the household event store, whose attachment table
// is frozen at 64 records and 50 MiB (V1.0-COMPATIBILITY) and travels in
// household exports.
//
// One IndexedDB database per household on this device
// ("kin-album:<local household id>"), so "Start over on this browser"
// (security/start-over.js, every "kin-" database) removes it too. It holds
//   photos { attachmentId, ciphertext, sealed, keyEpoch, digest, state, storedAt }
// - `ciphertext`: the household-key AES-GCM blob exactly as it is uploaded
//   (attachments/attachment-crypto.js), with its key epoch and SHA-256;
// - `sealed`: before this device has a household key (a household that
//   doesn't sync yet), the image sealed under this device's vault instead,
//   as attachment-lifecycle.js does for an item's photo;
// - `state`: "local" (saved, its event not yet committed), "queued" (waiting
//   to upload), "synced" (on the service, or downloaded from it) or
//   "failed".
// Nothing here is readable without the household key or the unlocked vault.
// A photo another device added is downloaded the first time it is shown and
// kept here, so the frame doesn't fetch it again.

const DATABASE_VERSION = 1;
const PHOTOS = "photos";
const ID = /^[a-f0-9]{32}$/;
const STATES = new Set(["local", "queued", "synced", "failed"]);

export const albumDatabaseName = (householdId) => `kin-album:${householdId}`;

export class AlbumStoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "AlbumStoreError";
    this.userMessage = message;
  }
}

const unavailable = (cause) => new AlbumStoreError("Kin couldn't use this device's storage for family photos.", cause);

const settle = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(unavailable(request.error));
});

const done = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(unavailable(transaction.error));
  transaction.onabort = () => reject(unavailable(transaction.error));
});

function validRow(row) {
  if (!row || !ID.test(row.attachmentId ?? "") || !STATES.has(row.state)) return false;
  if (row.ciphertext) return row.ciphertext instanceof Uint8Array && Number.isSafeInteger(row.keyEpoch) && /^[a-f0-9]{64}$/.test(row.digest ?? "");
  return Boolean(row.sealed) && row.keyEpoch === null && row.digest === null;
}

export class AlbumBlobStore {
  /** Opens (creating if needed) a household's album database. */
  static async open(householdId, { indexedDB = globalThis.indexedDB, now = () => Date.now() } = {}) {
    if (typeof householdId !== "string" || !ID.test(householdId) || !indexedDB) throw unavailable();
    const request = indexedDB.open(albumDatabaseName(householdId), DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PHOTOS)) db.createObjectStore(PHOTOS, { keyPath: "attachmentId" });
    };
    const db = await settle(request);
    // Another tab deleting the database: let it.
    db.onversionchange = () => db.close();
    return new AlbumBlobStore(db, { now });
  }

  constructor(db, { now }) {
    this.db = db;
    this.now = now;
  }

  /** One photo's row, or null. */
  async get(attachmentId) {
    if (!ID.test(attachmentId ?? "")) return null;
    const transaction = this.db.transaction([PHOTOS], "readonly");
    const row = await settle(transaction.objectStore(PHOTOS).get(attachmentId));
    return validRow(row) ? { ...row, ciphertext: row.ciphertext ? new Uint8Array(row.ciphertext) : null } : null;
  }

  /** What this device holds, without the bytes: [{ attachmentId, state,
   * storedAt, sealed: boolean }]. Reads one row at a time. */
  async inventory() {
    const transaction = this.db.transaction([PHOTOS], "readonly");
    const store = transaction.objectStore(PHOTOS);
    const ids = await settle(store.getAllKeys());
    const rows = [];
    for (const attachmentId of ids) {
      const row = await settle(store.get(attachmentId));
      if (validRow(row)) rows.push({ attachmentId, state: row.state, storedAt: row.storedAt ?? 0, sealed: !row.ciphertext });
    }
    return rows;
  }

  /** Keeps a photo's row. A row already kept with different ciphertext is a
   * conflict (two uploads under one ID never happen by chance). */
  async put({ attachmentId, ciphertext = null, sealed = null, keyEpoch = null, digest = null, state }) {
    const row = { attachmentId, ciphertext: ciphertext ? ciphertext.slice() : null, sealed, keyEpoch, digest, state, storedAt: this.now() };
    if (!validRow(row)) throw new AlbumStoreError("Kin couldn't keep this photo on this device.");
    const transaction = this.db.transaction([PHOTOS], "readwrite");
    const finished = done(transaction);
    transaction.objectStore(PHOTOS).put(row);
    await finished;
  }

  async setState(attachmentId, state) {
    if (!ID.test(attachmentId ?? "") || !STATES.has(state)) throw new AlbumStoreError("Kin couldn't update this photo.");
    const transaction = this.db.transaction([PHOTOS], "readwrite");
    const finished = done(transaction);
    const store = transaction.objectStore(PHOTOS);
    let row;
    try { row = await settle(store.get(attachmentId)); }
    catch (error) { await finished.catch(() => {}); throw error; }
    if (row) store.put({ ...row, state });
    await finished;
    return Boolean(row);
  }

  async delete(attachmentId) {
    if (!ID.test(attachmentId ?? "")) return;
    const transaction = this.db.transaction([PHOTOS], "readwrite");
    const finished = done(transaction);
    transaction.objectStore(PHOTOS).delete(attachmentId);
    await finished;
  }

  close() {
    this.db.close();
  }
}
