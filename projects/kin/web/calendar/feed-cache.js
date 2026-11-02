// This device's copy of the outside calendars it syncs (#668, ADR 0022 §3),
// so they show offline and right after unlocking.
//
// One IndexedDB database per household, "kin-calendar-feeds:<householdId>"
// version 1, apart from the frozen event and key databases, with one store:
//   feeds  { subscriptionId, sealed }
// `sealed` is the parsed feed sealed by the local vault (store
// "calendar-feed", the subscription ID as its context), like the other
// local encrypted records: { subscriptionId, fetchedAt (by the service),
// receivedAt (by this device), etag, source,
// audience, name, events (KICS events, kin-calendar.js decodeICalendar),
// skipped, truncated }. Nothing readable is kept: not the link (the device
// never has it unless it added it), not the titles.
//
// It is a cache, never a source of truth: a row that no longer opens (a
// recovery key replacement changed the local root) is dropped and fetched
// again. Turning a calendar off removes its row on every device the next
// time that device lists its calendars. These events never enter the
// household history.
export const FEED_CACHE_STORE = "calendar-feed";
const DATABASE_VERSION = 1;
const FEEDS = "feeds";
const ID = /^[a-f0-9]{32}$/;

export const feedCacheDatabaseName = (householdId) => `kin-calendar-feeds:${householdId}`;

const settle = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Kin couldn't use this device's calendar storage."));
});

/** The IndexedDB backend: get, put, delete and getAll on the feeds store. */
export async function openFeedDatabase(householdId, indexedDB = globalThis.indexedDB) {
  if (!ID.test(householdId ?? "") || !indexedDB) throw new Error("Kin couldn't use this device's calendar storage.");
  const request = indexedDB.open(feedCacheDatabaseName(householdId), DATABASE_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(FEEDS)) request.result.createObjectStore(FEEDS, { keyPath: "subscriptionId" });
  };
  const db = await settle(request);
  // Another tab deleting the database: let it.
  db.onversionchange = () => db.close();
  const run = (mode, operation) => {
    const transaction = db.transaction([FEEDS], mode);
    return settle(operation(transaction.objectStore(FEEDS)));
  };
  return {
    get: (id) => run("readonly", (store) => store.get(id)),
    getAll: () => run("readonly", (store) => store.getAll()),
    put: (row) => run("readwrite", (store) => store.put(row)),
    delete: (id) => run("readwrite", (store) => store.delete(id)),
    close: () => db.close(),
  };
}

/** A Map-backed backend, for tests and for a browser without IndexedDB. */
export function memoryFeedBackend() {
  const rows = new Map();
  return {
    rows,
    get: async (id) => structuredClone(rows.get(id)),
    getAll: async () => [...rows.values()].map((row) => structuredClone(row)),
    put: async (row) => { rows.set(row.subscriptionId, structuredClone(row)); },
    delete: async (id) => { rows.delete(id); },
    close: () => {},
  };
}

export class FeedCache {
  /** Opens a household's feed cache sealed by `vault`. Falls back to memory
   * when IndexedDB is unavailable (the feeds are fetched again next time). */
  static async open(householdId, { vault, indexedDB = globalThis.indexedDB } = {}) {
    let backend;
    try { backend = await openFeedDatabase(householdId, indexedDB); } catch { backend = memoryFeedBackend(); }
    return new FeedCache(backend, vault);
  }

  constructor(backend, vault) {
    this.backend = backend;
    this.vault = vault;
  }

  /** Every cached feed that still opens; rows that don't are dropped. */
  async readAll() {
    const out = [];
    for (const row of await this.backend.getAll()) {
      const value = await this.open(row);
      if (value) out.push(value);
    }
    return out;
  }

  async read(subscriptionId) {
    return this.open(await this.backend.get(subscriptionId));
  }

  async open(row) {
    if (!row || !ID.test(row.subscriptionId ?? "")) return null;
    try {
      const value = await this.vault.open(row.sealed, { store: FEED_CACHE_STORE, id: row.subscriptionId });
      if (value?.subscriptionId === row.subscriptionId) return value;
    } catch (error) {
      // Locked meanwhile: say so rather than drop a good row.
      if (error?.code === "locked" || this.vault.locked) throw error;
    }
    await this.backend.delete(row.subscriptionId).catch(() => {});
    return null;
  }

  async write(value) {
    if (!ID.test(value?.subscriptionId ?? "")) throw new Error("Kin received an invalid calendar.");
    const sealed = await this.vault.seal(value, { store: FEED_CACHE_STORE, id: value.subscriptionId });
    await this.backend.put({ subscriptionId: value.subscriptionId, sealed });
  }

  async remove(subscriptionId) {
    await this.backend.delete(subscriptionId);
  }

  close() {
    this.backend.close?.();
  }
}
