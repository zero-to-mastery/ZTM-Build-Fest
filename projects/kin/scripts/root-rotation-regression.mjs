// Executed in the existing isolated CDP storage runner with real IndexedDB,
// release WASM and Web Crypto. Secrets below are synthetic fixture data only.
export async function rootRotationRegression() {
  const { LocalVault } = await import("/security/local-vault.js");
  const { EventStore } = await import("/storage/event-store.js");
  const { snapshotStores, valuesEqual } = await import("/storage/encrypted-idb.js");
  const { loadKinEngine, idToHex } = await import("/wasm/kin-engine.js");
  const { migrateSyncKeys, finalizeSyncKeyMigration, prepareRootRotationKeys, commitRootRotationKeys } = await import("/sync/key-store.js");
  const names = ["events", "local_context", "sync_state", "sync_outbox", "sync_bindings"];
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw Error(message); checks += 1; };
  const reject = async (action, message) => { let error; try { await action(); } catch (caught) { error = caught; } check(Boolean(error), message); return error; };
  const transactionDone = (transaction) => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.__kinFailure ?? transaction.error ?? Error("fixture abort")); transaction.onerror = () => {}; });
  const remove = (name) => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(Error(`Close ${name} fixture connections`)); });
  const rawDatabase = () => new Promise((resolve, reject) => { const request = indexedDB.open("kin"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const engine = await loadKinEngine();
  const prepareKeys = prepareRootRotationKeys, commitKeys = commitRootRotationKeys;

  async function fixture(eventCount = 2) {
    await remove("kin"); await remove("kin-crypto-keys");
    const legacy = await EventStore.openLegacyForMigration();
    await legacy.append({ type: "add", text: "root lifecycle first canonical row", classification: "need" }, engine);
    await legacy.append({ type: "add", text: "root lifecycle second canonical row", classification: "today" }, engine);
    for (let index = 2; index < eventCount; index++)
      await legacy.append({ type: "add", text: `root batch fixture ${index}`, classification: "need" }, engine);
    await legacy.getCatchUpState();
    legacy.close();
    const source = await LocalVault.create();
    await EventStore.prepareSecurity(source.manifest);
    await EventStore.migrate({ vault: source.vault, engine,
      prepareKeys: (vault) => migrateSyncKeys(vault, { prepareOnly: true }), finalizeKeys: finalizeSyncKeyMigration });
    const store = await EventStore.open({ vault: source.vault, engine });
    const events = await store.loadEvents();
    const transaction = store.database.transaction(["sync_state", "sync_outbox", "sync_bindings"], "readwrite");
    transaction.objectStore("sync_state").put({ key: "active", householdId: "a".repeat(32), currentEpoch: 3, pendingCount: 1,
      pullCursor: 7, nextDeviceSequence: 8, pendingProvisioning: { recipientId: "b".repeat(32), retained: "synthetic protected retry state" } });
    transaction.objectStore("sync_outbox").put({ event_id: idToHex(events[0].event_id), canonical_event: events[0].encoded_event,
      envelope: { ciphertext: "exact cached synthetic ciphertext", nonce: "same cached nonce" }, queued: true });
    transaction.objectStore("sync_bindings").put({ legacy_key: "synthetic-binding", controlEnvelope: { ciphertext: "unchanged binding ciphertext" } });
    await transactionDone(transaction);
    await EventStore.updateSecurityManifest(await source.vault.addCredentialWrapper(crypto.getRandomValues(new Uint8Array(32)), {
      credentialId: "prior-root-prf-wrapper", prfSalt: "prior-root-prf-salt",
    }), source.vault);
    const oldManifest = await EventStore.securityStatus();
    const before = await snapshotStores(store.database, names);
    const candidate = await LocalVault.createRotation(source.vault);
    return { source, candidate, store, before, oldManifest };
  }
  async function finishResume(test, marker = null) {
    test.store.close(); test.source.vault.lock(); test.candidate.vault.lock();
    marker ??= await EventStore.securityStatus();
    const manifest = marker.rotation?.candidateManifest ?? marker;
    const vault = await LocalVault.unlock(manifest, test.candidate.recoverySecret);
    if (marker.phase !== "encrypted") await EventStore.resumeRotation({ candidateVault: vault, engine, prepareKeys, commitKeys });
    const store = await EventStore.open({ vault, engine });
    check(valuesEqual(await snapshotStores(store.database, names), test.before), "Restart preserves complete event/context/cursor/outbox/binding/provisioning values");
    const current = await EventStore.securityStatus();
    check(current.phase === "encrypted" && current.rootVersion === 2 && !current.rotation, "Restart publishes exactly one candidate root and removes its journal");
    check(current.wrappers.length === 1 && current.wrappers[0].type === "recovery", "Rotation retains only the new verified recovery path");
    store.close(); vault.lock();
    return current;
  }

  {
    const test = await fixture();
    const manifest = { formatVersion: 2, vaultId: test.source.vault.vaultId, rootVersion: 2, wrappers: [] };
    const reused = new LocalVault(manifest.vaultId, test.source.vault.root, manifest);
    manifest.wrappers.push(await reused.createWrapper(crypto.getRandomValues(new Uint8Array(32)), { type: "recovery" }));
    manifest.verifier = await reused.seal("kin-vault-check-v1", { store: "security", id: "verifier" });
    reused.manifest = structuredClone(manifest);
    await reject(() => EventStore.rotateProtection({ sourceVault: test.source.vault, candidateVault: reused, engine, prepareKeys, commitKeys }), "Relabeling the existing root cannot satisfy root replacement");
    check(valuesEqual(await EventStore.securityStatus(), test.oldManifest), "Rejected same-root rotation leaves the authoritative manifest unchanged");
    reused.lock(); test.store.close(); test.source.vault.lock(); test.candidate.vault.lock();
  }

  {
    const test = await fixture();
    const { exportHouseholdArchive } = await import("/security/archive.js");
    const seal = test.source.vault.sealArchive.bind(test.source.vault);
    let entered, release;
    const pending = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    test.source.vault.sealArchive = async (...args) => { entered(); await gate; return seal(...args); };
    const operation = exportHouseholdArchive({ store: test.store, engine, vault: test.source.vault });
    operation.catch(() => {});
    await pending;
    await EventStore.lockAll(); // Deliberately no peer broadcast: only durable epoch changes.
    release();
    await reject(() => operation, "Archive export rejects a peer's durable lock while encryption was pending");
    check(test.source.vault.locked, "Missed peer broadcast still disposes the stale archive capability");
    test.store.close(); test.candidate.vault.lock();
    const current = await LocalVault.unlock(await EventStore.securityStatus(), test.source.recoverySecret);
    const reopened = await EventStore.open({ vault: current, engine });
    check(valuesEqual(await snapshotStores(reopened.database, names), test.before), "Cancelled archive leaves exact recoverable history unchanged");
    reopened.close(); current.lock();
  }

  for (const phase of ["begun", "keys-staged", "event-stage-batch", "events-staged", "verified", "commit-pending", "events-committed", "keys-committed", "cleanup-pending", "complete"]) {
    const test = await fixture();
    let reached = false;
    await reject(() => EventStore.rotateProtection({ sourceVault: test.source.vault, candidateVault: test.candidate.vault, engine, prepareKeys, commitKeys,
      onPhase: async (current) => { if (current === phase) { reached = true; throw Error(`interruption at ${phase}`); } } }), `Interrupt ${phase}`);
    check(reached, `Rotation reached ${phase} fault boundary`);
    const marker = await EventStore.securityStatus();
    const savedCandidate = marker.rotation?.candidateManifest ?? marker;
    check(valuesEqual(savedCandidate.verifier, test.candidate.manifest.verifier), `${phase} retains exact candidate instead of generating another root`);
    if (marker.phase === "root-rotating") {
      const oldVault = await LocalVault.unlock(test.oldManifest, test.source.recoverySecret);
      const raw = await rawDatabase();
      const rows = await snapshotStores(raw, ["events"]); raw.close();
      const row = await oldVault.open(rows.events[0].protected_value, { store: "events", id: `n:${rows.events[0].local_sequence}` });
      check(valuesEqual(row.encoded_event, test.before.events[0].encoded_event), "Precommit interruption retains old-root canonical corpus");
      oldVault.lock();
    }
    await finishResume(test, marker);
  }

  for (const fault of ["event-crypto", "key-stage", "quota", "idb-abort", "local-lock", "peer-lock"]) {
    const test = await fixture();
    const seal = test.candidate.vault.seal.bind(test.candidate.vault);
    const originalPut = IDBObjectStore.prototype.put;
    let injected = false;
    if (fault === "event-crypto") test.candidate.vault.seal = async (value, context) => {
      if (context.store === "events") { injected = true; throw Error("event reprotection interruption"); }
      return seal(value, context);
    };
    if (fault === "quota" || fault === "idb-abort") IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === "events" && value?.protected_value?.rootVersion === 2 && !injected) {
        injected = true;
        if (fault === "quota") throw new DOMException("synthetic root staging quota", "QuotaExceededError");
        const request = originalPut.call(this, value, ...args);
        request.addEventListener("success", () => this.transaction.abort());
        return request;
      }
      return originalPut.call(this, value, ...args);
    };
    try {
      await reject(() => EventStore.rotateProtection({ sourceVault: test.source.vault, candidateVault: test.candidate.vault, engine, commitKeys,
        prepareKeys: fault === "key-stage" ? async () => { injected = true; throw Error("key reprotection interruption"); } : prepareKeys,
        onPhase: async (phase) => {
          if (phase === "events-staged" && fault === "peer-lock") { injected = true; await EventStore.lockAll(); }
          if (phase === "events-staged" && fault === "local-lock") { injected = true; test.candidate.vault.lock(); }
        } }), `${fault} rotation fails closed`);
    } finally { IDBObjectStore.prototype.put = originalPut; test.candidate.vault.seal = seal; }
    check(injected, `${fault} exercised intended production boundary`);
    await finishResume(test);
  }

  for (const field of ["vaultId", "fromRootVersion", "toRootVersion", "id"]) {
    const test = await fixture();
    await reject(() => EventStore.rotateProtection({ sourceVault: test.source.vault, candidateVault: test.candidate.vault, engine, prepareKeys, commitKeys,
      onPhase: async (phase) => { if (phase === "keys-staged") throw Error("journal mutation fixture"); } }), "Pause before invalid journal test");
    const valid = await EventStore.securityStatus();
    const malformed = structuredClone(valid);
    malformed.rotation[field] = typeof malformed.rotation[field] === "number" ? malformed.rotation[field] + 1 : "f".repeat(32);
    const database = await rawDatabase();
    let transaction = database.transaction("security_state", "readwrite"); transaction.objectStore("security_state").put(malformed); await transactionDone(transaction);
    await reject(() => EventStore.resumeRotation({ candidateVault: test.candidate.vault, engine, prepareKeys, commitKeys }), `Reject foreign/conflicting journal ${field}`);
    const persisted = await snapshotStores(database, ["events"]);
    check(persisted.events.every((row) => (row.protected_value.rootVersion ?? 1) === 1), "Foreign journal never replaces committed old-root events");
    transaction = database.transaction("security_state", "readwrite"); transaction.objectStore("security_state").put(valid); await transactionDone(transaction); database.close();
    await finishResume(test, valid);
  }

  {
    const test = await fixture(70);
    let reached = false;
    await reject(() => EventStore.rotateProtection({ sourceVault: test.source.vault, candidateVault: test.candidate.vault, engine, prepareKeys, commitKeys,
      onPhase: async (phase, detail) => {
        if (phase === "event-stage-batch" && detail.store === "events" && detail.offset >= 32) {
          reached = true;
          throw Error("second root staging page interruption");
        }
      } }), "A 70-event rotation stops after its second staged page");
    check(reached, "Second-page root interruption occurs after at least 64 candidate records");
    const database = await rawDatabase();
    const markerRows = await snapshotStores(database, ["security_state"]); database.close();
    check(markerRows.security_state.filter((row) => row.store === "events").length === 64, "Partial journal contains exactly two bounded event pages");
    await finishResume(test);
  }

  for (const phase of ["begun", "events-staged", "events-committed"]) {
    const test = await fixture();
    await reject(() => EventStore.rotateProtection({ sourceVault: test.source.vault, candidateVault: test.candidate.vault, engine, prepareKeys, commitKeys,
      onPhase: async (current) => { if (current === phase) throw Error("stale resumption fixture"); } }), `Pause ${phase} before peer lock`);
    await EventStore.lockAll();
    await reject(() => EventStore.resumeRotation({ candidateVault: test.candidate.vault, engine, prepareKeys, commitKeys }), "Old unlocked candidate cannot adopt a newer durable lock epoch during resume");
    check(test.candidate.vault.locked, "Rejected stale resumption disposes the candidate root capability");
    await finishResume(test);
  }

  const test = await fixture();
  const staleVault = await LocalVault.unlock(test.oldManifest, test.source.recoverySecret);
  const staleStore = await EventStore.open({ vault: staleVault, engine });
  const staleManifest = await staleVault.addCredentialWrapper(crypto.getRandomValues(new Uint8Array(32)), { credentialId: "stale-tab-passkey", prfSalt: "stale-salt" });
  await EventStore.rotateProtection({ sourceVault: test.source.vault, candidateVault: test.candidate.vault, engine, prepareKeys, commitKeys });
  test.store.close();
  const currentVault = await LocalVault.unlock(await EventStore.securityStatus(), test.candidate.recoverySecret);
  const currentStore = await EventStore.open({ vault: currentVault, engine });
  await currentStore.append({ type: "add", text: "new content after recovery compromise replacement", classification: "need" }, engine);
  check((await currentStore.loadEvents()).length === 3, "New recovery key unlocks old and new canonical history");
  const copiedOldVault = await LocalVault.unlock(test.oldManifest, test.source.recoverySecret);
  const database = await rawDatabase(); const protectedRows = await snapshotStores(database, ["events"]); database.close();
  await reject(() => copiedOldVault.open(protectedRows.events.at(-1).protected_value, { store: "events", id: `n:${protectedRows.events.at(-1).local_sequence}` }), "Old secret plus copied old wrapper cannot decrypt newly protected content");
  await reject(() => EventStore.open({ vault: copiedOldVault, engine }), "Copied older manifest cannot open newer committed root");
  await reject(() => staleStore.append({ type: "add", text: "stale root append", classification: "need" }, engine), "Old tab cannot append after rotation");
  await reject(() => EventStore.updateSecurityManifest(staleManifest, staleVault), "Old tab cannot overwrite new manifest or re-add obsolete wrapper");
  await reject(() => EventStore.rotateProtection({ sourceVault: staleVault, candidateVault: test.candidate.vault, engine, prepareKeys, commitKeys }), "Stale root cannot initiate a competing rotation");
  check((await EventStore.securityStatus()).rootVersion === 2 && (await currentStore.loadEvents()).length === 3, "Rejected stale operations preserve published root and corpus");
  const next = await LocalVault.createRotation(currentVault);
  await EventStore.rotateProtection({ sourceVault: currentVault, candidateVault: next.vault, engine, prepareKeys, commitKeys });
  const latest = await EventStore.securityStatus();
  check(latest.rootVersion === 3, "A later completed rotation advances monotonically from root two to three");
  const latestVault = await LocalVault.unlock(latest, next.recoverySecret);
  const latestStore = await EventStore.open({ vault: latestVault, engine });
  check((await latestStore.loadEvents()).length === 3, "Second rotation preserves every canonical event");
  latestStore.close(); latestVault.lock(); next.vault.lock();
  copiedOldVault.lock(); staleStore.close(); staleVault.lock(); currentStore.close(); currentVault.lock(); test.candidate.vault.lock();
  engine.dispose(); await remove("kin"); await remove("kin-crypto-keys");
  return `PASS ${checks} local-root rotation interruption, journal, exact preservation, stale capability and old-secret assertions`;
}

// The runner reloads the document between these two calls. Only the separately
// saved synthetic recovery key survives in the host; no live vault/engine does.
export async function rootRotationRestartFixture({ resume = null, phase = "events-staged" } = {}) {
  const { LocalVault } = await import("/security/local-vault.js");
  const { EventStore } = await import("/storage/event-store.js");
  const { loadKinEngine } = await import("/wasm/kin-engine.js");
  const { migrateSyncKeys, finalizeSyncKeyMigration, prepareRootRotationKeys, commitRootRotationKeys } = await import("/sync/key-store.js");
  const engine = await loadKinEngine();
  const remove = (name) => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(Error("Restart fixture remains open")); });
  if (resume) {
    const marker = await EventStore.securityStatus();
    const vault = await LocalVault.unlock(marker.rotation?.candidateManifest ?? marker, resume.recoverySecret);
    await EventStore.resumeRotation({ candidateVault: vault, engine, prepareKeys: prepareRootRotationKeys, commitKeys: commitRootRotationKeys });
    const store = await EventStore.open({ vault, engine });
    const rows = await store.loadEvents();
    if (rows.length !== 1 || JSON.stringify(Array.from(rows[0].encoded_event)) !== JSON.stringify(resume.canonical)) throw Error("Reload did not recover exact canonical history");
    const manifest = await EventStore.securityStatus();
    if (manifest.rootVersion !== 2 || manifest.phase !== "encrypted" || manifest.rotation) throw Error("Reload did not finish the exact candidate root");
    store.close(); vault.lock(); engine.dispose(); await remove("kin"); await remove("kin-crypto-keys");
    return { checks: 2 };
  }
  await remove("kin"); await remove("kin-crypto-keys");
  const legacy = await EventStore.openLegacyForMigration();
  await legacy.append({ type: "add", text: "browser restart preserves canonical history", classification: "need" }, engine);
  const canonical = Array.from((await legacy.loadEvents())[0].encoded_event); legacy.close();
  const source = await LocalVault.create(); await EventStore.prepareSecurity(source.manifest);
  await EventStore.migrate({ vault: source.vault, engine, prepareKeys: (vault) => migrateSyncKeys(vault, { prepareOnly: true }), finalizeKeys: finalizeSyncKeyMigration });
  const store = await EventStore.open({ vault: source.vault, engine });
  const candidate = await LocalVault.createRotation(source.vault);
  let interrupted = false;
  try {
    await EventStore.rotateProtection({ sourceVault: source.vault, candidateVault: candidate.vault, engine, prepareKeys: prepareRootRotationKeys, commitKeys: commitRootRotationKeys,
      onPhase: async (current) => { if (current === phase) { interrupted = true; throw Error("process-style restart boundary"); } } });
  } catch (error) { if (!interrupted) throw error; }
  if (!interrupted) throw Error("Restart boundary not reached");
  store.close();
  return { recoverySecret: candidate.recoverySecret, canonical };
}
