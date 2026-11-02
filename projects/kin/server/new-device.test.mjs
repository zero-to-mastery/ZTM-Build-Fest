// Signing in on a new device (ADR 0018 section 4, #568/#569/#570): the
// new-device capability (single use, expiry, bound to its member, rate
// limits), the vault download behind it, registering the device with a
// certificate signed by the member's certification key, replacing a device,
// the trusted-device limit, the certification-key endorsement, and the
// passkey and require-both paths.
import assert from "node:assert/strict";
import test from "node:test";
import {
  derivePasswordKeys,
  generateCertificationKey,
  generateVaultKey,
  sealVault,
  wrapVaultKey,
} from "../web/security/account-vault.js";
import {
  certificationKeyPair,
  createCertificationEndorsement,
  createMemberCertificate,
} from "../web/security/device-certification.js";
import { downloadSignInVault, openSignInVault, signInWithPassword } from "../web/security/new-device.js";
import { deviceKeyFingerprint, exportDevicePublicKeys, generateDeviceKeys } from "../web/sync/crypto.js";
import { DurableStore } from "./durable-store.mjs";
import { MAX_TRUSTED_DEVICES } from "./identity-limits.mjs";
import { NEW_DEVICE_TTL_MS, PairingError, PairingService, PASSWORD_ATTEMPTS, PASSWORD_WINDOW_MS } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const PASSWORD = "four unrelated words";
const SALT = new Uint8Array(16).fill(7);
let derived = null;
const passwordKeys = async () => (derived ??= await derivePasswordKeys(PASSWORD, SALT));

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

async function startServer({ now } = {}) {
  const store = new DurableStore(":memory:");
  const application = createKinServer({ store, webauthn: stubWebAuthn(), origin: "http://localhost", now });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${application.server.address().port}`;
  const browser = (jar = new Map()) => ({
    jar,
    async call(path, { method = "POST", body } = {}) {
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
    },
    /** fetch-shaped `request` for the browser library (web/security/new-device.js). */
    request: async (path, body = {}, { method = "POST" } = {}) => {
      const result = await browser(jar).call(path, { method, body });
      if (result.status >= 400) throw Object.assign(new Error(result.body.message), { code: result.body.error, status: result.status });
      return result.body;
    },
  });
  return { ...application, store, browser, close: () => new Promise((resolve) => application.server.close(resolve)).finally(() => store.close()) };
}

/**
 * A household founded with a password: the founder's device keys, an
 * account vault with a password wrapper (and any `extraWrappers`), and the
 * certification key endorsed by the founder's device.
 */
async function foundHousehold(server, { username = "sam.lee", endorse = true, extraWrappers = [] } = {}) {
  const founder = server.browser();
  const device = await deviceKeys();
  const { authKey, passwordKey } = await passwordKeys();
  const created = await founder.call("/api/account/bootstrap", { body: {
    username, authKey: b64(authKey), salt: b64(SALT), iterations: 600_000, deviceLabel: "Phone", syncPublicKeys: device.publicKeys,
  } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { householdId, memberId, deviceId } = created.body;
  const vaultKey = generateVaultKey();
  const certificationKey = await generateCertificationKey();
  const epochKey = new Uint8Array(32).fill(9);
  const ciphertext = await sealVault(vaultKey, { epochs: [{ family: "household", epoch: 1, key: epochKey }], certificationKey: certificationKey.pkcs8 },
    { householdId, memberId, version: 1 });
  const wrapperId = "1".repeat(32);
  const wrappers = [{ wrapperId, type: "password", version: 1, params: { kdf: "pbkdf2-sha256", iterations: 600_000, salt: b64(SALT) },
    wrapped: b64(await wrapVaultKey(vaultKey, passwordKey, { householdId, memberId, type: "password", wrapperId, version: 1 })) }];
  for (const extra of extraWrappers) wrappers.push(await extra({ vaultKey, householdId, memberId }));
  const uploaded = await founder.call("/api/account/vault", { method: "PUT", body: { expectedVersion: 0, ciphertext: b64(ciphertext), wrappers } });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const certification = await certificationKeyPair(certificationKey.pkcs8);
  let endorsement = null;
  if (endorse) {
    endorsement = await createCertificationEndorsement({ householdId, memberId, certification,
      device: { deviceId, fingerprint: device.fingerprint, signingKey: device.keys.signingPrivateKey } });
    const put = await founder.call("/api/account/certification", { method: "PUT", body: { endorsement } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.stored, true);
  }
  return { founder, device, householdId, memberId, deviceId, vaultKey, certification, endorsement, certificationKey };
}

/** Signs in from a fresh browser with the password; returns the browser and view. */
async function signIn(server, username = "sam.lee", password = PASSWORD) {
  const browser = server.browser();
  const { view, passwordKey } = await signInWithPassword({ username, password, request: browser.request });
  return { browser, view, passwordKey };
}

/** Registers the signed-in browser as a device, as the household panel does. */
async function register(browser, view, household, { replaceDeviceId = null, certification = household.certification, endorsement = household.endorsement, memberId = view.memberId } = {}) {
  const device = await deviceKeys();
  const certificate = await createMemberCertificate({ householdId: view.householdId, memberId, endorsement, certification,
    device: { deviceId: view.deviceId, publicKeys: device.publicKeys, fingerprint: device.fingerprint } });
  const result = await browser.call("/api/account/sign-in/device", { body: {
    syncPublicKeys: device.publicKeys, certificate, replaceDeviceId, deviceLabel: "Laptop", vaultEpochs: [1],
  } });
  return { ...result, device };
}

test("a password sign-in on a browser with no cookie gets a capability, not a session, and opens the vault", { timeout: 60_000 }, async () => {
  const server = await startServer();
  try {
    const household = await foundHousehold(server);
    const { browser, view, passwordKey } = await signIn(server, "Sam.Lee");
    assert.ok(browser.jar.get("kin_new_device"), "the capability is an HttpOnly cookie");
    assert.equal(browser.jar.get("kin_session"), undefined, "no session before the device is registered");
    assert.equal(view.method, "password");
    assert.equal(view.memberId, household.memberId);
    assert.deepEqual(view.devices.map((device) => device.deviceId), [household.deviceId], "the member's devices to choose from");
    assert.equal((await browser.call("/api/sync/status", { method: "GET" })).status, 401, "the capability is not a session");
    // The download releases only the password wrapper, and the endorsement.
    const download = await downloadSignInVault({ request: browser.request });
    assert.deepEqual(download.wrappers.map((wrapper) => wrapper.type), ["password"]);
    assert.equal(download.certificationEndorsement.fingerprint, household.certification.fingerprint);
    const opened = await openSignInVault({ download, method: "password", passwordKey, householdId: view.householdId, memberId: view.memberId });
    assert.equal(opened.contents.epochs[0].epoch, 1);
    assert.deepEqual([...opened.contents.certificationKey], [...household.certificationKey.pkcs8]);
    // Registering trusts the device, with a session and a device cookie.
    const registered = await register(browser, view, household);
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    assert.equal(registered.body.deviceId, view.deviceId);
    assert.ok(browser.jar.get("kin_session") && browser.jar.get("kin_device"));
    assert.equal(browser.jar.get("kin_new_device"), undefined, "the capability cookie is cleared");
    const stored = server.service.devices.get(view.deviceId);
    assert.equal(stored.deviceAuthorizationCertificate.version, 2);
    assert.deepEqual(stored.syncProvisionedEpochs, [1]);
    assert.equal(stored.syncHistoryFromEpoch, 1, "same-member history");
    assert.equal(server.syncService.state(view.householdId).rotationPending, true, "a new device starts a key rotation, as pairing does");
    const directory = await browser.call("/api/sync/devices", { method: "GET" });
    assert.equal(directory.status, 200);
    assert.equal(directory.body.devices.find((device) => device.deviceId === view.deviceId).certificate.version, 2);
    // A restart loads the version 2 certificate and the endorsement.
    const reloaded = new PairingService({ store: server.store });
    assert.equal(reloaded.devices.get(view.deviceId).deviceAuthorizationCertificate.version, 2);
    assert.equal(reloaded.certificationEndorsement(household.memberId).fingerprint, household.certification.fingerprint);
  } finally {
    await server.close();
  }
});

test("the capability is single use, expires, and is bound to its member", { timeout: 60_000 }, async () => {
  let clock = Date.now();
  const server = await startServer({ now: () => clock });
  try {
    const household = await foundHousehold(server);
    // Single use.
    const first = await signIn(server);
    assert.equal((await register(first.browser, first.view, household)).status, 201);
    first.browser.jar.set("kin_new_device", "reused");
    const reused = await register(first.browser, first.view, household);
    assert.equal(reused.status, 401);
    assert.equal(reused.body.error, "new_device_expired");
    // The same token again, kept from before registering, is spent too.
    const second = await signIn(server);
    const token = second.browser.jar.get("kin_new_device");
    assert.equal((await register(second.browser, second.view, household)).status, 201);
    const replay = server.browser(new Map([["kin_new_device", token]]));
    assert.equal((await register(replay, second.view, household)).status, 401, "a used capability can't register again");
    assert.equal((await replay.call("/api/account/sign-in/vault")).status, 401, "or download");
    // Expiry.
    const late = await signIn(server);
    clock += NEW_DEVICE_TTL_MS + 1;
    assert.equal((await late.browser.call("/api/account/sign-in/vault")).body.error, "new_device_expired");
    assert.equal((await register(late.browser, late.view, household)).status, 401);
    // Bound to its member: a certificate for another member is refused, and
    // a certificate from a key that isn't the endorsed one too (the service
    // can't mint a device the household trusts without the vault's key).
    const bound = await signIn(server);
    const otherMember = await register(bound.browser, bound.view, household, { memberId: "f".repeat(32) });
    assert.equal(otherMember.body.error, "device_certificate_invalid");
    const forged = await certificationKeyPair((await generateCertificationKey()).pkcs8);
    const forgedResult = await register(bound.browser, bound.view, household, { certification: { ...forged, fingerprint: household.certification.fingerprint } });
    assert.equal(forgedResult.body.error, "device_certificate_invalid");
    // Three failed registrations spend the capability.
    assert.equal((await register(bound.browser, bound.view, household, { memberId: "f".repeat(32) })).body.error, "device_certificate_invalid");
    assert.equal((await register(bound.browser, bound.view, household)).body.error, "new_device_expired");
  } finally {
    await server.close();
  }
});

test("wrong passwords and unknown names are refused alike and rate-limited; issuance is limited per member", { timeout: 120_000 }, async () => {
  const server = await startServer();
  try {
    await foundHousehold(server);
    // Parameters for an unknown name look like a real member's.
    const real = (await server.browser().call("/api/account/sign-in/parameters", { body: { username: "sam.lee" } })).body;
    const unknown = (await server.browser().call("/api/account/sign-in/parameters", { body: { username: "nobody.here" } })).body;
    const again = (await server.browser().call("/api/account/sign-in/parameters", { body: { username: "nobody.here" } })).body;
    assert.deepEqual(Object.keys(unknown).sort(), Object.keys(real).sort());
    assert.equal(unknown.salt, again.salt, "a made-up salt is stable");
    await assert.rejects(signIn(server, "nobody.here"), (error) => error.code === "sign_in_failed");
    for (let attempt = 1; attempt < PASSWORD_ATTEMPTS; attempt += 1)
      await assert.rejects(signIn(server, "sam.lee", "not the password"), (error) => error.code === "sign_in_failed");
    await assert.rejects(signIn(server, "sam.lee"), (error) => error.code === "password_rate_limited", "the member is limited, right password or not");
  } finally {
    await server.close();
  }
  const fresh = await startServer();
  try {
    await foundHousehold(fresh);
    let refused = null;
    for (let attempt = 0; attempt < 10 && !refused; attempt += 1) {
      try { await signIn(fresh); } catch (error) { refused = error; }
    }
    assert.equal(refused?.code, "password_rate_limited", "capabilities issued per member are limited");
  } finally {
    await fresh.close();
  }
});

test("replacing a device revokes it in the same step; the trusted-device limit counts after that", { timeout: 120_000 }, async () => {
  // Each sign-in starts a new limit window, so filling the household isn't
  // stopped by the per-member issuance limit.
  let clock = Date.now();
  const server = await startServer({ now: () => clock });
  const signInLater = (...args) => { clock += PASSWORD_WINDOW_MS + 1; return signIn(server, ...args); };
  try {
    const household = await foundHousehold(server);
    const laptop = await signInLater();
    const added = await register(laptop.browser, laptop.view, household);
    assert.equal(added.status, 201);
    assert.equal((await laptop.browser.call("/api/sync/status", { method: "GET" })).status, 200);
    // From another browser: "This replaces Laptop".
    const phone = await signInLater();
    assert.ok(phone.view.devices.some((device) => device.deviceId === laptop.view.deviceId));
    const someoneElses = await register(phone.browser, phone.view, household, { replaceDeviceId: "e".repeat(32) });
    assert.equal(someoneElses.body.error, "replacement_stale");
    const replaced = await register(phone.browser, phone.view, household, { replaceDeviceId: laptop.view.deviceId });
    assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
    assert.equal(replaced.body.replacedDeviceId, laptop.view.deviceId);
    assert.ok(server.service.devices.get(laptop.view.deviceId).revokedAt, "the replaced device is revoked");
    const refused = await laptop.browser.call("/api/sync/status", { method: "GET" });
    assert.equal(refused.status, 401, "its session ends at once");
    assert.ok(server.service.events.some((event) => event.type === "device_revoked" && event.deviceId === laptop.view.deviceId && event.reason === "replacement"));
    // A revoked device can't come back with its own keys: it would be a new
    // device with new keys, after a sign-in of its own.
    assert.equal((await laptop.browser.call("/api/login/password", { body: { username: "sam.lee", authKey: b64((await passwordKeys()).authKey) } })).status, 403);

    // Fill the household's trusted-device limit.
    const household2 = server.service.households.get(household.householdId);
    while (server.service.activeTrustedDeviceCount(household2) < MAX_TRUSTED_DEVICES) {
      const extra = await signInLater();
      assert.equal((await register(extra.browser, extra.view, household)).status, 201);
    }
    const full = await signInLater();
    assert.equal(full.view.deviceLimit.active, MAX_TRUSTED_DEVICES);
    assert.equal((await register(full.browser, full.view, household)).body.error, "device_limit");
    const swap = await register(full.browser, full.view, household, { replaceDeviceId: phone.view.deviceId });
    assert.equal(swap.status, 201, "a replacement fits, since the replaced device frees its place first");
  } finally {
    await server.close();
  }
});

test("after a move, an old device replaced on sign-in is left out of the removal, and a member can still sign in once the rest are removed", { timeout: 120_000 }, async () => {
  let clock = Date.now();
  const server = await startServer({ now: () => clock });
  const signInLater = (...args) => { clock += PASSWORD_WINDOW_MS + 1; return signIn(server, ...args); };
  try {
    const household = await foundHousehold(server);
    const laptop = await signInLater();
    assert.equal((await register(laptop.browser, laptop.view, household)).status, 201);
    const tablet = await signInLater();
    assert.equal((await register(tablet.browser, tablet.view, household)).status, 201);
    // What a move leaves behind (ADR 0026 §6): marked, and no token.
    for (const { view } of [laptop, tablet]) {
      const device = server.service.devices.get(view.deviceId);
      server.service.deviceTokens.delete(device.tokenHash);
      device.tokenHash = null;
      device.carriedOver = true;
    }
    server.service.persistHousehold(household.householdId);

    const phone = await signInLater();
    // "Which device is this?" says which ones came from the old address (#780).
    assert.deepEqual(phone.view.devices.map((device) => [device.deviceId, device.carriedOver]),
      [[household.deviceId, false], [laptop.view.deviceId, true], [tablet.view.deviceId, true]]);
    const options = await household.founder.call("/api/devices/carried-over/revocation/options");
    assert.equal(options.status, 200, JSON.stringify(options.body));
    assert.equal(options.body.devices, 2);
    // "This replaces Tablet", while the admin is still confirming.
    const replaced = await register(phone.browser, phone.view, household, { replaceDeviceId: tablet.view.deviceId });
    assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
    const finished = await household.founder.call("/api/devices/carried-over/revocation/finish", {
      body: { flow: options.body.flow, authKey: b64((await passwordKeys()).authKey) },
    });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.deepEqual(finished.body.revoked, [laptop.view.deviceId]);
    assert.equal(server.service.events.filter((event) => event.deviceId === tablet.view.deviceId && event.type === "device_revoked")
      .map((event) => event.reason).join(), "replacement");

    // The removed devices' certificates still endorse a new sign-in.
    const later = await signInLater();
    const added = await register(later.browser, later.view, household);
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal("carriedOver" in server.service.devices.get(later.view.deviceId), false);
  } finally {
    await server.close();
  }
});

test("endorsing the certification key: once per member, by the member's own device, verified", { timeout: 60_000 }, async () => {
  const server = await startServer();
  try {
    const household = await foundHousehold(server, { endorse: false });
    // Without an endorsement a new device can't certify itself.
    const early = await signIn(server);
    const certification = household.certification;
    const draft = await createCertificationEndorsement({ householdId: household.householdId, memberId: household.memberId, certification,
      device: { deviceId: household.deviceId, fingerprint: household.device.fingerprint, signingKey: household.device.keys.signingPrivateKey } });
    assert.equal((await register(early.browser, early.view, { ...household, endorsement: draft })).body.error, "certification_missing");
    // Signed by a key that isn't the session device's: refused.
    const stranger = await deviceKeys();
    const badSignature = await createCertificationEndorsement({ householdId: household.householdId, memberId: household.memberId, certification,
      device: { deviceId: household.deviceId, fingerprint: household.device.fingerprint, signingKey: stranger.keys.signingPrivateKey } });
    assert.equal((await household.founder.call("/api/account/certification", { method: "PUT", body: { endorsement: badSignature } })).body.error, "certification_invalid");
    // Naming another member: refused.
    const otherMember = await createCertificationEndorsement({ householdId: household.householdId, memberId: "d".repeat(32), certification,
      device: { deviceId: household.deviceId, fingerprint: household.device.fingerprint, signingKey: household.device.keys.signingPrivateKey } });
    assert.equal((await household.founder.call("/api/account/certification", { method: "PUT", body: { endorsement: otherMember } })).body.error, "certification_invalid");
    // The real one is stored; again is idempotent; a different key conflicts.
    assert.equal((await household.founder.call("/api/account/certification", { method: "PUT", body: { endorsement: draft } })).body.stored, true);
    assert.equal((await household.founder.call("/api/account/certification", { method: "PUT", body: { endorsement: draft } })).body.stored, false);
    const otherKey = await certificationKeyPair((await generateCertificationKey()).pkcs8);
    const conflicting = await createCertificationEndorsement({ householdId: household.householdId, memberId: household.memberId, certification: otherKey,
      device: { deviceId: household.deviceId, fingerprint: household.device.fingerprint, signingKey: household.device.keys.signingPrivateKey } });
    assert.equal((await household.founder.call("/api/account/certification", { method: "PUT", body: { endorsement: conflicting } })).body.error, "certification_key_conflict");
    const vault = await household.founder.call("/api/account/vault", { method: "GET" });
    assert.equal(vault.body.certificationEndorsement.fingerprint, certification.fingerprint);
    // No session: refused.
    assert.equal((await server.browser().call("/api/account/certification", { method: "PUT", body: { endorsement: draft } })).status, 401);
    // A member without a vault can't use the flow at all.
    assert.equal((await signIn(server)).view.method, "password");
  } finally {
    await server.close();
  }
});

test("passkeys: once added, the password alone no longer signs in; a passkey alone does, or both when required", { timeout: 60_000 }, async () => {
  const server = await startServer();
  try {
    const credentialId = b64(Buffer.alloc(32, 4));
    const prfSalt = b64(Buffer.alloc(32, 5));
    const passkeyWrapper = (type) => async ({ householdId, memberId }) => ({
      wrapperId: (type === "passkey" ? "2" : "3").repeat(32), type, version: 1,
      params: { ...(type === "password-passkey" ? { kdf: "pbkdf2-sha256", iterations: 600_000, salt: b64(SALT) } : {}), credentialId, prfSalt },
      wrapped: b64(Buffer.concat([Buffer.from([1]), Buffer.alloc(60, 1)])), householdId, memberId,
    });
    const strip = (make) => async (context) => { const { householdId: _h, memberId: _m, ...wrapper } = await make(context); return wrapper; };
    const household = await foundHousehold(server);
    // Adding the passkey removes the password-only wrapper in the same step (D3).
    server.accountVaultService.changeWrappers({ household: { id: household.householdId }, member: { id: household.memberId } },
      { put: [await strip(passkeyWrapper("passkey"))({})], remove: ["1".repeat(32)] });
    server.service.addCredential(household.memberId, { id: credentialId, publicKey: "key", algorithm: -7 });
    server.service.members.get(household.memberId).credentials.add(credentialId);
    // The password alone is refused now.
    await assert.rejects(signIn(server), (error) => error.code === "passkey_required");
    // Passkey options: this member's passkey, with its PRF input.
    const browser = server.browser();
    const options = await browser.call("/api/account/sign-in/passkey/options", { body: { username: "sam.lee" } });
    assert.deepEqual(options.body.publicKey.allowCredentials, [{ id: credentialId }]);
    assert.equal(options.body.prfSalts[credentialId], prfSalt);
    // An unknown name gets an answer of the same shape.
    const decoy = await server.browser().call("/api/account/sign-in/passkey/options", { body: { username: "nobody.here" } });
    assert.equal(decoy.body.publicKey.allowCredentials.length, 1);
    assert.notEqual(decoy.body.publicKey.allowCredentials[0].id, credentialId);
    // A wrong passkey is refused and charged.
    const wrong = await browser.call("/api/account/sign-in/passkey/finish", { body: { flow: options.body.flow, credential: { id: b64(Buffer.alloc(32, 8)) } } });
    assert.equal(wrong.body.error, "sign_in_failed");
    const again = await browser.call("/api/account/sign-in/passkey/options", { body: { username: "sam.lee" } });
    const finished = await browser.call("/api/account/sign-in/passkey/finish", { body: { flow: again.body.flow, credential: { id: credentialId } } });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.equal(finished.body.method, "passkey");
    const download = await browser.call("/api/account/sign-in/vault");
    assert.deepEqual(download.body.wrappers.map((wrapper) => wrapper.type), ["passkey"], "only the passkey's wrapper");
  } finally {
    await server.close();
  }
  const strict = await startServer();
  try {
    const credentialId = b64(Buffer.alloc(32, 6));
    const both = async () => ({ wrapperId: "3".repeat(32), type: "password-passkey", version: 1,
      params: { kdf: "pbkdf2-sha256", iterations: 600_000, salt: b64(SALT), credentialId, prfSalt: b64(Buffer.alloc(32, 2)) },
      wrapped: b64(Buffer.concat([Buffer.from([1]), Buffer.alloc(60, 1)])) });
    const household = await foundHousehold(strict);
    // Require-both means no password-only wrapper: it goes in the same step
    // (ADR 0018).
    strict.accountVaultService.changeWrappers({ household: { id: household.householdId }, member: { id: household.memberId } },
      { put: [await both()], remove: ["1".repeat(32)] });
    strict.service.addCredential(household.memberId, { id: credentialId, publicKey: "key", algorithm: -7 });
    strict.service.members.get(household.memberId).credentials.add(credentialId);
    // A passkey alone isn't enough.
    const alone = strict.browser();
    const aloneOptions = await alone.call("/api/account/sign-in/passkey/options", { body: { username: "sam.lee" } });
    assert.notEqual(aloneOptions.body.publicKey.allowCredentials[0].id, credentialId, "no passkey-only wrapper: nothing real is offered");
    // The password first: the capability waits for the passkey.
    const { browser, view } = await signIn(strict);
    assert.equal(view.needsPasskey, true);
    // The password alone doesn't show the member's devices, or which of them
    // a move carried over (#780).
    assert.deepEqual(view.devices, []);
    assert.equal((await browser.call("/api/account/sign-in/vault")).body.error, "passkey_required");
    const options = await browser.call("/api/account/sign-in/passkey/options", { body: {} });
    assert.deepEqual(options.body.publicKey.allowCredentials, [{ id: credentialId }]);
    const finished = await browser.call("/api/account/sign-in/passkey/finish", { body: { flow: options.body.flow, credential: { id: credentialId } } });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.equal(finished.body.method, "password-passkey");
    assert.equal(finished.body.needsPasskey, false);
    assert.deepEqual(finished.body.devices.map((device) => [device.deviceId, device.carriedOver]), [[household.deviceId, false]]);
    const download = await browser.call("/api/account/sign-in/vault");
    assert.deepEqual(download.body.wrappers.map((wrapper) => wrapper.type), ["password-passkey"]);
  } finally {
    await strict.close();
  }
});
