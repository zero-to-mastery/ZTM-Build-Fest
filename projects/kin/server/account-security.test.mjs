// A password account's passkey, password and backup code over HTTP (ADR
// 0018, #560/#561/#571/#572), with real Web Crypto and the browser library:
// adding a passkey (the password-only wrapper goes, admin actions move to the
// passkey), signing in on a new device with the passkey alone, requiring
// password and passkey, the backup code as a third way in (rate-limited like
// a password, forcing a new password), regenerating it, and changing the
// password (the verifier and the password wrappers move together).
import assert from "node:assert/strict";
import test from "node:test";
import { derivePasswordKeys, generateCertificationKey, generateVaultKey, sealVault } from "../web/security/account-vault.js";
import { addPasskeyChange, backupCodeChange, makeWrapper, passwordChangeWrappers, passwordParams, requireBothChange, wrapperChangeBody } from "../web/security/account-wrappers.js";
import { generateBackupCode } from "../web/security/backup-code.js";
import { certificationKeyPair, createCertificationEndorsement, createMemberCertificate } from "../web/security/device-certification.js";
import { downloadSignInVault, newPasswordForBackupCode, openSignInVault, signInWithBackupCode, signInWithPassword } from "../web/security/new-device.js";
import { deviceKeyFingerprint, exportDevicePublicKeys, generateDeviceKeys } from "../web/sync/crypto.js";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PASSWORD_ATTEMPTS, PASSWORD_WINDOW_MS } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const PASSWORD = "four unrelated words";
const SALT = new Uint8Array(16).fill(7);
const same = (left, right) => Buffer.from(left).equals(Buffer.from(right));

function stubWebAuthn() {
  return {
    registrationOptions: (flow, { userName } = {}) => ({ challenge: flow, user: { id: "dXNlcg", name: userName ?? "adult" } }),
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

/** A founder with a password, a vault (password wrapper) and an endorsed certification key. */
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
  return { founder, householdId, memberId, deviceId, vaultKey, keys, certification, endorsement, ids: { householdId, memberId } };
}

async function security(household) {
  const result = await household.founder.call("/api/account/security", { method: "GET" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function change(household, body, authKey = household.keys.authKey) {
  return household.founder.call("/api/account/vault/wrappers", { body: { currentAuthKey: b64(authKey), ...wrapperChangeBody(body) } });
}

async function register(browser, view, household, extra = {}) {
  const device = await deviceKeys();
  const certificate = await createMemberCertificate({ householdId: view.householdId, memberId: view.memberId, endorsement: household.endorsement,
    certification: household.certification, device: { deviceId: view.deviceId, publicKeys: device.publicKeys, fingerprint: device.fingerprint } });
  return browser.call("/api/account/sign-in/device", { body: { syncPublicKeys: device.publicKeys, certificate, deviceLabel: "Laptop", vaultEpochs: [1], ...extra } });
}

/** A passkey sign-in with the stub authenticator: options, then finish with `credentialId`. */
async function passkeySignIn(browser, username, credentialId) {
  const options = await browser.call("/api/account/sign-in/passkey/options", { body: { username } });
  return { options, finished: await browser.call("/api/account/sign-in/passkey/finish", { body: { flow: options.body.flow, credential: { id: credentialId } } }) };
}

test("adding a passkey: after the password, the passkey-alone wrapper replaces the password-only one; the passkey alone signs in on a new device", { timeout: 120_000 }, async () => {
  const server = await startServer();
  try {
    const household = await foundHousehold(server);
    const before = await security(household);
    assert.equal(before.username, "sam.lee");
    assert.equal(before.password, true);
    assert.deepEqual(before.passkeys, []);
    assert.deepEqual(before.vault.wrappers.map((wrapper) => wrapper.type), ["password"]);
    assert.equal(before.passwordParameters.salt, b64(SALT));
    assert.equal(before.vault.wrappers[0].wrapped, undefined, "the summary holds no wrapped keys");
    const member = server.service.members.get(household.memberId);
    assert.equal(server.service.confirmsWithPassword(member), true, "admin actions use the password until a passkey is added");

    // Registering needs the current password.
    const wrong = await household.founder.call("/api/account/passkeys/options", { body: { currentAuthKey: b64(new Uint8Array(32).fill(1)) } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, "password_incorrect");
    const options = await household.founder.call("/api/account/passkeys/options", { body: { currentAuthKey: b64(household.keys.authKey) } });
    assert.equal(options.status, 200, JSON.stringify(options.body));
    assert.equal(options.body.publicKey.user.name, "sam.lee", "the passkey is named for the account");
    const credentialId = b64(Buffer.alloc(32, 4));
    const finished = await household.founder.call("/api/account/passkeys/finish", { body: { flow: options.body.flow, credential: { id: credentialId } } });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.ok(member.credentials.has(credentialId));
    assert.equal(server.service.confirmsWithPassword(member), false, "admin actions now ask for the passkey");
    // A flow can't be finished twice, or by another session.
    assert.equal((await household.founder.call("/api/account/passkeys/finish", { body: { flow: options.body.flow, credential: { id: credentialId } } })).status, 410);

    // The wrappers: a change needs the current password, and keeps the rules.
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const added = await addPasskeyChange({ vaultKey: household.vaultKey, ...household.ids, wrappers: before.vault.wrappers,
      prfOutput: prf, credentialId, prfSalt: b64(Buffer.alloc(32, 5)) });
    assert.equal((await change(household, added, new Uint8Array(32).fill(2))).status, 401, "not without the password");
    const onlyAdd = await change(household, { put: added.put, remove: [] });
    assert.equal(onlyAdd.status, 409, "never a passkey beside a password-only wrapper");
    assert.equal(onlyAdd.body.error, "vault_wrapper_rules");
    const applied = await change(household, added);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.deepEqual(applied.body.wrappers.map((wrapper) => wrapper.type), ["passkey"]);

    // On a new device: the password alone is refused; the passkey alone opens the vault.
    await assert.rejects(signInWithPassword({ username: "sam.lee", password: PASSWORD, request: server.browser().request }), { code: "passkey_required" });
    const laptop = server.browser();
    const { finished: signedIn } = await passkeySignIn(laptop, "sam.lee", credentialId);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.equal(signedIn.body.method, "passkey");
    const download = await downloadSignInVault({ request: laptop.request });
    assert.equal(download.backupCode, false);
    const opened = await openSignInVault({ download, method: "passkey", credentialId, prfOutput: prf, ...household.ids });
    assert.ok(same(opened.vaultKey, household.vaultKey));
    assert.equal((await register(laptop, signedIn.body, household)).status, 201);
  } finally {
    await server.close();
  }
});

test("require password and passkey: the passkey alone is refused, both together open the vault; turning it off restores the passkey alone", { timeout: 120_000 }, async () => {
  const server = await startServer();
  try {
    const household = await foundHousehold(server);
    const credentialId = b64(Buffer.alloc(32, 6));
    server.service.addAccountPasskey(server.service.authorize(household.founder.jar.get("kin_session")), { id: credentialId, publicKey: "key", algorithm: -7 });
    const prf = crypto.getRandomValues(new Uint8Array(32));
    let wrappers = (await security(household)).vault.wrappers;
    assert.equal((await change(household, await addPasskeyChange({ vaultKey: household.vaultKey, ...household.ids, wrappers, prfOutput: prf, credentialId, prfSalt: b64(Buffer.alloc(32, 1)) }))).status, 200);
    wrappers = (await security(household)).vault.wrappers;
    const prfSalt = b64(Buffer.alloc(32, 2));
    const on = await requireBothChange({ on: true, vaultKey: household.vaultKey, ...household.ids, wrappers, prfOutput: prf, credentialId, prfSalt,
      passwordKey: household.keys.passwordKey, password: { salt: SALT, iterations: 600_000 } });
    assert.equal((await change(household, on)).status, 200);
    assert.deepEqual((await security(household)).vault.wrappers.map((wrapper) => wrapper.type), ["password-passkey"]);

    // The passkey alone: nothing real is offered, and finishing is refused.
    const alone = server.browser();
    const { options: aloneOptions, finished: refused } = await passkeySignIn(alone, "sam.lee", credentialId);
    assert.notEqual(aloneOptions.body.publicKey.allowCredentials[0].id, credentialId);
    assert.equal(refused.status, 401);
    // Password, then passkey: the combined wrapper, opened with both.
    const browser = server.browser();
    const { view, passwordKey } = await signInWithPassword({ username: "sam.lee", password: PASSWORD, request: browser.request });
    assert.equal(view.needsPasskey, true);
    const options = await browser.call("/api/account/sign-in/passkey/options", { body: {} });
    assert.equal(options.body.prfSalts[credentialId], prfSalt);
    const finished = await browser.call("/api/account/sign-in/passkey/finish", { body: { flow: options.body.flow, credential: { id: credentialId } } });
    assert.equal(finished.body.method, "password-passkey");
    const download = await downloadSignInVault({ request: browser.request });
    await assert.rejects(openSignInVault({ download, method: "password-passkey", credentialId, prfOutput: prf, passwordKey: new Uint8Array(32), ...household.ids }), { code: "vault_unlock_failed" });
    const opened = await openSignInVault({ download, method: "password-passkey", credentialId, prfOutput: prf, passwordKey, ...household.ids });
    assert.ok(same(opened.vaultKey, household.vaultKey));

    // Off: the passkey alone again.
    wrappers = (await security(household)).vault.wrappers;
    const off = await requireBothChange({ on: false, vaultKey: household.vaultKey, ...household.ids, wrappers, prfOutput: prf, credentialId });
    assert.equal((await change(household, off)).status, 200);
    const again = server.browser();
    assert.equal((await passkeySignIn(again, "sam.lee", credentialId)).finished.body.method, "passkey");
  } finally {
    await server.close();
  }
});

test("the backup code: a third way in, limited like a password, that must set a new password; a new code replaces the old one", { timeout: 120_000 }, async () => {
  let clock = Date.now();
  const server = await startServer({ now: () => clock });
  try {
    const household = await foundHousehold(server);
    const first = await generateBackupCode();
    let wrappers = (await security(household)).vault.wrappers;
    assert.equal((await change(household, await backupCodeChange({ vaultKey: household.vaultKey, ...household.ids, wrappers, codeBytes: first.bytes }))).status, 200);
    const summary = await security(household);
    assert.deepEqual(summary.vault.wrappers.map((wrapper) => wrapper.type).sort(), ["backup-code", "password"]);
    assert.deepEqual(summary.vault.wrappers.find((wrapper) => wrapper.type === "backup-code").params, {}, "the check value never leaves the service");

    // A new code replaces the old one: the old one stops signing in.
    const second = await generateBackupCode();
    wrappers = summary.vault.wrappers;
    assert.equal((await change(household, await backupCodeChange({ vaultKey: household.vaultKey, ...household.ids, wrappers, codeBytes: second.bytes }))).status, 200);
    await assert.rejects(signInWithBackupCode({ username: "sam.lee", code: first.text, request: server.browser().request }), { code: "sign_in_failed" });

    // Wrong codes are charged per member and address, like passwords: then even the right one waits.
    for (let attempt = 1; attempt < PASSWORD_ATTEMPTS; attempt += 1) {
      const other = await generateBackupCode();
      await assert.rejects(signInWithBackupCode({ username: "sam.lee", code: other.text, request: server.browser().request }), { code: "sign_in_failed" });
    }
    await assert.rejects(signInWithBackupCode({ username: "sam.lee", code: second.text, request: server.browser().request }), { code: "password_rate_limited" });
    // An unknown name answers the same way.
    await assert.rejects(signInWithBackupCode({ username: "nobody.here", code: second.text, request: server.browser().request }), { code: "password_rate_limited" }, "the address is over its limit too");
    clock += PASSWORD_WINDOW_MS + 1;
    await assert.rejects(signInWithBackupCode({ username: "nobody.here", code: second.text, request: server.browser().request }), { code: "sign_in_failed" });

    // The right code: a capability that opens the vault with the code.
    const browser = server.browser();
    const signedIn = await signInWithBackupCode({ username: "sam.lee", code: second.text, request: browser.request });
    assert.equal(signedIn.view.method, "backup-code");
    const download = await downloadSignInVault({ request: browser.request });
    assert.deepEqual(download.wrappers.map((wrapper) => wrapper.type), ["backup-code"]);
    assert.deepEqual(download.others.map((wrapper) => wrapper.type), ["password"]);
    assert.equal(download.others[0].wrapped, undefined);
    assert.equal(download.backupCode, true);
    const opened = await openSignInVault({ download, method: "backup-code", codeBytes: signedIn.codeBytes, ...household.ids });
    assert.ok(same(opened.vaultKey, household.vaultKey));
    // Registering without a new password is refused; with one, it replaces the old.
    const missing = await register(browser, signedIn.view, household);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "new_password_required");
    await assert.rejects(newPasswordForBackupCode({ password: "short", username: "sam.lee", opened, others: download.others, ...household.ids }), { code: "password_rejected" });
    const prepared = await newPasswordForBackupCode({ password: "a brand new kettle song", username: "sam.lee", opened, others: download.others, ...household.ids });
    assert.equal(prepared.body.vaultChange.put[0].type, "password", "the password wrapper is re-wrapped under the new password");
    const registered = await register(browser, signedIn.view, household, prepared.body);
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    // The old password no longer signs in; the new one does, and opens the vault.
    await assert.rejects(signInWithPassword({ username: "sam.lee", password: PASSWORD, request: server.browser().request }), { code: "sign_in_failed" });
    const later = server.browser();
    const next = await signInWithPassword({ username: "sam.lee", password: "a brand new kettle song", request: later.request });
    assert.equal(next.view.method, "password");
    const nextOpened = await openSignInVault({ download: await downloadSignInVault({ request: later.request }), method: "password", passwordKey: next.passwordKey, ...household.ids });
    assert.ok(same(nextOpened.vaultKey, household.vaultKey), "the re-wrapped password wrapper opens with the new password");
  } finally {
    await server.close();
  }
});

test("a backup-code sign-in with require-both on drops the combined wrapper (it needs the passkey); the account then signs in with the code until the passkey is set up again", { timeout: 120_000 }, async () => {
  const server = await startServer();
  try {
    const household = await foundHousehold(server);
    const credentialId = b64(Buffer.alloc(32, 6));
    server.service.addAccountPasskey(server.service.authorize(household.founder.jar.get("kin_session")), { id: credentialId, publicKey: "key", algorithm: -7 });
    const prf = crypto.getRandomValues(new Uint8Array(32));
    let wrappers = (await security(household)).vault.wrappers;
    await change(household, await requireBothChange({ on: true, vaultKey: household.vaultKey, ...household.ids, wrappers, prfOutput: prf, credentialId,
      passwordKey: household.keys.passwordKey, password: { salt: SALT, iterations: 600_000 } }).then((made) => ({ ...made, remove: wrappers.map((wrapper) => wrapper.wrapperId) })));
    const code = await generateBackupCode();
    wrappers = (await security(household)).vault.wrappers;
    assert.deepEqual(wrappers.map((wrapper) => wrapper.type), ["password-passkey"]);
    await change(household, await backupCodeChange({ vaultKey: household.vaultKey, ...household.ids, wrappers, codeBytes: code.bytes }));
    const browser = server.browser();
    const signedIn = await signInWithBackupCode({ username: "sam.lee", code: code.text, request: browser.request });
    const download = await downloadSignInVault({ request: browser.request });
    const opened = await openSignInVault({ download, method: "backup-code", codeBytes: signedIn.codeBytes, ...household.ids });
    const prepared = await newPasswordForBackupCode({ password: "a brand new kettle song", username: "sam.lee", opened, others: download.others, ...household.ids });
    assert.deepEqual(prepared.body.vaultChange, { put: [], remove: [wrappers.find((wrapper) => wrapper.type === "password-passkey").wrapperId] });
    assert.equal((await register(browser, signedIn.view, household, prepared.body)).status, 201);
    assert.deepEqual((await security(household)).vault.wrappers.map((wrapper) => wrapper.type), ["backup-code"]);
    await assert.rejects(signInWithPassword({ username: "sam.lee", password: "a brand new kettle song", request: server.browser().request }), { code: "backup_code_required" });
  } finally {
    await server.close();
  }
});

test("changing the password: after the current one, the verifier and the re-wrapped wrappers change together", { timeout: 120_000 }, async () => {
  const server = await startServer();
  try {
    const household = await foundHousehold(server);
    const salt = new Uint8Array(16).fill(8);
    const next = await derivePasswordKeys("five other unrelated words", salt);
    const wrappers = (await security(household)).vault.wrappers;
    const vaultChange = wrapperChangeBody(await passwordChangeWrappers({ vaultKey: household.vaultKey, ...household.ids, wrappers,
      passwordKey: next.passwordKey, password: { salt, iterations: 600_000 } }));
    const body = { salt: b64(salt), iterations: 600_000, authKey: b64(next.authKey), vaultChange };
    const wrong = await household.founder.call("/api/account/password", { body: { ...body, currentAuthKey: b64(new Uint8Array(32).fill(3)) } });
    assert.equal(wrong.status, 401);
    // A change that breaks the wrapper rules rolls the password back too.
    const broken = await household.founder.call("/api/account/password", { body: { ...body, currentAuthKey: b64(household.keys.authKey),
      vaultChange: { put: [{ ...vaultChange.put[0], version: 5 }], remove: [] } } });
    assert.equal(broken.status, 409);
    assert.equal((await security(household)).passwordParameters.salt, b64(SALT), "nothing changed");
    const changed = await household.founder.call("/api/account/password", { body: { ...body, currentAuthKey: b64(household.keys.authKey) } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(changed.body, { username: "sam.lee", salt: b64(salt), iterations: 600_000 });
    // The old password signs in nowhere; the new one opens the vault on a new device.
    await assert.rejects(signInWithPassword({ username: "sam.lee", password: PASSWORD, request: server.browser().request }), { code: "sign_in_failed" });
    const fresh = server.browser();
    const signedIn = await signInWithPassword({ username: "sam.lee", password: "five other unrelated words", request: fresh.request });
    const download = await downloadSignInVault({ request: fresh.request });
    const opened = await openSignInVault({ download, method: "password", passwordKey: signedIn.passwordKey, ...household.ids });
    assert.ok(same(opened.vaultKey, household.vaultKey));
    // The trusted device signs in with the new password too.
    const relogin = await household.founder.call("/api/login/password", { body: { username: "sam.lee", authKey: b64(next.authKey) } });
    assert.equal(relogin.status, 200);
  } finally {
    await server.close();
  }
});
