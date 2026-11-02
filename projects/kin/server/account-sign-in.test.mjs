// Username and password accounts (ADR 0018, #558): sign-up by creating or
// joining a household, sign-in on a trusted device, activation, fresh
// confirmations for members without a passkey, usernames, rate limits, and
// the passkey paths staying exactly as they were.
import assert from "node:assert/strict";
import test from "node:test";
import { derivePasswordKeys, PASSWORD_ITERATIONS } from "../web/security/account-vault.js";
import { AccountVaultService } from "./account-vault-service.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PASSWORD_ATTEMPTS, PairingError, PairingService, SIGN_IN_FAILED, USERNAME_CHECKS } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const SALT = new Uint8Array(16).fill(3);
const keys = new Map();
/** authKey for a password, derived as the browser does (cached: PBKDF2 is slow). */
async function authKeyFor(password, salt = SALT) {
  const id = `${password}:${b64(salt)}`;
  if (!keys.has(id)) {
    const derived = await derivePasswordKeys(password, salt);
    derived.passwordKey.fill(0);
    keys.set(id, b64(derived.authKey));
  }
  return keys.get(id);
}

async function signUp(username, password = "four unrelated words", salt = SALT) {
  return { username, authKey: await authKeyFor(password, salt), salt: b64(salt), iterations: PASSWORD_ITERATIONS };
}

// The WebAuthn checks stand in for a browser's passkey: a credential is its
// id, and an assertion passes when it names a registered credential.
function stubWebAuthn() {
  return {
    registrationOptions: (flow) => ({ challenge: flow }),
    authenticationOptions: (flow, credentialIds) => ({ challenge: flow, allowCredentials: credentialIds.map((id) => ({ id })) }),
    verifyRegistration: (response) => ({ id: response.id, publicKey: `key-${response.id}`, algorithm: -7, signCount: 0 }),
    verifyAuthentication(response, flow, registered) {
      if (!registered || response?.id !== registered.id) throw new PairingError("passkey_verification_failed", "Invalid passkey.", 401);
      return true;
    },
    discardFlow() {},
  };
}

async function startServer({ store = new DurableStore(":memory:"), service } = {}) {
  const application = createKinServer({ store, service, webauthn: stubWebAuthn(), origin: "http://localhost" });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${application.server.address().port}`;
  return {
    ...application,
    close: () => new Promise((resolve) => application.server.close(resolve)).finally(() => store.close()),
    /** A browser: its own cookie jar. */
    browser(jar = new Map()) {
      return {
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
      };
    },
  };
}

test("creating a household with a password: no passkey, a username, an Argon2id verifier that survives restart", async () => {
  const store = new DurableStore(":memory:");
  const server = await startServer({ store });
  try {
    const founder = server.browser();
    const created = await founder.call("/api/account/bootstrap", { body: { ...await signUp("Sam.Lee"), deviceLabel: "Phone" } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(founder.jar.get("kin_session") && founder.jar.get("kin_device"));
    assert.equal(created.body.sessionToken, undefined, "tokens travel only as cookies");
    const member = server.service.members.get(created.body.memberId);
    assert.equal(member.username, "sam.lee");
    assert.equal(member.credentials.size, 0);
    assert.equal(member.householdAdmin, true);
    assert.match(member.password.verifier, /^\$argon2id\$v=19\$/);
    assert.ok(!JSON.stringify(store.db.prepare("SELECT * FROM account_passwords").all()).includes(await authKeyFor("four unrelated words")),
      "the service keeps the verifier, never authKey");
    const status = await founder.call("/api/status", { method: "GET" });
    assert.equal(status.body.identity.memberId, created.body.memberId);

    // A restart reloads the username and the verifier from the database.
    const reloaded = new PairingService({ store });
    assert.equal(reloaded.members.get(created.body.memberId).username, "sam.lee");
    assert.equal(reloaded.members.get(created.body.memberId).password.verifier, member.password.verifier);
    assert.equal(reloaded.members.get(created.body.memberId).password.iterations, PASSWORD_ITERATIONS);
  } finally {
    await server.close();
  }
});

test("usernames are unique, case-insensitive, and refused when malformed", async () => {
  const server = await startServer();
  try {
    const first = server.browser();
    assert.equal((await first.call("/api/account/username", { body: { username: "Robin" } })).body.available, true);
    assert.equal((await first.call("/api/account/bootstrap", { body: await signUp("robin") })).status, 201);
    assert.deepEqual((await first.call("/api/account/username", { body: { username: "ROBIN" } })).body, { username: "robin", available: false });
    const second = server.browser();
    const taken = await second.call("/api/account/bootstrap", { body: await signUp("Robin") });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, "username_taken");
    assert.equal(second.jar.size, 0, "nothing is created for a taken username");
    for (const username of ["ro", "robin hood", "x".repeat(33)]) {
      const refused = await second.call("/api/account/bootstrap", { body: await signUp(username) });
      assert.equal(refused.body.error, "username_invalid", username);
    }
    // authKey, salt and iterations are checked before anything is kept.
    for (const change of [{ authKey: "short" }, { salt: "AAAA" }, { iterations: 1000 }]) {
      const refused = await second.call("/api/account/bootstrap", { body: { ...await signUp("someone"), ...change } });
      assert.equal(refused.body.error, "password_invalid", JSON.stringify(change));
    }
  } finally {
    await server.close();
  }
});

test("signing in on a trusted device: one calm error for a wrong username or password, then a limit", async () => {
  const server = await startServer();
  try {
    const phone = server.browser();
    await phone.call("/api/account/bootstrap", { body: await signUp("casey") });
    await phone.call("/api/logout");
    assert.equal((await phone.call("/api/status", { method: "GET" })).body.identity, null);
    const right = await authKeyFor("four unrelated words");
    const wrong = await authKeyFor("four unrelated wordz");

    const badPassword = await phone.call("/api/login/password", { body: { username: "casey", authKey: wrong } });
    const badName = await phone.call("/api/login/password", { body: { username: "someone-else", authKey: right } });
    assert.equal(badPassword.status, 401);
    assert.deepEqual(badPassword.body, { error: "sign_in_failed", message: SIGN_IN_FAILED });
    assert.deepEqual(badName.body, badPassword.body, "a wrong username reads exactly like a wrong password");
    assert.ok(phone.jar.get("kin_device"), "a failed sign-in keeps the device cookie");

    const signedIn = await phone.call("/api/login/password", { body: { username: "CASEY", authKey: right } });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.ok(phone.jar.get("kin_session"));
    assert.ok((await phone.call("/api/status", { method: "GET" })).body.identity);

    // Without this device's cookie there is nothing to sign in to (#568 later).
    const stranger = server.browser();
    assert.equal((await stranger.call("/api/login/password", { body: { username: "casey", authKey: right } })).body.error, "device_not_trusted");

    // Ten failures per member: then even the right password waits.
    for (let attempt = 2; attempt < PASSWORD_ATTEMPTS; attempt += 1)
      await phone.call("/api/login/password", { body: { username: "casey", authKey: wrong } });
    const limited = await phone.call("/api/login/password", { body: { username: "casey", authKey: right } });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "password_rate_limited");
  } finally {
    await server.close();
  }
});

test("joining with a password: the inviter still approves after comparing devices, then the joiner activates with the password", async () => {
  const server = await startServer();
  try {
    const founder = server.browser();
    await founder.call("/api/account/bootstrap", { body: { ...await signUp("parent.one"), syncPublicKeys: undefined } });
    const invitation = await founder.call("/api/pairings", { body: { kind: "adult" } });
    assert.equal(invitation.status, 201);

    const joiner = server.browser();
    // A username already taken is refused at the claim.
    assert.equal((await joiner.call("/api/account/claim", { body: { ...await signUp("Parent.One", "another fine password"), code: invitation.body.code } })).body.error,
      "username_taken");
    const claimed = await joiner.call("/api/account/claim", { body: { ...await signUp("parent.two", "another fine password"), code: invitation.body.code } });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.ok(joiner.jar.get("kin_claim"));
    const view = await joiner.call("/api/claim", { method: "GET" });
    assert.equal(view.body.state, "Claimed");
    assert.equal(view.body.signIn, "password");
    // The username is held while the claim waits.
    assert.equal((await server.browser().call("/api/account/username", { body: { username: "parent.two" } })).body.available, false);

    // The founder has no passkey: the approval asks for their password.
    const pairingView = await founder.call(`/api/pairings/${invitation.body.pairingId}`, { method: "GET" });
    const options = await founder.call(`/api/pairings/${invitation.body.pairingId}/approve/options`, { body: { expectedVersion: pairingView.body.version } });
    assert.deepEqual(options.body.password, { username: "parent.one", salt: b64(SALT), iterations: PASSWORD_ITERATIONS });
    const wrong = await founder.call(`/api/pairings/${invitation.body.pairingId}/approve/finish`,
      { body: { flow: options.body.flow, authKey: await authKeyFor("not the password") } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, "password_incorrect");
    assert.equal((await joiner.call("/api/claim", { method: "GET" })).body.state, "Claimed", "a wrong password approves nothing");
    const again = await founder.call(`/api/pairings/${invitation.body.pairingId}/approve/options`, { body: { expectedVersion: pairingView.body.version } });
    const approved = await founder.call(`/api/pairings/${invitation.body.pairingId}/approve/finish`,
      { body: { flow: again.body.flow, authKey: await authKeyFor("four unrelated words") } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.state, "Confirmed");

    // The joiner finishes with their own password, not the passkey route.
    assert.equal((await joiner.call("/api/claim/activate/options")).body.error, "password_required");
    const badActivation = await joiner.call("/api/claim/activate/password", { body: { authKey: await authKeyFor("four unrelated words") } });
    assert.equal(badActivation.body.error, "password_incorrect");
    const activated = await joiner.call("/api/claim/activate/password", { body: { authKey: await authKeyFor("another fine password") } });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.ok(joiner.jar.get("kin_session") && !joiner.jar.get("kin_claim"));
    const member = server.service.members.get(activated.body.memberId);
    assert.equal(member.username, "parent.two");
    assert.equal(member.credentials.size, 0);
  } finally {
    await server.close();
  }
});

test("adding a device to an existing member still needs a passkey", async () => {
  const server = await startServer();
  try {
    const founder = server.browser();
    await founder.call("/api/account/bootstrap", { body: await signUp("dana") });
    const devicePairing = await founder.call("/api/devices/pairings");
    assert.equal(devicePairing.status, 201);
    const refused = await server.browser().call("/api/account/claim", { body: { ...await signUp("dana.phone"), code: devicePairing.body.code } });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "passkey_required");
  } finally {
    await server.close();
  }
});

test("admin-only actions take a fresh password from a member with no passkey, and never from one with a passkey", async () => {
  const server = await startServer();
  try {
    const founder = server.browser();
    await founder.call("/api/account/bootstrap", { body: await signUp("admin.pw") });
    const options = await founder.call("/api/household/chat-policy/options", { body: { limited: "read", temporary: "none" } });
    assert.equal(options.status, 200, JSON.stringify(options.body));
    assert.equal(options.body.password.username, "admin.pw");
    // A passkey assertion isn't what this member has.
    const withCredential = await founder.call("/api/household/chat-policy/finish", { body: { flow: options.body.flow, credential: { id: "x" } } });
    assert.equal(withCredential.status, 400);
    const next = await founder.call("/api/household/chat-policy/options", { body: { limited: "read", temporary: "none" } });
    const changed = await founder.call("/api/household/chat-policy/finish", { body: { flow: next.body.flow, authKey: await authKeyFor("four unrelated words") } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.limited, "read");

    // A passkey member's options and checks are unchanged: no password
    // parameters, and an authKey is no substitute for the passkey.
    const passkeyFounder = server.browser();
    const registration = await passkeyFounder.call("/api/passkeys/register/options", { body: { purpose: "bootstrap" } });
    const registered = await passkeyFounder.call("/api/passkeys/register/finish", { body: { flow: registration.body.flow, credential: { id: "passkey-founder" } } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const passkeyOptions = await passkeyFounder.call("/api/household/chat-policy/options", { body: { limited: "read", temporary: "none" } });
    assert.equal(passkeyOptions.body.password, undefined);
    assert.deepEqual(passkeyOptions.body.publicKey.allowCredentials, [{ id: "passkey-founder" }]);
    const substituted = await passkeyFounder.call("/api/household/chat-policy/finish", { body: { flow: passkeyOptions.body.flow, authKey: await authKeyFor("four unrelated words") } });
    assert.equal(substituted.status, 401);
    const viaPasskey = await passkeyFounder.call("/api/household/chat-policy/options", { body: { limited: "read", temporary: "none" } });
    const passkeyChanged = await passkeyFounder.call("/api/household/chat-policy/finish", { body: { flow: viaPasskey.body.flow, credential: { id: "passkey-founder" } } });
    assert.equal(passkeyChanged.status, 200, JSON.stringify(passkeyChanged.body));
    // Passkey login still works and offers no password parameters.
    await passkeyFounder.call("/api/logout");
    const login = await passkeyFounder.call("/api/login/options");
    assert.equal(login.body.password, undefined);
    assert.equal((await passkeyFounder.call("/api/login/finish", { body: { flow: login.body.flow, credential: { id: "passkey-founder" } } })).status, 200);
    // And a password can't sign in a passkey member's device.
    const noPassword = await passkeyFounder.call("/api/login/password", { body: { username: "admin.pw", authKey: await authKeyFor("four unrelated words") } });
    assert.equal(noPassword.body.error, "sign_in_failed");
  } finally {
    await server.close();
  }
});

test("removing a member removes their account vault, password verifier and username", async () => {
  for (const store of [new DurableStore(":memory:"), null]) {
    const pairing = new PairingService({ store });
    const vaults = new AccountVaultService({ store });
    pairing.onAccountRemoved = (householdId, memberId) => vaults.removeMember(householdId, memberId);
    const founder = pairing.bootstrap({ credential: { id: `founder-${Math.random()}`, publicKey: "k", algorithm: -7 } });
    const invitation = pairing.createPairing(founder.sessionToken);
    const claim = pairing.claimPairing({ code: invitation.code, password: await pairing.preparePassword(await signUp("leaving.soon")) });
    pairing.approvePairing(founder.sessionToken, invitation.pairingId, claim.version);
    const joined = pairing.activateClaim(claim.claimToken);
    const wrapped = Buffer.alloc(61, 3);
    wrapped[0] = 1;
    const sealed = Buffer.alloc(120, 7);
    sealed.write("KVLT", 0, "latin1");
    sealed[4] = 1;
    vaults.upload(pairing.authorize(joined.sessionToken), { expectedVersion: 0, ciphertext: b64(sealed), wrappers: [{
      wrapperId: "1".repeat(32), type: "password", version: 1, wrapped: b64(wrapped),
      params: { kdf: "pbkdf2-sha256", iterations: PASSWORD_ITERATIONS, salt: b64(SALT) } }] });
    assert.equal(pairing.usernameAvailable("leaving.soon").available, false);

    pairing.removeOtherAdult(founder.sessionToken, joined.memberId, founder.memberId);
    assert.equal(vaults.storage.accountVault(founder.householdId, joined.memberId), null);
    assert.equal(vaults.storage.accountPassword(founder.householdId, joined.memberId), null);
    assert.equal(pairing.members.get(joined.memberId).username, undefined);
    assert.equal(pairing.usernameAvailable("leaving.soon").available, true, "the username can be chosen again");
    if (store) {
      assert.equal(new PairingService({ store }).members.get(joined.memberId).username, undefined, "and stays gone after a restart");
      store.close();
    }
  }
});

test("username checks are limited per client address", () => {
  const pairing = new PairingService();
  for (let attempt = 0; attempt < USERNAME_CHECKS; attempt += 1)
    assert.equal(pairing.usernameAvailable(`name-${attempt}`, "address-a").available, true);
  assert.throws(() => pairing.usernameAvailable("one-more", "address-a"), { code: "password_rate_limited" });
  assert.equal(pairing.usernameAvailable("one-more", "address-b").available, true, "another address is unaffected");
});

test("a password-only admin counts as a usable admin, so their other device can be revoked", () => {
  const pairing = new PairingService();
  const founder = pairing.bootstrap({ password: { username: "only.admin", salt: new Uint8Array(16), iterations: PASSWORD_ITERATIONS, verifier: "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", updatedAt: 1 } });
  const household = pairing.households.get(founder.householdId);
  assert.equal(pairing.hasUsableAdminAccess(household), true);
  assert.equal(pairing.confirmsWithPassword(pairing.members.get(founder.memberId)), true);
  // Exactly one of a passkey or a password signs a founder up.
  assert.throws(() => pairing.bootstrap({}), { code: "invalid_credential" });
});
