import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore, DurableStoreError, hasDatabaseProcessLock } from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { createKinServer } from "./server.mjs";

function fixture(t, count = 3) {
  const directory = mkdtempSync(join(tmpdir(), "kin-semantic-validation-"));
  const path = join(directory, "kin.sqlite");
  const store = new DurableStore(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const pairing = new PairingService({ store });
  const adult = pairing.bootstrap({
    credential: { id: "validation-adult", publicKey: "synthetic-key", algorithm: -7 },
    deviceLabel: "Validation fixture",
  });
  const invitation = pairing.createPairing(adult.sessionToken);
  const claim = pairing.claimPairing({
    code: invitation.code,
    credential: { id: "validation-partner", publicKey: "synthetic-key", algorithm: -7 },
    deviceLabel: "Validation partner",
  });
  pairing.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const partner = pairing.activateClaim(claim.claimToken);
  const sync = new EncryptedSyncService(pairing, { store });
  for (let start = 1; start <= count; start += 20) {
    const envelopes = Array.from({ length: Math.min(20, count - start + 1) }, (_, index) => {
      const sequence = start + index;
      return {
        protocolVersion: 1,
        envelopeVersion: 1,
        eventId: sequence.toString(16).padStart(32, "0"),
        householdId: adult.householdId,
        deviceId: adult.deviceId,
        deviceSequence: sequence,
        logicalTime: String(sequence),
        keyEpoch: 1,
        nonce: Buffer.alloc(12, 1).toString("base64url"),
        ciphertext: Buffer.alloc(32, 2).toString("base64url"),
        signature: Buffer.alloc(64, 3).toString("base64url"),
      };
    });
    sync.push(adult.sessionToken, envelopes);
  }
  assert.equal(store.validate(), true);
  return { directory, path, store, pairing, sync, adult, partner };
}

function updateEnvelope(db, mutate, sequence = 1) {
  const row = db.prepare("SELECT canonical_envelope FROM sync_events WHERE relay_sequence = ?").get(sequence);
  const pairs = JSON.parse(row.canonical_envelope);
  const envelope = Object.fromEntries(pairs);
  mutate(envelope);
  db.prepare("UPDATE sync_events SET canonical_envelope = ? WHERE relay_sequence = ?")
    .run(JSON.stringify(pairs.map(([key]) => [key, envelope[key]])), sequence);
}

const corruptions = [
  ["relay event ID mismatch", ({ store }) => store.db.exec("UPDATE sync_events SET event_id = 'ffffffffffffffffffffffffffffffff' WHERE relay_sequence = 1")],
  ["relay device ID mismatch", ({ store, partner }) => store.db.prepare("UPDATE sync_events SET device_id = ? WHERE relay_sequence = 1").run(partner.deviceId)],
  ["relay device sequence mismatch", ({ store }) => store.db.exec("UPDATE sync_events SET device_sequence = 99 WHERE relay_sequence = 1")],
  ["relay epoch mismatch", ({ store }) => store.db.exec("UPDATE sync_events SET key_epoch = 2 WHERE relay_sequence = 1")],
  ["malformed canonical envelope", ({ store }) => store.db.exec("UPDATE sync_events SET canonical_envelope = '{}' WHERE relay_sequence = 1")],
  ["foreign canonical household", ({ store }) => updateEnvelope(store.db, (value) => { value.householdId = "f".repeat(32); })],
  ["unsupported envelope version", ({ store }) => updateEnvelope(store.db, (value) => { value.envelopeVersion = 2; })],
  ["invalid envelope nonce", ({ store }) => updateEnvelope(store.db, (value) => { value.nonce = "bad"; })],
  ["relay sequence gap", ({ store }) => store.db.exec("UPDATE sync_events SET relay_sequence = 4 WHERE relay_sequence = 3")],
  ["device sequence gap with matching envelope", ({ store }) => {
    store.db.exec("UPDATE sync_events SET device_sequence = 4 WHERE relay_sequence = 3; UPDATE sync_device_sequences SET last_sequence = 4");
    updateEnvelope(store.db, (value) => { value.deviceSequence = 4; }, 3);
  }],
  ["incorrect relay tail", ({ store }) => store.db.exec("UPDATE sync_households SET next_sequence = 5")],
  ["incorrect device high water", ({ store }) => store.db.exec("UPDATE sync_device_sequences SET last_sequence = 4")],
  ["extra nonzero device high water", ({ store, adult, partner }) => store.db.prepare("INSERT INTO sync_device_sequences VALUES (?, ?, ?)").run(adult.householdId, partner.deviceId, 1)],
  ["future relay epoch with matching envelope", ({ store }) => {
    store.db.exec("UPDATE sync_events SET key_epoch = 2 WHERE relay_sequence = 1");
    updateEnvelope(store.db, (value) => { value.keyEpoch = 2; });
  }],
  ["invalid audit timestamp", ({ store }) => store.db.exec("UPDATE security_audit SET created_at = 1.5")],
  ["invalid audit type", ({ store }) => store.db.prepare("UPDATE security_audit SET event_type = ?").run("x".repeat(65))],
  ["invalid audit details", ({ store }) => store.db.exec("UPDATE security_audit SET details_json = '[]'")],
  ["unsupported nested audit details", ({ store }) => store.db.exec("UPDATE security_audit SET details_json = '{\"unsafe\":{\"nested\":true}}'")],
  ["invalid migration timestamp", ({ store }) => store.db.exec("UPDATE server_migrations SET applied_at = 1.5")],
  ["device provisioned epoch ahead of household", ({ store, partner }) => {
    const row = store.db.prepare("SELECT device_json FROM devices WHERE id = ?").get(partner.deviceId);
    const device = JSON.parse(row.device_json);
    device.syncProvisionedEpochs = [2];
    store.db.prepare("UPDATE devices SET device_json = ? WHERE id = ?").run(JSON.stringify(device), partner.deviceId);
  }],
  ["device history entitlement beyond pending epoch", ({ store, partner }) => {
    const row = store.db.prepare("SELECT device_json FROM devices WHERE id = ?").get(partner.deviceId);
    const device = JSON.parse(row.device_json);
    device.syncHistoryFromEpoch = 3;
    store.db.prepare("UPDATE devices SET device_json = ? WHERE id = ?").run(JSON.stringify(device), partner.deviceId);
  }],
];

for (const [name, corrupt] of corruptions) {
  test(`SQLite-valid ${name} prevents durable startup`, (t) => {
    const state = fixture(t);
    corrupt(state);
    assert.equal(state.store.db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(state.store.db.pragma("foreign_key_check"), []);
    state.store.close();
    assert.throws(() => new DurableStore(state.path), DurableStoreError);
    assert.equal(hasDatabaseProcessLock(state.path), false);
  });
}

test("new adult may enable sync while awaiting the next epoch", (t) => {
  const { store, sync, adult, partner } = fixture(t);
  sync.onDeviceAdded(adult.householdId, partner.deviceId);
  sync.enable(partner.sessionToken);
  const device = store.loadIdentity().devices.get(partner.deviceId);
  assert.equal(device.syncHistoryFromEpoch, 2);
  assert.deepEqual(device.syncProvisionedEpochs, [1]);
  assert.equal(store.validate(), true);
});

test("readiness detects semantic corruption before any household request; health remains liveness", async (t) => {
  const { store, path, adult } = fixture(t);
  const app = createKinServer({ store, databasePath: path });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await fetch(`${origin}/readiness`)).status, 200);
    store.db.exec("UPDATE sync_device_sequences SET last_sequence = 99");
    assert.equal(store.db.pragma("quick_check", { simple: true }), "ok");
    const ready = await fetch(`${origin}/readiness`);
    assert.equal(ready.status, 503);
    const body = await ready.text();
    assert.deepEqual(JSON.parse(body), { ready: false });
    assert.equal(body.includes(adult.householdId), false);
    assert.equal(body.includes(path), false);
    assert.equal(store.failed, true);
    const live = await fetch(`${origin}/health`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "ok" });
    assert.equal((await fetch(`${origin}/api/status`)).status, 503);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test("production startup never announces ready for semantic corruption", (t) => {
  const { store, path } = fixture(t);
  store.db.exec("UPDATE sync_device_sequences SET last_sequence = 99");
  store.close();
  assert.throws(() => createKinServer({ databasePath: path }), DurableStoreError);
  const child = spawnSync(process.execPath, [join(import.meta.dirname, "server.mjs")], {
    env: { ...process.env, KIN_DATABASE_PATH: path, KIN_PORT: "0", KIN_HOST: "127.0.0.1", KIN_ORIGIN: "http://localhost:8000" },
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.deepEqual(JSON.parse(child.stderr), { event: "startup_failed", outcome: "configuration_or_storage" });
  assert.equal(hasDatabaseProcessLock(path), false);
});

test("backup and restore reject semantic corruption without publishing or replacing state", async (t) => {
  const { store, directory, path } = fixture(t);
  const target = join(directory, "target.sqlite");
  new DurableStore(target).close();
  const targetBefore = readFileSync(target);
  store.db.exec("UPDATE sync_device_sequences SET last_sequence = 99");
  const backup = join(directory, "backup.sqlite");
  await assert.rejects(store.backup(backup), DurableStoreError);
  assert.equal(store.failed, true);
  assert.equal(existsSync(backup), false);
  store.close();
  const sourceBefore = readFileSync(path);
  await assert.rejects(DurableStore.restoreBackup(path, target), DurableStoreError);
  assert.deepEqual(readFileSync(target), targetBefore);
  assert.deepEqual(readFileSync(path), sourceBefore);
  assert.equal(readdirSync(directory).some((name) => /\.lock$|\.tmp$|\.restore$|\.pre-restore-/.test(name)), false);
});

test("backup copy must pass semantic validation before becoming a verified backup", async (t) => {
  const { store, directory } = fixture(t);
  const backup = join(directory, "backup.sqlite");
  const original = store.db.backup.bind(store.db);
  store.db.backup = async (temporary) => {
    const result = await original(temporary);
    const copy = new Database(temporary);
    try {
      copy.exec("UPDATE sync_device_sequences SET last_sequence = 99");
    } finally {
      copy.close();
    }
    return result;
  };
  await assert.rejects(store.backup(backup), DurableStoreError);
  assert.equal(existsSync(backup), false);
  assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
  assert.equal(store.validate(), true);
});

test("full validation uses bounded relay pages and valid backups/restores remain usable", async (t) => {
  const { store, directory, adult, partner } = fixture(t, 65);
  // A zero high-water entry for a device with no events is consistent.
  store.db.prepare("INSERT INTO sync_device_sequences VALUES (?, ?, ?)")
    .run(adult.householdId, partner.deviceId, 0);
  const query = store.statements.eventsAfter;
  const original = query.all.bind(query);
  const pageSizes = [];
  query.all = (...args) => {
    const rows = original(...args);
    pageSizes.push(rows.length);
    assert.ok(args[2] <= 20);
    return rows;
  };
  assert.equal(store.validate(), true);
  assert.deepEqual(pageSizes, [20, 20, 20, 5, 0]);
  const backup = join(directory, "backup.sqlite");
  await store.backup(backup);
  const target = join(directory, "restored.sqlite");
  await DurableStore.restoreBackup(backup, target);
  const restored = new DurableStore(target);
  try {
    assert.equal(restored.validate(), true);
    assert.equal(restored.eventCount(adult.householdId), 65);
  } finally {
    restored.close();
  }
});
