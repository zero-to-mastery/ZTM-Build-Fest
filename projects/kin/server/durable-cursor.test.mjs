import assert from "node:assert/strict";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

test("durable relay cursors resume bounded pages and agree with push and status", () => {
  const store = new DurableStore(":memory:");
  try {
    const pairing = new PairingService({ store });
    const identity = pairing.bootstrap({
      credential: { id: "cursor-adult", publicKey: "test-key", algorithm: -7 },
      deviceLabel: "Cursor test device",
    });
    const sync = new EncryptedSyncService(pairing, { store });
    const envelopes = [1, 2, 3].map((sequence) => ({
      protocolVersion: 1,
      envelopeVersion: 1,
      eventId: String(sequence).repeat(32),
      householdId: identity.householdId,
      deviceId: identity.deviceId,
      deviceSequence: sequence,
      logicalTime: String(sequence),
      keyEpoch: 1,
      nonce: Buffer.alloc(12, 1).toString("base64url"),
      ciphertext: Buffer.alloc(32, 2).toString("base64url"),
      signature: Buffer.alloc(64, 3).toString("base64url"),
    }));
    const accepted = sync.push(identity.sessionToken, envelopes);

    const first = sync.pull(identity.sessionToken, "", "2");
    assert.equal(first.events.length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, first.events.at(-1).cursor);
    const second = sync.pull(identity.sessionToken, first.nextCursor, "2");
    assert.equal(second.events.length, 1);
    assert.equal(second.hasMore, false);
    assert.deepEqual(
      [...first.events, ...second.events].map((event) => event.envelope),
      envelopes,
    );
    assert.equal(second.nextCursor, accepted.latestCursor);
    assert.equal(
      second.nextCursor,
      sync.status(identity.sessionToken).latestCursor,
    );
    assert.deepEqual(sync.pull(identity.sessionToken, second.nextCursor, "2"), {
      events: [],
      nextCursor: second.nextCursor,
      hasMore: false,
    });
    assert.deepEqual(
      sync
        .pull(identity.sessionToken, first.events[0].cursor, "2")
        .events.map((event) => event.envelope),
      envelopes.slice(1),
    );
  } finally {
    store.close();
  }
});
