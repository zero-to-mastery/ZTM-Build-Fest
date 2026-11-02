// A member's private blobs on this device (#502, ADR 0019): journal photos
// and their thumbnails, sealed here, kept here, and stored on the service in
// the member's own blob store (/api/private/blobs).
//
// Sealing. Each blob is encrypted with a fresh random 32-byte AES-GCM key.
// The key travels only inside the journal record that names the blob, and
// that record is sealed under the member key (private-envelope.js), so only
// the member's own devices can ever open a photo. Format 1: version byte 1,
// a 12-byte random nonce, then the ciphertext with its 16-byte tag. The
// additional data binds the format, the household and the member, so a
// blob can't be passed off as another member's or as a chat blob. A key
// seals exactly one blob, so a random nonce is never reused under a key.
// The blob's reference is the SHA-256 of its sealed bytes.
//
// Keeping. One IndexedDB database per member and household,
// "kin-private-blobs:<householdId>:<memberId>", version 1:
//   blobs   { ref, ciphertext, storedAt, pending }  sealed bytes; pending
//                                   until the service has them
//   retire  { ref, queuedAt }       blobs no longer needed, to delete on the
//                                   service on the next pass
// Ciphertext only: without the journal record nothing here can be opened.
// Removing the household from the device deletes the database.
//
// Sending. A sealed blob is kept as pending and uploaded on the next private
// pass (the journal saves first and works offline). Opening a blob uses the
// local copy, else fetches it, checks it against its reference and keeps it.
// Deleting (a photo removed, once its Undo has passed) drops the local copy
// and queues the reference; the next pass asks the service to delete it.

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const MIN_PRIVATE_BLOB_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
export const MAX_PRIVATE_BLOB_BYTES = 4 * 1024 * 1024 + 4096;
/** Most references one retire request names (the service's bound). */
export const MAX_PRIVATE_RETIRE_REFS = 64;
const DATABASE_VERSION = 1;
const BLOBS = "blobs";
const RETIRE = "retire";
const ID = /^[a-f0-9]{32}$/;

export const privateBlobDatabaseName = (householdId, memberId) => `kin-private-blobs:${householdId}:${memberId}`;

export class PrivateBlobError extends Error {
  constructor(message, code = "private_blob_invalid") {
    super(message);
    this.name = "PrivateBlobError";
    this.code = code;
  }
}

const unopenable = () => new PrivateBlobError("This photo couldn't be opened.");
export const isRef = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isKey = isRef;

function toHex(bytes) {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function fromHex(hex) {
  return Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
}

function additionalData(householdId, memberId) {
  return new TextEncoder().encode(`kin-private-blob\0${VERSION}\0${householdId}\0${memberId}`);
}

async function importKey(raw, usage) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32 || raw.every((byte) => byte === 0)) throw unopenable();
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

/** The hex SHA-256 of sealed bytes: their reference. */
export async function blobRef(ciphertext) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext)));
}

/**
 * Seals `plaintext` under a new key for one member. Returns { ref, key,
 * ciphertext }: `ref` and `key` (64 hex digits each) go in the journal
 * record, `ciphertext` is kept and uploaded. The plaintext is not modified.
 */
export async function sealPrivateBlob(plaintext, { householdId, memberId }) {
  if (!ID.test(householdId ?? "") || !ID.test(memberId ?? "")) throw new PrivateBlobError("Private storage needs this device's household and member.");
  if (!(plaintext instanceof Uint8Array) || plaintext.length < 1 || plaintext.length > MAX_PRIVATE_BLOB_BYTES - MIN_PRIVATE_BLOB_BYTES)
    throw new PrivateBlobError("That photo is too large to keep.", "private_blob_too_large");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  try {
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: additionalData(householdId, memberId), tagLength: TAG_BYTES * 8 },
      await importKey(key, "encrypt"),
      plaintext,
    ));
    const ciphertext = new Uint8Array(1 + NONCE_BYTES + sealed.length);
    ciphertext[0] = VERSION;
    ciphertext.set(nonce, 1);
    ciphertext.set(sealed, 1 + NONCE_BYTES);
    return { ref: await blobRef(ciphertext), key: toHex(key), ciphertext };
  } finally {
    key.fill(0);
  }
}

/** Opens a sealed blob after checking it is the one `ref` names. */
export async function openPrivateBlob(ciphertext, { ref, key, householdId, memberId }) {
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length < MIN_PRIVATE_BLOB_BYTES ||
    ciphertext.length > MAX_PRIVATE_BLOB_BYTES || ciphertext[0] !== VERSION || !isRef(ref) || !isKey(key))
    throw unopenable();
  if (await blobRef(ciphertext) !== ref) throw unopenable();
  const raw = fromHex(key);
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ciphertext.subarray(1, 1 + NONCE_BYTES), additionalData: additionalData(householdId, memberId), tagLength: TAG_BYTES * 8 },
      await importKey(raw, "decrypt"),
      ciphertext.subarray(1 + NONCE_BYTES),
    ));
  } catch {
    throw unopenable();
  } finally {
    raw.fill(0);
  }
}

const storageUnavailable = (cause) => {
  const error = new PrivateBlobError("Kin couldn't use this device's storage for your journal photos.", "private_storage_unavailable");
  error.cause = cause;
  return error;
};

const settle = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(storageUnavailable(request.error));
});

const done = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(storageUnavailable(transaction.error));
  transaction.onabort = () => reject(storageUnavailable(transaction.error));
});

/** This device's sealed private blobs for one member (see the module doc). */
export class PrivateBlobStore {
  static async open(householdId, memberId, { indexedDB = globalThis.indexedDB, now = () => Date.now() } = {}) {
    if (!ID.test(householdId ?? "") || !ID.test(memberId ?? "") || !indexedDB) throw storageUnavailable();
    const request = indexedDB.open(privateBlobDatabaseName(householdId, memberId), DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: "ref" });
      if (!db.objectStoreNames.contains(RETIRE)) db.createObjectStore(RETIRE, { keyPath: "ref" });
    };
    const db = await settle(request);
    db.onversionchange = () => db.close();
    return new PrivateBlobStore(db, { now });
  }

  constructor(db, { now }) {
    this.db = db;
    this.now = now;
  }

  async get(ref) {
    if (!isRef(ref)) return null;
    const row = await settle(this.db.transaction([BLOBS], "readonly").objectStore(BLOBS).get(ref));
    return row ? new Uint8Array(row.ciphertext) : null;
  }

  /** Keeps a sealed blob; `pending` until the service has it. A blob queued
   * for deletion is taken off the queue (it is wanted again). */
  async put(ref, ciphertext, { pending = false } = {}) {
    if (!isRef(ref) || !(ciphertext instanceof Uint8Array)) throw storageUnavailable();
    const transaction = this.db.transaction([BLOBS, RETIRE], "readwrite");
    const finished = done(transaction);
    transaction.objectStore(BLOBS).put({ ref, ciphertext: ciphertext.slice(), storedAt: this.now(), pending });
    transaction.objectStore(RETIRE).delete(ref);
    await finished;
  }

  /** Every kept blob, `[{ ref, ciphertext, storedAt }]` (the member's own
   * export, #494). */
  async entries() {
    const rows = await settle(this.db.transaction([BLOBS], "readonly").objectStore(BLOBS).getAll());
    return rows.filter((row) => isRef(row.ref) && row.ciphertext).map((row) => ({ ref: row.ref, ciphertext: new Uint8Array(row.ciphertext), storedAt: row.storedAt ?? 0 }));
  }

  /** References still waiting to upload. */
  async pending() {
    const rows = await settle(this.db.transaction([BLOBS], "readonly").objectStore(BLOBS).getAll());
    return rows.filter((row) => row.pending).map((row) => row.ref);
  }

  async markUploaded(ref) {
    const transaction = this.db.transaction([BLOBS], "readwrite");
    const finished = done(transaction);
    const store = transaction.objectStore(BLOBS);
    const request = store.get(ref);
    request.onsuccess = () => { if (request.result) store.put({ ...request.result, pending: false }); };
    await finished;
  }

  /** Drops local copies and queues the references for deletion on the
   * service, in one transaction. */
  async discard(refs) {
    const valid = [...new Set(refs)].filter(isRef);
    if (!valid.length) return 0;
    const transaction = this.db.transaction([BLOBS, RETIRE], "readwrite");
    const finished = done(transaction);
    for (const ref of valid) {
      transaction.objectStore(BLOBS).delete(ref);
      transaction.objectStore(RETIRE).put({ ref, queuedAt: this.now() });
    }
    await finished;
    return valid.length;
  }

  async retireQueue() {
    return (await settle(this.db.transaction([RETIRE], "readonly").objectStore(RETIRE).getAllKeys())).filter(isRef);
  }

  async retired(refs) {
    const transaction = this.db.transaction([RETIRE], "readwrite");
    const finished = done(transaction);
    for (const ref of refs) transaction.objectStore(RETIRE).delete(ref);
    await finished;
  }

  /** Drops cached copies the journal no longer names (never a pending one:
   * it may belong to an entry not saved yet). Nothing is queued: another
   * device may still be uploading what it names. Returns how many. */
  async prune(keep) {
    const transaction = this.db.transaction([BLOBS], "readwrite");
    const finished = done(transaction);
    const store = transaction.objectStore(BLOBS);
    let dropped = 0;
    const request = store.getAll();
    request.onsuccess = () => {
      for (const row of request.result) {
        if (!row.pending && !keep.has(row.ref)) { store.delete(row.ref); dropped += 1; }
      }
    };
    await finished;
    return dropped;
  }

  close() {
    this.db.close();
  }
}

/** The service's private blob routes. Ciphertext only. */
export class PrivateBlobClient {
  constructor({ fetch: fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    this.fetch = fetchImpl;
  }

  async call(path, init, fallback) {
    let response;
    try {
      response = await this.fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
    } catch (cause) {
      const error = new PrivateBlobError("Your journal couldn't reach the household service.", "connection_unavailable");
      error.cause = cause;
      throw error;
    }
    if (response.ok || response.status === 404) return response;
    const value = await response.json().catch(() => ({}));
    throw new PrivateBlobError(value.message || fallback, value.error || "private_blob_unavailable");
  }

  async upload(ref, ciphertext) {
    const response = await this.call(`/api/private/blobs/${ref}`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: ciphertext,
    }, "Your journal couldn't send that photo.");
    if (response.status === 404) throw new PrivateBlobError("Your journal couldn't send that photo.", "private_blob_unavailable");
    return response.json();
  }

  /** `{ ciphertext }`, or `{ missing: true }` when the member's other
   * device hasn't uploaded it yet. */
  async download(ref) {
    const response = await this.call(`/api/private/blobs/${ref}`, { method: "GET" }, "Your journal couldn't load that photo.");
    if (response.status === 404) return { missing: true };
    return { ciphertext: new Uint8Array(await response.arrayBuffer()) };
  }

  async retire(refs) {
    let retired = 0;
    for (let index = 0; index < refs.length; index += MAX_PRIVATE_RETIRE_REFS) {
      const response = await this.call("/api/private/blobs/retire", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refs: refs.slice(index, index + MAX_PRIVATE_RETIRE_REFS) }),
      }, "Your journal couldn't delete that photo.");
      retired += (await response.json()).retired ?? 0;
    }
    return retired;
  }
}

/** Sealing, keeping, sending and opening one member's private blobs. */
export class PrivateBlobs {
  constructor({ store, client = new PrivateBlobClient(), householdId, memberId }) {
    Object.assign(this, { store, client, householdId, memberId });
    this.syncing = null;
  }

  /** Seals and keeps bytes; returns { ref, key, size } for a journal record. */
  async seal(bytes) {
    const { ref, key, ciphertext } = await sealPrivateBlob(bytes, { householdId: this.householdId, memberId: this.memberId });
    await this.store.put(ref, ciphertext, { pending: true });
    return { ref, key, size: ciphertext.length };
  }

  /** `{ bytes }`, or `{ pending: true }` while the member's other device
   * hasn't uploaded it. */
  async open({ ref, key }) {
    let ciphertext = await this.store.get(ref);
    if (!ciphertext) {
      const fetched = await this.client.download(ref);
      if (fetched.missing) return { pending: true };
      ciphertext = fetched.ciphertext;
      const bytes = await openPrivateBlob(ciphertext, { ref, key, householdId: this.householdId, memberId: this.memberId });
      await this.store.put(ref, ciphertext);
      return { bytes };
    }
    return { bytes: await openPrivateBlob(ciphertext, { ref, key, householdId: this.householdId, memberId: this.memberId }) };
  }

  /** Blobs no longer needed: gone here now, on the service next pass. */
  discard(refs) {
    return this.store.discard(refs);
  }

  /** One pass: upload what's pending, then delete what's queued. Calls run
   * one at a time. */
  sync() {
    this.syncing ??= (async () => {
      try {
        for (const ref of await this.store.pending()) {
          const ciphertext = await this.store.get(ref);
          if (!ciphertext) continue;
          await this.client.upload(ref, ciphertext);
          await this.store.markUploaded(ref);
        }
        const queue = await this.store.retireQueue();
        if (queue.length) {
          await this.client.retire(queue);
          await this.store.retired(queue);
        }
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  close() {
    this.store.close();
  }
}
