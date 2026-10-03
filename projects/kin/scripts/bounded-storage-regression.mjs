// Additional cases in the established isolated browser storage runner.
export async function boundedStorageRegression() {
  const { LocalVault } = await import("/security/local-vault.js");
  const { encryptedDatabase, snapshotStores, PROTECTED_BATCH_SIZE, PROTECTED_PAGE_SIZE } = await import("/storage/encrypted-idb.js");
  const check = (value, message) => { if (!value) throw Error(message); checks += 1; };
  let checks = 0;
  const done = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.__kinFailure ?? transaction.error ?? Error("aborted"));
    transaction.onerror = () => {};
  });
  const result = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const rejects = async (operation, message) => {
    let failed = false; try { await operation(); } catch { failed = true; } check(failed, message);
  };
  const remove = (name) => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve;
    request.onerror = () => reject(request.error); request.onblocked = () => reject(Error("Fixture still open"));
  });
  const name = "kin-bounded-storage-fixture";
  await remove(name);
  const raw = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("events", { keyPath: "sequence" })
      .createIndex("event_id", "event_id", { unique: true });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const created = await LocalVault.create();
  const vault = created.vault;
  const database = encryptedDatabase(raw, vault, { events: { keyPath: "sequence", indexes: { event_id: "event_id" } } });
  let transaction = database.transaction("events", "readwrite"), completion = done(transaction);
  for (let index = 0; index < 270; index += 1)
    transaction.objectStore("events").put({ sequence: index * 2 + 1, event_id: `event-${index}`, text: `original-${index}` });
  await completion;
  let active = 0, peak = 0, opened = 0;
  const originalOpen = vault.open.bind(vault), nativeGetAll = IDBObjectStore.prototype.getAll;
  const counts = [];
  vault.open = async (...args) => {
    active += 1; peak = Math.max(peak, active); opened += 1;
    try { await new Promise((resolve) => setTimeout(resolve, 1)); return await originalOpen(...args); }
    finally { active -= 1; }
  };
  IDBObjectStore.prototype.getAll = function (...args) {
    if (this.transaction.db.name === name) counts.push(args[1]);
    return nativeGetAll.apply(this, args);
  };
  try {
    transaction = database.transaction("events"); completion = done(transaction);
    const reading = result(transaction.objectStore("events").getAll());
    const writer = database.transaction("events", "readwrite"), committed = done(writer);
    writer.objectStore("events").put({ sequence: 69, event_id: "event-34", text: "later write" });
    const rows = await reading; await completion; await committed;
    check(rows.length === 270 && rows.every((row, index) => row.sequence === index * 2 + 1 && row.text === `original-${index}`), "Paged reads preserve sparse primary-key order and serialized snapshot");
    check(counts.length === 3 && counts.every((count) => count === PROTECTED_PAGE_SIZE), "Bulk reads request only bounded native pages");
    check(peak > 1 && peak <= PROTECTED_BATCH_SIZE && opened === 270, "Web Crypto concurrency is bounded at 32");
  } finally { IDBObjectStore.prototype.getAll = nativeGetAll; vault.open = originalOpen; }

  const before = await snapshotStores(raw, ["events"]);
  transaction = raw.transaction("events", "readwrite"); completion = done(transaction);
  const altered = structuredClone(before.events[140]); altered.event_id = "forged-routing";
  transaction.objectStore("events").put(altered); await completion;
  transaction = database.transaction("events"); completion = done(transaction);
  const malformed = transaction.objectStore("events").getAll();
  await rejects(() => completion, "A routing mismatch in a later page aborts the complete read");
  check(malformed.result === undefined, "Failed paged reads never expose a partial result");
  transaction = raw.transaction("events", "readwrite"); completion = done(transaction);
  transaction.objectStore("events").put(before.events[140]); await completion;

  transaction = database.transaction("events", "readwrite"); completion = done(transaction);
  transaction.objectStore("events").add({ sequence: 999, event_id: "event-0", text: "duplicate routing" });
  await rejects(() => completion, "A duplicate routing index aborts without creating another record");
  check((await snapshotStores(raw, ["events"])).events.length === 270, "Duplicate routing preserves the source corpus");

  opened = 0;
  vault.open = async (...args) => {
    const value = await originalOpen(...args);
    if (++opened === PROTECTED_BATCH_SIZE) vault.lock();
    return value;
  };
  transaction = database.transaction("events"); completion = done(transaction);
  const locked = transaction.objectStore("events").getAll();
  await rejects(() => completion, "Lock between encrypted pages aborts the pending transaction");
  check(opened === PROTECTED_BATCH_SIZE && locked.result === undefined, "Lock never decrypts a second batch or returns partial plaintext");
  database.close(); await remove(name);

  const { EventStore } = await import("/storage/event-store.js");
  const { loadKinEngine } = await import("/wasm/kin-engine.js");
  const engine = await loadKinEngine();
  await remove("kin");
  const legacy = await EventStore.openLegacyForMigration();
  for (let index = 0; index < 70; index += 1)
    await legacy.append({ type: "add", text: `atomic restore lock fixture ${index}`, classification: "need" }, engine);
  const source = await snapshotStores(legacy.database, ["events", "local_context"]);
  const snapshot = { formatVersion: 1, ...source };
  legacy.close();
  const migration = await LocalVault.create();
  await EventStore.prepareSecurity(migration.manifest);
  await EventStore.lockAll();
  await rejects(() => EventStore.migrate({ vault: migration.vault, engine, prepareKeys: async () => ({}), finalizeKeys: async () => {} }), "A stale pre-migration capability cannot adopt a missed peer lock epoch");
  check(migration.vault.locked && (await EventStore.securityStatus()).phase === "preparing", "Stale migration admission preserves the original recoverable setup");
  migration.vault = await LocalVault.unlock(await EventStore.securityStatus(), migration.recoverySecret);
  const migrationSeal = migration.vault.seal.bind(migration.vault);
  let migrated = 0;
  migration.vault.seal = async (value, context) => {
    const encrypted = await migrationSeal(value, context);
    if (context.store === "events" && ++migrated === PROTECTED_BATCH_SIZE) await EventStore.lockAll();
    return encrypted;
  };
  await rejects(() => EventStore.migrate({ vault: migration.vault, engine, prepareKeys: async () => ({}), finalizeKeys: async () => {} }), "Missed-broadcast migration lock aborts between crypto batches");
  check(migrated === PROTECTED_BATCH_SIZE && migration.vault.locked && (await EventStore.securityStatus()).phase === "preparing", "Migration detects the durable epoch before processing a second batch");
  const resumed = await LocalVault.unlock(await EventStore.securityStatus(), migration.recoverySecret);
  await EventStore.migrate({ vault: resumed, engine, prepareKeys: async () => ({}), finalizeKeys: async () => {} });
  const migratedStore = await EventStore.open({ vault: resumed, engine });
  check((await migratedStore.loadEvents()).length === 70, "A fresh recovery unlock resumes the preserved complete migration source");
  migratedStore.close(); resumed.lock(); await remove("kin");
  const target = await LocalVault.create();
  await EventStore.prepareSecurity(target.manifest);
  await EventStore.migrate({ vault: target.vault, engine, prepareKeys: async () => ({}), finalizeKeys: async () => {} });
  let targetVault = target.vault;
  let store = await EventStore.open({ vault: targetVault, engine });
  const malformedArchive = structuredClone(snapshot);
  malformedArchive.events.push({ ...structuredClone(snapshot.events[0]), local_sequence: 71 });
  let protectedCalls = 0;
  const targetSeal = targetVault.seal.bind(targetVault);
  targetVault.seal = async (value, context) => { protectedCalls += 1; return targetSeal(value, context); };
  await rejects(() => EventStore.restoreEmpty({ vault: targetVault, engine, snapshot: malformedArchive }), "Rust import planning rejects exact duplicate archive event IDs");
  check(protectedCalls === 0 && (await store.loadEvents()).length === 0, "Malformed archive rejection precedes crypto and every destination write");
  let restored = 0;
  targetVault.seal = async (value, context) => {
    const encrypted = await targetSeal(value, context);
    if (context.store === "events" && ++restored === PROTECTED_BATCH_SIZE) await EventStore.lockAll();
    return encrypted;
  };
  await rejects(() => EventStore.restoreEmpty({ vault: targetVault, engine, snapshot }), "Missed-broadcast restore lock aborts between crypto batches");
  check(restored === PROTECTED_BATCH_SIZE && targetVault.locked, "Restore checks the durable epoch before processing another batch");
  store.close();
  targetVault = await LocalVault.unlock(await EventStore.securityStatus(), target.recoverySecret);
  store = await EventStore.open({ vault: targetVault, engine });
  const originalPut = IDBObjectStore.prototype.put;
  let injected = false;
  IDBObjectStore.prototype.put = function (value, ...args) {
    const request = originalPut.call(this, value, ...args);
    if (!injected && this.transaction.db.name === "kin" && this.name === "events" && value.protected_version === 1) {
      injected = true; request.addEventListener("success", () => targetVault.lock());
    }
    return request;
  };
  try {
    await rejects(() => EventStore.restoreEmpty({ vault: targetVault, engine, snapshot }), "Lock after restore row success aborts the native publication transaction");
  } finally { IDBObjectStore.prototype.put = originalPut; store.close(); }
  check(injected, "Restore lock test reached the native commit boundary");
  const unlocked = await LocalVault.unlock(await EventStore.securityStatus(), target.recoverySecret);
  const reopened = await EventStore.open({ vault: unlocked, engine });
  check((await reopened.loadEvents()).length === 0, "Locked restore preserves the prior empty household");
  await EventStore.restoreEmpty({ vault: unlocked, engine, snapshot });
  check((await reopened.loadEvents()).length === 70, "Retry after lock authenticates and publishes exactly one complete restore");
  reopened.close(); unlocked.lock(); engine.dispose(); await remove("kin");
  return `PASS ${checks} bounded paging, crypto concurrency, routing integrity and restore-lock assertions`;
}
