// Session event arena regressions and the projection-equivalence oracle.
//
// The oracle is the refactor track's correctness gate for every cached or
// incremental history path: the projection bytes the store's cached history
// produces must equal those of a fresh full read (native IndexedDB + decrypt
// of every row) followed by a full replay, for the same events, as_of,
// civil_date, cursor and identity. It runs in the page.

/** In-page oracle. Throws on any difference; returns sizes on success. */
export async function projectionOracle({ store, engine, vault, asOf = 1_791_900_000_000, civilDate = 20261014 }) {
  const { EVENT_STORE_DEFINITIONS } = await import("/storage/event-store.js");
  const { unprotectRecord, mapProtectedBatch } = await import("/storage/encrypted-idb.js");
  const { idToHex } = await import("/wasm/kin-engine.js");
  const raw = await new Promise((resolve, reject) => {
    const request = indexedDB.open("kin");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  let rows, contexts;
  try {
    [rows, contexts] = await new Promise((resolve, reject) => {
      const transaction = raw.transaction(["events", "local_context"], "readonly");
      const events = transaction.objectStore("events").getAll();
      const context = transaction.objectStore("local_context").getAll();
      transaction.oncomplete = () => resolve([events.result, context.result]);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { raw.close(); }
  const fresh = await mapProtectedBatch(rows, (row) => unprotectRecord(vault, "events", EVENT_STORE_DEFINITIONS.events, row));
  const [context] = await mapProtectedBatch(contexts, (row) => unprotectRecord(vault, "local_context", EVENT_STORE_DEFINITIONS.local_context, row));
  const cursor = context.last_looked_event_id ? idToHex(context.last_looked_event_id) : null;
  const identity = context.sync_household_id
    ? { householdId: idToHex(context.sync_household_id), memberId: idToHex(context.sync_member_id),
      deviceId: idToHex(context.sync_device_id), bindings: context.sync_identity_bindings }
    : null;
  const snapshot = await store.getCatchUpState();
  const fail = (message) => { throw new Error(`Projection oracle: ${message}`); };
  if (snapshot.cursor.eventId !== cursor) fail("cached cursor differs from storage");
  if (JSON.stringify(snapshot.syncIdentity) !== JSON.stringify(identity)) fail("cached identity differs from storage");
  if (snapshot.events.length !== fresh.length) fail(`cached history has ${snapshot.events.length} events, storage ${fresh.length}`);
  for (let index = 0; index < fresh.length; index += 1) {
    const expected = new Uint8Array(fresh[index].encoded_event), actual = snapshot.events.record(index);
    if (snapshot.events.localSequence(index) !== fresh[index].local_sequence ||
        expected.length !== actual.length || expected.some((byte, offset) => byte !== actual[offset]))
      fail(`event ${index} differs from storage`);
  }
  const expected = engine.projectionBytes(fresh.map((row) => row.encoded_event), asOf, cursor, civilDate, identity);
  const actual = engine.projectionBytes(snapshot.events, asOf, snapshot.cursor.eventId, civilDate, snapshot.syncIdentity);
  if (expected.length !== actual.length || expected.some((byte, offset) => byte !== actual[offset]))
    fail("projection bytes differ from a fresh full read and replay");
  return { events: fresh.length, projectionBytes: expected.length };
}

/** Store-level scenarios, run in the isolated storage runner. */
export async function eventArenaRegression(oracle) {
  const { LocalVault } = await import("/security/local-vault.js");
  const { EventStore } = await import("/storage/event-store.js");
  const { loadKinEngine, randomId } = await import("/wasm/kin-engine.js");
  const { migrateSyncKeys, finalizeSyncKeyMigration, prepareRootRotationKeys, commitRootRotationKeys } = await import("/sync/key-store.js");
  let checks = 0;
  const passed = [];
  const check = (condition, message) => { if (!condition) throw Error(message); checks += 1; };
  const remove = (name) => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error(`Close ${name} fixture connections`));
  });
  const raw = () => new Promise((resolve, reject) => {
    const request = indexedDB.open("kin"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const generation = async () => {
    const database = await raw();
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction("security_state").objectStore("security_state").get("event_generation");
        request.onsuccess = () => resolve(request.result?.generation ?? 0); request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  };
  const engine = await loadKinEngine();
  const add = (store, text) => store.append({ type: "add", text, classification: "need" }, engine);
  const protect = async () => {
    const created = await LocalVault.create();
    await EventStore.prepareSecurity(created.manifest);
    await EventStore.migrate({ vault: created.vault, engine,
      prepareKeys: (vault) => migrateSyncKeys(vault, { prepareOnly: true }), finalizeKeys: finalizeSyncKeyMigration });
    return created;
  };
  // Counts decryptions of event rows only (context/sync reads are separate).
  const countEventDecrypts = (vault) => {
    const open = vault.open.bind(vault);
    const counter = { events: 0, restore: () => { vault.open = open; } };
    vault.open = (sealed, context) => { if (context?.store === "events") counter.events += 1; return open(sealed, context); };
    return counter;
  };

  await remove("kin"); await remove("kin-crypto-keys");
  const first = await protect();
  const store = await EventStore.open({ vault: first.vault, engine });
  await oracle({ store, engine, vault: first.vault });
  const migrated = await generation();
  check(migrated === 1, "protecting the household replaces its corpus and bumps the generation");
  check(store.arena.length === 0 && store.arena.generation === migrated, "unlock builds an empty arena at the stored generation");
  for (let index = 0; index < 5; index += 1) {
    await add(store, `Arena local append ${index}`);
    await oracle({ store, engine, vault: first.vault });
  }
  check(store.arena.length === 5, "local appends extend the arena with the committed plaintext");
  {
    const counter = countEventDecrypts(first.vault);
    await store.getCatchUpState();
    await store.append({ type: "add", text: "No re-decrypt", classification: "today" }, engine);
    counter.restore();
    check(counter.events === 0, "a refresh and a command decrypt no stored event rows");
  }
  passed.push("unlock and local append match a fresh full read and replay");

  const peer = await EventStore.open({ vault: first.vault, engine });
  for (let index = 0; index < 3; index += 1) await add(peer, `Arena peer append ${index}`);
  {
    const counter = countEventDecrypts(first.vault);
    await oracle({ store, engine, vault: first.vault });
    counter.restore();
    // The oracle itself decrypts every row once (9) plus three peer rows for the arena.
    check(counter.events === 9 + 3, `a peer append decrypts only the rows after the tail (saw ${counter.events - 9})`);
  }
  check(store.arena.length === 9 && peer.arena.length === 9, "both connections converge on the same history");
  passed.push("cross-connection appends decrypt only rows after the arena tail");

  // A non-append rewrite: replace row 2 with a different valid event.
  {
    const rows = await peer.loadEvents();
    const context = await peer.ensureContext();
    const replacement = engine.executeCommand({ type: "add", text: "Rewritten history row", classification: "today" },
      { eventId: randomId(), householdId: context.household_id, actorId: context.actor_id, deviceId: context.device_id,
        timestamp: rows[1].timestamp, logicalTime: rows[1].logical_time, entityId: randomId() },
      [rows[0].encoded_event], 1_791_900_000_000, null, 20261014, null);
    const metadata = replacement.metadata;
    await new Promise((resolve, reject) => {
      const transaction = peer.database.transaction(["events"], "readwrite");
      transaction.objectStore("events").put({ local_sequence: rows[1].local_sequence, event_id: metadata.eventId,
        household_id: metadata.householdId, actor_id: metadata.actorId, device_id: metadata.deviceId,
        timestamp: metadata.timestamp, logical_time: metadata.logicalTime, kind: metadata.kind,
        event_version: metadata.eventVersion, encoded_event: replacement.encodedEvent });
      transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.__kinFailure ?? transaction.error);
    });
    let stale = null;
    try { await oracle({ store, engine, vault: first.vault }); } catch (error) { stale = error; }
    check(stale !== null, "negative control: without a generation bump the oracle detects the stale arena");
    const database = await raw();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("security_state", "readwrite");
      const request = transaction.objectStore("security_state").get("event_generation");
      request.onsuccess = () => transaction.objectStore("security_state").put({ key: "event_generation", generation: (request.result?.generation ?? 0) + 1 });
      transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    await oracle({ store, engine, vault: first.vault });
    await oracle({ store: peer, engine, vault: first.vault });
    check(store.arena.generation === migrated + 1, "a generation bump rebuilds the arena");
  }
  passed.push("a non-append change is detected through the store generation");

  // Out-of-order sync: remote events that sort before local history.
  {
    const before = await store.loadEvents();
    const identity = { householdId: "11".repeat(16), memberId: "22".repeat(16), deviceId: "33".repeat(16) };
    await store.initializeSync({ identity, serverStatus: { currentEpoch: 1, pendingEpoch: null, rotationPending: false },
      legacyBindingEnvelope: { version: 1, ciphertext: "opaque-test-control" } });
    await oracle({ store, engine, vault: first.vault });
    const { idFromHex } = await import("/wasm/kin-engine.js");
    const remote = (byte, logicalTime, text) => engine.executeCommand({ type: "add", text, classification: "shopping" },
      { eventId: new Uint8Array(16).fill(byte), householdId: idFromHex(identity.householdId), actorId: idFromHex("44".repeat(16)),
        deviceId: idFromHex("55".repeat(16)), timestamp: 1_000 + logicalTime, logicalTime: BigInt(logicalTime), entityId: new Uint8Array(16).fill(byte + 1) },
      [], 1_791_900_000_000, null, 20261014, null).encodedEvent;
    const committed = await store.commitRemoteBatch({ received: [{ encodedEvent: remote(0x61, 1, "Remote earliest") },
      { encodedEvent: remote(0x71, 2, "Remote early") }], nextCursor: "AAAAAAAAAAE", engine });
    check(committed.added === 2, "out-of-order remote events are admitted");
    await oracle({ store, engine, vault: first.vault });
    await oracle({ store: peer, engine, vault: first.vault });
    check(store.arena.length === before.length + 2 && store.arena.view().localSequence(store.arena.length - 1) > before.at(-1).local_sequence,
      "remote events append in local arrival order even though they replay first");
  }
  passed.push("out-of-order synchronized events keep local order and replay identically");
  const snapshot = await store.snapshotForArchive();
  peer.close();
  store.close();
  first.vault.lock();
  check(store.arena.length === 0, "closing and locking leaves no plaintext history");

  // Restore into an empty household bumps the generation.
  await remove("kin"); await remove("kin-crypto-keys");
  const second = await protect();
  const target = await EventStore.open({ vault: second.vault, engine });
  await oracle({ store: target, engine, vault: second.vault });
  const generationBefore = await generation();
  await EventStore.restoreEmpty({ vault: second.vault, engine, snapshot, manifest: second.manifest });
  check(await generation() === generationBefore + 1, "restore bumps the store generation in its commit");
  const restored = await oracle({ store: target, engine, vault: second.vault });
  check(restored.events === snapshot.events.length && target.arena.generation === generationBefore + 1,
    "the open store rebuilds the restored history");
  passed.push("restore rebuilds the arena through the generation counter");

  // Root rotation re-encrypts every row: peers lock and the generation bumps.
  {
    const held = target.arena.bytes;
    const before = await generation();
    const candidate = await LocalVault.createRotation(second.vault);
    await EventStore.rotateProtection({ sourceVault: second.vault, candidateVault: candidate.vault, engine,
      prepareKeys: prepareRootRotationKeys, commitKeys: commitRootRotationKeys });
    // The rotation advanced the durable lock epoch, so the stale store's next
    // transaction fails its guard, which locks the source vault.
    let staleRefused = false;
    try { await target.getCatchUpState(); } catch { staleRefused = true; }
    check(staleRefused && second.vault.locked && target.arena.length === 0 && held.every((byte) => byte === 0),
      "after rotation the stale store is refused, its vault locks and its arena is wiped");
    check(await generation() === before + 1, "rotation bumps the store generation with the replaced corpus");
    target.close();
    const rotated = await EventStore.open({ vault: candidate.vault, engine });
    await oracle({ store: rotated, engine, vault: candidate.vault });
    passed.push("rotation wipes stale arenas and the new root rebuilds identically");

    // Lock wipes.
    const bytes = rotated.arena.bytes, ids = rotated.arena.ids;
    check(bytes.some((byte) => byte !== 0), "fixture arena holds plaintext before lock");
    candidate.vault.lock();
    check(rotated.arena.length === 0 && bytes.every((byte) => byte === 0) && ids.every((byte) => byte === 0),
      "lock zero-fills and drops the arena");
    let refused = false;
    try { await rotated.getCatchUpState(); } catch { refused = true; }
    check(refused, "a locked store cannot rebuild its history");
    rotated.close();
    passed.push("lock zero-fills the arena");
  }
  // Retention: Kin has no event deletion or compaction (RETENTION.md); there
  // is no retention path to exercise. Any future one must bump the generation.
  await remove("kin"); await remove("kin-crypto-keys");
  engine.dispose();
  return { checks, passed };
}

/** Two real tabs on the shipped app (run by browser-regression.mjs). */
export async function eventArenaPeerRegressions(first, second, until) {
  await second.evaluate(`(() => {
    const app = document.querySelector('kin-app');
    const open = app.vault.open.bind(app.vault);
    window.arenaDecrypts = 0;
    window.arenaRestore = () => { app.vault.open = open; };
    app.vault.open = (sealed, context) => { if (context?.store === 'events') window.arenaDecrypts += 1; return open(sealed, context); };
    window.arenaLengthBefore = app.store.arena.length;
    return true;
  })()`);
  await first.evaluate(`document.querySelector('kin-app').ctx.items.handleAddItem({
    detail: { text: 'Arena two-tab change', classification: 'need' }
  })`);
  await until(() => second.evaluate(`(() => {
    const app = document.querySelector('kin-app');
    return !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending && app.state.items.some((item) => item.text === 'Arena two-tab change');
  })()`));
  const decrypts = await second.evaluate("window.arenaRestore(); window.arenaDecrypts");
  const result = await second.evaluate(`(async () => {
    const app = document.querySelector('kin-app');
    const outcome = await (${projectionOracle.toString()})({ store: app.store, engine: app.engine, vault: app.vault });
    return { ...outcome, grew: app.store.arena.length - window.arenaLengthBefore };
  })()`);
  if (result.grew !== 1) throw new Error(`peer tab arena grew by ${result.grew}, expected 1`);
  if (decrypts !== 1) throw new Error(`peer tab decrypted ${decrypts} event rows for one new event`);
  console.log(`PASS two-tab arena refresh decrypts one row and matches the oracle (${result.events} events)`);
}
