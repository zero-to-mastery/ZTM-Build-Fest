import assert from "node:assert/strict";
import test from "node:test";
import {
  DurableConflictError,
  DurableStore,
  DurableStoreError,
} from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";

function createIdentity(store) {
  return new PairingService({ store }).bootstrap({
    credential: { id: "conflict-adult", publicKey: "test-key", algorithm: -7 },
    deviceLabel: "Conflict test device",
  });
}

function eventEntry(identity, deviceSequence = 1) {
  const envelope = {
    protocolVersion: 1,
    envelopeVersion: 1,
    eventId: "a".repeat(32),
    householdId: identity.householdId,
    deviceId: identity.deviceId,
    deviceSequence,
    logicalTime: String(deviceSequence),
    keyEpoch: 1,
    nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(32, 2).toString("base64url"),
    signature: Buffer.alloc(64, 3).toString("base64url"),
  };
  return { envelope, canonical: JSON.stringify(Object.entries(envelope)) };
}

for (const conflict of [
  { code: "sync_cursor_conflict", nextSequence: 2, deviceSequence: 0 },
  { code: "sync_device_sequence_conflict", nextSequence: 1, deviceSequence: 1 },
]) {
  test(`${conflict.code} rolls back nested writes and permits a valid retry`, () => {
    const store = new DurableStore(":memory:");
    try {
      const identity = createIdentity(store);
      const householdBefore = store.db
        .prepare("SELECT * FROM households WHERE id = ?")
        .get(identity.householdId);
      const entry = eventEntry(identity);

      assert.throws(
        () =>
          store.transaction(() => {
            store.db
              .prepare("UPDATE households SET version = version + 1 WHERE id = ?")
              .run(identity.householdId);
            store.commitEvents(
              identity.householdId,
              conflict.nextSequence,
              identity.deviceId,
              conflict.deviceSequence,
              [entry],
            );
          }),
        (error) =>
          error instanceof DurableConflictError && error.code === conflict.code,
      );

      assert.equal(store.failed, false);
      assert.equal(store.db.inTransaction, false);
      assert.equal(store.health(), true);
      assert.deepEqual(
        store.db
          .prepare("SELECT * FROM households WHERE id = ?")
          .get(identity.householdId),
        householdBefore,
      );
      assert.deepEqual(store.db.prepare("SELECT * FROM sync_households").all(), []);
      assert.deepEqual(
        store.db.prepare("SELECT * FROM sync_device_sequences").all(),
        [],
      );
      assert.equal(store.eventCount(identity.householdId), 0);

      store.commitEvents(identity.householdId, 1, identity.deviceId, 0, [entry]);
      assert.equal(store.eventCount(identity.householdId), 1);
      assert.equal(store.loadSyncState(identity.householdId).nextSequence, 2);
      assert.equal(store.validate(), true);
    } finally {
      store.close();
    }
  });
}

test("unexpected durable invariant failures roll back and keep the store failed closed", () => {
  const store = new DurableStore(":memory:");
  try {
    const identity = createIdentity(store);
    const originalVersion = store.db
      .prepare("SELECT version FROM households WHERE id = ?")
      .get(identity.householdId).version;
    const failure = new DurableStoreError("Injected durable invariant failure.");
    assert.throws(
      () =>
        store.transaction(() => {
          store.db
            .prepare("UPDATE households SET version = version + 1 WHERE id = ?")
            .run(identity.householdId);
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal(store.failed, true);
    assert.equal(store.db.inTransaction, false);
    assert.equal(
      store.db
        .prepare("SELECT version FROM households WHERE id = ?")
        .get(identity.householdId).version,
      originalVersion,
    );
    assert.throws(() => store.health(), /storage is unavailable/);
    assert.throws(() => store.transaction(() => {}), /storage is unavailable/);
  } finally {
    store.close();
  }
});

test("an unexpected SQLite constraint failure rolls back the whole event batch and poisons the store", () => {
  const store = new DurableStore(":memory:");
  try {
    const identity = createIdentity(store);
    assert.throws(
      () =>
        store.commitEvents(identity.householdId, 1, identity.deviceId, 0, [
          eventEntry(identity, 1),
          eventEntry(identity, 2),
        ]),
      (error) => error.code === "SQLITE_CONSTRAINT_UNIQUE",
    );
    assert.equal(store.failed, true);
    assert.equal(store.db.inTransaction, false);
    assert.deepEqual(store.db.prepare("SELECT * FROM sync_events").all(), []);
    assert.deepEqual(store.db.prepare("SELECT * FROM sync_households").all(), []);
    assert.deepEqual(
      store.db.prepare("SELECT * FROM sync_device_sequences").all(),
      [],
    );
    assert.throws(() => store.health(), /storage is unavailable/);
    assert.throws(
      () =>
        store.commitEvents(identity.householdId, 1, identity.deviceId, 0, [
          eventEntry(identity),
        ]),
      /storage is unavailable/,
    );
  } finally {
    store.close();
  }
});
