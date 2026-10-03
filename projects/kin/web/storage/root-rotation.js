import { LocalVault, VaultError } from "../security/local-vault.js";
import { snapshotStores, protectRecord, unprotectRecord, recordIdentity, valuesEqual, compareStoreRows, PROTECTED_BATCH_SIZE } from "./encrypted-idb.js";

const SECURITY = "security_state";
const KEY = "vault";
const BATCH = PROTECTED_BATCH_SIZE;
const prefix = (rotation) => `root-rotation:${rotation.id}:`;
const stageKey = (rotation, store, row, definition) => `${prefix(rotation)}${store}:${recordIdentity(row[definition.keyPath])}`;
const failure = (message, code = "rotation_invalid") => new VaultError(message, code);

// A Web Lock coordinates the two databases. Each individual commit also checks
// its durable journal and epoch; the Web Lock alone is never write authority.
function coordinated(operation) {
  if (!globalThis.navigator?.locks?.request)
    throw failure("This browser cannot safely coordinate local protection changes. Saved data was preserved.");
  return navigator.locks.request("kin-security-migration", operation);
}

export function rotateEventProtection(options, contract) {
  return coordinated(async () => {
    const { sourceVault, candidateVault, engine, prepareKeys, commitKeys, onPhase = async () => {} } = options;
    requireCallbacks(engine, prepareKeys, commitKeys);
    sourceVault.assertUnlocked(); candidateVault.assertUnlocked();
    const database = await contract.openDatabase();
    try {
      const source = await readMarker(database);
      if (!matchesSource(source, sourceVault) || source.phase !== "encrypted")
        throw failure("Local protection changed. Unlock again before rotating it.", "security_changed");
      if (!Number.isSafeInteger(source.rootVersion) || source.rootVersion < 1 || source.rootVersion >= Number.MAX_SAFE_INTEGER ||
          candidateVault.vaultId !== source.vaultId || candidateVault.manifest.rootVersion !== source.rootVersion + 1 ||
          valuesEqual(candidateVault.root, sourceVault.root) ||
          candidateVault.manifest.wrappers?.length !== 1 || candidateVault.manifest.wrappers[0].type !== "recovery")
        throw failure("Kin requires a fresh root and a new verified recovery key.");
      if (await candidateVault.open(candidateVault.manifest.verifier, { store: "security", id: "verifier" }) !== "kin-vault-check-v1")
        throw failure("Kin could not verify the candidate local root.");
      const epoch = source.lockEpoch ?? 0, revision = source.configRevision ?? 0;
      if (![epoch, revision].every((value) => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER))
        throw failure("Kin could not safely advance local protection.");
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const candidateManifest = { ...structuredClone(candidateVault.manifest), key: KEY,
        phase: "encrypted", lockEpoch: epoch + 1, configRevision: revision + 1 };
      // Retain the old root only under the candidate root so interruption
      // recovery requires the new recovery key, not the retired wrapper.
      const root = sourceVault.root.slice();
      let sourceRoot;
      try { sourceRoot = await candidateVault.seal(root, { store: "root-rotation", id }); }
      finally { root.fill(0); }
      const rotation = { version: 1, id, stage: "begun", vaultId: source.vaultId, fromRootVersion: source.rootVersion,
        toRootVersion: candidateManifest.rootVersion, sourceManifest: source, candidateManifest, sourceRoot };
      const marker = { ...source, phase: "root-rotating", lockEpoch: epoch + 1, rotation };
      await changeMarker(database, source, marker, sourceVault, candidateVault);
      candidateVault.manifest = structuredClone(candidateManifest);
      candidateVault.securityEpoch = marker.lockEpoch;
      await onPhase("begun");
      return await continueRotation(database, { ...options, onPhase }, contract, marker);
    } finally { database.close(); }
  });
}

export function resumeEventProtection(options, contract) {
  return coordinated(async () => {
    const { candidateVault, engine, prepareKeys, commitKeys } = options;
    requireCallbacks(engine, prepareKeys, commitKeys);
    candidateVault.assertUnlocked();
    const database = await contract.openDatabase();
    let sourceVault;
    try {
      const marker = await readMarker(database);
      validateJournal(marker, candidateVault);
      const capabilityEpoch = candidateVault.securityEpoch ?? candidateVault.manifest.lockEpoch ?? 0;
      if (!Number.isSafeInteger(capabilityEpoch) || capabilityEpoch < 0 || capabilityEpoch !== (marker.lockEpoch ?? 0)) {
        candidateVault.lock();
        throw failure("Kin was locked after this recovery key was verified. Unlock the new recovery key again to resume.", "locked");
      }
      if (marker.phase === "root-rotating") {
        const rotation = marker.rotation;
        const root = await candidateVault.open(rotation.sourceRoot, { store: "root-rotation", id: rotation.id });
        try { sourceVault = new LocalVault(rotation.vaultId, root, rotation.sourceManifest); }
        finally { root.fill(0); }
        if (await sourceVault.open(rotation.sourceManifest.verifier, { store: "security", id: "verifier" }) !== "kin-vault-check-v1")
          throw failure("Kin could not verify the retained source root.");
      }
      candidateVault.securityEpoch = marker.lockEpoch ?? 0;
      return await continueRotation(database, { ...options, sourceVault }, contract, marker);
    } finally { sourceVault?.lock(); database.close(); }
  });
}

async function continueRotation(database, options, contract, marker) {
  const { sourceVault, candidateVault, engine, prepareKeys, commitKeys, onPhase = async () => {} } = options;
  const { definitions, validateRows } = contract;
  validateJournal(marker, candidateVault);
  let rotation = marker.rotation;
  const epoch = marker.lockEpoch ?? 0;
  const checkpoint = async (stage) => {
    const next = { ...marker, rotation: { ...rotation, stage } };
    await guardedWrite(database, marker, candidateVault, (transaction) => transaction.objectStore(SECURITY).put(next));
    marker = next; rotation = next.rotation;
  };
  const check = async () => {
    candidateVault.assertUnlocked();
    const current = await readMarker(database);
    if (!current || !["root-rotating", "root-cleanup"].includes(current.phase) ||
        current.vaultId !== rotation.vaultId || current.rotation?.id !== rotation.id ||
        (current.lockEpoch ?? 0) !== epoch || current.rotation.toRootVersion !== rotation.toRootVersion)
      throw failure("Kin was locked or local protection changed. Unlock the new recovery key to resume.", "locked");
    candidateVault.assertUnlocked();
    if (current.phase === "root-rotating") sourceVault?.assertUnlocked();
    return current;
  };
  if (marker.phase === "root-rotating") {
    sourceVault.assertUnlocked();
    const preparedKeys = await prepareKeys({ sourceVault, candidateVault, rotation, check });
    await checkpoint("keys-staged");
    await onPhase("keys-staged");
    await check();
    const original = await snapshotStores(database, Object.keys(definitions));
    const existing = (await readStageKeys(database)).filter((key) => typeof key === "string" && key.startsWith(prefix(rotation)));
    const protectedRows = {}, recoveredRows = {};
    const expectedStageKeys = new Set();
    for (const [store, rows] of Object.entries(original)) {
      protectedRows[store] = []; recoveredRows[store] = [];
      for (let offset = 0; offset < rows.length; offset += BATCH) {
        await check(); sourceVault.assertUnlocked();
        const page = rows.slice(offset, offset + BATCH);
        const savedPage = await readStages(database, page.map((source) => stageKey(rotation, store, source, definitions[store])));
        const batch = await Promise.all(page.map(async (source, index) => {
          const key = stageKey(rotation, store, source, definitions[store]);
          const value = await unprotectRecord(sourceVault, store, definitions[store], source);
          const saved = savedPage[index];
          if (saved && (saved.version !== 1 || saved.rotationId !== rotation.id || saved.vaultId !== rotation.vaultId ||
              saved.fromRootVersion !== rotation.fromRootVersion || saved.toRootVersion !== rotation.toRootVersion || saved.store !== store))
            throw failure("Kin found an inconsistent root-rotation staging record.");
          const row = saved?.row ?? await protectRecord(candidateVault, store, definitions[store], value);
          const recovered = await unprotectRecord(candidateVault, store, definitions[store], row);
          if (!valuesEqual(value, recovered)) throw failure("Kin could not verify the complete replacement history.");
          return { key, version: 1, rotationId: rotation.id, vaultId: rotation.vaultId,
            fromRootVersion: rotation.fromRootVersion, toRootVersion: rotation.toRootVersion, store, row, recovered };
        }));
        await guardedWrite(database, marker, candidateVault, (transaction) => {
          for (const { recovered, ...record } of batch) transaction.objectStore(SECURITY).put(record);
        });
        for (const record of batch) {
          expectedStageKeys.add(record.key);
          protectedRows[store].push(record.row); recoveredRows[store].push(record.recovered);
        }
        await onPhase("event-stage-batch", { store, offset, count: batch.length });
      }
    }
    if (existing.some((key) => !expectedStageKeys.has(key)))
      throw failure("Kin found unexpected root-rotation staging records.");
    await checkpoint("events-staged");
    await onPhase("events-staged");
    await check();
    for (const [store, rows] of Object.entries(protectedRows)) {
      for (let offset = 0; offset < rows.length; offset += BATCH) {
        await check();
        const keys = rows.slice(offset, offset + BATCH).map((row) => stageKey(rotation, store, row, definitions[store]));
        const staged = await readStages(database, keys);
        await Promise.all(staged.map(async (record, index) => {
          if (!record || record.version !== 1 || record.key !== keys[index] || record.rotationId !== rotation.id ||
              record.vaultId !== rotation.vaultId || record.fromRootVersion !== rotation.fromRootVersion ||
              record.toRootVersion !== rotation.toRootVersion || record.store !== store)
            throw failure("Kin could not read the complete staged replacement.");
          const recovered = await unprotectRecord(candidateVault, store, definitions[store], record.row);
          if (!valuesEqual(recovered, recoveredRows[store][offset + index]))
            throw failure("Kin could not verify the persisted replacement history.");
          rows[offset + index] = record.row;
        }));
      }
    }
    validateRows(recoveredRows, engine);
    for (const state of recoveredRows.sync_state ?? []) {
      if (state.pendingRotation?.sealed) {
        if (!preparedKeys?.verifyPendingRotation) throw failure("Kin could not verify the pending sync key.");
        await preparedKeys.verifyPendingRotation(state.pendingRotation);
      }
    }
    // Archive capability is independently authenticated before retiring source
    // wrappers. Recovery-wrapper proof was required when creating the candidate.
    const archiveProbe = await candidateVault.sealArchive({ rotationId: rotation.id });
    if ((await candidateVault.openArchive(archiveProbe)).rotationId !== rotation.id)
      throw failure("Kin could not verify the new archive capability.");
    await checkpoint("verified");
    await onPhase("verified");
    await check();
    await checkpoint("commit-pending");
    await onPhase("commit-pending");
    await check();
    const { sourceManifest, sourceRoot, candidateManifest, ...summary } = rotation;
    summary.stage = "events-committed";
    const replacement = { ...candidateManifest, key: KEY, lockEpoch: epoch, phase: "root-cleanup", rotation: summary };
    await replaceEvents(database, marker, replacement, original, protectedRows, candidateVault);
    marker = replacement; rotation = summary;
    candidateVault.manifest = structuredClone(replacement);
    candidateVault.securityEpoch = epoch;
    sourceVault.lock();
    await onPhase("events-committed");
  }
  await check();
  await commitKeys({ candidateVault, rotation, check });
  await checkpoint("keys-committed");
  await onPhase("keys-committed");
  await check();
  await checkpoint("cleanup-pending");
  await onPhase("cleanup-pending");
  await check();
  const { rotation: discarded, ...manifest } = marker;
  manifest.phase = "encrypted";
  await guardedWrite(database, marker, candidateVault, (transaction) => {
    const store = transaction.objectStore(SECURITY);
    const request = store.getAllKeys();
    request.onsuccess = () => {
      try {
        candidateVault.assertUnlocked();
        for (const key of request.result) if (typeof key === "string" && key.startsWith(prefix(rotation))) store.delete(key);
        store.put(manifest);
      } catch (error) { transaction.__kinFailure = error; transaction.abort(); }
    };
  });
  candidateVault.manifest = structuredClone(manifest);
  candidateVault.securityEpoch = epoch;
  await onPhase("complete");
  return manifest;
}

function requireCallbacks(engine, prepareKeys, commitKeys) {
  if (!engine || typeof prepareKeys !== "function" || typeof commitKeys !== "function")
    throw failure("Kin requires full event and device-key verification before rotating local protection.");
}

function matchesSource(marker, vault) {
  return marker && marker.vaultId === vault.vaultId && marker.rootVersion === vault.manifest.rootVersion &&
    (marker.lockEpoch ?? 0) === (vault.securityEpoch ?? vault.manifest.lockEpoch ?? 0) &&
    (marker.configRevision ?? 0) === (vault.manifest.configRevision ?? 0) && valuesEqual(marker.verifier, vault.manifest.verifier);
}

function validateJournal(marker, vault) {
  const r = marker?.rotation;
  if (!["root-rotating", "root-cleanup"].includes(marker?.phase) || !r || r.version !== 1 ||
      !/^[a-f0-9]{32}$/.test(r.id) || r.vaultId !== marker.vaultId || r.vaultId !== vault.vaultId ||
      !Number.isSafeInteger(r.fromRootVersion) || r.fromRootVersion < 1 || r.toRootVersion !== r.fromRootVersion + 1 ||
      r.toRootVersion !== vault.manifest.rootVersion ||
      !valuesEqual((marker.phase === "root-rotating" ? r.candidateManifest : marker)?.verifier, vault.manifest.verifier) ||
      (marker.phase === "root-rotating" && (marker.rootVersion !== r.fromRootVersion || r.sourceManifest?.rootVersion !== r.fromRootVersion ||
        r.sourceManifest.vaultId !== r.vaultId || !valuesEqual(r.sourceManifest.verifier, marker.verifier) ||
        r.candidateManifest?.rootVersion !== r.toRootVersion || r.candidateManifest.vaultId !== r.vaultId || !r.sourceRoot)) ||
      (marker.phase === "root-cleanup" && marker.rootVersion !== r.toRootVersion))
    throw failure("Kin found a mismatched or unsupported local-root rotation. Saved data was preserved.");
}

async function readMarker(database) {
  return (await readStages(database, [KEY]))[0] ?? null;
}

function readStages(database, keys) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SECURITY, "readonly");
    const rows = new Array(keys.length);
    for (let index = 0; index < keys.length; index += 1) {
      const request = transaction.objectStore(SECURITY).get(keys[index]);
      request.onsuccess = () => { rows[index] = request.result; };
    }
    transaction.oncomplete = () => resolve(rows);
    transaction.onabort = () => reject(transaction.error ?? failure("The rotation journal could not be read."));
    transaction.onerror = () => {};
  });
}

function readStageKeys(database) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SECURITY, "readonly");
    const request = transaction.objectStore(SECURITY).getAllKeys();
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? failure("The rotation staging keys could not be read."));
    transaction.onerror = () => {};
  });
}

function guardedWrite(database, expected, vault, schedule, names = [SECURITY]) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(names, "readwrite");
    const unsubscribe = vault.onLock?.(() => {
      transaction.__kinFailure ??= failure("Kin locked before local protection could commit.", "locked");
      try { transaction.abort(); } catch { /* The transaction has already ended. */ }
    });
    transaction.oncomplete = () => { unsubscribe?.(); resolve(); };
    transaction.onabort = () => {
      unsubscribe?.(); reject(transaction.__kinFailure ?? transaction.error ?? failure("The rotation transaction was interrupted."));
    };
    transaction.onerror = () => {};
    const request = transaction.objectStore(SECURITY).get(KEY);
    request.onsuccess = () => {
      try {
        vault.assertUnlocked();
        if (!valuesEqual(request.result, expected)) throw failure("Local protection changed before the rotation could commit.", "locked");
        schedule(transaction);
      } catch (error) { transaction.__kinFailure = error; transaction.abort(); }
    };
  });
}

function changeMarker(database, expected, replacement, sourceVault, candidateVault) {
  const guard = {
    assertUnlocked() { sourceVault.assertUnlocked(); candidateVault.assertUnlocked(); },
    onLock(callback) {
      const source = sourceVault.onLock(callback), candidate = candidateVault.onLock(callback);
      return () => { source(); candidate(); };
    },
  };
  return guardedWrite(database, expected, guard, (transaction) => transaction.objectStore(SECURITY).put(replacement));
}

function replaceEvents(database, expected, replacement, original, protectedRows, vault) {
  const names = [...Object.keys(original), SECURITY];
  return guardedWrite(database, expected, vault, (transaction) => {
    let remaining = Object.keys(original).length;
    const complete = () => {
        if (--remaining) return;
        try {
          vault.assertUnlocked();
          for (const [store, rows] of Object.entries(protectedRows)) {
            const target = transaction.objectStore(store); target.clear();
            for (const row of rows) target.put(row);
          }
          transaction.objectStore(SECURITY).put(replacement);
        } catch (error) { transaction.__kinFailure = error; transaction.abort(); }
    };
    for (const name of Object.keys(original)) {
      compareStoreRows(transaction, name, original[name], {
        check: () => vault.assertUnlocked(), complete,
        fail: (error) => { transaction.__kinFailure = error; transaction.abort(); },
      });
    }
  }, names);
}
