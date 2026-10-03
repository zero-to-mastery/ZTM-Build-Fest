// Browser capability adapter: domain records are encrypted before native IDB
// commits. A native request keeps transactions active across Web Crypto awaits.
const FORMAT = 1;
export const PROTECTED_BATCH_SIZE = 32;
export const PROTECTED_PAGE_SIZE = 128;

export async function mapProtectedBatch(values, operation, check = () => {}) {
  const result = new Array(values.length);
  for (let offset = 0; offset < values.length; offset += PROTECTED_BATCH_SIZE) {
    await check();
    const batch = await Promise.all(values.slice(offset, offset + PROTECTED_BATCH_SIZE).map(operation));
    await check();
    for (let index = 0; index < batch.length; index += 1) result[offset + index] = batch[index];
  }
  return result;
}

export function recordIdentity(value) {
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number" && Number.isSafeInteger(value)) return `n:${value}`;
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return `b:${Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  throw new Error("Kin could not identify a protected storage record.");
}

function sameKey(left, right) {
  return recordIdentity(left) === recordIdentity(right);
}

export async function protectRecord(vault, store, definition, value) {
  vault.assertUnlocked();
  const id = recordIdentity(value[definition.keyPath]);
  const routing = { [definition.keyPath]: value[definition.keyPath] };
  for (const path of Object.values(definition.indexes ?? {})) routing[path] = value[path];
  const protectedValue = await vault.seal(value, { store, id });
  vault.assertUnlocked();
  return { ...routing, protected_version: FORMAT, protected_value: protectedValue };
}

export async function unprotectRecord(vault, store, definition, row) {
  if (row === undefined) return undefined;
  vault.assertUnlocked();
  if (!row || row.protected_version !== FORMAT || !row.protected_value)
    throw new Error("Kin found an unprotected or unsupported local record. The saved data was preserved.");
  const expected = [definition.keyPath, ...Object.values(definition.indexes ?? {}), "protected_version", "protected_value"];
  if (Object.keys(row).some((key) => !expected.includes(key)))
    throw new Error("Kin found unexpected plaintext fields in protected storage.");
  const id = recordIdentity(row[definition.keyPath]);
  const value = await vault.open(row.protected_value, { store, id });
  vault.assertUnlocked();
  for (const path of [definition.keyPath, ...Object.values(definition.indexes ?? {})])
    if (!sameKey(value[path], row[path]))
      throw new Error("Kin found inconsistent protected storage identifiers.");
  return value;
}

export async function protectRows(vault, definitions, rowsByStore, { check = async () => {} } = {}) {
  const result = {};
  const assertCurrent = async () => { vault.assertUnlocked(); await check(); vault.assertUnlocked(); };
  for (const [store, rows] of Object.entries(rowsByStore)) {
    if (!definitions[store]) throw new Error("Unknown protected store.");
    // Verify one bounded group and release its recovered plaintext before
    // advancing. The complete recovered graph is never retained alongside source.
    result[store] = await mapProtectedBatch(rows, async (value) => {
        const row = await protectRecord(vault, store, definitions[store], value);
        const recovered = await unprotectRecord(vault, store, definitions[store], row);
        if (!valuesEqual(value, recovered)) throw new Error("Protected migration verification failed.");
        return row;
      }, assertCurrent);
  }
  return result;
}

export function valuesEqual(left, right) {
  if (left === right) return true;
  if (left == null || right == null || typeof left !== typeof right) return false;
  if (typeof left !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (left instanceof ArrayBuffer || ArrayBuffer.isView(left)) {
    if (!(right instanceof ArrayBuffer || ArrayBuffer.isView(right))) return false;
    const a = left instanceof ArrayBuffer ? new Uint8Array(left) : new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const b = right instanceof ArrayBuffer ? new Uint8Array(right) : new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  }
  const a = Object.keys(left).sort(), b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index] && valuesEqual(left[key], right[key]));
}

export function snapshotStores(database, names) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(names, "readonly");
    const rows = {};
    for (const name of names) {
      const request = transaction.objectStore(name).getAll();
      request.onsuccess = () => { rows[name] = request.result; };
    }
    transaction.oncomplete = () => resolve(rows);
    transaction.onabort = () => reject(transaction.error ?? new Error("Storage snapshot failed."));
    transaction.onerror = () => {};
  });
}

// Compare against a frozen source inside the committing native transaction.
// Paging avoids allocating a second complete source snapshot merely to compare it.
export function compareStoreRows(transaction, name, expected, { check, complete, fail }) {
  const store = transaction.objectStore(name);
  let offset = 0;
  const read = (range) => {
    const request = store.getAll(range, PROTECTED_PAGE_SIZE);
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      try {
        check();
        const rows = request.result;
        for (const row of rows) {
          if (offset >= expected.length || !valuesEqual(row, expected[offset++]))
            throw new Error("Stored data changed before replacement. The saved source was preserved.");
        }
        if (rows.length < PROTECTED_PAGE_SIZE) {
          if (offset !== expected.length) throw new Error("Stored records changed before replacement.");
          complete();
        } else read(IDBKeyRange.lowerBound(rows.at(-1)[store.keyPath], true));
      } catch (error) { fail(error); }
    };
  };
  try { read(); } catch (error) { fail(error); }
}

export function replaceStores(database, rowsByStore, { metadata, guard, vault } = {}) {
  const names = Object.keys(rowsByStore);
  if (metadata && !names.includes(metadata.store)) names.push(metadata.store);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(names, "readwrite");
    const unsubscribe = vault?.onLock(() => {
      const error = new Error("Kin locked before the storage replacement completed.");
      error.code = "locked";
      transaction.__kinFailure ??= error;
      try { transaction.abort(); } catch { /* Already ending. */ }
    });
    transaction.oncomplete = () => { unsubscribe?.(); resolve(); };
    transaction.onabort = () => {
      unsubscribe?.();
      reject(transaction.__kinFailure ?? transaction.error ?? new Error("Storage replacement failed."));
    };
    transaction.onerror = () => {};
    try {
      vault?.assertUnlocked();
      guard?.();
      for (const [name, rows] of Object.entries(rowsByStore)) {
        const store = transaction.objectStore(name);
        store.clear();
        for (const row of rows) store.put(row);
      }
      if (metadata) transaction.objectStore(metadata.store).put(metadata.value);
    } catch (error) {
      transaction.__kinFailure ??= error;
      try { transaction.abort(); } catch { /* A lock may have already aborted it. */ }
    }
  });
}

export function encryptedDatabase(database, vault, definitions, { securityGuard } = {}) {
  vault.assertUnlocked();
  const generation = vault.generation;
  const active = new Set();
  const assertLive = () => {
    vault.assertUnlocked();
    if (vault.generation !== generation) throw new Error("Kin is locked. Unlock before accessing household data.");
  };
  const unsubscribe = vault.onLock(() => {
    const error = new Error("Kin locked before the storage operation completed.");
    error.code = "locked";
    for (const transaction of active) transaction.fail(error);
  });
  return {
    name: database.name,
    version: database.version,
    objectStoreNames: database.objectStoreNames,
    close() { unsubscribe(); database.close(); },
    transaction(names, mode = "readonly") {
      assertLive();
      const list = typeof names === "string" ? [names] : Array.from(names);
      if (!list.length || list.some((name) => !definitions[name])) throw new Error("Unknown protected transaction store.");
      const transactionNames = securityGuard ? [...new Set([...list, securityGuard.store])] : list;
      const native = database.transaction(transactionNames, mode);
      let pending = 0;
      let ended = false;
      const nativeQueue = [];
      let operationTail = Promise.resolve();
      const requests = new Set();
      let guardPromise;
      let guardPending = true;
      const wrapper = {
        get error() { return native.error; },
        get __kinFailure() { return native.__kinFailure; },
        set __kinFailure(value) { native.__kinFailure = value; },
        get oncomplete() { return native.oncomplete; },
        set oncomplete(value) { native.oncomplete = value; },
        get onabort() { return native.onabort; },
        set onabort(value) { native.onabort = value; },
        get onerror() { return native.onerror; },
        set onerror(value) { native.onerror = value; },
        abort() { native.abort(); },
        addEventListener(...args) { native.addEventListener(...args); },
        fail(error) {
          if (ended) return;
          native.__kinFailure ??= error;
          for (const request of requests) request.result = undefined;
          try { native.abort(); } catch { /* Already ending. */ }
        },
        objectStore(name) {
          const store = native.objectStore(name);
          const definition = definitions[name];
          const read = (source, method, args, many = false) => requestOperation(async () => {
            if (many && source === store && args.length === 0) {
              // One native transaction retains the original serialization and
              // snapshot contract while holding at most 128 ciphertext rows;
              // Web Crypto still processes only 32 values at a time.
              const values = [];
              let range;
              while (true) {
                assertLive();
                const page = await runNative(() => store.getAll(range, PROTECTED_PAGE_SIZE));
                if (!page.length) return values;
                const lastKey = page.at(-1)[definition.keyPath];
                const decoded = await mapProtectedBatch(page,
                  (row) => unprotectRecord(vault, name, definition, row), assertLive);
                values.push(...decoded);
                if (page.length < PROTECTED_PAGE_SIZE) return values;
                range = IDBKeyRange.lowerBound(lastKey, true);
              }
            }
            const raw = await runNative(() => source[method](...args));
            if (many) return mapProtectedBatch(raw, (row) => unprotectRecord(vault, name, definition, row), assertLive);
            return unprotectRecord(vault, name, definition, raw);
          });
          return {
            name, keyPath: store.keyPath, transaction: wrapper,
            get(...args) { return read(store, "get", args); },
            getAll(...args) { return read(store, "getAll", args, true); },
            count(...args) { return requestOperation(() => runNative(() => store.count(...args))); },
            delete(...args) { return requestOperation(() => runNative(() => store.delete(...args))); },
            clear() { return requestOperation(() => runNative(() => store.clear())); },
            index(indexName) {
              if (!definition.indexes?.[indexName]) throw new Error("Unknown protected index.");
              const index = store.index(indexName);
              return { get(...args) { return read(index, "get", args); }, getAll(...args) { return read(index, "getAll", args, true); } };
            },
            add(value) { return write(value, "add"); },
            put(value) { return write(value, "put"); },
          };
          function write(input, method) {
            const value = structuredClone(input);
            return requestOperation(async () => {
              let key = value[definition.keyPath];
              let reserved = false;
              if (key === undefined && store.autoIncrement) {
                const routing = {};
                for (const path of Object.values(definition.indexes ?? {})) routing[path] = value[path];
                key = await runNative(() => store.add(routing));
                value[definition.keyPath] = key;
                reserved = true;
              }
              const row = await protectRecord(vault, name, definition, value);
              assertLive();
              return runNative(() => store[reserved ? "put" : method](row));
            });
          }
        },
      };
      active.add(wrapper);
      const finish = () => { ended = true; active.delete(wrapper); requests.clear(); };
      native.addEventListener("complete", finish);
      native.addEventListener("abort", finish);
      if (securityGuard) {
        guardPromise = new Promise((resolve, reject) => {
          const request = native.objectStore(securityGuard.store).get(securityGuard.key);
          request.onsuccess = () => {
            const marker = request.result;
            if (!marker || marker.phase !== "encrypted" || marker.vaultId !== vault.vaultId ||
                (securityGuard.epoch !== undefined && (marker.lockEpoch ?? 0) !== securityGuard.epoch) ||
                (securityGuard.rootVersion !== undefined && (marker.rootVersion ?? 1) !== securityGuard.rootVersion)) {
              const error = new Error("Kin was locked in another tab. Unlock before continuing.");
              error.code = "locked";
              vault.lock();
              reject(error);
              wrapper.fail(error);
            } else resolve();
          };
          request.onerror = () => reject(request.error);
        });
        if (securityGuard.checkExternal && vault.checkSecurityEpoch)
          guardPromise = guardPromise.then(() => vault.checkSecurityEpoch());
      } else if (vault.checkSecurityEpoch) {
        guardPromise = vault.checkSecurityEpoch();
      } else guardPromise = Promise.resolve();
      // A transaction may be created without a user request. Its guard still
      // needs an observed rejection and must abort, never silently complete.
      guardPromise.then(() => { guardPending = false; }, (error) => {
        guardPending = false;
        wrapper.fail(error);
      });
      // Pump only native reads. Every crypto continuation owns a pending token;
      // callbacks may schedule more work before releasing their token.
      function keepAlive() {
        if (ended) return;
        let request;
        try { request = native.objectStore(list[0]).get("__kin_keepalive__"); }
        catch (error) { wrapper.fail(error); return; }
        request.onsuccess = () => {
          // Issue native requests from an IDB task, where the transaction is
          // active, rather than from a Web Crypto task (which is inactive).
          for (const operation of nativeQueue.splice(0)) operation();
          if (pending > 0 || guardPending) keepAlive();
        };
      }
      function runNative(createRequest) {
        return new Promise((resolve, reject) => {
          nativeQueue.push(() => {
            try {
              assertLive();
              nativeRequest(createRequest()).then(resolve, reject);
            } catch (error) { reject(error); }
          });
        });
      }
      function requestOperation(operation) {
        assertLive();
        pending += 1;
        const listeners = { success: [], error: [] };
        const request = {
          result: undefined, error: null, onsuccess: null, onerror: null,
          addEventListener(type, callback) { listeners[type]?.push(callback); },
        };
        requests.add(request);
        operationTail = operationTail.then(() => {
          assertLive();
          if (ended) throw new Error("The protected storage transaction has ended.");
          return guardPromise.then(operation);
        }).then((result) => {
          assertLive();
          if (ended) return;
          request.result = result;
          const event = { target: request };
          request.onsuccess?.(event);
          for (const callback of listeners.success) callback(event);
        }).catch((error) => {
          request.error = error;
          try {
            request.onerror?.({ target: request });
            for (const callback of listeners.error) callback({ target: request });
          } finally { wrapper.fail(error); }
        }).finally(() => { pending -= 1; });
        return request;
      }
      keepAlive();
      return wrapper;
    },
  };
}

function nativeRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
