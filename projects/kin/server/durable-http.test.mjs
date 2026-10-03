import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { createKinServer } from "./server.mjs";

test("HTTP stale-writer conflict returns 409 and permits a fresh durable retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-conflict-http-"));
  const databasePath = join(directory, "kin.sqlite");
  const store = new DurableStore(databasePath, { acquireProcessLock: false });
  let peerStore;
  let app;
  try {
    const service = new PairingService({ store });
    const identity = service.bootstrap({
      credential: {
        id: "http-conflict-adult",
        publicKey: "synthetic-key",
        algorithm: -7,
      },
      deviceLabel: "Conflict test",
    });
    const syncService = new EncryptedSyncService(service, { store });
    syncService.status(identity.sessionToken);
    app = createKinServer({ store, service, syncService });
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    peerStore = new DurableStore(databasePath, { acquireProcessLock: false });
    const peerService = new PairingService({ store: peerStore });
    const peerIdentity = peerService.reauthenticate(
      identity.deviceToken,
      "http-conflict-adult",
    );
    const peerSync = new EncryptedSyncService(peerService, { store: peerStore });
    const envelope = (eventId, deviceSequence) => ({
      protocolVersion: 1,
      envelopeVersion: 1,
      eventId,
      householdId: identity.householdId,
      deviceId: identity.deviceId,
      deviceSequence,
      logicalTime: String(deviceSequence),
      keyEpoch: 1,
      nonce: Buffer.alloc(12, 1).toString("base64url"),
      ciphertext: Buffer.alloc(32, 2).toString("base64url"),
      signature: Buffer.alloc(64, 3).toString("base64url"),
    });
    peerSync.push(peerIdentity.sessionToken, [envelope("a".repeat(32), 1)]);
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const push = (event) =>
      fetch(`${origin}/api/sync/events`, {
        method: "POST",
        headers: {
          Cookie: `kin_session=${identity.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: [event] }),
      });
    const conflict = await push(envelope("b".repeat(32), 1));
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      error: "sync_cursor_conflict",
      message: "Kin synchronization state changed; retry from the current cursor.",
    });
    assert.equal(store.failed, false);
    assert.equal(store.eventCount(identity.householdId), 1);
    assert.equal((await fetch(`${origin}/readiness`)).status, 200);
    const retry = await push(envelope("b".repeat(32), 2));
    assert.equal(retry.status, 200, JSON.stringify(await retry.json()));
    assert.equal(store.eventCount(identity.householdId), 2);

    // Fatal persisted-data corruption still disables subsequent service use.
    store.db.prepare("UPDATE sync_events SET canonical_envelope = ?").run("{}");
    const fatal = await fetch(`${origin}/api/sync/events`, {
      headers: { Cookie: `kin_session=${identity.sessionToken}` },
    });
    assert.equal(fatal.status, 503);
    assert.equal((await fatal.json()).error, "durable_store_unavailable");
    assert.equal(store.failed, true);
    assert.equal((await fetch(`${origin}/readiness`)).status, 503);
  } finally {
    if (app?.server.listening)
      await new Promise((resolve) => app.server.close(resolve));
    peerStore?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
