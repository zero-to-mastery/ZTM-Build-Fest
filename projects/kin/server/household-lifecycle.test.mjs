import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableConflictError, DurableStore, HOUSEHOLD_DELETION_GRACE_MS } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { createKinServer } from "./server.mjs";

const acceptedEvent = (identity) => ({
  protocolVersion: 1,
  envelopeVersion: 1,
  eventId: "e".repeat(32),
  householdId: identity.householdId,
  deviceId: identity.deviceId,
  deviceSequence: 1,
  logicalTime: "1",
  keyEpoch: 1,
  nonce: Buffer.alloc(12, 1).toString("base64url"),
  ciphertext: Buffer.alloc(32, 2).toString("base64url"),
  signature: Buffer.alloc(64, 3).toString("base64url"),
});

function createFixture(now = 1_800_000_000_000) {
  const directory = mkdtempSync(join(tmpdir(), "kin-household-lifecycle-"));
  const store = new DurableStore(join(directory, "kin.sqlite"));
  let timestamp = now;
  const clock = () => timestamp;
  const service = new PairingService({ store, now: clock });
  const identity = service.bootstrap({
    credential: {
      id: "lifecycle-passkey",
      publicKey: "lifecycle-public-key",
      algorithm: -7,
    },
    deviceLabel: "Lifecycle test device",
  });
  const sync = new EncryptedSyncService(service, { store, now: clock });
  sync.push(identity.sessionToken, [acceptedEvent(identity)]);
  return {
    directory,
    store,
    service,
    sync,
    identity,
    now: clock,
    setNow(value) {
      timestamp = value;
    },
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("household deletion blocks authority immediately, can be cancelled, and finalizes irreversibly", () => {
  const fixture = createFixture();
  const { store, service, sync, identity } = fixture;
  try {
    assert.equal(store.eventCount(identity.householdId), 1);
    const requested = service.requestHouseholdDeletion(
      identity.sessionToken,
      identity.memberId,
    );
    assert.equal(requested.state, "deletion_pending");
    assert.equal(
      requested.finalizeAt - requested.requestedAt,
      HOUSEHOLD_DELETION_GRACE_MS,
    );
    assert.equal(store.eventCount(identity.householdId), 1);
    assert.equal(store.loadIdentity().members.has(identity.memberId), true);
    assert.throws(
      () => service.authorize(identity.sessionToken),
      (error) => error instanceof PairingError && error.code === "authentication_required",
    );
    assert.throws(
      () => sync.push(identity.sessionToken, [acceptedEvent(identity)]),
      (error) => error instanceof PairingError && error.code === "authentication_required",
    );
    assert.equal(
      store.lifecycleInfo(identity.householdId).state,
      "deletion_pending",
    );

    const cancelled = service.cancelHouseholdDeletion(
      identity.deviceToken,
      "lifecycle-passkey",
    );
    assert.equal(
      store.lifecycleInfo(identity.householdId).state,
      "active",
    );
    assert.equal(service.authorize(cancelled.sessionToken).household.id, identity.householdId);
    assert.equal(store.eventCount(identity.householdId), 1);

    const secondRequest = service.requestHouseholdDeletion(
      cancelled.sessionToken,
      identity.memberId,
    );
    fixture.setNow(secondRequest.finalizeAt);
    const finalized = service.finalizeExpiredDeletions();
    assert.deepEqual(finalized, [identity.householdId]);
    assert.equal(store.lifecycleInfo(identity.householdId).state, "deleted");
    assert.equal(store.eventCount(identity.householdId), 0);
    assert.equal(store.loadIdentity().members.has(identity.memberId), false);
    assert.equal(store.loadIdentity().devices.has(identity.deviceId), false);
    assert.throws(
      () =>
        service.cancelHouseholdDeletion(
          identity.deviceToken,
          "lifecycle-passkey",
        ),
      (error) => error instanceof PairingError,
    );
    assert.equal(store.validate(), true);
  } finally {
    fixture.close();
  }
});

test("deletion finalization is restart-safe and rejects cancellation at expiry", () => {
  const fixture = createFixture();
  const { directory, store, service, identity } = fixture;
  try {
    const pending = service.requestHouseholdDeletion(
      identity.sessionToken,
      identity.memberId,
    );
    fixture.setNow(pending.finalizeAt);
    assert.throws(
      () =>
        service.cancelHouseholdDeletion(
          identity.deviceToken,
          "lifecycle-passkey",
        ),
      (error) => error.code === "household_deletion_final",
    );
    store.close();
    const restartedStore = new DurableStore(join(directory, "kin.sqlite"));
    try {
      const restarted = new PairingService({
        store: restartedStore,
        now: () => pending.finalizeAt,
      });
      assert.equal(
        restartedStore.lifecycleInfo(identity.householdId).state,
        "deleted",
      );
      assert.equal(restartedStore.eventCount(identity.householdId), 0);
      assert.equal(restarted.households.get(identity.householdId).lifecycleState, "deleted");
      assert.equal(restartedStore.validate(), true);
    } finally {
      restartedStore.close();
    }
  } finally {
    fixture.close();
  }
});

for (const removedAdult of [false, true]) {
  test(`restore refuses a pending household over an older active backup${removedAdult ? " containing a removed adult and revoked device" : ""}`, async () => {
    const fixture = createFixture();
    const targetPath = join(fixture.directory, "kin.sqlite");
    const backupPath = join(fixture.directory, "before-deletion.sqlite");
    let joined;
    try {
      if (removedAdult) {
        const invitation = fixture.service.createPairing(fixture.identity.sessionToken);
        const claim = fixture.service.claimPairing({
          code: invitation.code,
          credential: {
            id: "removed-passkey",
            publicKey: "removed-public-key",
            algorithm: -7,
          },
          deviceLabel: "Removed adult device",
        });
        fixture.service.approvePairing(
          fixture.identity.sessionToken,
          invitation.pairingId,
          claim.version,
        );
        joined = fixture.service.activateClaim(claim.claimToken);
      }
      await fixture.store.backup(backupPath);
      if (joined) {
        fixture.service.removeOtherAdult(
          fixture.identity.sessionToken,
          joined.memberId,
          fixture.identity.memberId,
        );
        assert.equal(fixture.store.loadIdentity().members.get(joined.memberId).active, false);
        assert.ok(fixture.store.loadIdentity().devices.get(joined.deviceId).revokedAt);
        const backup = new DurableStore(backupPath, { readonly: true });
        try {
          const identity = backup.loadIdentity();
          assert.equal(identity.members.get(joined.memberId).active, true);
          assert.equal(identity.devices.get(joined.deviceId).revokedAt, null);
          assert.equal(identity.credentials.has("removed-passkey"), true);
        } finally {
          backup.close();
        }
      }
      const pending = fixture.service.requestHouseholdDeletion(
        fixture.identity.sessionToken,
        fixture.identity.memberId,
      );
      const targetFiles = new Map(
        ["", "-wal", "-shm"].map((suffix) => [
          suffix,
          readFileSync(`${targetPath}${suffix}`),
        ]),
      );
      fixture.store.close();
      // Keep an offline uncheckpointed snapshot to verify WAL/SHM preservation.
      for (const [suffix, bytes] of targetFiles)
        writeFileSync(`${targetPath}${suffix}`, bytes);
      const originalFiles = new Map(
        readdirSync(fixture.directory).sort().map((name) => [
          name,
          readFileSync(join(fixture.directory, name)),
        ]),
      );
      await assert.rejects(
        DurableStore.restoreBackup(backupPath, targetPath, {
          acknowledgeDeletionHistory: true,
        }),
        (error) =>
          error instanceof DurableConflictError &&
          error.code === "restore_blocked_deletion_pending" &&
          error.message ===
            "Cannot restore over a household with a pending deletion. Cancel the deletion using current household authority or allow it to finalize first.",
      );
      assert.deepEqual(readdirSync(fixture.directory).sort(), [...originalFiles.keys()]);
      for (const [name, bytes] of originalFiles)
        assert.deepEqual(readFileSync(join(fixture.directory, name)), bytes, name);
      const verification = new DurableStore(targetPath);
      try {
        assert.equal(verification.lifecycleInfo(fixture.identity.householdId).state, "deletion_pending");
        assert.equal(verification.lifecycleInfo(fixture.identity.householdId).finalizeAt, pending.finalizeAt);
        assert.equal(verification.eventCount(fixture.identity.householdId), 1);
        const service = new PairingService({ store: verification, now: fixture.now });
        if (joined) {
          assert.equal(service.members.get(joined.memberId).active, false);
          assert.ok(service.devices.get(joined.deviceId).revokedAt);
          assert.throws(
            () => service.cancelHouseholdDeletion(joined.deviceToken, "removed-passkey"),
            (error) => error instanceof PairingError,
          );
        }
        const cancelled = service.cancelHouseholdDeletion(
          fixture.identity.deviceToken,
          "lifecycle-passkey",
        );
        assert.equal(service.authorize(cancelled.sessionToken).member.id, fixture.identity.memberId);
        assert.equal(verification.validate(), true);
      } finally {
        verification.close();
      }
    } finally {
      fixture.close();
    }
  });
}

test("restore preserves a newer deletion cancellation over a pending backup", async () => {
  const fixture = createFixture();
  const targetPath = join(fixture.directory, "kin.sqlite");
  const backupPath = join(fixture.directory, "deletion-pending.sqlite");
  try {
    fixture.service.requestHouseholdDeletion(
      fixture.identity.sessionToken,
      fixture.identity.memberId,
    );
    await fixture.store.backup(backupPath);
    const backup = new DurableStore(backupPath, { readonly: true });
    try {
      assert.equal(backup.lifecycleInfo(fixture.identity.householdId).state, "deletion_pending");
    } finally {
      backup.close();
    }

    const cancelled = fixture.service.cancelHouseholdDeletion(
      fixture.identity.deviceToken,
      "lifecycle-passkey",
    );
    assert.equal(
      fixture.service.authorize(cancelled.sessionToken).household.id,
      fixture.identity.householdId,
    );
    fixture.store.close();

    const result = await DurableStore.restoreBackup(backupPath, targetPath, {
      acknowledgeDeletionHistory: true,
    });
    assert.equal(result.preservedAuthorityCount, 1);
    const verification = new DurableStore(targetPath);
    try {
      assert.equal(verification.lifecycleInfo(fixture.identity.householdId).state, "active");
      const identity = verification.loadIdentity();
      assert.equal(identity.members.get(fixture.identity.memberId).active, true);
      assert.equal(identity.devices.get(fixture.identity.deviceId).revokedAt, null);
      assert.equal(identity.credentials.has("lifecycle-passkey"), true);
      assert.equal(verification.validate(), true);
    } finally {
      verification.close();
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("restore merges newer deletion tombstones from the existing database", async () => {
  const fixture = createFixture();
  const targetPath = join(fixture.directory, "kin.sqlite");
  const backupPath = join(fixture.directory, "before-deletion.sqlite");
  try {
    await fixture.store.backup(backupPath);
    const pending = fixture.service.requestHouseholdDeletion(
      fixture.identity.sessionToken,
      fixture.identity.memberId,
    );
    fixture.setNow(pending.finalizeAt);
    fixture.service.finalizeExpiredDeletions();
    fixture.store.close();
    const restored = await DurableStore.restoreBackup(
      backupPath,
      targetPath,
      { acknowledgeDeletionHistory: true },
    );
    assert.equal(restored.preservedDeletionCount, 1);
    const verification = new DurableStore(targetPath);
    try {
      assert.equal(
        verification.lifecycleInfo(fixture.identity.householdId).state,
        "deleted",
      );
      assert.equal(verification.eventCount(fixture.identity.householdId), 0);
      const identity = verification.loadIdentity();
      assert.equal(identity.members.size, 0);
      assert.equal(identity.devices.size, 0);
      assert.equal(identity.credentials.size, 0);
      const service = new PairingService({ store: verification, now: fixture.now });
      assert.throws(
        () => service.reauthenticate(fixture.identity.deviceToken, "lifecycle-passkey"),
        (error) => error instanceof PairingError,
      );
      assert.throws(
        () => service.cancelHouseholdDeletion(fixture.identity.deviceToken, "lifecycle-passkey"),
        (error) => error instanceof PairingError,
      );
      assert.equal(verification.validate(), true);
    } finally {
      verification.close();
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("HTTP deletion requires a passkey flow and exposes an explicit pending lifecycle", async () => {
  const fixture = createFixture();
  const webauthn = {
    authenticationOptions: (flow, credentialIds) => ({
      challenge: "test",
      flow,
      credentialIds,
    }),
    verifyAuthentication: (credential) => {
      if (credential.id !== "lifecycle-passkey")
        throw new PairingError(
          "invalid_passkey",
          "That passkey could not be verified.",
          401,
        );
      return true;
    },
  };
  const app = createKinServer({
    store: fixture.store,
    service: fixture.service,
    syncService: fixture.sync,
    webauthn,
    now: fixture.now,
  });
  try {
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const request = (path, { method = "GET", cookie, body } = {}) =>
      fetch(`${origin}${path}`, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const sessionCookie = `kin_session=${fixture.identity.sessionToken}`;
    const deviceCookie = `kin_device=${fixture.identity.deviceToken}`;

    const unauthenticated = await request("/api/household/deletion/options", {
      method: "POST",
      body: {},
    });
    assert.equal(unauthenticated.status, 401);

    const options = await request("/api/household/deletion/options", {
      method: "POST",
      cookie: sessionCookie,
      body: {},
    });
    assert.equal(options.status, 200);
    const { flow } = await options.json();
    const invalidFinish = await request("/api/household/deletion/finish", {
      method: "POST",
      cookie: sessionCookie,
      body: { flow, credential: { id: "not-this-member" } },
    });
    assert.equal(invalidFinish.status, 401);
    assert.equal(
      fixture.store.lifecycleInfo(fixture.identity.householdId).state,
      "active",
    );
    const retryOptions = await request("/api/household/deletion/options", {
      method: "POST",
      cookie: sessionCookie,
      body: {},
    });
    assert.equal(retryOptions.status, 200);
    const { flow: retryFlow } = await retryOptions.json();
    const finish = await request("/api/household/deletion/finish", {
      method: "POST",
      cookie: sessionCookie,
      body: {
        flow: retryFlow,
        credential: { id: "lifecycle-passkey" },
      },
    });
    assert.equal(finish.status, 200);
    assert.equal((await finish.json()).state, "deletion_pending");

    const status = await request("/api/status", { cookie: deviceCookie });
    assert.equal(status.status, 200);
    assert.equal(
      (await status.json()).householdLifecycle.state,
      "deletion_pending",
    );
    const cancelled = await request(
      "/api/household/deletion/cancel/options",
      { method: "POST", cookie: deviceCookie, body: {} },
    );
    assert.equal(cancelled.status, 200);
    const { flow: cancelFlow } = await cancelled.json();
    const cancelledFinish = await request(
      "/api/household/deletion/cancel/finish",
      {
        method: "POST",
        cookie: deviceCookie,
        body: {
          flow: cancelFlow,
          credential: { id: "lifecycle-passkey" },
        },
      },
    );
    assert.equal(cancelledFinish.status, 200);
    assert.equal(
      fixture.store.lifecycleInfo(fixture.identity.householdId).state,
      "active",
    );
  } finally {
    if (app.server.listening)
      await new Promise((resolve) => app.server.close(resolve));
    fixture.close();
  }
});

test("HTTP lifecycle lookup answers without a session for active, pending, deleted, unknown, and malformed households", async () => {
  const fixture = createFixture();
  const app = createKinServer({
    store: fixture.store,
    service: fixture.service,
    syncService: fixture.sync,
    now: fixture.now,
  });
  try {
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const lookup = async (householdId) => {
      const response = await fetch(`${origin}/api/household/lifecycle?householdId=${householdId}`);
      return { status: response.status, body: await response.json() };
    };
    const { householdId } = fixture.identity;
    // A revoked or removed device keeps no session, so this lookup must work
    // without one for the client to distinguish lost access from deletion.
    assert.deepEqual(await lookup(householdId), {
      status: 200,
      body: { state: "active", finalizeAt: null, message: "This household is active." },
    });
    assert.equal((await lookup("f".repeat(32))).status, 404);
    assert.equal((await lookup("not-a-household")).status, 400);
    const requested = fixture.service.requestHouseholdDeletion(fixture.identity.sessionToken, fixture.identity.memberId);
    const pending = await lookup(householdId);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.state, "deletion_pending");
    assert.equal(pending.body.finalizeAt, requested.finalizeAt);
    fixture.setNow(requested.finalizeAt);
    const deleted = await lookup(householdId);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.state, "deleted");
    assert.match(deleted.body.message, /deleted/);
  } finally {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    fixture.close();
  }
});
