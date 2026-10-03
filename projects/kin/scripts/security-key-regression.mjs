// Run in an isolated browser profile before application setup, never user storage.
export async function keyMigrationRegression() {
  let checks = 0;
  const { LocalVault } = await import('/security/local-vault.js');
  const { SyncKeyStore, migrateSyncKeys, finalizeSyncKeyMigration } = await import('/sync/key-store.js');
  const { generateDeviceKeys, exportDevicePublicKeys, deviceKeyFingerprint, createHouseholdEpochKey,
    restoreHouseholdEpochKey, encryptEvent, decryptEvent } = await import('/sync/crypto.js');
  const assertFails = async action => {
    let failed = false;
    try { await action(); } catch { failed = true; }
    if (!failed) throw new Error('Expected the protected key operation to fail closed.');
    checks += 1;
  };
  const check = (value, message) => { if (!value) throw new Error(message); checks += 1; };
  const name = 'kin-crypto-keys';
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close key store connections before isolated regression.'));
  });
  const raw = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 3);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('devices', { keyPath: 'deviceId' });
      request.result.createObjectStore('epochs', { keyPath: 'key' }).createIndex('household_id', 'householdId');
      request.result.createObjectStore('trusted_devices', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const identity = { householdId: 'a'.repeat(32), memberId: 'b'.repeat(32), deviceId: 'c'.repeat(32) };
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  const fingerprint = await deviceKeyFingerprint(publicKeys);
  const epoch = await createHouseholdEpochKey({ householdId: identity.householdId, keyEpoch: 1, deviceKeys: keys });
  const rotation = await createHouseholdEpochKey({ householdId: identity.householdId, keyEpoch: 2, deviceKeys: keys });
  await new Promise((resolve, reject) => {
    const tx = raw.transaction(['devices', 'epochs'], 'readwrite');
    tx.objectStore('devices').add({ ...identity, keys, publicKeys, fingerprint });
    tx.objectStore('epochs').add({ key: `${identity.householdId}:1`, householdId: identity.householdId, keyEpoch: 1, ...epoch });
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
  });
  raw.close();
  const { vault, manifest, recoverySecret } = await LocalVault.create();
  const conflicting = await createHouseholdEpochKey({ householdId: identity.householdId, keyEpoch: 1, deviceKeys: keys });
  await writeLegacyEpoch({ ...epoch, sealed: conflicting.sealed, fingerprint: conflicting.fingerprint });
  await assertFails(() => migrateSyncKeys(vault, { prepareOnly: true }));
  const rejectedRows = await rawRows();
  check(rejectedRows.epochs[0].householdKey instanceof CryptoKey && rejectedRows.devices[0].keys.signingPrivateKey instanceof CryptoKey,
    'AES/sealed mismatch must preserve every original key capability');
  check(rejectedRows.security_state.length === 0, 'AES/sealed mismatch must not commit a migration journal');
  await writeLegacyEpoch(epoch);
  const checkingVault = await LocalVault.unlock(manifest, recoverySecret);
  let preparationChecks = 0;
  await assertFails(() => migrateSyncKeys(checkingVault, { check: async () => {
    if (++preparationChecks === 3) { checkingVault.lock(); throw new Error('Injected durable peer epoch change between keys'); }
  } }));
  const interruptedCheck = await rawRows();
  check(preparationChecks === 3 && interruptedCheck.security_state.length === 0 &&
    interruptedCheck.devices[0].keys.signingPrivateKey instanceof CryptoKey,
  'durable per-key check must stop before staging and preserve the legacy source');
  const preparingVault = await LocalVault.unlock(manifest, recoverySecret);
  await assertFails(() => lockDuringMetadataWrite('preparing', preparingVault,
    () => migrateSyncKeys(preparingVault, { prepareOnly: true })));
  const interruptedPreparation = await rawRows();
  check(interruptedPreparation.security_state.length === 0 && interruptedPreparation.devices[0].keys.signingPrivateKey instanceof CryptoKey,
    'locking after queued journal write must abort preparation and preserve the legacy source');
  await migrateSyncKeys(vault, { prepareOnly: true });
  await assertFails(() => SyncKeyStore.open({ vault }));
  const staged = await rawRows();
  check(staged.devices[0].keys.signingPrivateKey instanceof CryptoKey, 'legacy key preserved before verification');
  const firstStage = JSON.stringify(staged.security_state);
  const resumed = await migrateSyncKeys(vault, { prepareOnly: true });
  check(firstStage === JSON.stringify((await rawRows()).security_state), 'resume must reuse exact staged successor');
  const eventRows = await resumed.rewrapEventRows({ sync_state: [{ key: 'active', pendingRotation: { sealed: rotation.sealed } }] });
  const batchVault = await LocalVault.unlock(manifest, recoverySecret);
  let protectionChecks = 0;
  await assertFails(() => finalizeSyncKeyMigration(batchVault, { check: async () => {
    if (++protectionChecks === 3) { batchVault.lock(); throw new Error('Injected durable peer epoch change after a key batch'); }
  } }));
  const interruptedBatch = await rawRows();
  check(protectionChecks === 3 && JSON.stringify(interruptedBatch.security_state) === firstStage &&
    interruptedBatch.devices[0].keys.signingPrivateKey instanceof CryptoKey,
  'durable batch check must preserve all legacy keys and exact staged successor');
  const committingVault = await LocalVault.unlock(manifest, recoverySecret);
  await assertFails(() => lockDuringMetadataWrite('encrypted', committingVault,
    () => finalizeSyncKeyMigration(committingVault)));
  const interruptedCommit = await rawRows();
  check(JSON.stringify(interruptedCommit.security_state) === firstStage &&
    interruptedCommit.devices[0].keys.signingPrivateKey instanceof CryptoKey &&
    interruptedCommit.epochs[0].householdKey instanceof CryptoKey,
  'locking after queued final metadata must restore all original keys and the exact migration journal');
  await finalizeSyncKeyMigration(vault);
  const store = await SyncKeyStore.open({ vault });
  const device = await store.getDevice(identity.deviceId);
  check(device.keys.signingPrivateKey.extractable === false, 'runtime signing key must not be extractable');
  check(device.pendingTransition.oldFingerprint === fingerprint, 'transition must retain authenticated predecessor');
  const restored = await store.getEpoch(identity.householdId, 1);
  const pendingKey = await restoreHouseholdEpochKey({ sealed: eventRows.sync_state[0].pendingRotation.sealed, deviceKeys: device.keys });
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, rotation.householdKey, new Uint8Array([42]));
  check(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, pendingKey, encrypted))[0] === 42, 'pending rotation must survive key migration');
  const persisted = await rawRows();
  for (const name of ['devices', 'epochs', 'trusted_devices']) for (const row of persisted[name]) {
    check(row.protected_version === 1, 'all key rows must be protected');
    check(!row.keys && !row.householdKey && !row.serializedKeys && !row.pendingTransition, 'no persisted usable private material');
  }
  check(!persisted.security_state[0].staging, 'final commit must remove migration staging');
  const plaintext = new TextEncoder().encode('retained history');
  const envelope = await encryptEvent({ ...identity, eventId: 'd'.repeat(32), deviceSequence: 1, logicalTime: 1,
    keyEpoch: 1, plaintext, householdKey: epoch.householdKey, signingKey: keys.signingPrivateKey });
  check(new TextDecoder().decode(await decryptEvent({ envelope, householdKey: restored.householdKey, signingKey: keys.signingPublicKey })) === 'retained history', 'historical epoch unchanged');
  await trustedPinRegression();
  store.close();
  vault.lock();
  await assertFails(() => store.getDevice(identity.deviceId));
  const reopenedVault = await LocalVault.unlock(manifest, recoverySecret);
  const reopened = await SyncKeyStore.open({ vault: reopenedVault });
  check((await reopened.getEpoch(identity.householdId, 1)).householdKey instanceof CryptoKey, 'reload must restore protected epoch');
  reopened.close(); reopenedVault.lock();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
  });
  return `PASS ${checks} legacy key migration, mismatch preservation, durable batch cancellation, native lock rollback, rotation reseal, protected recovery and trusted-pin assertions`;

  async function lockDuringMetadataWrite(phase, targetVault, action) {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      const request = original.call(this, value, ...args);
      if (this.name === 'security_state' && value?.key === 'vault' && value.phase === phase) targetVault.lock();
      return request;
    };
    try { return await action(); }
    finally { IDBObjectStore.prototype.put = original; targetVault.lock(); }
  }

  async function trustedPinRegression() {
    const candidate = { ...identity, deviceId: 'e'.repeat(32), publicKeys, fingerprint };
    const otherKeys = await exportDevicePublicKeys(await generateDeviceKeys());
    const otherFingerprint = await deviceKeyFingerprint(otherKeys);
    const first = await delayedDigest(() => store.pinTrustedDevice(candidate));
    check(first.fingerprint === fingerprint, 'delayed fingerprint must allow a new trusted pin');
    check((await store.getPinnedDevice(identity.householdId, candidate.deviceId)).fingerprint === fingerprint,
      'new trusted pin must be committed before the operation resolves');
    const repeated = await delayedDigest(() => store.pinTrustedDevice(candidate));
    check(JSON.stringify(repeated) === JSON.stringify(first), 'delayed fingerprint must preserve an existing matching pin');
    const invalid = { ...candidate, deviceId: 'f'.repeat(32), fingerprint: otherFingerprint };
    await assertFails(() => delayedDigest(() => store.pinTrustedDevice(invalid)));
    check(await store.getPinnedDevice(identity.householdId, invalid.deviceId) === null,
      'a mismatched fingerprint must not persist a pin');
    await assertFails(() => delayedDigest(() => store.pinTrustedDevice({
      ...candidate, publicKeys: otherKeys, fingerprint: otherFingerprint,
    })));
    check((await store.getPinnedDevice(identity.householdId, candidate.deviceId)).fingerprint === fingerprint,
      'conflicting trusted key material must preserve the established pin');

    const mutable = { ...candidate, deviceId: '1'.repeat(32), publicKeys: structuredClone(publicKeys) };
    const saved = await delayedDigest(() => store.pinTrustedDevice(mutable), () => {
      Object.assign(mutable.publicKeys, otherKeys);
    });
    const persisted = await store.getPinnedDevice(identity.householdId, mutable.deviceId);
    check(await deviceKeyFingerprint(saved.publicKeys) === fingerprint &&
      await deviceKeyFingerprint(persisted.publicKeys) === fingerprint,
    'a mutation during fingerprint verification must not alter the verified or persisted key material');

    const concurrent = { ...candidate, deviceId: '2'.repeat(32) };
    const outcomes = await delayedDigest(() => Promise.allSettled([
      store.pinTrustedDevice(concurrent),
      store.pinTrustedDevice({ ...concurrent, publicKeys: otherKeys, fingerprint: otherFingerprint }),
    ]));
    check(outcomes.filter(result => result.status === 'fulfilled').length === 1 &&
      outcomes.filter(result => result.status === 'rejected').length === 1,
    'concurrent different pins must atomically retain only the first verified key');
    const winner = outcomes.find(result => result.status === 'fulfilled').value;
    check((await store.getPinnedDevice(identity.householdId, concurrent.deviceId)).fingerprint === winner.fingerprint,
      'the concurrently accepted pin must match persistent storage');

    const lockingVault = await LocalVault.unlock(manifest, recoverySecret);
    const lockingStore = await SyncKeyStore.open({ vault: lockingVault });
    const lockedCandidate = { ...candidate, deviceId: '3'.repeat(32) };
    try {
      await assertFails(() => delayedDigest(() => lockingStore.pinTrustedDevice(lockedCandidate), () => lockingVault.lock()));
      check(await store.getPinnedDevice(identity.householdId, lockedCandidate.deviceId) === null,
        'locking during fingerprint verification must not publish a trusted pin');
    } finally {
      lockingStore.close();
      lockingVault.lock();
    }

    async function delayedDigest(action, duringDigest = () => {}) {
      const original = crypto.subtle.digest;
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      crypto.subtle.digest = function (...args) {
        const digest = original.apply(this, args);
        enter();
        return Promise.all([digest, gate]).then(([result]) => result);
      };
      const operation = Promise.resolve().then(action);
      // Observe rejection immediately: the regression intentionally allows IDB
      // to become idle while the fingerprint result is still pending.
      operation.catch(() => {});
      try {
        await entered;
        await duringDigest();
        await new Promise(resolve => setTimeout(resolve, 50));
        release();
        return await operation;
      } finally {
        release();
        crypto.subtle.digest = original;
      }
    }
  }

  async function writeLegacyEpoch(value) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('epochs', 'readwrite');
        tx.objectStore('epochs').put({ key: `${identity.householdId}:1`, householdId: identity.householdId, keyEpoch: 1, ...value });
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }

  async function rawRows() {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 4);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const names = ['devices', 'epochs', 'trusted_devices', 'security_state'];
        const tx = db.transaction(names, 'readonly'); const result = {};
        for (const name of names) { const request = tx.objectStore(name).getAll(); request.onsuccess = () => { result[name] = request.result; }; }
        tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
}
