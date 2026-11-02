// A small in-memory IndexedDB for Node tests of chat storage (not shipped).
// It models only what chat storage uses: open with an upgrade, object
// stores with a key path, get/getAll (in key order, from a lower
// bound, up to a count)/put/delete, transactions that stay active
// while microtasks run and commit once no request is pending, failing
// requests (`failNext`), and deleteDatabase, which asks open connections to
// close (versionchange) and is blocked by one that doesn't. Values are
// structured-cloned as a browser would.
// IndexedDB orders numbers before strings; within each, by value.
const compareKeys = (left, right) =>
  typeof left !== typeof right ? (typeof left === "number" ? -1 : 1) : left < right ? -1 : left > right ? 1 : 0;

class Request {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
  succeed(result) { this.result = result; queueMicrotask(() => this.onsuccess?.({ target: this })); }
}

class Transaction {
  constructor(db, names, mode) {
    this.db = db; this.names = names; this.mode = mode; this.pending = 0; this.finished = false;
    this.oncomplete = null; this.onerror = null; this.onabort = null;
    this.schedule();
  }
  schedule() {
    setImmediate(() => {
      if (this.finished || this.pending) return;
      this.finished = true;
      this.oncomplete?.();
    });
  }
  objectStore(name) {
    if (!this.names.includes(name)) throw new Error(`NotFoundError: ${name} is not in this transaction`);
    const rows = this.db.stores.get(name);
    const keyPath = this.db.keyPaths.get(name);
    const request = (work) => {
      if (this.finished) throw new Error("TransactionInactiveError");
      const result = new Request();
      this.pending += 1;
      if (this.db.factory.failNext) {
        // The request fails and the transaction aborts with it.
        this.db.factory.failNext = false;
        result.error = new Error("UnknownError");
        queueMicrotask(() => {
          this.pending -= 1;
          result.onerror?.({ target: result });
          this.finished = true;
          queueMicrotask(() => { this.error = result.error; this.onerror?.(); this.onabort?.(); });
        });
        return result;
      }
      const value = work();
      queueMicrotask(() => { this.pending -= 1; result.succeed(value); queueMicrotask(() => this.schedule()); });
      return result;
    };
    const write = (work) => {
      if (this.mode !== "readwrite") throw new Error("ReadOnlyError");
      return request(work);
    };
    return {
      get: (key) => request(() => (rows.has(key) ? structuredClone(rows.get(key)) : undefined)),
      getAll: (range, count) => request(() => [...rows.keys()]
        .filter((key) => range == null || compareKeys(key, range.lower) >= 0)
        .sort(compareKeys)
        .slice(0, count || undefined)
        .map((key) => structuredClone(rows.get(key)))),
      getAllKeys: () => request(() => [...rows.keys()].sort(compareKeys)),
      put: (value) => write(() => { rows.set(value[keyPath], structuredClone(value)); return value[keyPath]; }),
      delete: (key) => write(() => { rows.delete(key); }),
    };
  }
}

class Database {
  constructor(name, factory) { this.name = name; this.factory = factory; this.stores = new Map(); this.keyPaths = new Map(); this.closed = false; this.version = 0; this.onversionchange = null; }
  get objectStoreNames() { return { contains: (name) => this.stores.has(name) }; }
  createObjectStore(name, { keyPath }) { this.stores.set(name, new Map()); this.keyPaths.set(name, keyPath); }
  transaction(names, mode = "readonly") {
    if (this.closed) throw new Error("InvalidStateError");
    return new Transaction(this, [names].flat(), mode);
  }
  close() { this.closed = true; }
}

/** IDBKeyRange for the fake: only lowerBound (inclusive), which getAll takes. */
export const fakeKeyRange = { lowerBound: (lower) => ({ lower }) };

export function fakeIndexedDB() {
  const databases = new Map();
  // Every connection handed out, so a deletion can ask them to close.
  const connections = new Map();
  const factory = {
    databases,
    failNext: false,
    open(name, version) {
      const request = new Request();
      request.onupgradeneeded = null;
      setImmediate(() => {
        let db = databases.get(name);
        if (!db) { db = new Database(name, factory); databases.set(name, db); }
        // A connection object of its own, sharing the stored data.
        const connection = Object.create(db);
        connection.closed = false;
        connection.onversionchange = null;
        connection.close = () => { connection.closed = true; };
        if (!connections.has(name)) connections.set(name, []);
        connections.get(name).push(connection);
        request.result = connection;
        if (db.version < version) { db.version = version; request.onupgradeneeded?.({ target: request }); }
        request.succeed(connection);
      });
      return request;
    },
    deleteDatabase(name) {
      const request = new Request();
      request.onblocked = null;
      setImmediate(() => {
        const open = (connections.get(name) ?? []).filter((connection) => !connection.closed);
        for (const connection of open) connection.onversionchange?.({ oldVersion: connection.version, newVersion: null });
        if (open.some((connection) => !connection.closed)) {
          request.onblocked?.({ target: request });
          return;
        }
        databases.delete(name);
        connections.delete(name);
        request.succeed(undefined);
      });
      return request;
    },
  };
  return factory;
}
