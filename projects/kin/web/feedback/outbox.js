// The report outbox (#632, #628): a report or suggestion the person pressed
// Send on, kept on this device until the service has it. It is sent again
// when the device is online, after an unlock, and when "What I've sent"
// opens. Nothing goes in without Send, and nothing is sent that wasn't put
// in by Send.
//
// Where it lives: its own IndexedDB database, `kin-feedback-outbox`, apart
// from the household's encrypted stores, because a report can be written on
// the lock screen or during setup, when no household key is open. What it
// holds is what the person chose to send (their typed text, the diagnostics
// they kept and, if they chose it, a screenshot), unencrypted on this device
// until it is sent or they remove it from "What I've sent"; "Start over on
// this browser" deletes it with every other Kin database. At most
// MAX_OUTBOX reports wait at once.
//
// An item is { reference, kind, signed, memberId, body, title, createdAt,
// attempts, lastStatus, lastMessage }. A signed item goes out only while the same member
// is signed in on this device; one written without signing in goes to the
// anonymous route.

export const MAX_OUTBOX = 10;
const DATABASE = "kin-feedback-outbox";
const STORE = "reports";

/** Kept in memory: for tests, and where IndexedDB is unavailable. */
export function memoryOutboxStorage() {
  const items = new Map();
  return {
    async all() { return [...items.values()].map((item) => structuredClone(item)); },
    async put(item) { items.set(item.reference, structuredClone(item)); },
    async delete(reference) { items.delete(reference); },
  };
}

/** The IndexedDB storage, opened on first use. */
export function indexedDbOutboxStorage(indexedDB = globalThis.indexedDB) {
  let opening = null;
  const open = () => (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "reference" });
    request.onsuccess = () => {
      const database = request.result;
      // Another tab's "Start over" deletes it: let go, and open afresh next time.
      database.onversionchange = () => { database.close(); opening = null; };
      resolve(database);
    };
    request.onerror = () => { opening = null; reject(request.error); };
    request.onblocked = () => { opening = null; reject(new Error("The report outbox is busy in another tab.")); };
  }));
  const run = async (mode, operation) => {
    const database = await open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const result = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(result.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    all: () => run("readonly", (store) => store.getAll()),
    put: (item) => run("readwrite", (store) => store.put(item)),
    delete: (reference) => run("readwrite", (store) => store.delete(reference)),
  };
}

export class OutboxFullError extends Error {
  constructor() {
    super(`${MAX_OUTBOX} reports are already waiting to be sent. Send or remove some in What I've sent first.`);
    this.name = "OutboxFullError";
  }
}

/** HTTP statuses after which an item is not tried again by itself. */
const FINAL = new Set([400, 403, 409, 413]);

export class FeedbackOutbox {
  /**
   * `storage` holds the items; `send(item)` delivers one and resolves
   * `{ status }` (the HTTP status), or rejects when the network failed.
   */
  constructor({ storage = memoryOutboxStorage(), send, now = () => Date.now() } = {}) {
    this.storage = storage;
    this.send = send;
    this.now = now;
    this.flushing = null;
    this.listeners = new Set();
  }

  async list() {
    const items = await this.storage.all();
    return items.sort((left, right) => left.createdAt - right.createdAt);
  }

  /** Keeps an item to send; refuses past MAX_OUTBOX. */
  async add(item) {
    const items = await this.storage.all();
    if (!items.some((entry) => entry.reference === item.reference) && items.length >= MAX_OUTBOX) throw new OutboxFullError();
    await this.storage.put({ attempts: 0, lastStatus: null, createdAt: this.now(), ...item });
    this.changed();
  }

  async remove(reference) {
    await this.storage.delete(reference);
    this.changed();
  }

  /**
   * Sends what can go now. `identity` is the signed-in member on this
   * device ({ memberId }) or null; signed items wait for their own member.
   * Resolves [{ reference, outcome }] with outcome "sent", "waiting" or
   * "refused". One flush at a time.
   */
  flush({ identity = null, online = globalThis.navigator?.onLine !== false } = {}) {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushItems({ identity, online }).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async flushItems({ identity, online }) {
    const results = [];
    if (!online) return results;
    for (const item of await this.list()) {
      if (item.signed && item.memberId !== identity?.memberId) { results.push({ reference: item.reference, outcome: "waiting" }); continue; }
      if (FINAL.has(item.lastStatus)) { results.push({ reference: item.reference, outcome: "refused" }); continue; }
      let status;
      let value;
      try {
        ({ status, value } = await this.send(item));
      } catch {
        // Offline or unreachable: it stays, untouched, for next time.
        results.push({ reference: item.reference, outcome: "waiting" });
        break;
      }
      if (status === 200 || status === 201) {
        await this.storage.delete(item.reference);
        results.push({ reference: item.reference, outcome: "sent" });
        continue;
      }
      // The service's own sentence about why, to show in What I've sent.
      const lastMessage = typeof value?.message === "string" ? value.message.slice(0, 300) : null;
      await this.storage.put({ ...item, attempts: item.attempts + 1, lastStatus: status, lastMessage });
      results.push({ reference: item.reference, outcome: FINAL.has(status) ? "refused" : "waiting" });
      // Rate limited or signed out: the rest would be answered the same way.
      if (status === 429 || status === 401) break;
    }
    if (results.length) this.changed();
    return results;
  }

  /** Calls `listener()` after any change; returns an unsubscribe. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* a listener's trouble isn't the outbox's */ }
    }
  }
}
