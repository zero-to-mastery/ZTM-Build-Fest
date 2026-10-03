// Isolated real-browser coverage; never run against a user's browser profile.
export async function rootKeyRotationRegression() {
  const { LocalVault } = await import("/security/local-vault.js");
  const { SyncKeyStore, migrateSyncKeys, finalizeSyncKeyMigration,
    prepareRootRotationKeys, commitRootRotationKeys } = await import("/sync/key-store.js");
  const { createHouseholdEpochKey, encryptEvent, decryptEvent, generateProtectedDeviceKeys } = await import("/sync/crypto.js");
  const { valuesEqual, unprotectRecord, protectRecord } = await import("/storage/encrypted-idb.js");
  const name = "kin-crypto-keys";
  const identity = { householdId: "a".repeat(32), memberId: "b".repeat(32), deviceId: "c".repeat(32) };
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const reject = async (action, message) => {
    let failed = false;
    try { await action(); } catch { failed = true; }
    check(failed, message);
  };
  const removeDatabase = () => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Key rotation fixture still has an open database."));
  });
  await removeDatabase();
  const source = await LocalVault.create();
  let candidate, peer, restored, store, peerStore, current;
  try {
    await migrateSyncKeys(source.vault);
    await finalizeSyncKeyMigration(source.vault);
    store = await SyncKeyStore.open({ vault: source.vault });
    await store.getOrCreatePendingDevice();
    const device = await store.bindPendingDevice(identity);
    const epoch = await createHouseholdEpochKey({ householdId: identity.householdId, keyEpoch: 1, deviceKeys: device.keys });
    const pendingEpoch = await createHouseholdEpochKey({ householdId: identity.householdId, keyEpoch: 2, deviceKeys: device.keys });
    await store.saveEpoch({ householdId: identity.householdId, keyEpoch: 1, ...epoch });
    await store.pinTrustedDevice({ ...identity, deviceId: "d".repeat(32), publicKeys: device.publicKeys, fingerprint: device.fingerprint });
    store.close(); store = null;
    peer = await LocalVault.unlock(source.manifest, source.recoverySecret);
    peerStore = await SyncKeyStore.open({ vault: peer });
    const original = await snapshot();
    candidate = await LocalVault.createRotation(source.vault);
    const rotation = { version: 1, id: "e".repeat(32), vaultId: source.vault.vaultId,
      fromRootVersion: source.manifest.rootVersion, toRootVersion: candidate.manifest.rootVersion,
      sourceManifest: source.manifest, candidateManifest: candidate.manifest };

    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value, ...args) {
      if (this.name === "security_state" && value?.purpose === "kin.local-root-key-stage.v1")
        throw new DOMException("Injected staging quota failure", "QuotaExceededError");
      return add.call(this, value, ...args);
    };
    try {
      await reject(() => prepareRootRotationKeys({ sourceVault: source.vault, candidateVault: candidate.vault, rotation }),
        "quota failure must interrupt key staging");
    } finally { IDBObjectStore.prototype.add = add; }
    check(valuesEqual((await snapshot()).data, original.data), "quota failure must preserve the complete source key corpus");
    await reject(() => peerStore.getDevice(identity.deviceId), "a peer's old-root key capability must stop at the rotation fence");
    check(peer.locked, "the rejected stale peer must drop its local root capability");
    peerStore.close(); peerStore = null;

    let steps = 0;
    await reject(() => prepareRootRotationKeys({ sourceVault: source.vault, candidateVault: candidate.vault, rotation,
      check: async () => { if (++steps === 5) throw new Error("Injected interruption between key stages"); } }),
    "an interruption during staging must be reported");
    const interrupted = await snapshot();
    check(interrupted.security.some(row => row.purpose === "kin.local-root-key-stage.v1"), "the interrupted rotation retains an exact encrypted stage");
    check(valuesEqual(interrupted.data, original.data), "staging never replaces the authoritative source rows");
    const prepared = await prepareRootRotationKeys({ sourceVault: source.vault, candidateVault: candidate.vault, rotation });
    const staged = await snapshot();
    for (const row of interrupted.security.filter(row => row.purpose === "kin.local-root-key-stage.v1"))
      check(valuesEqual(row, staged.security.find(candidate => candidate.key === row.key)), "resume must reuse the exact already staged ciphertext");
    await prepared.verifyPendingRotation({ epoch: 2, sealed: pendingEpoch.sealed, fingerprint: pendingEpoch.fingerprint });
    checks++;
    await reject(() => prepared.verifyPendingRotation({ epoch: 2, sealed: pendingEpoch.sealed, fingerprint: "0".repeat(64) }),
      "pending rotation secret fingerprint corruption must fail verification");
    await reject(() => prepareRootRotationKeys({ sourceVault: source.vault, candidateVault: candidate.vault,
      rotation: { ...rotation, id: "f".repeat(32) } }), "a competing rotation cannot replace the frozen key journal");
    await reject(() => commitRootRotationKeys({ candidateVault: candidate.vault,
      rotation: { ...rotation, fromRootVersion: 0 } }), "an invalid source root cannot commit candidate keys");

    const firstStage = staged.security.find(row => row.purpose === "kin.local-root-key-stage.v1");
    const damaged = structuredClone(firstStage);
    const sealed = damaged.candidate.protected_value;
    sealed.ciphertext = (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1);
    await putSecurity(damaged);
    await reject(() => commitRootRotationKeys({ candidateVault: candidate.vault, rotation }), "corrupt final staging must not publish any key replacement");
    check(valuesEqual((await snapshot()).data, original.data), "failed verification preserves every source key");
    await putSecurity(firstStage);
    const extra = { ...firstStage, key: `${firstStage.key}:unexpected` };
    await putSecurity(extra);
    await reject(() => commitRootRotationKeys({ candidateVault: candidate.vault, rotation }), "unexpected duplicate stage routing must fail closed");
    await putSecurity(null, extra.key);

    candidate.vault.lock();
    restored = await LocalVault.unlock(candidate.manifest, candidate.recoverySecret);
    const summary = { version: rotation.version, id: rotation.id, vaultId: rotation.vaultId,
      fromRootVersion: rotation.fromRootVersion, toRootVersion: rotation.toRootVersion };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      const result = put.call(this, value, ...args);
      if (this.name === "security_state" && value?.completedRotationId === rotation.id) restored.lock();
      return result;
    };
    try {
      await reject(() => commitRootRotationKeys({ candidateVault: restored, rotation: summary }),
        "a local lock after queued key publication must abort the native transaction");
    } finally { IDBObjectStore.prototype.put = put; }
    check(valuesEqual((await snapshot()).data, original.data), "lock during the final transaction preserves all source key rows");
    restored = await LocalVault.unlock(candidate.manifest, candidate.recoverySecret);
    await commitRootRotationKeys({ candidateVault: restored, rotation: summary });
    const committed = await snapshot();
    check(committed.security.length === 1 && committed.security[0].rootVersion === rotation.toRootVersion,
      "key publication atomically removes all stages and records the new root version");
    await commitRootRotationKeys({ candidateVault: restored, rotation: summary });
    check(valuesEqual(await snapshot(), committed), "repeating a completed key commit must preserve exact ciphertext");
    await reject(() => SyncKeyStore.open({ vault: source.vault }), "an old copied manifest/root cannot reopen the new key database");
    await reject(() => unprotectRecord(source.vault, "devices", { keyPath: "deviceId" }, committed.data.devices[0]),
      "the copied old root cannot decrypt the newly protected private key serialization");
    current = await SyncKeyStore.open({ vault: restored });
    const nextDevice = await current.getDevice(identity.deviceId);
    const nextEpoch = await current.getEpoch(identity.householdId, 1);
    check(nextDevice.fingerprint === device.fingerprint && nextDevice.keys.signingPrivateKey.extractable === false,
      "local rotation preserves the device identity and nonextractable runtime signing key");
    check(valuesEqual(nextEpoch.sealed, epoch.sealed) && nextEpoch.fingerprint === epoch.fingerprint,
      "local rotation preserves the exact household epoch seal and key fingerprint");
    check(valuesEqual(await current.getPinnedDevice(identity.householdId, "d".repeat(32)),
      await source.vault.open(original.data.trusted_devices[0].protected_value,
        { store: "trusted_devices", id: `s:${identity.householdId}:${"d".repeat(32)}` })),
    "local rotation preserves trusted-device pins");
    const plaintext = new TextEncoder().encode("history after local root replacement");
    const envelope = await encryptEvent({ ...identity, eventId: "1".repeat(32), deviceSequence: 1,
      logicalTime: 1, keyEpoch: 1, plaintext, householdKey: nextEpoch.householdKey,
      signingKey: nextDevice.keys.signingPrivateKey });
    check(valuesEqual(await decryptEvent({ envelope, householdKey: epoch.householdKey,
      signingKey: device.keys.signingPublicKey }), plaintext), "transport encryption and signatures retain their original keys");
    current.close(); current = null;
    await privateScalarCorruption();
    return `PASS ${checks} local-root key rotation, quota/interruption recovery, stale guards, exact stages, corruption, restart and transport identity assertions`;
  } finally {
    store?.close(); peerStore?.close(); current?.close();
    source.vault.lock(); candidate?.vault.lock(); peer?.lock(); restored?.lock();
    await removeDatabase();
  }

  async function openRaw() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async function privateScalarCorruption() {
    // Some platforms reject mismatched JWK scalars on import; others permit the
    // import but must fail the actual signing/agreement capability verification.
    for (const purpose of ["signing", "agreement"]) {
      await removeDatabase();
      const fixture = await LocalVault.create();
      let replacement, fixtureStore;
      try {
        await migrateSyncKeys(fixture.vault); await finalizeSyncKeyMigration(fixture.vault);
        fixtureStore = await SyncKeyStore.open({ vault: fixture.vault });
        await fixtureStore.getOrCreatePendingDevice();
        fixtureStore.close(); fixtureStore = null;
        const before = await snapshot();
        const definition = { keyPath: "deviceId" };
        const device = await unprotectRecord(fixture.vault, "devices", definition, before.data.devices[0]);
        const other = await generateProtectedDeviceKeys();
        device.serializedKeys[purpose].d = other.serializedKeys[purpose].d;
        const corrupt = await protectRecord(fixture.vault, "devices", definition, device);
        const database = await openRaw();
        try {
          await new Promise((resolve, reject) => {
            const tx = database.transaction("devices", "readwrite"); tx.objectStore("devices").put(corrupt);
            tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
          });
        } finally { database.close(); }
        const preserved = (await snapshot()).data;
        replacement = await LocalVault.createRotation(fixture.vault);
        const rotation = { version: 1, id: "f".repeat(32), vaultId: fixture.vault.vaultId,
          fromRootVersion: 1, toRootVersion: 2, sourceManifest: fixture.manifest, candidateManifest: replacement.manifest };
        await reject(() => prepareRootRotationKeys({ sourceVault: fixture.vault, candidateVault: replacement.vault, rotation }),
          `a mismatched ${purpose} private scalar must not pass replacement verification`);
        check(valuesEqual((await snapshot()).data, preserved), `failed ${purpose} capability verification must preserve source ciphertext`);
      } finally { fixtureStore?.close(); fixture.vault.lock(); replacement?.vault.lock(); }
    }
  }
  async function snapshot() {
    const database = await openRaw();
    try {
      return await new Promise((resolve, reject) => {
        const names = ["devices", "epochs", "trusted_devices", "security_state"];
        const transaction = database.transaction(names, "readonly"), data = {};
        let security;
        for (const store of names) {
          const request = transaction.objectStore(store).getAll();
          request.onsuccess = () => { if (store === "security_state") security = request.result; else data[store] = request.result; };
        }
        transaction.oncomplete = () => resolve({ data, security });
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }
  async function putSecurity(row, key) {
    const database = await openRaw();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("security_state", "readwrite");
        if (row) transaction.objectStore("security_state").put(row);
        else transaction.objectStore("security_state").delete(key);
        transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }
}
