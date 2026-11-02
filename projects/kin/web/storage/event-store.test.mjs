import assert from "node:assert/strict";
import test from "node:test";
import { EventStore, EventStoreError, validatePortableMembership } from "./event-store.js";

const member = (memberId, memberKind, status, expiresAt) => ({
  memberId, memberKind, status,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

test("portable membership accepts authoritative Temporary status across either browser clock skew", () => {
  const expired = member("11".repeat(16), "temporary", "expired", 2_000);
  const active = member("22".repeat(16), "temporary", "active", 2_000);
  const removed = member("33".repeat(16), "temporary", "removed", 3_000);

  // Historical membership snapshots are validated structurally. A browser clock
  // cannot override the server-authored status during export or restore.
  const systemNow = Date.now;
  try {
    Date.now = () => 1_000; // Browser behind server: expiry lies in the future locally.
    validatePortableMembership([expired, active, removed]);
    Date.now = () => 4_000; // Browser ahead: an active server status stays active.
    validatePortableMembership([expired, active, removed]);
  } finally {
    Date.now = systemNow;
  }
  assert.equal(expired.status, "expired");
  assert.equal(active.status, "active");
  assert.equal(removed.status, "removed");
});

test("portable membership rejects contradictory status and expiry structures", () => {
  const invalid = [
    member("11".repeat(16), "adult", "expired"),
    member("22".repeat(16), "limited", "active", 3_000),
    member("33".repeat(16), "temporary", "expired"),
    member("44".repeat(16), "temporary", "active", Number.NaN),
    member("55".repeat(16), "temporary", "unknown", 3_000),
    { ...member("66".repeat(16), "temporary", "removed", 3_000), unexpected: true },
  ];
  for (const snapshot of invalid)
    assert.throws(() => validatePortableMembership([snapshot]), EventStoreError);
});

test("legacy archives without portable membership remain valid", () => {
  validatePortableMembership([]);
  assert.throws(() => validatePortableMembership(null), EventStoreError);
});

function stubOpenStorage(t) {
  const listeners = new Set();
  const removals = [];
  const manifest = { phase: "encrypted", vaultId: "test-vault", rootVersion: 1 };
  const vault = {
    vaultId: manifest.vaultId, manifest,
    assertUnlocked() {},
    onLock(callback) {
      listeners.add(callback);
      const index = removals.push(0) - 1;
      return () => { removals[index] += 1; listeners.delete(callback); };
    },
  };
  const database = {
    close: t.mock.fn(),
    transaction(name) {
      assert.equal(name, "security_state");
      const transaction = {
        objectStore: () => ({
          get: () => {
            const request = { result: manifest };
            queueMicrotask(() => { request.onsuccess(); transaction.oncomplete(); });
            return request;
          },
        }),
      };
      return transaction;
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = { result: database };
        queueMicrotask(() => request.onsuccess());
        return request;
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else delete globalThis.indexedDB;
  });
  return { vault, database, listeners, removals };
}

test("closing an opened store removes its vault lock listener exactly once", async (t) => {
  const { vault, listeners, removals } = stubOpenStorage(t);
  t.mock.method(EventStore.prototype, "ensureContext", async () => ({ actor_id: new Uint8Array(16) }));
  const store = await EventStore.open({ vault });
  assert.equal(listeners.size, 2, "database guard and arena lock listeners");
  const bytes = store.arena.bytes;
  bytes.fill(7);
  store.close();
  assert.equal(listeners.size, 0);
  assert.ok(bytes.every((byte) => byte === 0), "close still wipes session plaintext");
  assert.doesNotThrow(() => store.close());
  assert.equal(listeners.size, 0);
  assert.equal(removals[1], 1, "the arena listener is removed only once");
});

test("a failed store open removes registered vault lock listeners and closes storage", async (t) => {
  const { vault, database, listeners } = stubOpenStorage(t);
  const error = new Error("context unavailable");
  let bytes;
  t.mock.method(EventStore.prototype, "ensureContext", async function () {
    assert.equal(listeners.size, 2);
    bytes = this.arena.bytes;
    bytes.fill(7);
    throw error;
  });
  await assert.rejects(EventStore.open({ vault }), (caught) => caught === error);
  assert.equal(listeners.size, 0);
  assert.equal(database.close.mock.callCount(), 1);
  assert.ok(bytes.every((byte) => byte === 0));
});
