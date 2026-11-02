import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash, webcrypto } from "node:crypto";
import { PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { DurableStore } from "./durable-store.mjs";
import { canonicalEventEnvelope } from "./sync-contract.mjs";
import { requestBody, responseBody } from "./sync-wire-test-utils.mjs";

globalThis.crypto ??= webcrypto;

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

async function start(service = new PairingService()) {
  const app = createKinServer({ service, store: new DurableStore(":memory:") });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  return {
    ...app,
    url: `http://127.0.0.1:${app.server.address().port}`,
    close: () =>
      new Promise((resolve, reject) =>
        app.server.close((error) => (error ? reject(error) : resolve())),
      ).finally(() => app.store?.close()),
  };
}

async function publicKeys() {
  const [agreement, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]),
  ]);
  return {
    agreement: await crypto.subtle.exportKey("jwk", agreement.publicKey),
    signing: await crypto.subtle.exportKey("jwk", signing.publicKey),
  };
}

function eventEnvelope(identity, overrides = {}) {
  return {
    protocolVersion: 1,
    envelopeVersion: 1,
    eventId: "a".repeat(32),
    householdId: identity.householdId,
    deviceId: identity.deviceId,
    deviceSequence: 1,
    logicalTime: "1",
    keyEpoch: 1,
    nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(32, 2).toString("base64url"),
    signature: Buffer.alloc(64, 3).toString("base64url"),
    ...overrides,
  };
}

for (const failure of ["durable row", "page encoding"]) {
  test(`pull reports invalid ${failure} with event metadata but no ciphertext`, async (t) => {
    const service = new PairingService();
    const adult = service.bootstrap({ credential: credential(`bad-${failure}`), deviceLabel: "A" });
    const app = await start(service);
    const logs = t.mock.method(console, "error", () => {});
    const envelope = eventEnvelope(adult);
    try {
      app.syncService.push(adult.sessionToken, [envelope]);
      const invalid = { ...envelope, signature: `${envelope.signature.slice(0, -1)}B` };
      if (failure === "durable row") {
        app.store.db.prepare("UPDATE sync_events SET canonical_envelope = ? WHERE household_id = ? AND event_id = ?")
          .run(canonicalEventEnvelope(invalid), adult.householdId, envelope.eventId);
      } else {
        t.mock.method(app.store, "readEvents", () => ({
          events: [{ cursor: "AAAAAAAAAAE", envelope: invalid }],
          nextCursor: "AAAAAAAAAAE", hasMore: false,
        }));
      }
      const response = await fetch(`${app.url}/api/sync/events?cursor=&limit=20`, {
        headers: { Cookie: `kin_session=${adult.sessionToken}` },
      });
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.error, "sync_store_invalid");
      assert.equal(Object.hasOwn(body, "nextCursor"), false);
      const lines = logs.mock.calls.map((call) => call.arguments[0]);
      const diagnostic = lines.map((line) => JSON.parse(line)).find((line) => line.event === "sync_store_invalid");
      assert.deepEqual(diagnostic, {
        event: "sync_store_invalid", householdId: adult.householdId, eventId: envelope.eventId,
      });
      assert.ok(lines.every((line) => !line.includes(envelope.ciphertext)));
      assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM sync_events").get().count, 1);
    } finally {
      await app.close();
    }
  });
}

test("HTTP sync operations require an active session and revoked devices cannot use stale cursors", async () => {
  const service = new PairingService();
  const adult = service.bootstrap({
    credential: credential("a"),
    deviceLabel: "A",
  });
  const invite = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invite.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  service.approvePairing(adult.sessionToken, invite.pairingId, claim.version);
  const other = service.activateClaim(claim.claimToken);
  const app = await start(service);
  const call = (
    path,
    { method = "GET", body, token = adult.sessionToken } = {},
  ) =>
    fetch(`${app.url}${path}`, {
      method,
      headers: {
        ...(token ? { Cookie: `kin_session=${token}` } : {}),
        ...requestBody(path, method, body).headers,
      },
      body: requestBody(path, method, body).body,
    });
  try {
    assert.equal((await call("/api/sync/status", { token: null })).status, 401);
    const keys = await publicKeys();
    assert.equal(
      (
        await call("/api/sync/device-keys", {
          method: "POST",
          body: { publicKeys: keys },
        })
      ).status,
      200,
    );
    assert.equal((await call("/api/sync/status")).status, 200);
    const envelope = eventEnvelope(adult);
    assert.equal(
      (
        await call("/api/sync/events", {
          method: "POST",
          body: { events: [envelope] },
        })
      ).status,
      200,
    );
    const pulled = await call("/api/sync/events?cursor=&limit=1");
    assert.equal(
      (await responseBody(pulled)).events[0].envelope.eventId,
      envelope.eventId,
    );

    const sessionOnlyRevoke = await call(`/api/devices/${other.deviceId}`, {
      method: "DELETE",
      body: {},
    });
    assert.equal(sessionOnlyRevoke.status, 401);
    assert.equal(service.devices.get(other.deviceId).revokedAt, null);
    service.revokeDevice(adult.sessionToken, other.deviceId, adult.memberId);
    app.syncService.onAccessChange(adult.householdId, [other.deviceId]);
    const status = await (await call("/api/sync/status")).json();
    assert.equal(status.rotationPending, true);
    assert.equal(status.pendingEpoch, 2);
    assert.equal(
      (
        await call("/api/sync/events?cursor=AAAAAAAAAAE", {
          token: other.sessionToken,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/api/sync/events", {
          method: "POST",
          body: {
            events: [
              eventEnvelope(adult, {
                eventId: "b".repeat(32),
                deviceSequence: 2,
              }),
            ],
          },
        })
      ).status,
      409,
    );
  } finally {
    await app.close();
  }
});

test("independent HTTP clients retain relay history while revoked devices fail on reconnect", async () => {
  const service = new PairingService();
  const adultA = service.bootstrap({ credential: credential("live-a"), deviceLabel: "Client A" });
  const invite = service.createPairing(adultA.sessionToken);
  const claim = service.claimPairing({
    code: invite.code,
    credential: credential("live-b"),
    deviceLabel: "Client B",
  });
  service.approvePairing(adultA.sessionToken, invite.pairingId, claim.version);
  const adultB = service.activateClaim(claim.claimToken);
  const app = await start(service);
  const client = (session) => async (path, { method = "GET", body } = {}) =>
    fetch(`${app.url}${path}`, {
      method,
      headers: {
        Cookie: `kin_session=${session}`,
        ...requestBody(path, method, body).headers,
      },
      body: requestBody(path, method, body).body,
    });
  const clientA = client(adultA.sessionToken);
  const clientB = client(adultB.sessionToken);
  const event = eventEnvelope(adultA, { eventId: "c".repeat(32) });
  try {
    assert.equal((await clientA("/api/sync/events", { method: "POST", body: { events: [event] } })).status, 200);
    const firstPull = await clientB("/api/sync/events?cursor=&limit=20");
    assert.equal(firstPull.status, 200);
    assert.deepEqual((await responseBody(firstPull)).events.map((row) => row.envelope), [event]);

    // Client B retains its old cursor and retryable upload. The relay accepts
    // the exact retry once; revocation must invalidate the same session later.
    const retry = eventEnvelope(adultB, { eventId: "d".repeat(32), deviceSequence: 1 });
    assert.equal((await clientB("/api/sync/events", { method: "POST", body: { events: [retry] } })).status, 200);
    assert.equal((await clientB("/api/sync/events", { method: "POST", body: { events: [retry] } })).status, 200);
    service.revokeDevice(adultA.sessionToken, adultB.deviceId, adultA.memberId);
    app.syncService.onAccessChange(adultA.householdId, [adultB.deviceId]);

    assert.equal((await clientB("/api/sync/status")).status, 401);
    assert.equal((await clientB("/api/sync/events?cursor=&limit=20")).status, 401);
    assert.equal((await clientB("/api/sync/events", { method: "POST", body: { events: [retry] } })).status, 401);

    // An authorized client still sees both distinct events exactly once and in
    // the relay order; revocation changes access, not the event history.
    const reconciled = await responseBody(await clientA("/api/sync/events?cursor=&limit=20"));
    assert.deepEqual(reconciled.events.map((row) => row.envelope), [event, retry]);
    assert.equal(reconciled.events.length, 2);
  } finally {
    await app.close();
  }
});

test("HTTP attachment transfer requires an active synced session and returns only opaque bytes", async () => {
  const service = new PairingService();
  const adult = service.bootstrap({ credential: credential("attachment-http"), deviceLabel: "A" });
  const app = await start(service);
  const headers = { Cookie: `kin_session=${adult.sessionToken}` };
  try {
    assert.equal((await fetch(`${app.url}/api/sync/enable`, { method: "POST", headers })).status, 200);
    const ciphertext = Buffer.alloc(64, 0xd3);
    const digest = createHash("sha256").update(ciphertext).digest("hex");
    const attachmentId = "d".repeat(32);
    const uploaded = await fetch(`${app.url}/api/sync/attachments/${attachmentId}`, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream", "X-Attachment-Key-Epoch": "1", "X-Attachment-SHA256": digest }, body: ciphertext });
    assert.equal(uploaded.status, 200);
    assert.deepEqual(await uploaded.json(), { accepted: true, size: 64, digest });
    const listed = await fetch(`${app.url}/api/sync/attachments`, { headers });
    assert.deepEqual(await listed.json(), { attachments: [{ attachmentId, keyEpoch: 1, size: 64, digest }] });
    const downloaded = await fetch(`${app.url}/api/sync/attachments/${attachmentId}`, { headers });
    assert.equal(downloaded.headers.get("content-type"), "application/octet-stream");
    assert.equal(downloaded.headers.get("x-attachment-sha256"), digest);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), ciphertext);
    assert.equal((await fetch(`${app.url}/api/sync/attachments/${attachmentId}`, { method: "DELETE", headers })).status, 200);
    assert.equal((await fetch(`${app.url}/api/sync/attachments/${attachmentId}`, { headers })).status, 404);
    assert.equal((await fetch(`${app.url}/api/sync/attachments`, {})).status, 401);
  } finally { await app.close(); }
});

test("relay without a durable store is process-local and HTTPS is required outside loopback", async () => {
  const service = new PairingService();
  const adult = service.bootstrap({
    credential: credential("a"),
    deviceLabel: "A",
  });
  const first = new EncryptedSyncService(service);
  first.push(adult.sessionToken, [eventEnvelope(adult)]);
  const restarted = new EncryptedSyncService(service);
  assert.equal(restarted.status(adult.sessionToken).eventCount, 0);
  assert.throws(
    () => createKinServer({ host: "0.0.0.0", origin: "http://localhost:8000" }),
    /must bind to loopback/,
  );
  assert.throws(
    () => createKinServer({ host: "0.0.0.0", origin: "https://kin.example" }),
    /must bind to loopback/,
  );
  const app = createKinServer({
    host: "127.0.0.1",
    origin: "https://kin.example",
    store: new DurableStore(":memory:"),
  });
  app.store.close();
});

test("durable identity and relay survive store restart while sessions expire", () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-durable-restart-"));
  const databasePath = join(directory, "kin.sqlite");
  let store = new DurableStore(databasePath);
  try {
    const service = new PairingService({ store });
    const adult = service.bootstrap({
      credential: credential("restart-adult"),
      deviceLabel: "Restart device",
    });
    const sync = new EncryptedSyncService(service, { store });
    const envelope = eventEnvelope(adult);
    assert.equal(sync.push(adult.sessionToken, [envelope]).durable, true);
    store.close();

    store = new DurableStore(databasePath);
    const restartedService = new PairingService({ store });
    const restartedSync = new EncryptedSyncService(restartedService, { store });
    assert.throws(
      () => restartedService.authorize(adult.sessionToken),
      (error) => error.code === "authentication_required",
    );
    const renewed = restartedService.reauthenticate(
      adult.deviceToken,
      "restart-adult",
    );
    assert.equal(
      restartedSync.status(renewed.sessionToken).acceptance,
      "durable",
    );
    assert.equal(restartedSync.status(renewed.sessionToken).eventCount, 1);
    assert.deepEqual(
      restartedSync.pull(renewed.sessionToken).events[0].envelope,
      envelope,
    );
    assert.equal(restartedSync.push(renewed.sessionToken, [envelope]).durable, true);

    const conflict = { ...envelope, ciphertext: "B".repeat(24) };
    assert.throws(
      () => restartedSync.push(renewed.sessionToken, [conflict]),
      (error) => error.code === "event_duplicate_conflict",
    );
    assert.throws(
      () =>
        restartedSync.push(renewed.sessionToken, [
          eventEnvelope(renewed, {
            eventId: "b".repeat(32),
            deviceSequence: 3,
          }),
        ]),
      (error) => error.code === "sync_sequence_gap",
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
