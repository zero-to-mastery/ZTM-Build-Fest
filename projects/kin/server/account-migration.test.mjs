// Moving a household set up the old way to accounts (#574/#575), and
// removing a passkey (#592 follow-up), over HTTP with the browser library and
// real Web Crypto. WebAuthn is a stub on the service; in the "browser" an
// authenticator double answers with a PRF output that depends only on the
// credential and the salt, as a real one does.
//
// From each older state: a member with a passkey and no account (the PRF
// passkey becomes the vault's way in, so no password-only wrapper ever
// exists; without PRF, the password wrapper), a run cut off after the
// password was set (resumes with the password; no second account), a vault
// that exists while this device holds no key for it (another device moved
// first), and a vault whose certification key isn't endorsed yet. Then the
// new account signs in on a fresh browser.
import assert from "node:assert/strict";
import test from "node:test";
import { openVault, wipeVaultContents } from "../web/security/account-vault.js";
import { migrateAccount, migrationProblems, migrationState, setAccountPassword } from "../web/security/account-migration.js";
import { accountState, removeAccountPasskey } from "../web/security/account-security.js";
import { certificationKeyPair, createCertificationEndorsement, createMemberCertificate } from "../web/security/device-certification.js";
import { downloadSignInVault, openSignInVault, signInWithPassword } from "../web/security/new-device.js";
import { fromBase64Url, LocalVault, randomRecoverySecret } from "../web/security/local-vault.js";
import { deviceKeyFingerprint, exportDevicePublicKeys, generateDeviceKeys } from "../web/sync/crypto.js";
import { DurableStore } from "./durable-store.mjs";
import { PairingError } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const PASSWORD = "four unrelated words";
const same = (left, right) => Buffer.from(left).equals(Buffer.from(right));
globalThis.PublicKeyCredential ??= class {};

function stubWebAuthn() {
  return {
    registrationOptions: (flow, { userName } = {}) => ({ challenge: flow, user: { id: "dXNlcg", name: userName ?? "adult" } }),
    authenticationOptions: (flow, credentialIds) => ({ challenge: b64(Buffer.from(flow)), allowCredentials: credentialIds.map((id) => ({ type: "public-key", id })) }),
    verifyRegistration: (response) => ({ id: response.id, publicKey: `key-${response.id}`, algorithm: -7, signCount: 0 }),
    verifyAuthentication(response, _flow, registered) {
      if (!registered || response?.id !== registered.id) throw new PairingError("passkey_verification_failed", "Invalid passkey.", 401);
      return true;
    },
    discardFlow() {},
  };
}

/** A passkey double: PRF output = SHA-256(credential ID || salt). */
function authenticator(id, { prf = true } = {}) {
  const calls = [];
  return {
    calls,
    async create() { throw new Error("nothing is registered here"); },
    async get({ publicKey }) {
      calls.push(publicKey);
      const extension = publicKey.extensions?.prf;
      const input = extension?.eval?.first ?? extension?.evalByCredential?.[id]?.first;
      let first;
      if (prf && input) {
        const joined = new Uint8Array([...new TextEncoder().encode(id), ...input]);
        first = (await crypto.subtle.digest("SHA-256", joined));
      }
      return { id, type: "public-key", response: {
        clientDataJSON: new Uint8Array([1]).buffer, authenticatorData: new Uint8Array([1]).buffer, signature: new Uint8Array([1]).buffer, userHandle: null,
      }, getClientExtensionResults: () => (first ? { prf: { results: { first } } } : {}) };
    },
  };
}

async function prfFor(id, salt) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...new TextEncoder().encode(id), ...fromBase64Url(salt)])));
}

async function deviceKeys() {
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  return { keys, publicKeys, fingerprint: await deviceKeyFingerprint(publicKeys) };
}

async function startServer() {
  const store = new DurableStore(":memory:");
  const application = createKinServer({ store, webauthn: stubWebAuthn(), origin: "http://localhost" });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${application.server.address().port}`;
  const browser = (jar = new Map()) => {
    const call = async (path, { method = "POST", body } = {}) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") },
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      });
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const [name, value] = pair.split("=");
        if (value) jar.set(name, value); else jar.delete(name);
      }
      return { status: response.status, body: await response.json() };
    };
    return {
      jar, call,
      request: async (path, body = {}, { method = "POST" } = {}) => {
        const result = await call(path, { method, body });
        if (result.status >= 400) throw Object.assign(new Error(result.body.message), { code: result.body.error, status: result.status });
        return result.body;
      },
    };
  };
  return { ...application, store, browser, close: () => new Promise((resolve) => application.server.close(resolve)).finally(() => store.close()) };
}

/** A household set up the old way: a passkey, a device with keys, a local
 * root with only a backup key, and no username, password or vault. */
async function legacyHousehold(server, credentialId = b64(Buffer.alloc(32, 7))) {
  const device = await deviceKeys();
  const created = server.service.bootstrap({ credential: { id: credentialId, publicKey: "key", algorithm: -7 }, syncPublicKeys: device.publicKeys });
  const founder = server.browser(new Map([["kin_session", created.sessionToken], ["kin_device", created.deviceToken]]));
  const identity = { householdId: created.householdId, memberId: created.memberId, deviceId: created.deviceId };
  const epochKey = new Uint8Array(32).fill(9);
  let held = null;
  const keyStore = {
    accountVaultKey: async () => held?.slice() ?? null,
    setAccountVaultKey: async (_deviceId, key) => { held = key.slice(); },
    vaultEpochKeys: async () => [{ family: "household", epoch: 1, key: epochKey.slice() }],
    get held() { return held; },
    forget() { held = null; },
  };
  const { vault } = await LocalVault.create(randomRecoverySecret());
  const endorse = async () => {
    const value = await founder.request("/api/account/vault", {}, { method: "GET" });
    if (value.certificationEndorsement) return "endorsed";
    const contents = await openVault(held, fromBase64Url(value.vault.ciphertext), { ...identity, version: value.vault.version });
    try {
      const certification = await certificationKeyPair(contents.certificationKey);
      const endorsement = await createCertificationEndorsement({ householdId: identity.householdId, memberId: identity.memberId, certification,
        device: { deviceId: identity.deviceId, fingerprint: device.fingerprint, signingKey: device.keys.signingPrivateKey } });
      await founder.request("/api/account/certification", { endorsement }, { method: "PUT" });
      return "endorsed_now";
    } finally { wipeVaultContents(contents); }
  };
  return { founder, identity, credentialId, keyStore, vault, endorse, device };
}

async function securityOf(household) {
  return household.founder.request("/api/account/security", {}, { method: "GET" });
}

/** A fresh browser signs in and registers itself with the account. */
async function signInOnFreshBrowser(server, household, { method, credentialId = null, prfOutput = null, passwordKey = null, username }) {
  const fresh = server.browser();
  let view;
  if (method === "passkey") {
    const options = await fresh.call("/api/account/sign-in/passkey/options", { body: { username } });
    const finished = await fresh.call("/api/account/sign-in/passkey/finish", { body: { flow: options.body.flow, credential: { id: credentialId } } });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    view = finished.body;
  } else {
    const signedIn = await signInWithPassword({ username, password: PASSWORD, request: fresh.request });
    ({ view, passwordKey } = signedIn);
  }
  const download = await downloadSignInVault({ request: fresh.request });
  assert.ok(download.certificationEndorsement, "the moved account can certify a new device");
  const opened = await openSignInVault({ download, method, credentialId, prfOutput, passwordKey, householdId: view.householdId, memberId: view.memberId });
  const device = await deviceKeys();
  const certification = await certificationKeyPair(opened.contents.certificationKey);
  const certificate = await createMemberCertificate({ householdId: view.householdId, memberId: view.memberId, endorsement: download.certificationEndorsement,
    certification, device: { deviceId: view.deviceId, publicKeys: device.publicKeys, fingerprint: device.fingerprint } });
  const registered = await fresh.call("/api/account/sign-in/device", { body: { syncPublicKeys: device.publicKeys, certificate, deviceLabel: "New phone", vaultEpochs: [1] } });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  return { opened, registered: registered.body };
}

test("migration rules: who is invited, and the words for a weak choice", () => {
  assert.equal(migrationState(null), null);
  assert.equal(migrationState({ password: false, passkeys: ["a"], memberKind: "adult" }), "invite");
  assert.equal(migrationState({ password: false, passkeys: ["a"], memberKind: "limited" }), "invite");
  assert.equal(migrationState({ password: false, passkeys: ["a"], memberKind: "temporary" }), null, "guests get no account");
  assert.equal(migrationState({ password: true, vault: { wrappers: [] } }, { holdsVaultKey: false }), "finish");
  assert.equal(migrationState({ password: true, vault: null }, { holdsVaultKey: true }), "finish");
  assert.equal(migrationState({ password: true, vault: { wrappers: [] } }, { holdsVaultKey: true }), "done");
  assert.deepEqual(Object.keys(migrationProblems({ username: "x", password: "short" })).sort(), ["password", "username"]);
  assert.match(migrationProblems({ username: "robin", password: PASSWORD, again: "other" }).again, /don't match/);
  assert.deepEqual(migrationProblems({ username: "robin", password: PASSWORD, again: PASSWORD }), {});
  // The settings only change an account this device can change.
  assert.equal(accountState({ password: true, vault: { wrappers: [] }, deviceHoldsVaultKey: false }).account, false);
  assert.equal(accountState({ password: true, vault: { wrappers: [] }, deviceHoldsVaultKey: true }).account, true);
});

test("a passkey household moves to an account: the PRF passkey opens the vault, the password unlocks this device, and a fresh browser signs in", { timeout: 120_000 }, async () => {
  const server = await startServer();
  try {
    const household = await legacyHousehold(server);
    const before = await securityOf(household);
    assert.deepEqual({ password: before.password, passkeys: before.passkeys, vault: before.vault, kind: before.memberKind },
      { password: false, passkeys: [household.credentialId], vault: null, kind: "adult" });
    assert.equal(migrationState(before), "invite");
    const passkey = authenticator(household.credentialId);
    const steps = [];
    const result = await migrateAccount({ username: "Robin.Lee", password: PASSWORD, security: before, identity: household.identity,
      keyStore: household.keyStore, localVault: household.vault, endorse: household.endorse, request: household.founder.request,
      credentials: passkey, onStep: (step) => steps.push(step) });
    assert.deepEqual(steps, ["password", "vault", "endorse", "local"]);
    assert.equal(passkey.calls.length, 1, "one touch: the passkey confirms and gives the vault wrapper's PRF output");
    assert.equal(passkey.calls[0].userVerification, "required");
    assert.equal(result.created, true);
    assert.equal(result.wrapper, "passkey");

    const member = server.service.members.get(household.identity.memberId);
    assert.equal(member.username, "robin.lee");
    assert.ok(member.password?.verifier, "the service keeps the password's verifier");
    const after = await securityOf(household);
    assert.deepEqual(after.vault.wrappers.map((wrapper) => wrapper.type), ["passkey"], "a PRF passkey: no password-only wrapper ever exists (D3/D4)");
    assert.ok(server.service.certificationEndorsement(household.identity.memberId), "the certification key is endorsed");
    assert.equal(migrationState(after, { holdsVaultKey: true }), "done");
    // This device: the backup key still works, and the password unlocks it offline.
    assert.deepEqual(result.manifest.wrappers.map((wrapper) => wrapper.type).sort(), ["password", "recovery"]);
    const passwordWrapper = result.manifest.wrappers.find((wrapper) => wrapper.type === "password");
    assert.equal(passwordWrapper.username, "robin.lee");
    // The vault holds the epoch this device had.
    const stored = await household.founder.request("/api/account/vault", {}, { method: "GET" });
    const contents = await openVault(household.keyStore.held, fromBase64Url(stored.vault.ciphertext), { ...household.identity, version: stored.vault.version });
    assert.deepEqual(contents.epochs.map((entry) => [entry.family, entry.epoch]), [["household", 1]]);
    assert.ok(contents.certificationKey);
    wipeVaultContents(contents);

    // Signing up again is refused: one account per member.
    await assert.rejects(setAccountPassword({ username: "robin.other", password: PASSWORD, request: household.founder.request, credentials: passkey }), { code: "account_exists" });

    // A fresh browser: the username and the passkey alone.
    const prfSalt = after.vault.wrappers[0].params.prfSalt;
    const { opened } = await signInOnFreshBrowser(server, household, { method: "passkey", credentialId: household.credentialId,
      prfOutput: await prfFor(household.credentialId, prfSalt), username: "robin.lee" });
    assert.ok(same(opened.vaultKey, household.keyStore.held), "the new browser opens the same vault");
    await assert.rejects(signInWithPassword({ username: "robin.lee", password: PASSWORD, request: server.browser().request }), { code: "passkey_required" });
  } finally {
    await server.close();
  }
});

test("without PRF the password opens the vault; a run cut off after the password resumes with it", { timeout: 120_000 }, async () => {
  const server = await startServer();
  try {
    const household = await legacyHousehold(server);
    const noPrf = authenticator(household.credentialId, { prf: false });
    // Cut off after the first step: the service has the password, nothing else.
    const first = await setAccountPassword({ username: "sam.lee", password: PASSWORD, request: household.founder.request, credentials: noPrf });
    assert.equal(first.prf, null);
    for (const key of ["authKey", "passwordKey", "localKek"]) first.keys[key].fill(0);
    const middle = await securityOf(household);
    assert.equal(middle.password, true);
    assert.equal(middle.vault, null);
    assert.equal(migrationState(middle, { holdsVaultKey: false }), "finish");

    // Resuming: a wrong password is refused, calmly, before anything else.
    await assert.rejects(migrateAccount({ password: "not the password", security: middle, identity: household.identity, keyStore: household.keyStore,
      localVault: household.vault, endorse: household.endorse, request: household.founder.request, credentials: noPrf }), { code: "password_rejected" });
    assert.equal(household.keyStore.held, null, "nothing was kept");
    const result = await migrateAccount({ password: PASSWORD, security: middle, identity: household.identity, keyStore: household.keyStore,
      localVault: household.vault, endorse: household.endorse, request: household.founder.request, credentials: noPrf });
    assert.equal(result.wrapper, "password", "a passkey without PRF leaves the password as the vault's way in");
    assert.equal(server.service.members.get(household.identity.memberId).username, "sam.lee", "no second account");
    assert.deepEqual((await securityOf(household)).vault.wrappers.map((wrapper) => wrapper.type), ["password"]);

    // A run again changes nothing: the vault is opened with this device's key.
    const again = await migrateAccount({ password: PASSWORD, security: await securityOf(household), identity: household.identity, keyStore: household.keyStore,
      localVault: household.vault, endorse: household.endorse, request: household.founder.request, credentials: noPrf });
    assert.equal(again.created, false);
    assert.equal(again.manifest, null, "this device already unlocks with the password");

    // A fresh browser: username and password.
    const { opened } = await signInOnFreshBrowser(server, household, { method: "password", username: "sam.lee" });
    assert.ok(same(opened.vaultKey, household.keyStore.held));
  } finally {
    await server.close();
  }
});

test("a vault made elsewhere, with no key on this device and no endorsement yet, is opened through the passkey and endorsed here", { timeout: 120_000 }, async () => {
  const server = await startServer();
  try {
    const household = await legacyHousehold(server);
    const passkey = authenticator(household.credentialId);
    // The account and vault exist, made without endorsing (an older run).
    const made = await migrateAccount({ username: "lee.kim", password: PASSWORD, security: await securityOf(household), identity: household.identity,
      keyStore: household.keyStore, localVault: household.vault, request: household.founder.request, credentials: passkey });
    assert.equal(made.wrapper, "passkey");
    assert.equal(server.service.certificationEndorsement(household.identity.memberId), null, "not endorsed yet");
    const original = household.keyStore.held.slice();
    // This device no longer holds the key (as on another device of the member).
    household.keyStore.forget();
    const security = await securityOf(household);
    assert.equal(migrationState(security, { holdsVaultKey: false }), "finish");
    const { vault: other } = await LocalVault.create(randomRecoverySecret());
    const touches = passkey.calls.length;
    const finished = await migrateAccount({ password: PASSWORD, security, identity: household.identity, keyStore: household.keyStore,
      localVault: other, endorse: household.endorse, request: household.founder.request, credentials: passkey });
    assert.equal(finished.created, false);
    assert.equal(passkey.calls.length, touches + 1, "one touch opens the vault through the passkey wrapper");
    assert.ok(same(household.keyStore.held, original), "this device now keeps the same vault key");
    assert.ok(server.service.certificationEndorsement(household.identity.memberId), "and endorsed the certification key");
    assert.deepEqual(finished.manifest.wrappers.map((wrapper) => wrapper.type).sort(), ["password", "recovery"]);
  } finally {
    await server.close();
  }
});

test("the migration routes: a fresh passkey of the member's own, never twice, never for a guest, a free username", { timeout: 60_000 }, async () => {
  const server = await startServer();
  try {
    const household = await legacyHousehold(server);
    const bare = await household.founder.call("/api/account/migrate/finish", { body: { flow: "nope" } });
    assert.equal(bare.status, 410, "no flow, no change");
    const options = await household.founder.call("/api/account/migrate/options", { body: {} });
    assert.equal(options.status, 200);
    assert.deepEqual(options.body.publicKey.allowCredentials.map((entry) => entry.id), [household.credentialId]);
    const wrong = await household.founder.call("/api/account/migrate/finish", { body: { flow: options.body.flow, credential: { id: "someone-else" },
      username: "pat.lee", salt: b64(new Uint8Array(16).fill(1)), iterations: 600_000, authKey: b64(new Uint8Array(32).fill(2)) } });
    assert.equal(wrong.status, 401, "another passkey doesn't move this member");
    assert.equal(server.service.members.get(household.identity.memberId).password, undefined);

    // A username already taken is refused.
    const other = await legacyHousehold(server, b64(Buffer.alloc(32, 8)));
    await setAccountPassword({ username: "pat.lee", password: PASSWORD, request: other.founder.request, credentials: authenticator(other.credentialId) });
    await assert.rejects(setAccountPassword({ username: "pat.lee", password: PASSWORD, request: household.founder.request, credentials: authenticator(household.credentialId) }),
      { code: "username_taken" });

    // A guest (Temporary member) isn't offered an account.
    const member = server.service.members.get(household.identity.memberId);
    Object.assign(member, { kind: "temporary", expiresAt: Date.now() + 3_600_000 });
    const guest = await household.founder.call("/api/account/migrate/options", { body: {} });
    assert.equal(guest.status, 409, JSON.stringify(guest.body));
    assert.equal(guest.body.error, "account_unavailable");
    Object.assign(member, { kind: "adult", expiresAt: undefined });
  } finally {
    await server.close();
  }
});

test("removing a passkey: after the password; the last one brings the password wrapper back; never the last way in", { timeout: 120_000 }, async () => {
  const server = await startServer();
  try {
    const household = await legacyHousehold(server);
    const passkey = authenticator(household.credentialId);
    await migrateAccount({ username: "jo.lee", password: PASSWORD, security: await securityOf(household), identity: household.identity,
      keyStore: household.keyStore, localVault: household.vault, endorse: household.endorse, request: household.founder.request, credentials: passkey });
    // This device also unlocks with the passkey.
    const prfSalt = b64(new Uint8Array(32).fill(5));
    await household.vault.addCredentialWrapper(await prfFor(household.credentialId, prfSalt), { credentialId: household.credentialId, prfSalt });
    const security = await securityOf(household);
    const member = server.service.members.get(household.identity.memberId);

    // The route needs the password.
    const bare = await household.founder.call("/api/account/passkeys/remove", { body: { credentialId: household.credentialId } });
    assert.equal(bare.status, 401);
    await assert.rejects(removeAccountPasskey({ password: "not my password at all", credentialId: household.credentialId, security, identity: household.identity,
      vaultKey: household.keyStore.held, localVault: household.vault, request: household.founder.request }), { code: "password_incorrect" });
    await assert.rejects(removeAccountPasskey({ password: PASSWORD, credentialId: "not-mine", security, identity: household.identity,
      vaultKey: household.keyStore.held, localVault: household.vault, request: household.founder.request }), { code: "credential_unavailable" });
    // A change that would leave the passkey's wrapper is refused by the service.
    const kept = await household.founder.call("/api/account/passkeys/remove", { body: { credentialId: household.credentialId, currentAuthKey: "x" } });
    assert.equal(kept.status, 401);

    const manifest = await removeAccountPasskey({ password: PASSWORD, credentialId: household.credentialId, security, identity: household.identity,
      vaultKey: household.keyStore.held, localVault: household.vault, request: household.founder.request });
    assert.equal(member.credentials.size, 0, "the passkey is gone from the account");
    assert.equal(server.service.credentials.has(household.credentialId), false);
    assert.deepEqual((await securityOf(household)).vault.wrappers.map((wrapper) => wrapper.type), ["password"],
      "the last passkey's going brings the password wrapper back");
    assert.deepEqual(manifest.wrappers.map((wrapper) => wrapper.type).sort(), ["password", "recovery"], "and this device's passkey unlock goes");
    assert.equal(server.service.confirmsWithPassword(member), true, "admin actions use the password again");

    // A member without a password can never remove their only passkey.
    const legacy = await legacyHousehold(server, b64(Buffer.alloc(32, 3)));
    const legacyAuth = server.service.authorize(legacy.founder.jar.get("kin_session"));
    assert.throws(() => server.service.removeAccountPasskey(legacyAuth, legacy.credentialId, null), { code: "last_way_in" });
    // A vault left with only its backup code is refused.
    assert.throws(() => server.service.removeAccountPasskey(server.service.authorize(household.founder.jar.get("kin_session")), "x", null), { code: "passkey_not_found" });
    server.service.addCredential(household.identity.memberId, { id: "cred-two", publicKey: "key", algorithm: -7 });
    member.credentials.add("cred-two");
    assert.throws(() => server.service.removeAccountPasskey(server.service.authorize(household.founder.jar.get("kin_session")), "cred-two",
      [{ type: "backup-code", params: {} }]), { code: "last_way_in" });
    assert.throws(() => server.service.removeAccountPasskey(server.service.authorize(household.founder.jar.get("kin_session")), "cred-two",
      [{ type: "passkey", params: { credentialId: "cred-two" } }]), { code: "vault_wrapper_rules" });
  } finally {
    await server.close();
  }
});
