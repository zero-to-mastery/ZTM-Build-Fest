// Real browser IndexedDB + Web Crypto regressions; no third-party harness.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { keyMigrationRegression } from "./security-key-regression.mjs";
import { rotationStorageRegression } from "./rotation-storage-regression.mjs";
import { rootRotationRegression, rootRotationRestartFixture } from "./root-rotation-regression.mjs";
import { boundedStorageRegression } from "./bounded-storage-regression.mjs";
import { rootKeyRotationRegression } from "./root-key-rotation-regression.mjs";

export async function securityStorageRegressions(client, { adapterOnly = false } = {}) {
  const result = await client.evaluate(`(${browserChecks.toString()})(${JSON.stringify({ adapterOnly })})`);
  assert.ok(result.checks >= (adapterOnly ? 8 : 17));
  console.log(`PASS ${result.checks} encrypted storage, transaction, lock and migration assertions`);
  return result;
}

async function browserChecks({ adapterOnly }) {
  const { LocalVault } = await import("/security/local-vault.js");
  const { encryptedDatabase, snapshotStores } = await import("/storage/encrypted-idb.js");
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw Error(message); checks += 1; };
  const reject = async (operation, message) => {
    let rejected = false;
    try { await operation(); } catch { rejected = true; }
    check(rejected, message);
  };
  const done = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.__kinFailure ?? transaction.error ?? Error("aborted"));
    transaction.onerror = () => {};
  });
  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const remove = (name) => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error("fixture database open"));
  });
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("kin-protected-fixture", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("events", { keyPath: "sequence", autoIncrement: true });
      store.createIndex("event_id", "event_id", { unique: true });
      request.result.createObjectStore("context", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  let { vault } = await LocalVault.create();
  const definitions = { events: { keyPath: "sequence", indexes: { event_id: "event_id" } }, context: { keyPath: "key" } };
  let protectedDb = encryptedDatabase(database, vault, definitions);
  let transaction = protectedDb.transaction(["events", "context"], "readwrite");
  let completion = done(transaction);
  const first = transaction.objectStore("events").add({ event_id: "a", text: "private family words", canonical: new Uint8Array([1, 2, 3]), logical: 8n });
  const firstResult = requestResult(first);
  transaction.objectStore("context").put({ key: "active", private: "family metadata" });
  await completion;
  check(await firstResult === 1, "encrypted add preserves generated sequence");
  const raw = await snapshotStores(database, ["events", "context"]);
  check(!JSON.stringify(raw).includes("family") && raw.events[0].protected_version === 1 && !Object.hasOwn(raw.events[0], "canonical"), "all household values encrypted at rest");
  transaction = protectedDb.transaction("events");
  completion = done(transaction);
  const loaded = await requestResult(transaction.objectStore("events").index("event_id").get("a"));
  await completion;
  check(loaded.text === "private family words" && loaded.logical === 8n && loaded.canonical[2] === 3, "index read decrypts exact typed values");
  transaction = protectedDb.transaction("context", "readwrite");
  completion = done(transaction);
  transaction.objectStore("context").put({ key: "active", private: "first ordered write" });
  transaction.objectStore("context").put({ key: "active", private: "last ordered write" });
  const ordered = requestResult(transaction.objectStore("context").get("active"));
  await completion;
  check((await ordered).private === "last ordered write", "async encryption preserves native request ordering and read-after-write");

  const originalSeal = vault.seal.bind(vault);
  vault.seal = async (value, context) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (value.private === "reject") throw Error("injected crypto failure");
    return originalSeal(value, context);
  };
  transaction = protectedDb.transaction(["events", "context"], "readwrite");
  completion = done(transaction);
  transaction.objectStore("events").add({ event_id: "b", text: "must abort" });
  transaction.objectStore("context").put({ key: "active", private: "reject" });
  await reject(() => completion, "crypto failure aborts transaction");
  check((await snapshotStores(database, ["events"])).events.length === 1, "crypto failure rolls back earlier encrypted event");
  vault.seal = originalSeal;

  transaction = database.transaction("events", "readwrite");
  completion = done(transaction);
  const tampered = structuredClone(raw.events[0]);
  tampered.protected_value.ciphertext = (tampered.protected_value.ciphertext[0] === "A" ? "B" : "A") + tampered.protected_value.ciphertext.slice(1);
  transaction.objectStore("events").put(tampered);
  await completion;
  transaction = protectedDb.transaction("events");
  completion = done(transaction);
  transaction.objectStore("events").getAll();
  await reject(() => completion, "tampered ciphertext cannot yield partial success");
  transaction = database.transaction("events", "readwrite");
  completion = done(transaction);
  transaction.objectStore("events").put(raw.events[0]);
  await completion;

  vault.checkSecurityEpoch = () => new Promise((resolve, reject) => setTimeout(() => reject(Error("delayed stale epoch")), 25));
  transaction = protectedDb.transaction("context", "readwrite");
  completion = done(transaction);
  await reject(() => completion, "an empty protected transaction waits for and rejects a delayed stale security epoch");
  delete vault.checkSecurityEpoch;

  transaction = protectedDb.transaction("events", "readwrite");
  completion = done(transaction);
  transaction.objectStore("events").add({ event_id: "c", text: "lock before commit" });
  vault.lock();
  await reject(() => completion, "lock aborts pending writes");
  check((await snapshotStores(database, ["events"])).events.length === 1, "lock preserves previous corpus");
  await reject(async () => protectedDb.transaction("events"), "stale adapter cannot transact after lock");
  protectedDb.close();
  await remove("kin-protected-fixture");
  if (adapterOnly) return { checks };

  const { EventStore } = await import("/storage/event-store.js");
  const { loadKinEngine } = await import("/wasm/kin-engine.js");
  const engine = await loadKinEngine();
  await remove("kin");
  const legacy = await EventStore.openLegacyForMigration();
  await legacy.append({ type: "add", text: "legacy household secret", classification: "need" }, engine);
  const originalEvents = await legacy.loadEvents();
  const originalCatchUp = await legacy.getCatchUpState();
  legacy.close();
  const created = await LocalVault.create();
  vault = created.vault;
  await EventStore.prepareSecurity(created.manifest);
  await reject(() => EventStore.open(), "locked EventStore cannot replay legacy or encrypted data");
  await reject(() => EventStore.openLegacyForMigration(), "setup prevents legacy API writes");
  const prepareKeys = async () => ({ rewrapEventRows: async () => {} });
  const finalizeKeys = async () => {};
  let rawDatabase = await new Promise((resolve) => { const request = indexedDB.open("kin"); request.onsuccess = () => resolve(request.result); });
  let migrationTxn = rawDatabase.transaction("sync_outbox", "readwrite");
  migrationTxn.objectStore("sync_outbox").put({ event_id: "ff".repeat(16), canonical_event: originalEvents[0].encoded_event.slice() });
  await done(migrationTxn);
  rawDatabase.close();
  await reject(() => EventStore.migrate({ vault, engine, prepareKeys, finalizeKeys }), "orphaned legacy outbox row cannot migrate");
  rawDatabase = await new Promise((resolve) => { const request = indexedDB.open("kin"); request.onsuccess = () => resolve(request.result); });
  migrationTxn = rawDatabase.transaction("sync_outbox", "readwrite");
  migrationTxn.objectStore("sync_outbox").clear();
  const divergent = originalEvents[0].encoded_event.slice(); divergent[divergent.length - 1] ^= 1;
  migrationTxn.objectStore("sync_outbox").put({ event_id: [...originalEvents[0].event_id].map((byte) => byte.toString(16).padStart(2, "0")).join(""), canonical_event: divergent });
  await done(migrationTxn);
  rawDatabase.close();
  await reject(() => EventStore.migrate({ vault, engine, prepareKeys, finalizeKeys }), "divergent legacy outbox copy cannot migrate");
  rawDatabase = await new Promise((resolve) => { const request = indexedDB.open("kin"); request.onsuccess = () => resolve(request.result); });
  migrationTxn = rawDatabase.transaction("sync_outbox", "readwrite");
  migrationTxn.objectStore("sync_outbox").clear();
  await done(migrationTxn);
  let sourceAfterOutboxFailure = await snapshotStores(rawDatabase, ["events"]);
  check(sourceAfterOutboxFailure.events[0].encoded_event.every((byte, index) => byte === originalEvents[0].encoded_event[index]), "outbox integrity failures preserve authoritative source history");
  rawDatabase.close();
  const originalMigrationSeal = vault.seal.bind(vault);
  vault.seal = async () => { throw Error("injected migration crypto failure"); };
  await reject(() => EventStore.migrate({ vault, engine, prepareKeys, finalizeKeys }), "failed migration preserves source");
  vault.seal = originalMigrationSeal;
  rawDatabase = await new Promise((resolve) => { const request = indexedDB.open("kin"); request.onsuccess = () => resolve(request.result); });
  let persisted = await snapshotStores(rawDatabase, ["events"]);
  check(persisted.events[0].encoded_event.every((byte, index) => byte === originalEvents[0].encoded_event[index]), "failed encryption retains exact canonical history");
  rawDatabase.close();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, ...args) {
    if (this.name === "events" && value.protected_version === 1) throw new DOMException("migration quota fixture", "QuotaExceededError");
    return originalPut.call(this, value, ...args);
  };
  try { await reject(() => EventStore.migrate({ vault, engine, prepareKeys, finalizeKeys }), "migration quota abort preserves original stores"); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  check((await EventStore.securityStatus()).phase === "preparing", "quota failure leaves recoverable preparation journal");
  IDBObjectStore.prototype.put = function(value, ...args) {
    const request = originalPut.call(this, value, ...args);
    if (this.name === "events" && value.protected_version === 1) request.addEventListener("success", () => this.transaction.abort());
    return request;
  };
  try { await reject(() => EventStore.migrate({ vault, engine, prepareKeys, finalizeKeys }), "migration abort after write success rolls back replacement"); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  check((await EventStore.securityStatus()).phase === "preparing", "aborted replacement cannot commit cleanup journal");
  await reject(() => EventStore.migrate({ vault, engine, prepareKeys, finalizeKeys: async () => { throw Error("injected key cleanup interruption"); } }), "interrupted cross-database cleanup is recoverable");
  check((await EventStore.securityStatus()).phase === "cleanup-pending", "migration journal records cleanup requirement");
  await reject(() => EventStore.open({ vault, engine }), "cleanup pending never opens household");
  const manifest = await EventStore.migrate({ vault, engine, prepareKeys: async () => { throw Error("must not reread legacy"); }, finalizeKeys });
  check(manifest.phase === "encrypted", "restart resumes final cleanup without a new root");
  const store = await EventStore.open({ vault, engine });
  const migrated = await store.loadEvents();
  check(migrated[0].encoded_event.every((byte, index) => byte === originalEvents[0].encoded_event[index]), "migration preserves canonical bytes exactly");
  check((await store.getCatchUpState()).cursor.eventId === originalCatchUp.cursor.eventId, "migration preserves catch-up cursor");
  await store.append({ type: "add", text: "protected later secret", classification: "today" }, engine);
  check((await store.loadEvents()).length === 2, "encrypted append performs command and atomic replay");
  const archive = await store.snapshotForArchive();
  await reject(() => EventStore.restoreEmpty({ vault, engine, snapshot: archive }), "archive import cannot overwrite a nonempty household");
  rawDatabase = await new Promise((resolve) => { const request = indexedDB.open("kin"); request.onsuccess = () => resolve(request.result); });
  persisted = await snapshotStores(rawDatabase, ["events", "local_context", "sync_state", "sync_outbox", "sync_bindings"]);
  check(!JSON.stringify(persisted).includes("secret") && persisted.events.every((row) => !Object.hasOwn(row, "encoded_event")), "migration removes all plaintext event copies");
  rawDatabase.close();
  const wrapperSecret = crypto.getRandomValues(new Uint8Array(32));
  const firstWrapper = await vault.addCredentialWrapper(wrapperSecret, { credentialId: "fixture-one", prfSalt: "fixture-salt-one" });
  const added = await EventStore.updateSecurityManifest(firstWrapper, vault);
  check(added.configRevision === 1 && vault.manifest.configRevision === 1, "wrapper commit advances persisted and in-memory revision");
  const staleVault = await LocalVault.unlock(await EventStore.securityStatus(), created.recoverySecret);
  const staleStore = await EventStore.open({ vault: staleVault, engine });
  const staleAddition = await staleVault.addCredentialWrapper(crypto.getRandomValues(new Uint8Array(32)), { credentialId: "fixture-stale", prfSalt: "fixture-salt-stale" });
  await EventStore.updateSecurityManifest(await vault.addCredentialWrapper(crypto.getRandomValues(new Uint8Array(32)), { credentialId: "fixture-two", prfSalt: "fixture-salt-two" }), vault);
  await reject(() => EventStore.updateSecurityManifest(staleAddition, staleVault), "stale addition cannot overwrite concurrent wrapper changes");
  check((await EventStore.securityStatus()).wrappers.some((wrapper) => wrapper.credentialId === "fixture-two") && staleVault.locked, "stale wrapper write preserves new credential and drops stale capability");
  staleStore.close();
  const resurrectionVault = await LocalVault.unlock(await EventStore.securityStatus(), created.recoverySecret);
  const resurrectionStore = await EventStore.open({ vault: resurrectionVault, engine });
  const resurrection = await resurrectionVault.addCredentialWrapper(crypto.getRandomValues(new Uint8Array(32)), { credentialId: "fixture-resurrection", prfSalt: "fixture-salt-resurrection" });
  const revokedWrapper = vault.manifest.wrappers.find((wrapper) => wrapper.credentialId === "fixture-one");
  const beforeRevocation = await EventStore.securityStatus();
  const revoked = await EventStore.updateSecurityManifest(vault.removeWrapper(revokedWrapper.id), vault);
  check(revoked.lockEpoch === beforeRevocation.lockEpoch + 1 && revoked.configRevision === beforeRevocation.configRevision + 1, "removal atomically revokes prior lock epoch and wrapper revision");
  await reject(() => EventStore.updateSecurityManifest(resurrection, resurrectionVault), "stale addition cannot resurrect a removed wrapper");
  check(!(await EventStore.securityStatus()).wrappers.some((wrapper) => wrapper.id === revokedWrapper.id), "removed credential remains absent after stale write");
  await reject(async () => LocalVault.unlock(await EventStore.securityStatus(), wrapperSecret, revokedWrapper.id), "removed local unlock path cannot unwrap current manifest");
  resurrectionStore.close();
  wrapperSecret.fill(0);
  const peerVault = await LocalVault.unlock(await EventStore.securityStatus(), created.recoverySecret);
  const peerStore = await EventStore.open({ vault: peerVault, engine });
  await EventStore.lockAll();
  await reject(() => peerStore.append({ type: "add", text: "stale peer must not write", classification: "need" }, engine), "durable lock epoch rejects a peer that missed broadcast");
  check(peerVault.locked === true, "stale epoch drops peer key capability");
  peerStore.close();
  vault.lock();
  await reject(() => store.loadEvents(), "locked store cannot reload a projection source");
  store.close();
  await remove("kin");
  const target = await LocalVault.create();
  await EventStore.prepareSecurity(target.manifest);
  await EventStore.migrate({ vault: target.vault, engine, prepareKeys, finalizeKeys });
  const corrupted = structuredClone(archive);
  corrupted.events[0].kind = "ITEM_COMPLETED";
  await reject(() => EventStore.restoreEmpty({ vault: target.vault, engine, snapshot: corrupted }), "corrupt archive cannot partially import");
  const destination = await EventStore.open({ vault: target.vault, engine });
  check((await destination.loadEvents()).length === 0, "failed archive validation preserves empty target");
  const restored = await EventStore.restoreEmpty({ vault: target.vault, engine, snapshot: archive });
  check(restored.eventCount === 2 && restored.localOnly, "archive restores complete history under independent root");
  const restoredRows = await destination.loadEvents();
  check(restoredRows.every((row, i) => row.encoded_event.every((byte, j) => byte === archive.events[i].encoded_event[j])), "archive restores exact canonical bytes");
  await destination.append({ type: "add", text: "new anonymous local author", classification: "need" }, engine);
  const afterRestore = await destination.loadEvents();
  check(afterRestore.length === 3 && afterRestore[2].actor_id.some((byte, i) => byte !== archive.events[0].actor_id[i]) && afterRestore[2].device_id.some((byte, i) => byte !== archive.events[0].device_id[i]), "restored history supports fresh local actor and device");
  await reject(() => destination.initializeSync({ identity: { householdId: "11".repeat(16), memberId: "22".repeat(16), deviceId: "33".repeat(16) }, serverStatus: { currentEpoch: 1 } }), "archive does not restore transport authorization");
  destination.close();
  target.vault.lock();
  await remove("kin");
  return { checks };
}

async function storagePerformance({ maximumPayload = false } = {}) {
  const { LocalVault } = await import("/security/local-vault.js");
  const { EventStore } = await import("/storage/event-store.js");
  const { loadKinEngine, encodeAddedRecord, randomId } = await import("/wasm/kin-engine.js");
  const { projectionContext } = await import("/browser-time.js");
  const { exportHouseholdArchive, importHouseholdArchive } = await import("/security/archive.js");
  const started = performance.now();
  const engine = await loadKinEngine();
  const initializationMs = performance.now() - started;
  const results = [];
  for (const [count, large] of [[1000, false], [10000, false], ...(maximumPayload ? [[10000, true]] : [])]) {
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase("kin"); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
    const legacy = await EventStore.openLegacyForMigration();
    const context = await legacy.ensureContext();
    const rows = [];
    const text = large ? "x".repeat(4096) : "Migration benchmark household event";
    for (let i = 0; i < count; i += 1) {
      const eventId = randomId();
      const identity = { eventId, householdId: context.household_id, actorId: context.actor_id, deviceId: context.device_id, timestamp: 1700000000000 + i, logicalTime: BigInt(i + 1) };
      const encoded = encodeAddedRecord({ ...identity, itemId: randomId(), text, classification: "need" });
      rows.push({ event_id: eventId, household_id: identity.householdId, actor_id: identity.actorId, device_id: identity.deviceId, timestamp: identity.timestamp, logical_time: identity.logicalTime, kind: "ITEM_ADDED", event_version: 2, encoded_event: encoded });
    }
    await new Promise((resolve, reject) => {
      const transaction = legacy.database.transaction(["events", "local_context"], "readwrite");
      for (const row of rows) transaction.objectStore("events").add(row);
      transaction.objectStore("local_context").put({ ...context, next_logical_time: BigInt(count + 1) });
      transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
    });
    legacy.close();
    const { vault, manifest, recoverySecret } = await LocalVault.create();
    await EventStore.prepareSecurity(manifest);
    const migrationStart = performance.now();
    await EventStore.migrate({ vault, engine, prepareKeys: async () => ({}), finalizeKeys: async () => {} });
    const migrationMs = performance.now() - migrationStart;
    vault.lock();
    const unlockStart = performance.now();
    const unlocked = await LocalVault.unlock(await EventStore.securityStatus(), recoverySecret);
    const store = await EventStore.open({ vault: unlocked, engine });
    let snapshot = await store.getCatchUpState();
    const unlockDecryptMs = performance.now() - unlockStart;
    const replayStart = performance.now();
    const { asOf, civilDate } = projectionContext();
    engine.applyEvents(snapshot.events.map((row) => row.encoded_event), asOf, null, civilDate);
    const replayMs = performance.now() - replayStart;
    const measurement = { events: count, textBytes: text.length, canonicalBytes: rows.reduce((total, row) => total + row.encoded_event.byteLength, 0), migrationMs, unlockDecryptMs, replayMs };
    snapshot = null;
    const raw = await new Promise((resolve, reject) => { const request = indexedDB.open("kin"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      measurement.encryptedRecordBytes = await new Promise((resolve, reject) => {
        const transaction = raw.transaction(Array.from(raw.objectStoreNames), "readonly");
        const encoder = new TextEncoder();
        let bytes = 0;
        for (const name of raw.objectStoreNames) {
          const request = transaction.objectStore(name).openCursor();
          request.onsuccess = () => { const cursor = request.result; if (cursor) { bytes += encoder.encode(JSON.stringify(cursor.value)).byteLength; cursor.continue(); } };
        }
        transaction.oncomplete = () => resolve(bytes); transaction.onabort = () => reject(transaction.error);
      });
    } finally { raw.close(); }
    measurement.originUsageBytes = (await navigator.storage.estimate()).usage;
    {
      const exportStart = performance.now();
      const archive = await exportHouseholdArchive({ store, engine, vault: unlocked });
      measurement.archiveBytes = archive.byteLength;
      measurement.archiveExportMs = performance.now() - exportStart;
      if (archive.byteLength > 64 * 1024 * 1024) throw Error("Archive exceeded its supported 64 MiB framing bound.");
      store.close(); unlocked.lock();
      await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase("kin"); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
      const target = await LocalVault.create();
      await EventStore.prepareSecurity(target.manifest);
      await EventStore.migrate({ vault: target.vault, engine, prepareKeys: async () => ({}), finalizeKeys: async () => {} });
      const restoredStore = await EventStore.open({ vault: target.vault, engine });
      const restoreStart = performance.now();
      await importHouseholdArchive({ bytes: archive, recoverySecret, engine, vault: target.vault });
      measurement.archiveRestoreMs = performance.now() - restoreStart;
      const restored = await restoredStore.loadEvents();
      if (restored.length !== rows.length || restored.some((row, i) => row.encoded_event.length !== rows[i].encoded_event.length || row.encoded_event.some((byte, j) => byte !== rows[i].encoded_event[j])))
        throw Error("Archive did not restore the exact complete canonical history.");
      measurement.archiveRoundTripExact = true;
      restoredStore.close(); target.vault.lock();
    }
    results.push(measurement);
  }
  return { initializationMs, results, scope: "Real browser crypto/IDB and release WASM; source fixture rows retained for exact roundtrip comparison; encryptedRecordBytes is UTF-8 serialized records, originUsageBytes is browser-estimated storage rather than physical database file size." };
}

function monitorRendererMemory(profile) {
  if (process.platform !== "win32") return { stop: async () => ({ peakRendererWorkingSetBytes: null, memoryScope: "Renderer working-set sampling unavailable on this host." }) };
  // Only the isolated test profile and its descendant renderers are measured.
  // Sampled working set includes native/WASM allocations; it is not JS heap size.
  const script = `
$ErrorActionPreference = 'Stop'
while ($true) {
  $kinProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe' OR Name = 'chrome.exe'")
  $kinIds = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($kinProcess in $kinProcesses) { if ($kinProcess.CommandLine -like "*$env:KIN_TEST_PROFILE*") { [void]$kinIds.Add([int]$kinProcess.ProcessId) } }
  do { $kinChanged = $false; foreach ($kinProcess in $kinProcesses) { if ($kinIds.Contains([int]$kinProcess.ParentProcessId) -and $kinIds.Add([int]$kinProcess.ProcessId)) { $kinChanged = $true } } } while ($kinChanged)
  [long]$kinWorkingSet = 0
  foreach ($kinProcess in $kinProcesses) { if ($kinIds.Contains([int]$kinProcess.ProcessId) -and $kinProcess.CommandLine -like '*--type=renderer*') { $kinWorkingSet += [long]$kinProcess.WorkingSetSize } }
  [Console]::WriteLine($kinWorkingSet)
  Start-Sleep -Milliseconds 500
}`;
  const monitor = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, KIN_TEST_PROFILE: profile } });
  let pending = "", peak = 0, samples = 0, failure = "";
  monitor.stdout.on("data", (data) => {
    pending += data.toString();
    const lines = pending.split(/\r?\n/u); pending = lines.pop();
    for (const line of lines) { const bytes = Number(line); if (bytes > 0) { peak = Math.max(peak, bytes); samples += 1; } }
  });
  monitor.stderr.on("data", (data) => { failure += data.toString(); });
  monitor.on("error", (error) => { failure = error.message; });
  return { stop: async () => {
    monitor.kill();
    if (monitor.exitCode === null) await Promise.race([once(monitor, "exit"), delay(2_000)]).catch(() => {});
    return { peakRendererWorkingSetBytes: peak || null, rendererMemorySamples: samples,
      memoryScope: "Peak sampled sum of isolated-profile renderer working sets during all benchmark cases; sampled about every 500ms plus process-query time, includes retained source fixture rows. Not a mobile measurement.",
      ...(failure ? { memorySamplingError: failure.trim() } : {}) };
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  assert.ok(executable, "Usage: node scripts/security-storage-regression.mjs <browser executable> [--adapter-only]");
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
  const profile = await mkdtemp(join(tmpdir(), "kin-security-storage-"));
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Kin storage regression</title>"); return; }
    const path = resolve(webRoot, `.${pathname}`);
    if (!path.startsWith(webRoot + sep)) { response.writeHead(403).end(); return; }
    try { response.setHeader("Content-Type", { ".js": "text/javascript", ".wasm": "application/wasm" }[extname(path)] ?? "application/octet-stream"); response.end(await readFile(path)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, socket;
  async function connectBrowser() {
    await rm(join(profile, "DevToolsActivePort"), { force: true });
    browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--edge-skip-compat-layer-relaunch", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
    let port;
    for (let attempt = 0; attempt < 200 && !port; attempt += 1) { try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { await delay(50); } }
    assert.ok(port, "Browser did not start");
    const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin)}`, { method: "PUT" }).then((response) => response.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id) { const task = pending.get(message.id); pending.delete(message.id); message.error ? task.reject(Error(JSON.stringify(message.error))) : task.resolve(message.result); } };
    socket.onclose = () => { for (const task of pending.values()) task.reject(Error("Isolated browser connection closed")); pending.clear(); };
    const send = (method, params) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); });
    const client = { evaluate: async (expression) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value; } };
    for (let attempt = 0; attempt < 100; attempt += 1) { if (await client.evaluate("location.origin === " + JSON.stringify(origin))) break; await delay(20); }
    return client;
  }
  async function stopBrowser() {
    if (socket) {
      const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
      socket.close();
      await Promise.race([closed, delay(1_000)]);
      socket = null;
    }
    if (!browser) return;
    if (process.platform === "win32" && browser.pid) {
      const killer = spawn("powershell.exe", ["-NoProfile", "-Command",
        "for ($attempt = 0; $attempt -lt 10; $attempt++) { $targets = Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe' OR Name = 'chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$env:KIN_TEST_PROFILE*\" }; if (-not $targets) { break }; foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 100 }"],
      { windowsHide: true, stdio: "ignore", env: { ...process.env, KIN_TEST_PROFILE: profile } });
      const [code] = await once(killer, "exit");
      assert.equal(code, 0, "Could not terminate the isolated browser profile");
    } else browser.kill("SIGKILL");
    if (browser.exitCode === null) await Promise.race([once(browser, "exit"), delay(2_000)]);
    browser.unref();
    browser = null;
  }
  try {
    let client = await connectBrowser();
    if (!process.argv.includes("--performance-only")) {
      await securityStorageRegressions(client, { adapterOnly: process.argv.includes("--adapter-only") });
      if (!process.argv.includes("--adapter-only")) console.log(await client.evaluate(`(${keyMigrationRegression.toString()})()`));
      if (!process.argv.includes("--adapter-only")) console.log(await client.evaluate(`(${rotationStorageRegression.toString()})()`));
      if (!process.argv.includes("--adapter-only")) console.log(await client.evaluate(`(${rootRotationRegression.toString()})()`));
      if (!process.argv.includes("--adapter-only")) console.log(await client.evaluate(`(${boundedStorageRegression.toString()})()`));
      if (!process.argv.includes("--adapter-only")) console.log(await client.evaluate(`(${rootKeyRotationRegression.toString()})()`));
      if (!process.argv.includes("--adapter-only")) {
        let restartChecks = 0;
        for (const phase of ["events-staged", "events-committed"]) {
          const resume = await client.evaluate(`(${rootRotationRestartFixture.toString()})(${JSON.stringify({ phase })})`);
          const prior = await client.evaluate("performance.timeOrigin");
          await client.evaluate("location.reload(); true");
          let reloaded = false;
          for (let attempt = 0; attempt < 100 && !reloaded; attempt++) {
            await delay(20);
            reloaded = await client.evaluate(`performance.timeOrigin !== ${prior} && document.readyState === 'complete'`);
          }
          assert.ok(reloaded, "Isolated page did not reload at root-rotation restart boundary");
          restartChecks += (await client.evaluate(`(${rootRotationRestartFixture.toString()})(${JSON.stringify({ resume })})`)).checks;
        }
        console.log(`PASS ${restartChecks} actual page-reload root rotation recovery assertions`);
        let processChecks = 0;
        for (const phase of ["events-staged", "events-committed"]) {
          const resume = await client.evaluate(`(${rootRotationRestartFixture.toString()})(${JSON.stringify({ phase })})`);
          // Terminate the actual isolated browser process and reopen its saved
          // profile. Only the user's separately retained fixture secret stays in
          // this host; no JS heap, vault, engine or connection survives.
          await stopBrowser();
          client = await connectBrowser();
          processChecks += (await client.evaluate(`(${rootRotationRestartFixture.toString()})(${JSON.stringify({ resume })})`)).checks;
        }
        console.log(`PASS ${processChecks} actual browser-process restart root rotation recovery assertions`);
      }
    }
    if (process.argv.includes("--performance") || process.argv.includes("--performance-only")) {
      const monitor = monitorRendererMemory(profile);
      let measurement;
      try { measurement = await client.evaluate(`(${storagePerformance.toString()})(${JSON.stringify({ maximumPayload: process.argv.includes("--maximum-payload") })})`); }
      finally { const memory = await monitor.stop(); if (measurement) console.log("PERFORMANCE " + JSON.stringify({ ...measurement, ...memory })); }
    }
  } finally {
    await stopBrowser();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await delay(300);
    await rm(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch((error) => {
      if (error.code !== "EBUSY") throw error;
      console.warn("Temporary Edge profile remained busy; the OS may remove it later.");
    });
  }
  process.exit(0);
}
