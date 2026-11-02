// The move package (ADR 0026 §2–§3, #737): every table is classified, a
// package holds one household's records and no secret that authenticates
// anything, and a home server imports it whole or not at all.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { SERVER_SCHEMA_VERSION } from "./durable-store/shared.mjs";
import {
  MOVED_TABLES, MOVING_WRAPPER_TYPES, SERVER_TABLES, STAYING_TABLES,
  buildMovePackage, checkMovePackage, importMovePackage, tablesOf,
} from "./move-package.mjs";
import { PairingService } from "./pairing-service.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

function sealedVault() {
  const bytes = Buffer.alloc(120, 7);
  bytes.write("KVLT", 0, "latin1");
  bytes[4] = 1;
  return bytes;
}

function wrapper(wrapperId, type, params) {
  const wrapped = Buffer.alloc(61, 3);
  wrapped[0] = 1;
  return { wrapperId, type, version: 1, params, wrapped };
}

/** A folder for the test's databases, and `open(path)` for a store in it.
 * Stores close before the folder goes (Windows keeps an open file). */
function folder(t) {
  const directory = mkdtempSync(join(tmpdir(), "kin-move-package-"));
  const stores = [];
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch { /* closed by the test */ } }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const open = (name) => { const store = new DurableStore(join(directory, name), { acquireProcessLock: false }); stores.push(store); return store; };
  return { directory, open };
}

/** The hosted service: two households, the first with an account (vault
 * with password, passkey and backup-code wrappers, and a password), stored
 * as the service stores them (bytes, not base64). */
function hosted(t) {
  const { directory, open } = folder(t);
  const store = open("hosted.sqlite");
  const pairing = new PairingService({ store });
  pairing.householdPolicy = { allowNew: true, maxHouseholds: null };
  const moving = pairing.bootstrap({ credential: credential("moving-admin"), deviceLabel: "Synthetic laptop" });
  const staying = pairing.bootstrap({ credential: credential("staying-admin"), deviceLabel: "Synthetic phone" });
  store.putAccountVault(moving.householdId, moving.memberId, {
    expectedVersion: 0, ciphertext: sealedVault(), now: 1,
    wrappers: [
      wrapper("1".repeat(32), "password", { kdf: "pbkdf2-sha256", iterations: 600_000, salt: b64(Buffer.alloc(16, 9)) }),
      wrapper("a".repeat(32), "backup-code", { verifier: b64(Buffer.alloc(32, 6)) }),
    ],
  });
  store.putAccountVaultWrapper(moving.householdId, moving.memberId, wrapper("2".repeat(32), "passkey", { credentialId: b64(Buffer.alloc(32, 4)), prfSalt: b64(Buffer.alloc(32, 5)) }), 2);
  store.putAccountPassword(moving.householdId, moving.memberId, { salt: new Uint8Array(16).fill(1), iterations: 600_000, verifier: "$argon2id$v=19$m=19456,t=2,p=1$x$y", now: 3 });
  return { directory, open, store, pairing, moving, staying };
}

test("every table is either moved, left behind, or the server's own", () => {
  const store = new DurableStore(":memory:");
  try {
    const classified = [...MOVED_TABLES, ...STAYING_TABLES, ...SERVER_TABLES];
    assert.equal(new Set(classified).size, classified.length, "no table is in two lists");
    assert.deepEqual(tablesOf(store.db), [...classified].sort(), "a new table needs a decision in server/move-package.mjs");
  } finally {
    store.close();
  }
});

test("a package holds one household's records and nothing that signs anyone in", (t) => {
  const { directory, store, moving, staying } = hosted(t);
  const path = join(directory, "move.sqlite");
  const summary = buildMovePackage(store, moving.householdId, path);
  assert.deepEqual({ householdId: summary.householdId, households: summary.households, members: summary.members, devices: summary.devices }, { householdId: moving.householdId, households: 1, members: 1, devices: 1 });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM households WHERE id = ?").get(staying.householdId).n, 0, "only this household");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credentials").get().n, 0, "no passkeys");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM devices WHERE token_hash IS NOT NULL").get().n, 0, "no device tokens");
    assert.deepEqual(db.prepare("SELECT credential_ids FROM members").all().map((row) => row.credential_ids), ["[]"]);
    assert.deepEqual(db.prepare("SELECT type FROM account_vault_wrappers ORDER BY type").all().map((row) => row.type), [...MOVING_WRAPPER_TYPES].sort(), "the passkey wrapper stays behind");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM account_passwords").get().n, 1, "the password check moves");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM security_audit").get().n, 0);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, SERVER_SCHEMA_VERSION);
  } finally {
    db.close();
  }
  // The hosted household itself is untouched.
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM credentials").get().n, 2);
  assert.ok(store.db.prepare("SELECT token_hash FROM devices WHERE household_id = ?").get(moving.householdId).token_hash);
  assert.throws(() => buildMovePackage(store, moving.householdId, path), { code: "move-exists" });
  assert.throws(() => buildMovePackage(store, "no-such-household", join(directory, "other.sqlite")), { code: "move-unknown-household" });
});

test("a home server imports the package whole: the same IDs, account and history, signed in nowhere", (t) => {
  const { directory, open, store, moving } = hosted(t);
  const path = join(directory, "move.sqlite");
  buildMovePackage(store, moving.householdId, path);
  const home = open("home.sqlite");
  const summary = importMovePackage(home, path);
  assert.equal(summary.householdId, moving.householdId);
  // As the service loads it at startup.
  const pairing = new PairingService({ store: home });
  assert.ok(pairing.households.has(moving.householdId));
  assert.equal(pairing.members.get(moving.memberId).householdId, moving.householdId);
  assert.equal(pairing.credentials.size, 0);
  assert.equal(pairing.deviceTokens.size, 0, "every device signs in again");
  assert.equal(home.accountVault(moving.householdId, moving.memberId).version, 1);
  assert.ok(home.accountPassword(moving.householdId, moving.memberId), "the same password works here");
  home.validate();
  // A second time: refused, and the home server keeps working.
  assert.throws(() => importMovePackage(home, path), { code: "move-clash" });
  assert.equal(home.failed, false);
  home.validate();
});

/** The moving household with a second device, revoked before the move. */
function withRevokedDevice(pairing, moving) {
  const request = pairing.createDevicePairing(moving.sessionToken);
  const claim = pairing.claimPairing({ code: request.code, credential: credential("old-tablet"), deviceLabel: "Old tablet", rateKey: "old-tablet" });
  pairing.approvePairing(moving.sessionToken, request.pairingId, claim.version);
  const tablet = pairing.activateClaim(claim.claimToken);
  pairing.revokeDevice(moving.sessionToken, tablet.deviceId, moving.memberId);
  return tablet.deviceId;
}

test("imported devices are marked as carried over from the old address", (t) => {
  const { directory, open, store, pairing, moving } = hosted(t);
  const revokedId = withRevokedDevice(pairing, moving);
  const path = join(directory, "move.sqlite");
  buildMovePackage(store, moving.householdId, path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM devices WHERE json_extract(device_json, '$.carriedOver') IS NOT NULL").get().n, 0,
      "the package itself carries no mark");
  } finally {
    db.close();
  }
  const home = open("home.sqlite");
  importMovePackage(home, path);
  home.validate();
  const service = new PairingService({ store: home });
  assert.equal(service.devices.get(moving.deviceId).carriedOver, true);
  assert.equal("carriedOver" in service.devices.get(revokedId), false, "a revoked device isn't marked");
  // The hosted household itself is untouched.
  assert.equal("carriedOver" in pairing.devices.get(moving.deviceId), false);
});

test("a household that moves again is marked afresh", (t) => {
  const { directory, open, store, pairing, moving } = hosted(t);
  const revokedId = withRevokedDevice(pairing, moving);
  const path = join(directory, "move.sqlite");
  buildMovePackage(store, moving.householdId, path);
  // As a package from a home server that received the household before.
  const edit = new DatabaseSync(path);
  edit.prepare("UPDATE devices SET device_json = json_set(device_json, '$.carriedOver', json('true')) WHERE id = ?").run(revokedId);
  edit.close();
  const home = open("home.sqlite");
  importMovePackage(home, path);
  const service = new PairingService({ store: home });
  assert.equal(service.devices.get(moving.deviceId).carriedOver, true);
  assert.equal("carriedOver" in service.devices.get(revokedId), false);
});

test("a package from a newer Kin, or one carrying a token, is refused before anything changes", (t) => {
  const { directory, open, store, moving } = hosted(t);
  const newer = join(directory, "newer.sqlite");
  buildMovePackage(store, moving.householdId, newer);
  const db = new DatabaseSync(newer);
  db.exec(`PRAGMA user_version = ${SERVER_SCHEMA_VERSION + 1}`);
  db.close();
  assert.throws(() => checkMovePackage(newer), { code: "move-newer" });

  const tampered = join(directory, "tampered.sqlite");
  buildMovePackage(store, moving.householdId, tampered);
  const edit = new DatabaseSync(tampered);
  edit.prepare("UPDATE devices SET token_hash = ?").run("f".repeat(64));
  edit.close();
  assert.throws(() => checkMovePackage(tampered), { code: "move-invalid" });

  const home = open("home.sqlite");
  assert.throws(() => importMovePackage(home, tampered), { code: "move-invalid" });
  assert.equal(home.db.prepare("SELECT COUNT(*) AS n FROM households").get().n, 0, "nothing changed");
  assert.throws(() => checkMovePackage(join(directory, "missing.sqlite")), { code: "move-invalid" });
});

test("only a household in use moves", (t) => {
  const { directory, store, moving } = hosted(t);
  store.db.prepare("UPDATE households SET lifecycle_state = 'deletion_pending', deletion_requested_at = 1, deletion_finalize_at = 2 WHERE id = ?").run(moving.householdId);
  assert.throws(() => buildMovePackage(store, moving.householdId, join(directory, "move.sqlite")), { code: "move-not-active" });
});
