// The household key a rotation makes reaches the committer's account vault
// in the same step (#791, ADR 0018). A device that commits a rotation sends
// its vault re-sealed with the new key alongside POST /api/sync/epochs, and
// the service stores both in one transaction or neither. Before, the new key
// lived only on the committing device until its vault keeper ran; losing
// that device in the window left a backup-code (or password, or passkey)
// sign-in on a new device without the key, with sync paused for good.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { derivePasswordKeys, generateCertificationKey, generateVaultKey, openVault, sealVault, wipeVaultContents } from "../web/security/account-vault.js";
import { backupCodeChange, makeWrapper, passwordParams, wrapperChangeBody } from "../web/security/account-wrappers.js";
import { generateBackupCode } from "../web/security/backup-code.js";
import { certificationKeyPair, createCertificationEndorsement, createMemberCertificate } from "../web/security/device-certification.js";
import { downloadSignInVault, openSignInVault, signInWithBackupCode, signInWithPassword, vaultHouseholdEpochs, wipeSignIn } from "../web/security/new-device.js";
import { createHouseholdEpochKey, deviceKeyFingerprint, exportDevicePublicKeys, exportStoredEpochKey, generateDeviceKeys } from "../web/sync/crypto.js";
import { SyncCoordinator } from "../web/sync/sync-coordinator.js";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { createKinServer } from "./server.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const PASSWORD = "four unrelated words";
const SALT = new Uint8Array(16).fill(7);
const same = (left, right) => Buffer.from(left).equals(Buffer.from(right));

function stubWebAuthn() {
  return {
    registrationOptions: (flow) => ({ challenge: flow }),
    authenticationOptions: (flow, credentialIds) => ({ challenge: b64(Buffer.from(flow)), allowCredentials: credentialIds.map((id) => ({ id })) }),
    verifyRegistration: (response) => ({ id: response.id, publicKey: `key-${response.id}`, algorithm: -7, signCount: 0 }),
    verifyAuthentication(response, _flow, registered) {
      if (!registered || response?.id !== registered.id) throw new PairingError("passkey_verification_failed", "Invalid passkey.", 401);
      return true;
    },
    discardFlow() {},
  };
}

async function deviceKeys() {
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  return { keys, publicKeys, fingerprint: await deviceKeyFingerprint(publicKeys) };
}

// Sends only the headers of a body `length` bytes long and reads the answer.
// A body over the limit is refused by its declared length and the connection
// closed, so a client still uploading it may see a reset instead of the 413.
function declareBody(url, path, length, jar) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(length), Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") },
    }, (response) => {
      let text = "";
      response.on("data", (data) => { text += data; });
      response.on("end", () => { request.destroy(); resolve({ status: response.statusCode, body: JSON.parse(text) }); });
    });
    request.on("error", reject);
    request.flushHeaders();
  });
}

async function startServer({ durable = true, options = {} } = {}) {
  // `store: false` is the service without a durable store (never the
  // default database file).
  const store = durable ? new DurableStore(":memory:") : null;
  const application = createKinServer({ store: store ?? false, webauthn: stubWebAuthn(), origin: "http://localhost", ...options });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${application.server.address().port}`;
  const browser = (jar = new Map()) => {
    /** `body` is sent as is when it is a string (the coordinator's own JSON). */
    const call = async (path, { method = "POST", body } = {}) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") },
        body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body ?? {}),
      });
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const [name, value] = pair.split("=");
        if (value) jar.set(name, value); else jar.delete(name);
      }
      return { status: response.status, body: await response.json() };
    };
    const fail = (result) => Object.assign(new Error(result.body.message), { code: result.body.error, status: result.status });
    return {
      jar, call,
      /** For the browser sign-in library (web/security/new-device.js). */
      request: async (path, body = {}, { method = "POST" } = {}) => {
        const result = await call(path, { method, body });
        if (result.status >= 400) throw fail(result);
        return result.body;
      },
      /** SyncCoordinator.request's shape: `{ method = "GET", body }`. */
      sync: async (path, { method = "GET", body } = {}) => {
        const result = await call(path, { method, body });
        if (result.status >= 400) throw fail(result);
        return result.body;
      },
    };
  };
  return { ...application, store, browser, url,
    close: () => new Promise((resolve) => application.server.close(resolve)).finally(() => store?.close()) };
}

/** A founder with a password, a vault (version 1: a password wrapper, a
 * backup code, household epoch 1) and an endorsed certification key. */
async function foundHousehold(server, username = "sam.lee") {
  const founder = server.browser();
  const device = await deviceKeys();
  const keys = await derivePasswordKeys(PASSWORD, SALT);
  const created = await founder.call("/api/account/bootstrap", { body: {
    username, authKey: b64(keys.authKey), salt: b64(SALT), iterations: 600_000, deviceLabel: "Phone", syncPublicKeys: device.publicKeys,
  } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { householdId, memberId, deviceId } = created.body;
  const vaultKey = generateVaultKey();
  const certificationKey = await generateCertificationKey();
  const ciphertext = await sealVault(vaultKey, { epochs: [{ family: "household", epoch: 1, key: new Uint8Array(32).fill(9) }], certificationKey: certificationKey.pkcs8 },
    { householdId, memberId, version: 1 });
  const wrapper = await makeWrapper({ vaultKey, kek: keys.passwordKey, type: "password", params: passwordParams({ salt: SALT, iterations: 600_000 }), householdId, memberId });
  const uploaded = await founder.call("/api/account/vault", { method: "PUT", body: { expectedVersion: 0, ciphertext: b64(ciphertext), wrappers: wrapperChangeBody({ put: [wrapper] }).put } });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const certification = await certificationKeyPair(certificationKey.pkcs8);
  const endorsement = await createCertificationEndorsement({ householdId, memberId, certification,
    device: { deviceId, fingerprint: device.fingerprint, signingKey: device.keys.signingPrivateKey } });
  assert.equal((await founder.call("/api/account/certification", { method: "PUT", body: { endorsement } })).status, 200);
  const backupCode = await generateBackupCode();
  const current = (await founder.call("/api/account/security", { method: "GET" })).body.vault.wrappers;
  const change = await backupCodeChange({ vaultKey, householdId, memberId, wrappers: current, codeBytes: backupCode.bytes.slice() });
  const added = await founder.call("/api/account/vault/wrappers", { body: { currentAuthKey: b64(keys.authKey), ...wrapperChangeBody(change) } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  return { founder, device, householdId, memberId, deviceId, vaultKey, keys, certification, endorsement, backupCode };
}

/** Signs a new browser in with the password and registers it as a device of
 * the same member: the service starts a key rotation (onDeviceAdded). */
async function addDevice(server, household) {
  const browser = server.browser();
  const { view } = await signInWithPassword({ username: "sam.lee", password: PASSWORD, request: browser.request });
  const device = await deviceKeys();
  const certificate = await createMemberCertificate({ householdId: view.householdId, memberId: view.memberId, endorsement: household.endorsement,
    certification: household.certification, device: { deviceId: view.deviceId, publicKeys: device.publicKeys, fingerprint: device.fingerprint } });
  const registered = await browser.call("/api/account/sign-in/device", { body: { syncPublicKeys: device.publicKeys, certificate, deviceLabel: "Laptop", vaultEpochs: [1] } });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  return { browser, device, deviceId: view.deviceId };
}

/**
 * A real SyncCoordinator for `added` over HTTP, with in-memory sync state
 * and key store, as the rotation-recovery fixture builds them. `vaultKey`
 * is the coordinator's option (the member's vault key, or null). Every
 * request's method and path is kept in `requests`.
 */
async function coordinatorFor(household, added, { vaultKey = () => household.vaultKey.slice() } = {}) {
  const identity = { householdId: household.householdId, memberId: household.memberId, deviceId: added.deviceId };
  const epochs = new Map([[1, await createHouseholdEpochKey({ householdId: household.householdId, keyEpoch: 1, deviceKeys: added.device.keys })]]);
  const state = { currentEpoch: 1, pendingRotation: null };
  const store = {
    async getSyncState() { return structuredClone(state); },
    async savePendingRotation(value) { state.pendingRotation = structuredClone(value); return structuredClone(value); },
    async replacePendingRotationPackages({ packages, issuerFingerprint }) {
      state.pendingRotation = { ...state.pendingRotation, packages, issuerFingerprint };
      return structuredClone(state.pendingRotation);
    },
    async commitPendingRotation({ currentEpoch }) { state.pendingRotation = null; state.currentEpoch = currentEpoch; },
    async clearPendingRotation() { state.pendingRotation = null; },
  };
  const coordinator = new SyncCoordinator({ store, engine: {}, identity, vaultKey: async () => vaultKey() });
  coordinator.deviceKeys = { keys: added.device.keys, fingerprint: added.device.fingerprint };
  const installed = [];
  coordinator.keyStore = {
    async getEpoch(_householdId, epoch) { return epochs.get(epoch); },
    async saveEpoch(record) {
      installed.push({ epoch: record.keyEpoch, afterCommit: requests.includes("POST /api/sync/epochs") });
      epochs.set(record.keyEpoch, record);
    },
  };
  const requests = [];
  coordinator.request = async (path, options = {}) => {
    requests.push(`${options.method ?? "GET"} ${path}`);
    return added.browser.sync(path, options);
  };
  coordinator.loadDeviceDirectory = async () => (await coordinator.request("/api/sync/devices")).devices;
  coordinator.provisionMemberHistory = async () => {};
  /** The raw household key this device committed for `epoch`. */
  const rawKey = (epoch) => exportStoredEpochKey({ record: { householdId: household.householdId, ...epochs.get(epoch) }, deviceKeys: added.device.keys });
  return { coordinator, epochs, state, installed, requests, rawKey };
}

/** The stored vault, opened with the member's vault key. */
async function storedVault(server, household) {
  const row = server.accountVaultService.storage.accountVault(household.householdId, household.memberId);
  const contents = await openVault(household.vaultKey, row.ciphertext, { householdId: household.householdId, memberId: household.memberId, version: row.version });
  return { version: row.version, contents };
}

test("#791: the device that commits a rotation is lost at once; a backup-code sign-in on a new device still gets the new household key", { timeout: 120_000 }, async () => {
  const server = await startServer();
  try {
    const household = await foundHousehold(server);
    // D3: a new device of the same member. Registering it starts a rotation,
    // which D3 commits on its first sync.
    const d3 = await addDevice(server, household);
    assert.equal(server.syncService.state(household.householdId).rotationPending, true);
    const sync = await coordinatorFor(household, d3);
    await sync.coordinator.commitRotation();
    assert.equal(server.syncService.state(household.householdId).currentEpoch, 2);
    // D3 is lost right here: its vault keeper never runs, and nothing else
    // on D3 talks to the service again.
    assert.ok(!sync.requests.includes("PUT /api/account/vault"), "no separate vault upload was needed");
    assert.deepEqual(sync.installed, [{ epoch: 2, afterCommit: true }], "the key is installed only once the service accepted it");
    const committed = await sync.rawKey(2);
    const stored = await storedVault(server, household);
    try {
      const entry = stored.contents.epochs.find((item) => item.family === "household" && item.epoch === 2);
      assert.ok(entry, `the account vault holds household epoch 2 (vault version ${stored.version}, epochs ${vaultHouseholdEpochs(stored.contents)})`);
      assert.ok(same(entry.key, committed), "and it is the key that committed");
      assert.equal(stored.version, 2);
    } finally {
      wipeVaultContents(stored.contents);
    }

    // D4 signs in with the backup code. The vault it downloads covers the
    // household's current epoch, so its first sync doesn't pause for want
    // of the key.
    const d4 = server.browser();
    const signedIn = await signInWithBackupCode({ username: "sam.lee", code: household.backupCode.text, request: d4.request });
    const opened = await openSignInVault({ download: await downloadSignInVault({ request: d4.request }), method: "backup-code",
      codeBytes: signedIn.codeBytes, householdId: household.householdId, memberId: household.memberId });
    try {
      const current = server.syncService.state(household.householdId).currentEpoch;
      assert.ok(vaultHouseholdEpochs(opened.contents).includes(current), `D4's vault holds the current epoch ${current}`);
      assert.ok(same(opened.contents.epochs.find((item) => item.family === "household" && item.epoch === current).key, committed));
    } finally {
      wipeSignIn({ ...opened, codeBytes: signedIn.codeBytes });
      committed.fill(0);
    }
  } finally {
    await server.close();
  }
});

/** A sealed vault as the service sees it: "KVLT", format 1, opaque bytes. */
function sealedVault(size = 120, fill = 7) {
  const bytes = Buffer.alloc(size, fill);
  bytes.write("KVLT", 0, "latin1");
  bytes[4] = 1;
  return b64(bytes);
}

/**
 * A one-device household over HTTP with a rotation due: the founder signs up
 * with a password and (unless `vault` is false) uploads vault version 1. With
 * one device a rotation has no packages, so only the service's checks stand
 * in its way.
 */
async function oneDevice(server, { vault = true } = {}) {
  const founder = server.browser();
  const device = await deviceKeys();
  const keys = await derivePasswordKeys(PASSWORD, SALT);
  const created = await founder.call("/api/account/bootstrap", { body: {
    username: "sam.lee", authKey: b64(keys.authKey), salt: b64(SALT), iterations: 600_000, deviceLabel: "Phone", syncPublicKeys: device.publicKeys,
  } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { householdId, memberId } = created.body;
  if (vault) {
    const wrapper = await makeWrapper({ vaultKey: generateVaultKey(), kek: keys.passwordKey, type: "password",
      params: passwordParams({ salt: SALT, iterations: 600_000 }), householdId, memberId });
    const uploaded = await founder.call("/api/account/vault", { method: "PUT", body: { expectedVersion: 0, ciphertext: sealedVault(), wrappers: wrapperChangeBody({ put: [wrapper] }).put } });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  }
  server.syncService.onAccessChange(householdId);
  const stored = () => server.accountVaultService.storage.accountVault(householdId, memberId);
  const status = () => server.syncService.state(householdId);
  /** What a restart would load (durable only). */
  const reloaded = () => new EncryptedSyncService(new PairingService({ store: server.store }), { store: server.store }).state(householdId);
  const commit = (body) => founder.call("/api/sync/epochs", { body: { expectedEpoch: 1, packages: [], proposalId: "f".repeat(32), ...body } });
  return { founder, householdId, memberId, stored, status, reloaded, commit };
}

/** Still at epoch 1 with its rotation due, in memory and in the store, and the vault as it was. */
function unchanged(server, household, before) {
  for (const state of server.store ? [household.status(), household.reloaded()] : [household.status()]) {
    assert.equal(state.currentEpoch, 1);
    assert.equal(state.rotationPending, true);
    assert.equal(state.lastRotation ?? null, null);
  }
  const after = household.stored();
  assert.equal(after?.version ?? null, before?.version ?? null);
  if (before) assert.ok(same(after.ciphertext, before.ciphertext));
}

for (const durable of [true, false]) {
  const where = durable ? "durable" : "in memory";

  test(`a rotation and its vault change are stored together (${where})`, { timeout: 60_000 }, async () => {
    const server = await startServer({ durable });
    try {
      const household = await oneDevice(server);
      const answer = await household.commit({ vaultChange: { expectedVersion: 1, ciphertext: sealedVault(140, 8) } });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.deepEqual(answer.body, { currentEpoch: 2, rotationPending: false, retried: false, proposalId: "f".repeat(32), vault: { version: 2 } });
      assert.equal(household.status().currentEpoch, 2);
      assert.equal(household.stored().version, 2);
      assert.equal(b64(household.stored().ciphertext), sealedVault(140, 8));
      assert.equal((await household.founder.call("/api/sync/status", { method: "GET" })).body.currentEpoch, 2);
      if (durable) assert.equal(household.reloaded().currentEpoch, 2, "both survive a restart");
      // The same proposal again is a retry: the vault is not written again.
      const retried = await household.commit({ vaultChange: { expectedVersion: 2, ciphertext: sealedVault(150, 9) } });
      assert.equal(retried.status, 200, JSON.stringify(retried.body));
      assert.equal(retried.body.retried, true);
      assert.equal(retried.body.vault, null);
      assert.equal(household.stored().version, 2);
      assert.equal(b64(household.stored().ciphertext), sealedVault(140, 8));
      // Without a vault change the answer says none was stored.
      server.syncService.onAccessChange(household.householdId);
      const plain = await household.founder.call("/api/sync/epochs", { body: { expectedEpoch: 2, packages: [], proposalId: "e".repeat(32) } });
      assert.equal(plain.status, 200, JSON.stringify(plain.body));
      assert.equal(plain.body.vault, null);
      assert.equal(household.stored().version, 2);
    } finally {
      await server.close();
    }
  });

  test(`a refused vault change commits nothing, and a refused rotation stores no vault change (${where})`, { timeout: 60_000 }, async () => {
    const server = await startServer({ durable });
    try {
      const household = await oneDevice(server);
      const before = household.stored();
      // Another device wrote the vault first.
      const conflict = await household.commit({ vaultChange: { expectedVersion: 2, ciphertext: sealedVault(140, 8) } });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error, "vault_version_conflict");
      unchanged(server, household, before);
      // The rotation's own checks come first: a stale epoch with a valid
      // vault change stores neither.
      const stale = await household.commit({ expectedEpoch: 5, vaultChange: { expectedVersion: 1, ciphertext: sealedVault(140, 8) } });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error, "stale_key_epoch");
      unchanged(server, household, before);
      for (const vaultChange of [
        { expectedVersion: 0, ciphertext: sealedVault() },
        { expectedVersion: 1, ciphertext: sealedVault(), wrappers: [] },
        { expectedVersion: 1 },
        { expectedVersion: "1", ciphertext: sealedVault() },
        { expectedVersion: 1.5, ciphertext: sealedVault() },
        { expectedVersion: 1, ciphertext: b64(Buffer.alloc(120, 7)) },
        { expectedVersion: 1, ciphertext: `${sealedVault(121)}=` },
        { expectedVersion: 1, ciphertext: sealedVault(16) },
        [1, sealedVault()],
        "change",
        null,
      ]) {
        const invalid = await household.commit({ vaultChange });
        assert.equal(invalid.status, 400, JSON.stringify(vaultChange));
        assert.equal(invalid.body.error, "vault_invalid");
        unchanged(server, household, before);
      }
      // A full write window refuses the commit too, before anything changes.
      for (let spent = 0; server.accountVaultService.memberWrites.spend(household.memberId); spent += 1) assert.ok(spent < 100);
      const limited = await household.commit({ vaultChange: { expectedVersion: 1, ciphertext: sealedVault(140, 8) } });
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error, "vault_rate_limited");
      unchanged(server, household, before);
      // The service is still healthy, and the same proposal then commits.
      if (durable) assert.equal(server.store.failed, false);
      const plain = await household.commit({});
      assert.equal(plain.status, 200, JSON.stringify(plain.body));
      assert.equal(household.status().currentEpoch, 2);
    } finally {
      await server.close();
    }
  });

  test(`a member without a vault is told so and nothing commits (${where})`, { timeout: 60_000 }, async () => {
    const server = await startServer({ durable });
    try {
      const household = await oneDevice(server, { vault: false });
      const missing = await household.commit({ vaultChange: { expectedVersion: 1, ciphertext: sealedVault() } });
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error, "vault_not_found");
      unchanged(server, household, null);
    } finally {
      await server.close();
    }
  });
}

test("a rotation that fails after its vault change was stored rolls the vault back with it", { timeout: 60_000 }, async () => {
  // The vault is written first and the epoch saved last, so only the one
  // transaction keeps a failed commit from leaving the vault holding a key
  // for an epoch that never committed (later refused as vault_epoch_conflict).
  const server = await startServer({ durable: true });
  try {
    const household = await oneDevice(server);
    const before = household.stored();
    const saveSyncState = server.store.saveSyncState.bind(server.store);
    let fail = true;
    server.store.saveSyncState = (...args) => {
      if (fail) {
        fail = false;
        assert.equal(household.stored().version, 2, "the vault change was stored before the epoch");
        throw new Error("The disk is full.");
      }
      return saveSyncState(...args);
    };
    const failed = await household.commit({ vaultChange: { expectedVersion: 1, ciphertext: sealedVault(140, 8) } });
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.equal(fail, false, "the save was reached");
    assert.equal(household.stored().version, before.version, "the vault change is rolled back");
    assert.ok(same(household.stored().ciphertext, before.ciphertext));
    const reloaded = household.reloaded();
    assert.equal(reloaded.currentEpoch, 1, "and the epoch never committed");
    assert.equal(reloaded.rotationPending, true);
  } finally {
    await server.close();
  }
});

test("a rotation with a full-size vault fits the request limit; a bigger body is refused", { timeout: 60_000 }, async () => {
  const server = await startServer();
  try {
    const household = await oneDevice(server);
    // A 64 KiB vault next to more package bytes than the old 256,000-byte
    // JSON limit left room for: the request reaches the rotation's checks.
    const packages = Array.from({ length: 64 }, (_, index) => ({ grantId: index.toString(16).padStart(32, "0"), padding: "p".repeat(2_600) }));
    const ciphertext = sealedVault(64 * 1024);
    assert.ok(JSON.stringify({ packages, ciphertext }).length > 256_000);
    const large = await household.commit({ packages, vaultChange: { expectedVersion: 1, ciphertext } });
    assert.equal(large.status, 409, JSON.stringify(large.body).slice(0, 200));
    assert.equal(large.body.error, "provisioning_device_mismatch");
    const oversized = JSON.stringify({ expectedEpoch: 1, packages: [...packages, ...packages], proposalId: "f".repeat(32), vaultChange: { expectedVersion: 1, ciphertext } });
    const tooLarge = await declareBody(server.url, "/api/sync/epochs", Buffer.byteLength(oversized), household.founder.jar);
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body.error, "request_too_large");
    const committed = await household.commit({ vaultChange: { expectedVersion: 1, ciphertext } });
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(household.stored().ciphertext.length, 64 * 1024);
  } finally {
    await server.close();
  }
});

test("without a linked vault service the field is ignored, as an older service would", () => {
  const pairing = new PairingService();
  const sync = new EncryptedSyncService(pairing);
  const adult = pairing.bootstrap({ credential: { id: "adult", publicKey: "key", algorithm: -7 } });
  sync.onAccessChange(adult.householdId);
  const answer = sync.rotateEpoch(adult.sessionToken, { expectedEpoch: 1, packages: [], proposalId: "f".repeat(32),
    vaultChange: { expectedVersion: 1, ciphertext: sealedVault() } });
  assert.deepEqual(answer, { currentEpoch: 2, rotationPending: false, retried: false, proposalId: "f".repeat(32), vault: null });
});
