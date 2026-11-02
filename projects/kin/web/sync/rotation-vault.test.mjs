// Committing a household key rotation with the account vault change (#791,
// web/sync/rotation-vault.js), against a fake service with real crypto: the
// vault a request carries opens with the real vault key at the next version
// and holds exactly the proposal's key; a conflict rebuilds it and resends
// the same proposal; every fallback commits as before; and the diagnostic is
// content-free.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { diagnostics } from "../diagnostics/ring-buffer.js";
import { normalizeFields } from "../diagnostics/registry.js";
import { generateVaultKey, openVault, sealVault, wipeVaultContents } from "../security/account-vault.js";
import { createProvisionedHouseholdEpoch, deviceKeyFingerprint, exportDevicePublicKeys, generateDeviceKeys } from "./crypto.js";
import { ROTATION_VAULT_ATTEMPTS, submitRotation } from "./rotation-vault.js";

const HOUSEHOLD = "a".repeat(32);
const MEMBER = "b".repeat(32);
const DEVICE = "c".repeat(32);
const PARTNER = "d".repeat(32);
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const fingerprint = (raw) => createHash("sha256").update(raw).digest("hex");
const serviceError = (code) => Object.assign(new Error(code), { code });

let shared = null;
/** This device's keys and a partner to wrap the proposal for (made once). */
async function devices() {
  if (shared) return shared;
  const keys = await generateDeviceKeys();
  const partnerKeys = await generateDeviceKeys();
  const partnerPublic = await exportDevicePublicKeys(partnerKeys);
  shared = { keys, recipient: { deviceId: PARTNER, publicKeys: partnerPublic, fingerprint: await deviceKeyFingerprint(partnerPublic) } };
  return shared;
}

/**
 * A pending proposal for epoch 3 (expected 2), a vault at version 4 holding
 * household epochs 1 and 2, and a fake service. `epochs(request)` answers
 * POST /api/sync/epochs (the default commits and stores the vault change
 * compare-and-set, as the service does).
 */
async function fixture({ vaultKey = generateVaultKey(), vault = true, epochs } = {}) {
  const { keys, recipient } = await devices();
  const rotation = await createProvisionedHouseholdEpoch({ householdId: HOUSEHOLD, keyEpoch: 3, deviceKeys: keys,
    senderDeviceId: DEVICE, recipients: [recipient], expiresAt: Date.now() + 600_000 });
  const pending = { expectedEpoch: 2, epoch: 3, proposalId: "e".repeat(32), sealed: rotation.sealed,
    fingerprint: rotation.fingerprint, packages: rotation.packages };
  const memberVaultKey = (vaultKey ?? generateVaultKey()).slice();
  const stored = vault ? { version: 4, ciphertext: await sealVault(memberVaultKey, { epochs: [
    { family: "household", epoch: 1, key: new Uint8Array(32).fill(1) },
    { family: "household", epoch: 2, key: new Uint8Array(32).fill(2) },
  ] }, { householdId: HOUSEHOLD, memberId: MEMBER, version: 4 }) } : null;
  const service = { vault: stored, bodies: [], requests: [], committed: false };
  const commit = (body) => {
    if (body.vaultChange) {
      if (!service.vault || body.vaultChange.expectedVersion !== service.vault.version) throw serviceError("vault_version_conflict");
      service.vault = { version: service.vault.version + 1, ciphertext: Buffer.from(body.vaultChange.ciphertext, "base64url") };
    }
    service.committed = true;
    return { currentEpoch: 3, rotationPending: false, retried: false, proposalId: body.proposalId,
      vault: body.vaultChange ? { version: service.vault.version } : null };
  };
  const request = async (path, options = {}) => {
    service.requests.push(`${options.method ?? "GET"} ${path}`);
    if (path === "/api/account/vault" && (options.method ?? "GET") === "GET") {
      if (service.downloadError) throw serviceError(service.downloadError);
      return { vault: service.vault ? { version: service.vault.version, ciphertext: b64(service.vault.ciphertext), updatedAt: 1 } : null,
        wrappers: [{ wrapperId: "1".repeat(32), type: "password", version: 1, params: {}, wrapped: b64(new Uint8Array(61).fill(5)) }] };
    }
    assert.equal(`${options.method} ${path}`, "POST /api/sync/epochs");
    service.bodies.push(options.body);
    return (epochs ?? commit)(JSON.parse(options.body), { service, commit });
  };
  const given = [];
  const submit = () => submitRotation({ request, identity: { householdId: HOUSEHOLD, memberId: MEMBER, deviceId: DEVICE },
    pending, deviceKeys: keys, vaultKey: async () => {
      if (!vaultKey) return null;
      const copy = vaultKey.slice();
      given.push(copy);
      return copy;
    } });
  const plain = JSON.stringify({ expectedEpoch: 2, packages: pending.packages, proposalId: pending.proposalId });
  /** The household epochs a sent vault change holds, opened at its version. */
  const opened = async (body, key = memberVaultKey) => {
    const { vaultChange } = JSON.parse(body);
    const contents = await openVault(key, Buffer.from(vaultChange.ciphertext, "base64url"),
      { householdId: HOUSEHOLD, memberId: MEMBER, version: vaultChange.expectedVersion + 1 });
    try {
      return contents.epochs.map((entry) => ({ family: entry.family, epoch: entry.epoch, fingerprint: fingerprint(entry.key) }));
    } finally {
      wipeVaultContents(contents);
    }
  };
  return { pending, service, submit, plain, opened, given, memberVaultKey, keys };
}

const skippedReasons = () => diagnostics.snapshot().filter((entry) => entry.code === "rotation_vault_skipped").map((entry) => entry.fields.reason);

test("the commit carries the vault re-sealed for the next version with exactly the proposal's key added", async () => {
  diagnostics.clear();
  const f = await fixture();
  const result = await f.submit();
  assert.deepEqual(result.vault, { version: 5 });
  assert.equal(f.service.bodies.length, 1);
  const body = JSON.parse(f.service.bodies[0]);
  assert.deepEqual(Object.keys(body).sort(), ["expectedEpoch", "packages", "proposalId", "vaultChange"]);
  assert.deepEqual(Object.keys(body.vaultChange).sort(), ["ciphertext", "expectedVersion"]);
  assert.equal(body.vaultChange.expectedVersion, 4);
  assert.equal(body.proposalId, f.pending.proposalId);
  assert.deepEqual(body.packages, f.pending.packages);
  const epochs = await f.opened(f.service.bodies[0]);
  const added = epochs.filter((entry) => entry.epoch > 2);
  assert.deepEqual(added, [{ family: "household", epoch: body.expectedEpoch + 1, fingerprint: f.pending.fingerprint }],
    "the only new entry is the proposal's own key for the epoch it commits");
  assert.deepEqual(epochs.filter((entry) => entry.epoch <= 2).map((entry) => entry.epoch), [1, 2], "the earlier keys are kept");
  assert.deepEqual(f.service.requests, ["GET /api/account/vault", "POST /api/sync/epochs"]);
  assert.ok(f.given.every((copy) => copy.every((byte) => byte === 0)), "the vault key copy is zeroed");
  assert.deepEqual(skippedReasons(), []);
});

test("a vault conflict downloads again, merges and resends the same proposal with a working vault key", async () => {
  diagnostics.clear();
  // Another device writes the vault (a chat key) just before the first POST lands.
  let first = true;
  const f = await fixture({ epochs: async (body, { service, commit }) => {
    if (first) {
      first = false;
      service.vault = { version: 5, ciphertext: await sealVault(f.memberVaultKey, { epochs: [
        { family: "household", epoch: 1, key: new Uint8Array(32).fill(1) },
        { family: "household", epoch: 2, key: new Uint8Array(32).fill(2) },
        { family: "chat", epoch: 1, key: new Uint8Array(32).fill(7) },
      ] }, { householdId: HOUSEHOLD, memberId: MEMBER, version: 5 }) };
      throw serviceError("vault_version_conflict");
    }
    return commit(body);
  } });
  const result = await f.submit();
  assert.deepEqual(result.vault, { version: 6 });
  assert.equal(f.service.bodies.length, 2);
  const [one, two] = f.service.bodies.map((body) => JSON.parse(body));
  assert.equal(two.vaultChange?.expectedVersion, 5, "the resend still carries a vault change, built on the new version");
  assert.equal(two.proposalId, one.proposalId);
  assert.deepEqual(two.packages, one.packages);
  const epochs = await f.opened(f.service.bodies[1]);
  assert.ok(epochs.some((entry) => entry.family === "chat" && entry.epoch === 1), "the other device's key is kept");
  assert.ok(epochs.some((entry) => entry.family === "household" && entry.epoch === 3 && entry.fingerprint === f.pending.fingerprint),
    "the same proposal's key, not a new one");
  assert.deepEqual(f.service.requests, ["GET /api/account/vault", "POST /api/sync/epochs", "GET /api/account/vault", "POST /api/sync/epochs"]);
  assert.deepEqual(skippedReasons(), []);
});

test(`after ${ROTATION_VAULT_ATTEMPTS} conflicts, the rotation is committed once without the vault change`, async () => {
  diagnostics.clear();
  const f = await fixture({ epochs: (body, { commit }) => {
    if (body.vaultChange) throw serviceError("vault_version_conflict");
    return commit(body);
  } });
  const result = await f.submit();
  assert.equal(result.vault, null);
  assert.equal(f.service.bodies.length, ROTATION_VAULT_ATTEMPTS + 1);
  assert.equal(f.service.bodies.at(-1), f.plain, "the last request is today's body, byte for byte");
  assert.ok(f.service.bodies.slice(0, -1).every((body) => JSON.parse(body).vaultChange));
  assert.deepEqual(skippedReasons(), ["vault_version_conflict"]);
});

for (const code of ["vault_not_found", "vault_rate_limited", "vault_invalid", "request_too_large"]) {
  test(`a ${code} refusal commits once without the vault change`, async () => {
    diagnostics.clear();
    const f = await fixture({ epochs: (body, { commit }) => {
      if (body.vaultChange) throw serviceError(code);
      return commit(body);
    } });
    await f.submit();
    assert.equal(f.service.bodies.length, 2);
    assert.equal(f.service.bodies[1], f.plain);
    assert.deepEqual(skippedReasons(), [code]);
  });
}

test("rotation_vault_skipped is recorded only once the commit without the vault change lands", async () => {
  diagnostics.clear();
  let online = false;
  const f = await fixture({ epochs: (body, { commit }) => {
    if (body.vaultChange) throw serviceError("vault_rate_limited");
    if (!online) throw serviceError("connection_unavailable");
    return commit(body);
  } });
  await assert.rejects(f.submit(), { code: "connection_unavailable" });
  assert.deepEqual(skippedReasons(), [], "the plain commit was lost: nothing to report yet");
  online = true;
  await f.submit();
  assert.deepEqual(skippedReasons(), ["vault_rate_limited"]);
});

// The member's vault downloads share one window with a new device's sign-in
// (a backup code, a password or a passkey), so a rotation the service keeps
// refusing for its own reasons must not download the vault on every pass.
for (const code of ["provisioning_device_mismatch", "provisioning_capacity", "sync_epoch_limit"]) {
  test(`a commit refused with ${code} keeps its vault change: later passes resend it without downloading again`, async () => {
    diagnostics.clear();
    let refusals = 3;
    const f = await fixture({ epochs: (body, { commit }) => {
      if (refusals > 0) {
        refusals -= 1;
        throw serviceError(code);
      }
      return commit(body);
    } });
    for (let pass = 0; pass < 3; pass += 1) await assert.rejects(f.submit(), { code });
    const result = await f.submit();
    assert.deepEqual(result.vault, { version: 5 });
    assert.equal(f.service.requests.filter((line) => line === "GET /api/account/vault").length, 1, "one download for the proposal");
    assert.equal(f.service.bodies.length, 4);
    assert.ok(f.service.bodies.every((body) => body === f.service.bodies[0]), "the same proposal and vault change every time");
    assert.ok(JSON.parse(f.service.bodies[0]).vaultChange);
    assert.deepEqual(skippedReasons(), []);
  });
}

test("a kept vault change that went stale is rebuilt from one fresh download", async () => {
  diagnostics.clear();
  let refused = false;
  const f = await fixture({ epochs: (body, { commit }) => {
    if (!refused) {
      refused = true;
      throw serviceError("provisioning_capacity");
    }
    return commit(body);
  } });
  await assert.rejects(f.submit(), { code: "provisioning_capacity" });
  // Another device writes the vault between passes.
  f.service.vault = { version: 5, ciphertext: await sealVault(f.memberVaultKey, { epochs: [
    { family: "household", epoch: 1, key: new Uint8Array(32).fill(1) },
    { family: "household", epoch: 2, key: new Uint8Array(32).fill(2) },
  ] }, { householdId: HOUSEHOLD, memberId: MEMBER, version: 5 }) };
  const result = await f.submit();
  assert.deepEqual(result.vault, { version: 6 });
  assert.deepEqual(f.service.requests, ["GET /api/account/vault", "POST /api/sync/epochs", "POST /api/sync/epochs",
    "GET /api/account/vault", "POST /api/sync/epochs"]);
});

test("a member without a vault downloads once for a proposal the service keeps refusing", async () => {
  diagnostics.clear();
  let refusals = 2;
  const f = await fixture({ vault: false, epochs: (body, { commit }) => {
    if (refusals > 0) {
      refusals -= 1;
      throw serviceError("sync_epoch_limit");
    }
    return commit(body);
  } });
  for (let pass = 0; pass < 2; pass += 1) await assert.rejects(f.submit(), { code: "sync_epoch_limit" });
  await f.submit();
  assert.deepEqual(f.service.bodies, [f.plain, f.plain, f.plain]);
  assert.equal(f.service.requests.filter((line) => line === "GET /api/account/vault").length, 1);
});

test("other refusals are the rotation's own and are thrown as before", async () => {
  diagnostics.clear();
  const f = await fixture({ epochs: () => { throw serviceError("stale_key_epoch"); } });
  await assert.rejects(f.submit(), { code: "stale_key_epoch" });
  assert.equal(f.service.bodies.length, 1);
  assert.ok(f.given.every((copy) => copy.every((byte) => byte === 0)), "the vault key copy is zeroed on failure too");
});

test("without a vault key, or without a vault, the body is today's, byte for byte", async () => {
  diagnostics.clear();
  const noKey = await fixture({ vaultKey: null });
  await noKey.submit();
  assert.deepEqual(noKey.service.bodies, [noKey.plain]);
  assert.deepEqual(noKey.service.requests, ["POST /api/sync/epochs"], "no vault download");
  const noVault = await fixture({ vault: false });
  await noVault.submit();
  assert.deepEqual(noVault.service.bodies, [noVault.plain]);
  assert.deepEqual(skippedReasons(), [], "neither is worth a diagnostic");
});

test("a vault with a different key for that epoch, or one this key doesn't open, is left out of the commit", async () => {
  diagnostics.clear();
  // A different key for epoch 3 means another proposal committed it, so the
  // service refuses this one as stale, as the real service does.
  const conflicting = await fixture({ epochs: () => { throw serviceError("stale_key_epoch"); } });
  conflicting.service.vault = { version: 4, ciphertext: await sealVault(conflicting.memberVaultKey, { epochs: [
    { family: "household", epoch: 3, key: new Uint8Array(32).fill(3) },
  ] }, { householdId: HOUSEHOLD, memberId: MEMBER, version: 4 }) };
  await assert.rejects(conflicting.submit(), { code: "stale_key_epoch" });
  assert.deepEqual(conflicting.service.bodies, [conflicting.plain]);
  assert.deepEqual(skippedReasons(), [], "nothing was committed, so no rotation_vault_skipped");
  const unreadable = await fixture();
  unreadable.service.vault = { version: 4, ciphertext: await sealVault(generateVaultKey(), { epochs: [] }, { householdId: HOUSEHOLD, memberId: MEMBER, version: 4 }) };
  await unreadable.submit();
  assert.deepEqual(unreadable.service.bodies, [unreadable.plain]);
  assert.deepEqual(skippedReasons(), ["vault_unreadable"]);
});

test("a vault download the connection loses stops the pass; other download trouble skips the vault change", async () => {
  diagnostics.clear();
  const offline = await fixture();
  offline.service.downloadError = "connection_unavailable";
  await assert.rejects(offline.submit(), { code: "connection_unavailable" });
  assert.deepEqual(offline.service.bodies, [], "nothing was committed without the vault");
  const failing = await fixture();
  failing.service.downloadError = "server_error";
  await failing.submit();
  assert.deepEqual(failing.service.bodies, [failing.plain]);
  assert.deepEqual(skippedReasons(), ["other"]);
});

test("an older service's answer without `vault` is recorded as not applied; a retried answer is not", async () => {
  diagnostics.clear();
  const old = await fixture({ epochs: (body) => ({ currentEpoch: 3, rotationPending: false, retried: false, proposalId: body.proposalId }) });
  await old.submit();
  assert.ok(JSON.parse(old.service.bodies[0]).vaultChange, "the field was sent");
  const odd = await fixture({ epochs: (body) => ({ currentEpoch: 3, rotationPending: false, retried: false, proposalId: body.proposalId, vault: { version: 99 } }) });
  await odd.submit();
  const retried = await fixture({ epochs: (body) => ({ currentEpoch: 3, rotationPending: false, retried: true, proposalId: body.proposalId, vault: null }) });
  await retried.submit();
  assert.deepEqual(skippedReasons(), ["not_applied", "not_applied"]);
});

test("rotation_vault_skipped holds a reason from a fixed list and nothing else", () => {
  assert.deepEqual(normalizeFields("rotation_vault_skipped", { reason: "vault_version_conflict", householdId: HOUSEHOLD, message: "secret" }),
    { reason: "vault_version_conflict" });
  assert.deepEqual(normalizeFields("rotation_vault_skipped", { reason: "a household name" }), { reason: "other" });
});
