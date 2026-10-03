// Execute in the existing isolated real-browser harness; no application DBs used.
export async function rotationStorageRegression() {
  const { LocalVault } = await import("/security/local-vault.js");
  const { encryptedDatabase } = await import("/storage/encrypted-idb.js");
  const { EventStore, EVENT_STORE_DEFINITIONS } = await import("/storage/event-store.js");
  const { loadKinEngine } = await import("/wasm/kin-engine.js");
  const engine = await loadKinEngine();
  const { vault } = await LocalVault.create();
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const reject = async (action, message) => {
    let failed = false;
    try { await action(); } catch { failed = true; }
    check(failed, message);
  };
  const name = "kin-rotation-regression";
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      for (const [name, definition] of Object.entries(EVENT_STORE_DEFINITIONS)) {
        const store = request.result.createObjectStore(name, {
          keyPath: definition.keyPath, ...(name === "events" ? { autoIncrement: true } : {}),
        });
        for (const [index, path] of Object.entries(definition.indexes ?? {}))
          store.createIndex(index, path, { unique: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const store = new EventStore(encryptedDatabase(database, vault, EVENT_STORE_DEFINITIONS));
  try {
    await store.ensureContext();
    await store.initializeSync({
      identity: { householdId: "11".repeat(16), memberId: "22".repeat(16), deviceId: "33".repeat(16) },
      serverStatus: { currentEpoch: 1, pendingEpoch: 2, rotationPending: true },
    });
    const original = { expectedEpoch: 1, epoch: 2, proposalId: "44".repeat(16),
      sealed: { test: "same sealed epoch" }, fingerprint: "55".repeat(32),
      packages: [{ test: "original" }], issuerFingerprint: "66".repeat(32) };
    await store.savePendingRotation(original);
    const refreshed = await store.replacePendingRotationPackages({
      expected: original, packages: [{ test: "renewed" }], issuerFingerprint: original.issuerFingerprint,
    });
    check(refreshed.proposalId === original.proposalId && refreshed.fingerprint === original.fingerprint &&
      refreshed.sealed.test === original.sealed.test, "refresh must preserve the proposed epoch identity and secret");
    await reject(() => store.replacePendingRotationPackages({ expected: original, packages: [], issuerFingerprint: original.issuerFingerprint }),
      "a stale tab cannot overwrite already refreshed packages");
    const raced = await Promise.allSettled(["one", "two"].map(test => store.replacePendingRotationPackages({
      expected: refreshed, packages: [{ test }], issuerFingerprint: original.issuerFingerprint,
    })));
    check(raced.filter(result => result.status === "fulfilled").length === 1 &&
      raced.filter(result => result.status === "rejected").length === 1,
    "concurrent package refresh must have one atomic winner");
    check(await store.clearPendingRotation("ff".repeat(16)) === false,
      "a different proposal cannot clear the pending rotation");
    await reject(() => store.commitPendingRotation({ expectedEpoch: 1, currentEpoch: 2, proposalId: "ff".repeat(16) }),
      "a different proposal cannot acknowledge the pending rotation");

    // The first rotation committed, but a subsequent revocation already needs
    // epoch 3. A local append during lost-response recovery must await epoch 3.
    await store.updateSyncServerState({ currentEpoch: 2, pendingEpoch: 3, rotationPending: true });
    await store.commitPendingRotation({ expectedEpoch: 1, currentEpoch: 2, proposalId: original.proposalId });
    const acknowledged = await store.getSyncState();
    check(acknowledged.rotationPending && acknowledged.pendingEpoch === 3 && acknowledged.pendingRotation === null,
      "acknowledging the old proposal must retain the newer access-change barrier");
    await store.append({ type: "add", text: "After revocation", classification: "need" }, engine);
    const waiting = await store.getPendingOutbox();
    check(waiting.length === 1 && waiting[0].keyEpoch === null && waiting[0].envelope === null,
      "new changes cannot bind to the pre-revocation epoch during recovery");
    await store.updateSyncServerState({ currentEpoch: 3, pendingEpoch: null, rotationPending: false });
    check((await store.getPendingOutbox())[0].keyEpoch === 3,
      "the authoritative completed rotation releases new changes into the new epoch");

    const newer = { ...original, expectedEpoch: 3, epoch: 4, proposalId: "77".repeat(16) };
    await store.savePendingRotation(newer);
    check(await store.clearPendingRotation(original.proposalId) === false,
      "a delayed old-proposal cleanup cannot remove the next rotation");
    await reject(() => store.commitPendingRotation({ expectedEpoch: 1, currentEpoch: 2, proposalId: original.proposalId }),
      "a delayed old acknowledgement cannot roll back or clear the next rotation");
    await reject(() => store.replacePendingRotationPackages({ expected: original, packages: [], issuerFingerprint: original.issuerFingerprint }),
      "a delayed refresh cannot replace the next rotation");
    check((await store.getSyncState()).pendingRotation.proposalId === newer.proposalId,
      "the current rotation survives all stale operations");
    return `PASS ${checks} encrypted rotation storage, concurrent refresh, stale proposal and post-revocation append assertions`;
  } finally {
    store.close();
    vault.lock();
    engine.dispose?.();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Rotation regression database remained open."));
    });
  }
}
