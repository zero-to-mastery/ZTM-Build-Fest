import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import {
  canManageTrust,
  canParticipate,
  CLAIM_TTL_MS,
  isHouseholdAdmin,
  isTemporaryMember,
  normalizeMemberKind,
  PAIRING_CODE_ALPHABET,
  PAIRING_TTL_MS,
  PairingError,
  PairingService,
  RATE_WINDOW_MS,
  SESSION_TTL_MS,
  TERMINAL_PAIRING_RETENTION_MS,
} from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { DurableStore } from "./durable-store.mjs";
import { CHALLENGE_TTL_MS, WebAuthn } from "./webauthn.mjs";
import {
  createDeviceAuthorizationCertificate,
  deviceKeyFingerprint,
} from "../web/sync/crypto.js";
import { requestBody } from "./sync-wire-test-utils.mjs";

globalThis.crypto ??= webcrypto;

const credential = (suffix) => ({
  id: `credential-${suffix}`,
  publicKey: `key-${suffix}`,
  algorithm: -7,
});

async function syncDeviceKeyPair() {
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
    keys: {
      agreementPrivateKey: agreement.privateKey,
      signingPrivateKey: signing.privateKey,
    },
    publicKeys: {
      agreement: await crypto.subtle.exportKey("jwk", agreement.publicKey),
      signing: await crypto.subtle.exportKey("jwk", signing.publicKey),
    },
  };
}
const setup = () => {
  let now = 1_000_000;
  const service = new PairingService({
    now: () => now,
    secret: Buffer.alloc(32, 7),
  });
  const adult = service.bootstrap({
    credential: credential("a"),
    deviceLabel: "A phone",
  });
  return {
    service,
    adult,
    advance: (value) => {
      now += value;
    },
  };
};

test("new invitations echo the inviter key the inviting client verifies before showing the code", async () => {
  const { service, adult } = setup();
  const inviterKeys = await syncDeviceKeyPair();
  service.registerSyncPublicKeys(adult.sessionToken, inviterKeys.publicKeys);
  const fingerprint = await deviceKeyFingerprint(inviterKeys.publicKeys);
  for (const created of [
    service.createPairing(adult.sessionToken, { kind: "adult" }),
    service.createPairing(adult.sessionToken, { kind: "limited" }),
    service.createDevicePairing(adult.sessionToken),
  ]) {
    assert.equal(created.inviterDeviceId, adult.deviceId);
    assert.equal(created.inviterKeyFingerprint, fingerprint);
    const view = service.pairingView(service.pairings.get(created.pairingId));
    assert.equal(created.inviterKeyFingerprint, view.inviterKeyFingerprint);
  }
});

test("member trust rules keep limited and temporary participation separate from adult authority", () => {
  const now = 1_500_000;
  const limitedMember = { active: true, kind: "limited" };
  const temporaryMember = { active: true, kind: "temporary", expiresAt: now + 10_000 };
  const expiredTemporaryMember = { active: true, kind: "temporary", expiresAt: now - 10_000 };

  assert.equal(canManageTrust(limitedMember), false);
  assert.equal(canParticipate(limitedMember, now), true);
  assert.equal(canManageTrust(temporaryMember, now), false);
  assert.equal(canParticipate(temporaryMember, now), true);
  assert.equal(canParticipate(expiredTemporaryMember, now), false);
  assert.equal(isTemporaryMember(expiredTemporaryMember, now), false);
});

test("legacy missing kinds stay adult while malformed explicit kinds fail closed", () => {
  assert.equal(normalizeMemberKind(undefined), "adult");
  assert.equal(normalizeMemberKind("adult"), "adult");
  assert.equal(normalizeMemberKind("limited"), "limited");
  assert.equal(normalizeMemberKind("temporary"), "temporary");
  for (const kind of ["whatever", "admin", null, "", "malformed-object"]) {
    assert.equal(normalizeMemberKind(kind), "invalid");
    const member = { active: true, kind };
    assert.equal(canManageTrust(member), false);
    assert.equal(canParticipate(member), false);
    assert.equal(isTemporaryMember(member), false);
  }
});

test("the final trusted adult cannot leave when only limited or temporary members remain", () => {
  const scenarios = [
    [{ adult: 1, limited: 1, temporary: 0 }, "last_adult"],
    [{ adult: 1, limited: 0, temporary: 1 }, "last_adult"],
    [{ adult: 1, limited: 1, temporary: 1 }, "last_adult"],
    [{ adult: 2, limited: 1, temporary: 0 }, true],
    [{ adult: 2, limited: 0, temporary: 1 }, true],
  ];

  for (const [counts, expected] of scenarios) {
    const service = new PairingService({
      now: () => 1_000_000,
      secret: Buffer.alloc(32, 7),
    });
    const householdId = `household-${Math.random().toString(16).slice(2)}`;
    const adultId = "a".repeat(32);
    const adultDeviceId = "b".repeat(32);
    service.households.set(householdId, {
      id: householdId,
      members: new Set([adultId]),
      version: 1,
      lifecycleState: "active",
      deletionRequestedAt: null,
      deletionFinalizeAt: null,
      deletedAt: null,
    });
    service.members.set(adultId, {
      id: adultId,
      householdId,
      active: true,
      kind: "adult",
      credentials: new Set(["credential-a"]),
    });
    service.devices.set(adultDeviceId, {
      id: adultDeviceId,
      memberId: adultId,
      householdId,
      label: "adult device",
      trustedAt: 1_000,
      revokedAt: null,
      tokenHash: null,
    });
    const adultSessionToken = service.issueSession(adultId, adultDeviceId).sessionToken;

    for (let index = 0; index < counts.limited; index += 1) {
      const memberId = `${index}`.padStart(32, "0");
      service.members.set(memberId, {
        id: memberId,
        householdId,
        active: true,
        kind: "limited",
        credentials: new Set(),
      });
      service.households.get(householdId).members.add(memberId);
    }
    for (let index = 0; index < counts.temporary; index += 1) {
      const memberId = `${index + 100}`.padStart(32, "0");
      service.members.set(memberId, {
        id: memberId,
        householdId,
        active: true,
        kind: "temporary",
        expiresAt: 2_000_000,
        credentials: new Set(),
      });
      service.households.get(householdId).members.add(memberId);
    }
    for (let index = 0; index < counts.adult - 1; index += 1) {
      const memberId = `adult-${index}`.padStart(32, "0");
      service.members.set(memberId, {
        id: memberId,
        householdId,
        active: true,
        kind: "adult",
        credentials: new Set([`credential-${index}`]),
      });
      service.households.get(householdId).members.add(memberId);
      service.devices.set(`device-${index}`.padStart(32, "0"), {
        id: `device-${index}`.padStart(32, "0"), memberId, householdId,
        label: "another Adult device", trustedAt: 1_000, revokedAt: null,
      });
    }

    if (expected === "last_adult") {
      assert.throws(
        () => service.leaveHousehold(adultSessionToken, adultId),
        (error) => error.code === "last_adult",
      );
    } else {
      assert.equal(service.leaveHousehold(adultSessionToken, adultId).removed, true);
    }
  }
});

test("last Adult safety requires another active Adult with credentials and an unrevoked device", () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({ code: invitation.code, credential: credential("last-adult-b"), deviceLabel: "B phone" });
  service.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const other = service.activateClaim(claim.claimToken);
  service.revokeDevice(adult.sessionToken, other.deviceId, adult.memberId);
  assert.throws(
    () => service.leaveHousehold(adult.sessionToken, adult.memberId),
    (error) => error.code === "last_adult",
  );
  assert.throws(
    () => service.reauthenticate(other.deviceToken, "credential-last-adult-b"),
    (error) => error.code === "device_not_trusted",
  );
});

test("expired temporary members lose session access even when the device remains trusted", () => {
  let now = 1_000_000;
  const service = new PairingService({
    now: () => now,
    secret: Buffer.alloc(32, 7),
  });
  const householdId = "household-1";
  const memberId = "member-1";
  const deviceId = "device-1";

  service.households.set(householdId, {
    id: householdId,
    members: new Set([memberId]),
    version: 1,
    lifecycleState: "active",
    deletionRequestedAt: null,
    deletionFinalizeAt: null,
    deletedAt: null,
  });
  service.members.set(memberId, {
    id: memberId,
    householdId,
    active: true,
    kind: "temporary",
    expiresAt: now + 10_000,
    credentials: new Set(),
  });
  service.devices.set(deviceId, {
    id: deviceId,
    memberId,
    householdId,
    label: "Guest device",
    trustedAt: now,
    revokedAt: null,
    tokenHash: null,
  });
  const { sessionToken } = service.issueSession(memberId, deviceId);
  now += 20_000;

  assert.throws(
    () => service.authorize(sessionToken),
    (error) => error instanceof PairingError && error.code === "membership_removed",
  );
});

function testWebAuthn() {
  return {
    registrationCalls: 0,
    discardedFlows: [],
    registrationOptions(flow) {
      this.registrationCalls += 1;
      return { challenge: flow };
    },
    authenticationOptions(flow, credentialIds) {
      return {
        challenge: flow,
        allowCredentials: credentialIds.map((id) => ({ id })),
      };
    },
    verifyRegistration(response, flow) {
      if (response?.flow !== flow)
        throw new PairingError(
          "registration_failed",
          "Invalid registration.",
          400,
        );
      return {
        id: response.id,
        publicKey: `key-${response.id}`,
        algorithm: -7,
        signCount: 0,
      };
    },
    verifyAuthentication(response, flow, registeredCredential) {
      if (
        !registeredCredential ||
        response?.id !== registeredCredential.id ||
        response?.flow !== flow
      )
        throw new PairingError(
          "passkey_verification_failed",
          "Invalid passkey.",
          401,
        );
      return true;
    },
    discardFlow(flow) {
      this.discardedFlows.push(flow);
    },
  };
}

async function startTestServer({
  service = new PairingService(),
  now = () => Date.now(),
  origin = "http://localhost",
  maxFlows,
  maxAnonymousFlows,
  webauthn = testWebAuthn(),
} = {}) {
  const store = new DurableStore(":memory:");
  const application = createKinServer({
    service,
    store,
    webauthn,
    now,
    origin,
    maxFlows,
    maxAnonymousFlows,
  });
  await new Promise((resolve, reject) => {
    application.server.once("error", reject);
    application.server.listen(0, "127.0.0.1", resolve);
  });
  return {
    ...application,
    webauthn,
    url: `http://127.0.0.1:${application.server.address().port}`,
    close: () =>
      new Promise((resolve, reject) =>
        application.server.close((error) =>
          error ? reject(error) : resolve(),
        ),
      ).finally(() => application.store?.close()),
  };
}

function apiRequest(server, path, { method = "GET", body, cookie } = {}) {
  const request = requestBody(path, method, body);
  const headers = { ...request.headers };
  if (cookie) headers.Cookie = cookie;
  return fetch(`${server.url}${path}`, {
    method,
    headers,
    body: request.body,
  });
}

function responseCookies(response) {
  return response.headers.getSetCookie().map((value) => value.split(";", 1)[0]);
}

function cookieValue(cookies, name) {
  return cookies
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

const base64url = (value) => Buffer.from(value).toString("base64url");
const cborHead = (major, length) => {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const result = Buffer.alloc(3);
  result[0] = (major << 5) | 25;
  result.writeUInt16BE(length, 1);
  return result;
};
function encodeCbor(value) {
  if (Buffer.isBuffer(value))
    return Buffer.concat([cborHead(2, value.length), value]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (typeof value === "number")
    return cborHead(value >= 0 ? 0 : 1, value >= 0 ? value : -1 - value);
  if (value instanceof Map) {
    const entries = [...value].flatMap(([key, item]) => [
      encodeCbor(key),
      encodeCbor(item),
    ]);
    return Buffer.concat([cborHead(5, value.size), ...entries]);
  }
  throw new Error("Unsupported test CBOR value");
}
function registrationAttestation(cose) {
  const credentialId = Buffer.from([1, 2, 3]);
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    createHash("sha256").update("localhost").digest(),
    Buffer.from([0x45]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    idLength,
    credentialId,
    encodeCbor(cose),
  ]);
  return {
    id: base64url(credentialId),
    attestationObject: base64url(encodeCbor(new Map([["authData", authData]]))),
  };
}
function clientData(challenge, overrides = {}) {
  return base64url(
    JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin: "http://localhost",
      ...overrides,
    }),
  );
}
function assertVerificationError(action) {
  assert.throws(
    action,
    (error) =>
      error instanceof PairingError &&
      ["passkey_verification_failed", "unsupported_passkey"].includes(
        error.code,
      ),
  );
}

test("HTTP logout and passkey login restore the same member and household", async () => {
  const { service, adult } = setup();
  const server = await startTestServer({ service });
  try {
    assert.equal(
      (await apiRequest(server, "/api/login/options", { method: "POST" }))
        .status,
      403,
    );
    const unknownOptionsResponse = await apiRequest(
      server,
      "/api/login/options",
      {
        method: "POST",
        cookie: `kin_device=${adult.deviceToken}`,
      },
    );
    const unknownOptions = await unknownOptionsResponse.json();
    assert.equal(
      (
        await apiRequest(server, "/api/login/finish", {
          method: "POST",
          cookie: `kin_device=${adult.deviceToken}`,
          body: {
            flow: unknownOptions.flow,
            credential: { id: "unknown-credential", flow: unknownOptions.flow },
          },
        })
      ).status,
      401,
    );

    const logout = await apiRequest(server, "/api/logout", {
      method: "POST",
      cookie: `kin_session=${adult.sessionToken}; kin_device=${adult.deviceToken}`,
    });
    assert.equal(logout.status, 200);
    assert.ok(
      responseCookies(logout).some((value) => value === "kin_session="),
    );
    assert.equal(
      responseCookies(logout).some((value) => value.startsWith("kin_device=")),
      false,
    );

    const optionsResponse = await apiRequest(server, "/api/login/options", {
      method: "POST",
      cookie: `kin_device=${adult.deviceToken}`,
    });
    assert.equal(optionsResponse.status, 200);
    const options = await optionsResponse.json();
    assert.deepEqual(options.publicKey.allowCredentials, [
      { id: "credential-a" },
    ]);

    const loginResponse = await apiRequest(server, "/api/login/finish", {
      method: "POST",
      cookie: `kin_device=${adult.deviceToken}`,
      body: {
        flow: options.flow,
        credential: { id: "credential-a", flow: options.flow },
      },
    });
    assert.equal(loginResponse.status, 200);
    const identity = await loginResponse.json();
    assert.equal(identity.memberId, adult.memberId);
    assert.equal(identity.deviceId, adult.deviceId);
    assert.equal(identity.householdId, adult.householdId);
    assert.equal("sessionToken" in identity, false);
    assert.equal("deviceToken" in identity, false);

    const newCookies = responseCookies(loginResponse);
    assert.notEqual(cookieValue(newCookies, "kin_device"), adult.deviceToken);
    const statusResponse = await apiRequest(server, "/api/status", {
      cookie: newCookies.join("; "),
    });
    const status = await statusResponse.json();
    assert.equal(status.identity.memberId, adult.memberId);
    assert.equal(status.identity.householdId, adult.householdId);
  } finally {
    await server.close();
  }
});

test("reloaded terminal claims clear their cookie and allow a new code", async () => {
  for (const terminalState of ["Expired", "Revoked"]) {
    let now = 4_000_000;
    const service = new PairingService({
      now: () => now,
      secret: Buffer.alloc(32, 13),
    });
    const adult = service.bootstrap({
      credential: credential("a"),
      deviceLabel: "A",
    });
    const invitation = service.createPairing(adult.sessionToken);
    const claim = service.claimPairing({
      code: invitation.code,
      credential: credential("b"),
      deviceLabel: "B",
    });
    if (terminalState === "Expired") now += CLAIM_TTL_MS;
    else service.revokePairing(adult.sessionToken, invitation.pairingId);

    const server = await startTestServer({ service, now: () => now });
    try {
      const reload = await apiRequest(server, "/api/status", {
        cookie: `kin_claim=${claim.claimToken}`,
      });
      const status = await reload.json();
      assert.equal(status.claim.state, terminalState);
      assert.ok(
        responseCookies(reload).some((value) => value === "kin_claim="),
      );

      const next = service.createPairing(adult.sessionToken);
      const retry = await apiRequest(server, "/api/passkeys/register/options", {
        method: "POST",
        cookie: `kin_claim=${claim.claimToken}`,
        body: { purpose: "claim", code: next.code, deviceLabel: "B again" },
      });
      assert.equal(retry.status, 200);
      assert.ok(responseCookies(retry).some((value) => value === "kin_claim="));
    } finally {
      await server.close();
    }
  }
});

test("HTTP claim preflight precedes WebAuthn and short-lived flows stay bounded", async () => {
  let now = 2_000_000;
  const service = new PairingService({
    now: () => now,
    secret: Buffer.alloc(32, 9),
  });
  const adult = service.bootstrap({
    credential: credential("a"),
    deviceLabel: "A",
  });
  const expired = service.createPairing(adult.sessionToken);
  now += PAIRING_TTL_MS;
  const server = await startTestServer({
    service,
    now: () => now,
    maxFlows: 2,
  });
  const optionsPath = "/api/passkeys/register/options";
  const requestOptions = (code) =>
    apiRequest(server, optionsPath, {
      method: "POST",
      body: { purpose: "claim", code, deviceLabel: "B" },
    });
  try {
    assert.equal((await requestOptions("NOT-A-CODE")).status, 404);
    assert.equal((await requestOptions(expired.code)).status, 410);

    const revoked = service.createPairing(adult.sessionToken);
    service.revokePairing(adult.sessionToken, revoked.pairingId);
    assert.equal((await requestOptions(revoked.code)).status, 404);
    assert.equal(server.webauthn.registrationCalls, 0);

    const valid = service.createPairing(adult.sessionToken);
    const validResponse = await requestOptions(valid.code);
    assert.equal(validResponse.status, 200);
    const validFlow = await validResponse.json();
    assert.deepEqual(validFlow.publicKey.user, undefined);
    assert.equal(service.pairings.get(valid.pairingId).state, "Pending");
    assert.equal(service.pairings.get(valid.pairingId).attempts, 0);

    const secondResponse = await apiRequest(server, optionsPath, {
      method: "POST",
      body: { purpose: "bootstrap", deviceLabel: "Another device" },
    });
    const secondFlow = await secondResponse.json();
    assert.equal(secondResponse.status, 200);
    assert.equal(server.flows.size, 2);
    assert.equal(
      (
        await apiRequest(server, optionsPath, {
          method: "POST",
          body: { purpose: "bootstrap", deviceLabel: "Overflow" },
        })
      ).status,
      503,
    );
    assert.equal(server.flows.has(validFlow.flow), true);
    assert.equal(server.flows.has(secondFlow.flow), true);

    now += 120_001;
    const freshResponse = await apiRequest(server, optionsPath, {
      method: "POST",
      body: { purpose: "bootstrap", deviceLabel: "Fresh flow" },
    });
    const freshFlow = await freshResponse.json();
    assert.equal(server.flows.size, 1);
    now += 120_001;
    const staleFinish = await apiRequest(
      server,
      "/api/passkeys/register/finish",
      {
        method: "POST",
        body: {
          flow: freshFlow.flow,
          credential: { id: "late", flow: freshFlow.flow },
        },
      },
    );
    assert.equal(staleFinish.status, 410);
    assert.equal(server.flows.size, 0);
  } finally {
    await server.close();
  }
});

test("anonymous bootstrap capacity preserves room for trusted passkey login", async () => {
  const service = new PairingService();
  const adult = service.bootstrap({
    credential: credential("capacity"),
    deviceLabel: "Trusted device",
  });
  const webauthn = new WebAuthn({
    rpId: "localhost",
    origin: "http://localhost",
    maxChallenges: 3,
    maxAnonymousChallenges: 1,
  });
  const server = await startTestServer({
    service,
    webauthn,
    maxFlows: 3,
    maxAnonymousFlows: 1,
  });
  try {
    const first = await apiRequest(server, "/api/passkeys/register/options", {
      method: "POST",
      body: { purpose: "bootstrap", deviceLabel: "Anonymous device" },
    });
    assert.equal(first.status, 200);

    const saturated = await apiRequest(
      server,
      "/api/passkeys/register/options",
      {
        method: "POST",
        body: { purpose: "bootstrap", deviceLabel: "Another device" },
      },
    );
    assert.equal(saturated.status, 503);

    const trusted = await apiRequest(server, "/api/login/options", {
      method: "POST",
      cookie: `kin_device=${adult.deviceToken}`,
    });
    assert.equal(trusted.status, 200);
    assert.equal(server.flows.size, 2);
    assert.equal(server.webauthn.challenges.size, 2);
  } finally {
    await server.close();
  }
});

test("failed passkey option allocation rolls back its server flow", async () => {
  const webauthn = testWebAuthn();
  webauthn.registrationOptions = () => {
    throw new PairingError(
      "challenge_capacity",
      "Too many active passkey requests. Wait and try again.",
      503,
    );
  };
  const server = await startTestServer({ webauthn });
  try {
    const response = await apiRequest(
      server,
      "/api/passkeys/register/options",
      {
        method: "POST",
        body: { purpose: "bootstrap", deviceLabel: "Device" },
      },
    );
    assert.equal(response.status, 503);
    assert.equal(server.flows.size, 0);
    assert.equal(webauthn.discardedFlows.length, 1);
  } finally {
    await server.close();
  }
});

test("failed passkey finish discards the flow's outstanding challenge", async () => {
  const webauthn = new WebAuthn({
    rpId: "localhost",
    origin: "http://localhost",
  });
  const server = await startTestServer({ webauthn });
  try {
    const optionsResponse = await apiRequest(
      server,
      "/api/passkeys/register/options",
      {
        method: "POST",
        body: { purpose: "bootstrap", deviceLabel: "Device" },
      },
    );
    const options = await optionsResponse.json();
    assert.equal(optionsResponse.status, 200);
    assert.equal(webauthn.challenges.size, 1);

    const finish = await apiRequest(
      server,
      "/api/passkeys/register/finish",
      {
        method: "POST",
        body: {
          flow: options.flow,
          credential: {
            id: "malformed",
            response: { clientDataJSON: base64url("not JSON") },
          },
        },
      },
    );
    assert.equal(finish.status, 401);
    assert.equal(server.flows.size, 0);
    assert.equal(webauthn.challenges.size, 0);
  } finally {
    await server.close();
  }
});

test("auth cookies are Secure only for a configured HTTPS origin", async () => {
  for (const origin of ["http://localhost", "https://kin.test"]) {
    const server = await startTestServer({ origin });
    try {
      const optionsResponse = await apiRequest(
        server,
        "/api/passkeys/register/options",
        {
          method: "POST",
          body: { purpose: "bootstrap", deviceLabel: "Test device" },
        },
      );
      const options = await optionsResponse.json();
      const finish = await apiRequest(server, "/api/passkeys/register/finish", {
        method: "POST",
        body: {
          flow: options.flow,
          credential: {
            id: `credential-${origin.startsWith("https") ? "secure" : "local"}`,
            flow: options.flow,
          },
        },
      });
      assert.equal(finish.status, 201);
      const cookies = finish.headers.getSetCookie();
      const secure = origin.startsWith("https:");
      for (const name of ["kin_session=", "kin_device="]) {
        const header = cookies.find((value) => value.startsWith(name));
        assert.ok(header);
        assert.equal(header.includes("; Secure"), secure);
      }
      const body = await finish.json();
      assert.equal("sessionToken" in body, false);
      assert.equal("deviceToken" in body, false);
    } finally {
      await server.close();
    }
  }
});

test("HTTP member removal requires fresh action-bound passkey proof", async () => {
  let now = 3_000_000;
  const service = new PairingService({
    now: () => now,
    secret: Buffer.alloc(32, 11),
  });
  const adult = service.bootstrap({
    credential: credential("a"),
    deviceLabel: "A",
  });
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  const approved = service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  const joined = service.activateClaim(claim.claimToken);
  const server = await startTestServer({ service, now: () => now });
  const sessionCookie = `kin_session=${adult.sessionToken}`;
  const optionsPath = "/api/household/membership/remove/options";
  const finishRemoval = (flow, id) =>
    apiRequest(server, "/api/household/membership/remove/finish", {
      method: "POST",
      cookie: sessionCookie,
      body: { flow, credential: { id, flow } },
    });
  try {
    const sessionOnly = await apiRequest(server, "/api/household/membership", {
      method: "DELETE",
      cookie: sessionCookie,
      body: { memberId: joined.memberId },
    });
    assert.equal(sessionOnly.status, 401);

    const wrongMemberOptions = await apiRequest(server, optionsPath, {
      method: "POST",
      cookie: sessionCookie,
      body: { memberId: joined.memberId },
    });
    const wrongMemberFlow = await wrongMemberOptions.json();
    assert.deepEqual(wrongMemberFlow.publicKey.allowCredentials, [
      { id: "credential-a" },
    ]);
    assert.equal(
      (await finishRemoval(wrongMemberFlow.flow, "credential-b")).status,
      401,
    );

    const staleOptions = await apiRequest(server, optionsPath, {
      method: "POST",
      cookie: sessionCookie,
      body: { memberId: joined.memberId },
    });
    const staleFlow = await staleOptions.json();
    now += 120_001;
    assert.equal(
      (await finishRemoval(staleFlow.flow, "credential-a")).status,
      410,
    );

    const validOptions = await apiRequest(server, optionsPath, {
      method: "POST",
      cookie: sessionCookie,
      body: { memberId: joined.memberId },
    });
    const validFlow = await validOptions.json();
    assert.equal(
      server.flows.get(validFlow.flow).targetMemberId,
      joined.memberId,
    );
    assert.equal(
      (await finishRemoval(validFlow.flow, "credential-a")).status,
      200,
    );
    assert.equal(
      (await finishRemoval(validFlow.flow, "credential-a")).status,
      410,
    );
    assert.equal(service.members.get(joined.memberId).active, false);
    assert.ok(service.devices.get(joined.deviceId).revokedAt);
    assert.throws(
      () => service.authorize(joined.sessionToken),
      (error) => error.code === "authentication_required",
    );
    const revokedStatus = await apiRequest(server, "/api/status", {
      cookie: `kin_session=${joined.sessionToken}; kin_device=${joined.deviceToken}`,
    });
    assert.equal((await revokedStatus.json()).identity, null);
    assert.deepEqual(responseCookies(revokedStatus), [
      "kin_session=",
      "kin_device=",
    ]);
    assert.equal(approved.state, "Confirmed");
  } finally {
    await server.close();
  }
});

test("HTTP device revocation requires fresh Adult passkey proof and is target-bound", async () => {
  const service = new PairingService({ secret: Buffer.alloc(32, 21) });
  const adult = service.bootstrap({ credential: credential("revoke-adult"), deviceLabel: "Adult phone" });
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({ code: invitation.code, credential: credential("revoke-other"), deviceLabel: "Kitchen tablet" });
  service.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const other = service.activateClaim(claim.claimToken);
  const server = await startTestServer({ service });
  const cookie = `kin_session=${adult.sessionToken}`;
  try {
    const direct = await apiRequest(server, `/api/devices/${other.deviceId}`, { method: "DELETE", cookie, body: {} });
    assert.equal(direct.status, 401);
    assert.equal(service.devices.get(other.deviceId).revokedAt, null);

    const optionsPath = `/api/devices/${other.deviceId}/revocation/options`;
    const start = async () => apiRequest(server, optionsPath, { method: "POST", cookie, body: {} });
    const finish = (flow, id) => apiRequest(server, "/api/devices/revocation/finish", {
      method: "POST", cookie, body: { flow, credential: { id, flow } },
    });
    const wrong = await (await start()).json();
    assert.equal((await finish(wrong.flow, "revoke-other")).status, 401);
    assert.equal(service.devices.get(other.deviceId).revokedAt, null);
    const valid = await (await start()).json();
    assert.equal(service.devices.get(other.deviceId).revokedAt, null); // cancellation preserves access
    assert.equal((await finish(valid.flow, "credential-revoke-adult")).status, 200);
    assert.ok(service.devices.get(other.deviceId).revokedAt);
  } finally { await server.close(); }
});

for (const adultCount of [2, 4]) {
  test(`HTTP fresh-passkey self-leave preserves revocation and epoch semantics with ${adultCount} adults`, async () => {
    const { service, adult, advance } = setup();
    const add = (request, suffix, actor = adult) => {
      const claim = service.claimPairing({
        code: request.code,
        credential: credential(suffix),
        deviceLabel: suffix,
        rateKey: suffix,
      });
      service.approvePairing(actor.sessionToken, request.pairingId, claim.version);
      return service.activateClaim(claim.claimToken);
    };
    const departing = add(service.createPairing(adult.sessionToken), "departing");
    service.setHouseholdAdmin(adult.sessionToken, departing.memberId, true, adult.memberId);
    for (let index = 2; index < adultCount; index++)
      add(service.createPairing(adult.sessionToken), `adult-${index}`);
    const extraDevice = add(service.createDevicePairing(departing.sessionToken), "extra-device", departing);
    const extraSession = service.reauthenticate(departing.deviceToken, "credential-departing");
    const invitation = adultCount === 2
      ? service.createPairing(departing.sessionToken)
      : service.createDevicePairing(departing.sessionToken);
    service.claimPairing({
      code: invitation.code, credential: credential("pending"), deviceLabel: "Pending",
    });
    const server = await startTestServer({ service, now: () => service.now() });
    const cookie = `kin_session=${departing.sessionToken}; kin_device=${departing.deviceToken}`;
    const options = async (memberId = departing.memberId, sessionCookie = cookie) => {
      const response = await apiRequest(server, "/api/household/membership/remove/options", {
        method: "POST", cookie: sessionCookie, body: { memberId },
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const finish = (flow, assertion = { id: "credential-departing", flow }, sessionCookie = cookie) =>
      apiRequest(server, "/api/household/membership/remove/finish", {
        method: "POST", cookie: sessionCookie, body: { flow, credential: assertion },
      });
    const unchanged = () => {
      assert.equal(service.members.get(departing.memberId).active, true);
      assert.equal(service.devices.get(departing.deviceId).revokedAt, null);
      assert.equal(service.devices.get(extraDevice.deviceId).revokedAt, null);
      assert.equal(service.authorize(departing.sessionToken).member.id, departing.memberId);
      assert.equal(service.pairings.get(invitation.pairingId).state, "Claimed");
      assert.equal(server.syncService.status(adult.sessionToken).rotationPending, false);
    };
    try {
      server.syncService.enable(adult.sessionToken);
      const denied = await apiRequest(server, "/api/household/membership", {
        method: "DELETE", cookie, body: {},
      });
      assert.equal(denied.status, 401);
      assert.equal((await denied.json()).error, "fresh_auth_required");
      assert.deepEqual(responseCookies(denied), []);
      unchanged();

      const cancelled = await options();
      assert.equal(server.flows.get(cancelled.flow).targetMemberId, departing.memberId);
      unchanged(); // No finish request is made when the authenticator is cancelled.
      const bad = await options();
      assert.equal((await finish(bad.flow, { id: "credential-departing", flow: "wrong-challenge" })).status, 401);
      assert.equal((await finish(bad.flow)).status, 410);
      unchanged();
      const wrongMember = await options();
      assert.equal((await finish(wrongMember.flow, { id: "credential-a", flow: wrongMember.flow })).status, 401);
      unchanged();
      const wrongDevice = await options();
      assert.equal((await finish(wrongDevice.flow, undefined, `kin_session=${extraDevice.sessionToken}`)).status, 400);
      unchanged();
      const wrongAction = await options();
      server.flows.get(wrongAction.flow).purpose = "login";
      assert.equal((await finish(wrongAction.flow)).status, 400);
      unchanged();
      const expired = await options();
      advance(120_001);
      assert.equal((await finish(expired.flow)).status, 410);
      unchanged();

      const valid = await options();
      const removed = await finish(valid.flow);
      assert.equal(removed.status, 200);
      assert.deepEqual(await removed.json(), { memberId: departing.memberId, removed: true });
      assert.deepEqual(responseCookies(removed), ["kin_session=", "kin_device="]);
      assert.equal(service.members.get(departing.memberId).active, false);
      assert.equal(service.activeMemberCount(service.households.get(adult.householdId)), adultCount - 1);
      for (const deviceId of [departing.deviceId, extraDevice.deviceId]) {
        assert.ok(service.devices.get(deviceId).revokedAt);
        assert.ok(server.store.loadIdentity().devices.get(deviceId).revokedAt);
      }
      for (const token of [departing.sessionToken, extraDevice.sessionToken, extraSession.sessionToken]) {
        assert.throws(() => service.authorize(token), error => error.code === "authentication_required");
        for (const path of ["/api/sync/status", "/api/sync/events?cursor=&limit=1"])
          assert.equal((await apiRequest(server, path, { cookie: `kin_session=${token}` })).status, 401);
        assert.equal((await apiRequest(server, "/api/sync/events", {
          method: "POST", cookie: `kin_session=${token}`, body: { events: [] },
        })).status, 401);
      }
      assert.equal([...service.sessions.values()].some(session => session.memberId === departing.memberId), false);
      assert.equal(service.pairings.get(invitation.pairingId).state, "Revoked");
      assert.equal(server.store.loadIdentity().members.get(departing.memberId).active, false);
      assert.equal(server.syncService.status(adult.sessionToken).pendingEpoch, 2);
      assert.equal(server.store.loadSyncState(adult.householdId).rotationPending, true);
      assert.equal(server.store.validate(), true);

      if (adultCount === 2) {
        const last = await options(adult.memberId, `kin_session=${adult.sessionToken}`);
        const protectedResult = await finish(last.flow, { id: "credential-a", flow: last.flow }, `kin_session=${adult.sessionToken}`);
        assert.equal(protectedResult.status, 409);
        assert.equal((await protectedResult.json()).error, "last_adult");
        assert.equal(service.members.get(adult.memberId).active, true);
        assert.equal(service.devices.get(adult.deviceId).revokedAt, null);
        assert.equal(service.authorize(adult.sessionToken).member.id, adult.memberId);
      }
    } finally {
      await server.close();
    }
  });
}

test("HTTP self-leave rolls back durable revocation if access-change persistence fails", async () => {
  const { service, adult } = setup();
  const request = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({ code: request.code, credential: credential("b"), deviceLabel: "B" });
  service.approvePairing(adult.sessionToken, request.pairingId, claim.version);
  const departing = service.activateClaim(claim.claimToken);
  const server = await startTestServer({ service });
  try {
    server.syncService.enable(adult.sessionToken);
    const cookie = `kin_session=${departing.sessionToken}`;
    const started = await (await apiRequest(server, "/api/household/membership/remove/options", {
      method: "POST", cookie, body: { memberId: departing.memberId },
    })).json();
    server.store.db.exec(`CREATE TRIGGER fail_leave_rotation BEFORE UPDATE ON sync_households
      BEGIN SELECT RAISE(ABORT, 'injected rotation persistence failure'); END`);
    const response = await apiRequest(server, "/api/household/membership/remove/finish", {
      method: "POST", cookie,
      body: { flow: started.flow, credential: { id: "credential-b", flow: started.flow } },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(responseCookies(response), []);
    assert.equal(server.store.failed, true);
    assert.equal(server.store.db.prepare("SELECT active FROM members WHERE id = ?").get(departing.memberId).active, 1);
    assert.equal(server.store.db.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(departing.deviceId).revoked_at, null);
    assert.equal(server.store.db.prepare("SELECT rotation_pending FROM sync_households WHERE household_id = ?").get(adult.householdId).rotation_pending, 0);
    assert.equal((await apiRequest(server, "/api/sync/status", { cookie })).status, 503);
  } finally {
    await server.close();
  }
});

for (const kind of ["limited", "temporary"]) {
  test(`HTTP ${kind} self-leave requires a fresh passkey and revokes its authority`, async () => {
    const { service, adult } = setup();
    const expiresAt = Math.max(service.now(), Date.now()) + 60_000;
    const invitation = service.createPairing(adult.sessionToken, {
      kind,
      ...(kind === "temporary" ? { expiresAt } : {}),
    });
    const claim = service.claimPairing({
      code: invitation.code,
      credential: credential(`${kind}-member`),
      deviceLabel: `${kind} device`,
    });
    service.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
    const member = service.activateClaim(claim.claimToken);
    const extraDevice = {
      id: `extra-device-${kind}`,
      memberId: member.memberId,
      householdId: member.householdId,
      label: `${kind} extra device`,
      trustedAt: service.now(),
      revokedAt: null,
      tokenHash: null,
    };
    service.devices.set(extraDevice.id, extraDevice);
    service.issueDeviceToken(extraDevice);
    const extraSession = service.issueSession(member.memberId, extraDevice.id);
    const server = await startTestServer({ service, now: () => service.now() });
    const cookie = `kin_session=${member.sessionToken}; kin_device=${member.deviceToken}`;
    const optionsPath = "/api/household/membership/remove/options";
    const finishPath = "/api/household/membership/remove/finish";
    try {
      server.syncService.enable(adult.sessionToken);
      const sessionOnly = await apiRequest(server, "/api/household/membership", {
        method: "DELETE", cookie, body: { memberId: member.memberId },
      });
      assert.equal(sessionOnly.status, 401);
      assert.equal((await sessionOnly.json()).error, "fresh_auth_required");

      const otherMember = await apiRequest(server, optionsPath, {
        method: "POST", cookie, body: { memberId: adult.memberId },
      });
      assert.equal(otherMember.status, 403);
      assert.equal((await otherMember.json()).error, "adult_required");

      const started = await apiRequest(server, optionsPath, {
        method: "POST", cookie, body: { memberId: member.memberId },
      });
      assert.equal(started.status, 200);
      const { flow } = await started.json();
      assert.equal(server.flows.get(flow).targetMemberId, member.memberId);

      const invalid = await apiRequest(server, finishPath, {
        method: "POST", cookie, body: { flow, credential: { id: `credential-${kind}-member`, flow: "wrong" } },
      });
      assert.equal(invalid.status, 401);
      assert.equal(service.members.get(member.memberId).active, true);
      assert.equal(service.devices.get(member.deviceId).revokedAt, null);
      assert.equal(service.devices.get(extraDevice.id).revokedAt, null);
      assert.equal(service.authorize(member.sessionToken).member.id, member.memberId);
      assert.equal(service.authorize(extraSession.sessionToken).member.id, member.memberId);

      const valid = await apiRequest(server, optionsPath, {
        method: "POST", cookie, body: { memberId: member.memberId },
      });
      const validFlow = await valid.json();
      const removed = await apiRequest(server, finishPath, {
        method: "POST", cookie,
        body: { flow: validFlow.flow, credential: { id: `credential-${kind}-member`, flow: validFlow.flow } },
      });
      assert.equal(removed.status, 200);
      assert.deepEqual(responseCookies(removed), ["kin_session=", "kin_device="]);
      assert.equal(service.members.get(member.memberId).active, false);
      if (kind === "temporary") assert.equal(service.members.get(member.memberId).expiresAt, expiresAt);
      for (const deviceId of [member.deviceId, extraDevice.id])
        assert.ok(service.devices.get(deviceId).revokedAt);
      for (const token of [member.sessionToken, extraSession.sessionToken]) {
        assert.throws(() => service.authorize(token), error => error.code === "authentication_required");
        assert.equal((await apiRequest(server, "/api/sync/events?cursor=&limit=1", { cookie: `kin_session=${token}` })).status, 401);
      }
      assert.equal([...service.sessions.values()].some(session => session.memberId === member.memberId), false);
      assert.equal(server.syncService.status(adult.sessionToken).pendingEpoch, 2);
      assert.equal(server.store.loadSyncState(adult.householdId).rotationPending, true);
    } finally {
      await server.close();
    }
  });
}

test("HTTP pairing approval binds the assertion credential to the signed-in adult", async () => {
  const { service, adult } = setup();
  const other = service.bootstrap({
    credential: credential("other-adult"),
    deviceLabel: "Other household phone",
  });
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("joining"),
    deviceLabel: "Joining phone",
  });
  const server = await startTestServer({ service });
  const path = `/api/pairings/${invitation.pairingId}/approve`;
  const cookie = `kin_session=${adult.sessionToken}`;
  const options = async () => {
    const response = await apiRequest(server, `${path}/options`, {
      method: "POST",
      cookie,
      body: { expectedVersion: claim.version },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const finish = (flow, id) =>
    apiRequest(server, `${path}/finish`, {
      method: "POST",
      cookie,
      body: { flow, credential: { id, flow } },
    });
  try {
    for (const id of ["credential-other-adult", "unknown-credential"]) {
      const attempt = await options();
      const response = await finish(attempt.flow, id);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, "passkey_member_mismatch");
      assert.equal(service.households.get(adult.householdId).members.size, 1);
    }

    const valid = await options();
    assert.equal((await finish(valid.flow, "credential-a")).status, 200);
    assert.equal(service.households.get(adult.householdId).members.size, 2);
    assert.equal((await finish(valid.flow, "credential-a")).status, 410);
    assert.equal(
      service.credentials.get("credential-other-adult").memberId,
      other.memberId,
    );
  } finally {
    await server.close();
  }
});

test("HTTP same-member device pairing claims, approves, and activates without adding an adult", async () => {
  const { service, adult } = setup();
  const inviterKeys = await syncDeviceKeyPair();
  service.registerSyncPublicKeys(adult.sessionToken, inviterKeys.publicKeys);
  const server = await startTestServer({ service });
  const adultCookie = `kin_session=${adult.sessionToken}`;
  try {
    const invitationResponse = await apiRequest(
      server,
      "/api/devices/pairings",
      { method: "POST", cookie: adultCookie, body: {} },
    );
    assert.equal(invitationResponse.status, 201);
    const invitation = await invitationResponse.json();
    assert.equal(invitation.purpose, "device");

    const registrationOptions = await apiRequest(
      server,
      "/api/passkeys/register/options",
      {
        method: "POST",
        body: {
          purpose: "claim",
          code: invitation.code,
          deviceLabel: "Second device",
        },
      },
    );
    const registration = await registrationOptions.json();
    assert.equal(registrationOptions.status, 200);
    assert.equal(server.flows.get(registration.flow).purpose, "device-claim");
    const claimantKeys = await syncDeviceKeyPair();
    const claimResponse = await apiRequest(
      server,
      "/api/passkeys/register/finish",
      {
        method: "POST",
        body: {
          flow: registration.flow,
          credential: { id: "credential-device-two", flow: registration.flow },
          syncPublicKeys: claimantKeys.publicKeys,
        },
      },
    );
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    const claimCookie = cookieValue(
      responseCookies(claimResponse),
      "kin_claim",
    );
    assert.equal(claim.purpose, "device");
    const pendingPairing = service.pairings.get(invitation.pairingId);
    const deviceCertificate = await createDeviceAuthorizationCertificate({
      householdId: adult.householdId,
      memberId: pendingPairing.claimant.memberId,
      deviceId: pendingPairing.claimant.deviceId,
      issuerDeviceId: adult.deviceId,
      issuerFingerprint: await deviceKeyFingerprint(inviterKeys.publicKeys),
      publicKeys: claimantKeys.publicKeys,
      signingKey: inviterKeys.keys.signingPrivateKey,
    });

    const approvalOptionsResponse = await apiRequest(
      server,
      `/api/pairings/${invitation.pairingId}/approve/options`,
      {
        method: "POST",
        cookie: adultCookie,
        body: { expectedVersion: claim.version },
      },
    );
    const approval = await approvalOptionsResponse.json();
    const approved = await apiRequest(
      server,
      `/api/pairings/${invitation.pairingId}/approve/finish`,
      {
        method: "POST",
        cookie: adultCookie,
        body: {
          flow: approval.flow,
          credential: { id: "credential-a", flow: approval.flow },
          deviceCertificate,
        },
      },
    );
    assert.equal(approved.status, 200);
    assert.equal(service.households.get(adult.householdId).members.size, 1);
    assert.equal(service.devices.size, 2);

    const activationOptions = await apiRequest(
      server,
      "/api/claim/activate/options",
      { method: "POST", cookie: `kin_claim=${claimCookie}`, body: {} },
    );
    const activation = await activationOptions.json();
    const activated = await apiRequest(server, "/api/claim/activate/finish", {
      method: "POST",
      cookie: `kin_claim=${claimCookie}`,
      body: {
        flow: activation.flow,
        credential: { id: "credential-device-two", flow: activation.flow },
      },
    });
    assert.equal(activated.status, 200);
    const cookies = responseCookies(activated);
    const status = await apiRequest(server, "/api/status", {
      cookie: cookies.join("; "),
    });
    const identity = (await status.json()).identity;
    assert.equal(identity.memberId, adult.memberId);
    assert.notEqual(identity.deviceId, adult.deviceId);
    const directory = await apiRequest(server, "/api/sync/devices", {
      cookie: cookies.join("; "),
    });
    const directoryBody = await directory.json();
    const devices = directoryBody.devices;
    assert.deepEqual(directoryBody.members, [{
      memberId: adult.memberId,
      memberKind: "adult",
      memberActive: true,
      memberStatus: "active",
    }]);
    assert.equal(
      devices.find((device) => device.deviceId === adult.deviceId).certificate,
      null,
    );
    assert.equal(
      devices.find((device) => device.deviceId === identity.deviceId)
        .certificate.issuerDeviceId,
      adult.deviceId,
    );
  } finally {
    await server.close();
  }
});

test("same-member device pairing adds a trusted device without a second adult", () => {
  const { service, adult } = setup();
  const invitation = service.createDevicePairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("credential-a-device-two"),
    deviceLabel: "A's second device",
  });
  assert.equal(claim.purpose, "device");
  const pairing = service.pairings.get(invitation.pairingId);
  assert.equal(pairing.memberId, adult.memberId);
  assert.equal(pairing.confirmedDeviceId, undefined);
  const approved = service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  assert.equal(approved.state, "Confirmed");
  assert.equal(
    service.activeMemberCount(service.households.get(adult.householdId)),
    1,
  );
  assert.equal(service.members.get(adult.memberId).credentials.size, 2);
  const activated = service.activateClaim(claim.claimToken);
  assert.equal(activated.memberId, adult.memberId);
  assert.notEqual(activated.deviceId, adult.deviceId);
  assert.equal(
    service.authorize(activated.sessionToken).member.id,
    adult.memberId,
  );
  assert.equal(
    service.devices.get(activated.deviceId).memberId,
    adult.memberId,
  );
});

test("trusted-device enrollment stops at the household device bound", () => {
  const { service, adult, advance } = setup();
  for (let index = 1; index < 16; index += 1) {
    if (index > 1) advance(60_001);
    const invitation = service.createDevicePairing(adult.sessionToken);
    const claim = service.claimPairing({
      code: invitation.code,
      credential: credential(`device-${index}`),
      deviceLabel: `Device ${index}`,
    });
    service.approvePairing(
      adult.sessionToken,
      invitation.pairingId,
      claim.version,
    );
    service.activateClaim(claim.claimToken);
  }
  assert.equal(
    service.activeTrustedDeviceCount(service.households.get(adult.householdId)),
    16,
  );
  assert.throws(
    () => service.createDevicePairing(adult.sessionToken),
    (error) => error.code === "device_limit",
  );
});

test("expired WebAuthn challenges are pruned without evicting active ones", () => {
  let now = 10_000;
  const webauthn = new WebAuthn({
    rpId: "localhost",
    origin: "http://localhost",
    now: () => now,
    maxChallenges: 2,
  });
  const first = webauthn.challenge("authenticate", "one");
  now += CHALLENGE_TTL_MS / 2;
  const second = webauthn.challenge("authenticate", "two");
  assert.throws(
    () => webauthn.challenge("authenticate", "three"),
    (error) => error.code === "challenge_capacity",
  );
  assert.equal(webauthn.challenges.has(first), true);
  assert.equal(webauthn.challenges.has(second), true);
  now += CHALLENGE_TTL_MS / 2;
  const third = webauthn.challenge("authenticate", "three");
  assert.equal(webauthn.challenges.has(first), false);
  assert.equal(webauthn.challenges.has(second), true);
  assert.equal(webauthn.challenges.has(third), true);
});

test("anonymous WebAuthn capacity is bounded and discardFlow releases it", () => {
  const webauthn = new WebAuthn({
    rpId: "localhost",
    origin: "http://localhost",
    maxChallenges: 4,
    maxAnonymousChallenges: 1,
  });
  const anonymous = webauthn.challenge("register", "anonymous-one", {
    anonymous: true,
  });
  assert.throws(
    () =>
      webauthn.challenge("register", "anonymous-two", { anonymous: true }),
    (error) => error.code === "challenge_capacity",
  );

  const trusted = webauthn.challenge("authenticate", "trusted");
  assert.equal(webauthn.challenges.has(anonymous), true);
  assert.equal(webauthn.challenges.has(trusted), true);

  webauthn.discardFlow("anonymous-one");
  const replacement = webauthn.challenge("register", "anonymous-two", {
    anonymous: true,
  });
  assert.equal(webauthn.challenges.has(anonymous), false);
  assert.equal(webauthn.challenges.has(replacement), true);
});

test("malformed registration CBOR and COSE fail with controlled errors", () => {
  const malformedAttestations = [
    Buffer.alloc(0),
    Buffer.from([0xa1]),
    Buffer.from([0x58, 0x05, 0x01]),
    Buffer.from([0xc0]),
  ];
  const malformedCose = [
    new Map(),
    new Map([
      [1, 2],
      [3, -8],
    ]),
    new Map([
      [1, 2],
      [3, -7],
      [-1, 2],
      [-2, Buffer.alloc(32)],
      [-3, Buffer.alloc(32)],
    ]),
    new Map([
      [1, 3],
      [3, -257],
      [-1, Buffer.alloc(0)],
      [-2, Buffer.from([1])],
    ]),
    new Map([
      [1, 3],
      [3, -257],
      [-1, Buffer.from([1])],
      [-2, Buffer.alloc(0)],
    ]),
  ];
  for (const attestationObject of [
    ...malformedAttestations.map(base64url),
    ...malformedCose.map(
      (cose) => registrationAttestation(cose).attestationObject,
    ),
  ]) {
    const webauthn = new WebAuthn({
      rpId: "localhost",
      origin: "http://localhost",
    });
    const challenge = webauthn.challenge("register", "flow");
    const valid = registrationAttestation(new Map());
    assertVerificationError(() =>
      webauthn.verifyRegistration(
        {
          id: valid.id,
          response: {
            clientDataJSON: clientData(challenge, { type: "webauthn.create" }),
            attestationObject,
          },
        },
        "flow",
      ),
    );
  }
});

test("malformed authentication input never escapes as a runtime parser error", () => {
  const rpHash = createHash("sha256").update("localhost").digest();
  const validAuthData = Buffer.concat([
    rpHash,
    Buffer.from([0x05]),
    Buffer.alloc(4),
  ]);
  const cases = [
    { clientDataJSON: base64url("{"), authData: validAuthData },
    { client: { type: "wrong.type" }, authData: validAuthData },
    { client: { challenge: "wrong" }, authData: validAuthData },
    { client: { origin: "https://wrong.test" }, authData: validAuthData },
    { authData: Buffer.alloc(0) },
    { authData: Buffer.alloc(31) },
    { authData: rpHash },
    { authData: Buffer.concat([rpHash, Buffer.from([0x05])]) },
    { authData: Buffer.alloc(37) },
    { authData: Buffer.concat([rpHash, Buffer.from([0x01]), Buffer.alloc(4)]) },
    { authData: Buffer.concat([rpHash, Buffer.from([0x04]), Buffer.alloc(4)]) },
    { authData: validAuthData, signature: Buffer.alloc(0) },
    { authData: validAuthData, signature: Buffer.from([1, 2, 3]) },
  ];
  for (const item of cases) {
    const webauthn = new WebAuthn({
      rpId: "localhost",
      origin: "http://localhost",
    });
    const challenge = webauthn.challenge("authenticate", "flow");
    const encodedClient =
      item.clientDataJSON ?? clientData(challenge, item.client);
    assertVerificationError(() =>
      webauthn.verifyAuthentication(
        {
          id: "credential-a",
          response: {
            clientDataJSON: encodedClient,
            authenticatorData: base64url(item.authData),
            signature: base64url(item.signature ?? Buffer.from([1])),
          },
        },
        "flow",
        {
          id: "credential-a",
          algorithm: -7,
          publicKey: "not a public key",
          signCount: 0,
        },
      ),
    );
  }
});

test("expired sessions are pruned while active sessions remain", () => {
  const { service, adult, advance } = setup();
  const active = service.issueSession(adult.memberId, adult.deviceId);
  for (let index = 0; index < 64; index += 1)
    service.issueSession(adult.memberId, adult.deviceId);
  assert.equal(service.sessions.size, 66);
  advance(SESSION_TTL_MS);
  assert.throws(
    () => service.authorize(active.sessionToken),
    (error) => error.code === "authentication_required",
  );
  assert.equal(service.sessions.size, 0);
  const fresh = service.issueSession(adult.memberId, adult.deviceId);
  assert.equal(service.sessions.size, 1);
  assert.equal(service.authorize(fresh.sessionToken).member.id, adult.memberId);
});

test("pairing codes use only unbiased alphabet characters and remain unique", () => {
  const { service, adult } = setup();
  const codes = new Set();
  for (let index = 0; index < 512; index += 1) {
    const code = service.createPairing(adult.sessionToken).code;
    const normalized = code.replace("-", "");
    assert.equal(code.length, 9);
    assert.equal(normalized.length, 8);
    for (const character of normalized)
      assert.ok(PAIRING_CODE_ALPHABET.includes(character));
    codes.add(normalized);
  }
  assert.ok(codes.size > 480);
});

test("pairing requires claim and explicit approval, then becomes single use", () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  assert.equal(invitation.state, "Pending");
  const claim = service.claimPairing({
    code: invitation.code.toLowerCase().replace("-", " "),
    credential: credential("b"),
    deviceLabel: "B phone",
  });
  assert.equal(claim.state, "Claimed");
  const confirmed = service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  assert.equal(confirmed.state, "Confirmed");
  assert.equal(service.households.get(adult.householdId).members.size, 2);
  assert.equal(
    service.approvePairing(
      adult.sessionToken,
      invitation.pairingId,
      claim.version,
    ).state,
    "Confirmed",
  );
  assert.throws(
    () =>
      service.claimPairing({
        code: invitation.code,
        credential: credential("c"),
        deviceLabel: "C",
      }),
    (error) => error.code === "invalid_code" || error.code === "pairing_used",
  );
});

test("Adult invitation records the chosen kind and confirmation ignores claimant kind fields", () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken, { kind: "limited" });
  assert.equal(invitation.memberKind, "limited");
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("limited-member"),
    deviceLabel: "Tablet",
    kind: "adult",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  const confirmed = service.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  assert.equal(service.members.get(confirmed.confirmedMemberId).kind, "limited");
  assert.equal(service.members.get(confirmed.confirmedMemberId).expiresAt, undefined);
});

test("Limited and Temporary direct HTTP trust-management calls are denied", async () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const memberId = "c".repeat(32);
  const deviceId = "d".repeat(32);
  service.members.set(memberId, { id: memberId, householdId: adult.householdId, active: true, kind: "limited", credentials: new Set() });
  service.households.get(adult.householdId).members.add(memberId);
  service.devices.set(deviceId, { id: deviceId, householdId: adult.householdId, memberId, label: "Limited tablet", trustedAt: 1_000_000, revokedAt: null, tokenHash: null });
  const limited = service.issueSession(memberId, deviceId);
  const temporaryId = "e".repeat(32);
  const temporaryDeviceId = "f".repeat(32);
  service.members.set(temporaryId, { id: temporaryId, householdId: adult.householdId, active: true, kind: "temporary", expiresAt: 2_000_000, credentials: new Set() });
  service.households.get(adult.householdId).members.add(temporaryId);
  service.devices.set(temporaryDeviceId, { id: temporaryDeviceId, householdId: adult.householdId, memberId: temporaryId, label: "Temporary phone", trustedAt: 1_000_000, revokedAt: null, tokenHash: null });
  const temporary = service.issueSession(temporaryId, temporaryDeviceId);
  const server = await startTestServer({ service, now: () => 1_000_000 });
  try {
    for (const [kind, sessionToken, targetDeviceId] of [["limited", limited.sessionToken, deviceId], ["temporary", temporary.sessionToken, temporaryDeviceId]]) {
      const cookie = `kin_session=${sessionToken}`;
      const requests = [
        apiRequest(server, "/api/pairings", { method: "POST", cookie, body: { kind: "limited" } }),
        apiRequest(server, `/api/pairings/${invitation.pairingId}`, { cookie }),
        apiRequest(server, `/api/pairings/${invitation.pairingId}`, { method: "DELETE", cookie }),
        apiRequest(server, `/api/pairings/${invitation.pairingId}/approve/options`, { method: "POST", cookie, body: { expectedVersion: 1 } }),
        apiRequest(server, "/api/devices/pairings", { method: "POST", cookie, body: {} }),
        apiRequest(server, "/api/devices", { cookie }),
        apiRequest(server, `/api/devices/${targetDeviceId}/revocation/options`, { method: "POST", cookie, body: {} }),
        apiRequest(server, "/api/household/membership/remove/options", { method: "POST", cookie, body: { memberId: adult.memberId } }),
        apiRequest(server, "/api/household/recovery", { method: "POST", cookie, body: {} }),
        apiRequest(server, "/api/household/deletion/options", { method: "POST", cookie, body: {} }),
        apiRequest(server, "/api/sync/epochs", { method: "POST", cookie, body: {} }),
        apiRequest(server, "/api/sync/provisioning/grants", { method: "POST", cookie, body: {} }),
      ];
      const responses = await Promise.all(requests);
      assert.deepEqual(responses.map((response) => response.status), Array(12).fill(403));
      const syncStatus = await apiRequest(server, "/api/sync/status", { cookie });
      assert.equal(syncStatus.status, 200);
      assert.equal((await syncStatus.json()).memberKind, kind);
      assert.equal((await apiRequest(server, "/api/sync/events", { cookie })).status, 200);
    }
  } finally {
    await server.close();
  }
});

test("Temporary participation works before expiry and expires into a server-side access change", async () => {
  let now = 3_000_000;
  const service = new PairingService({ now: () => now, secret: Buffer.alloc(32, 11) });
  const adult = service.bootstrap({ credential: credential("expiry-adult"), deviceLabel: "Adult device" });
  const expiry = now + 10_000;
  const invitation = service.createPairing(adult.sessionToken, { kind: "temporary", expiresAt: expiry });
  const claim = service.claimPairing({ code: invitation.code, credential: credential("expiry-guest"), deviceLabel: "Guest device" });
  service.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const temporary = service.activateClaim(claim.claimToken);
  const server = await startTestServer({ service, now: () => now });
  try {
    await apiRequest(server, "/api/sync/enable", { method: "POST", cookie: `kin_session=${adult.sessionToken}`, body: {} });
    const status = await apiRequest(server, "/api/sync/status", { cookie: `kin_session=${temporary.sessionToken}` });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).memberKind, "temporary");
    assert.equal((await apiRequest(server, "/api/sync/events", { cookie: `kin_session=${temporary.sessionToken}` })).status, 200);

    now = expiry;
    assert.notEqual((await apiRequest(server, "/api/sync/events", { cookie: `kin_session=${temporary.sessionToken}` })).status, 200);
    const member = service.members.get(temporary.memberId);
    assert.equal(member.active, false);
    assert.equal(service.devices.get(temporary.deviceId).revokedAt, expiry);
    const adultStatus = await apiRequest(server, "/api/sync/status", { cookie: `kin_session=${adult.sessionToken}` });
    assert.equal((await adultStatus.json()).rotationPending, true);
    assert.equal((await apiRequest(server, "/api/sync/events", { method: "POST", cookie: `kin_session=${adult.sessionToken}`, body: { events: [] } })).status, 409);
    assert.equal((await apiRequest(server, "/api/sync/provisioning/grants", {
      method: "POST",
      cookie: `kin_session=${adult.sessionToken}`,
      body: { recipientDeviceId: temporary.deviceId, keyEpoch: 2, requestId: "a".repeat(32) },
    })).status, 409);
  } finally {
    await server.close();
  }
});

test("Adult can revoke Temporary access early through the existing passkey removal ceremony", async () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken, { kind: "temporary", expiresAt: 2_000_000 });
  const claim = service.claimPairing({ code: invitation.code, credential: credential("early-guest"), deviceLabel: "Guest device" });
  service.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const temporary = service.activateClaim(claim.claimToken);
  const server = await startTestServer({ service, now: () => 1_000_000 });
  const cookie = `kin_session=${adult.sessionToken}`;
  try {
    const options = await apiRequest(server, "/api/household/membership/remove/options", { method: "POST", cookie, body: { memberId: temporary.memberId } });
    const flow = await options.json();
    const result = await apiRequest(server, "/api/household/membership/remove/finish", {
      method: "POST",
      cookie,
      body: { flow: flow.flow, credential: { id: "credential-a", flow: flow.flow } },
    });
    assert.equal(result.status, 200);
    assert.equal(service.members.get(temporary.memberId).active, false);
    assert.ok(service.devices.get(temporary.deviceId).revokedAt);
    assert.equal(server.syncService.status(adult.sessionToken).rotationPending, true);
  } finally {
    await server.close();
  }
});

test("Temporary invitation requires and persists a server-held future expiry", () => {
  const { service, adult } = setup();
  for (const expiresAt of [undefined, null, NaN, Infinity, "later", 999_999])
    assert.throws(() => service.createPairing(adult.sessionToken, { kind: "temporary", expiresAt }), (error) => error.code === "temporary_expiry_required");
  const expiry = 2_000_000;
  const invitation = service.createPairing(adult.sessionToken, { kind: "temporary", expiresAt: expiry });
  const claim = service.claimPairing({ code: invitation.code, credential: credential("temporary-member"), deviceLabel: "Guest phone", kind: "adult", expiresAt: Number.MAX_SAFE_INTEGER });
  const confirmed = service.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const member = service.members.get(confirmed.confirmedMemberId);
  assert.equal(member.kind, "temporary");
  assert.equal(member.expiresAt, expiry);
  assert.equal(canManageTrust(member), false);
});

test("member limits are bounded by type and Temporary expiry reconciliation is deterministic", () => {
  const { service, adult } = setup();
  for (let index = 0; index < 8; index += 1) {
    const memberId = `${index + 1}`.padStart(32, "0");
    service.members.set(memberId, { id: memberId, householdId: adult.householdId, active: true, kind: "limited", credentials: new Set() });
    service.households.get(adult.householdId).members.add(memberId);
  }
  assert.throws(() => service.createPairing(adult.sessionToken, { kind: "limited" }), (error) => error.code === "household_full");
  const temporaryId = "e".repeat(32);
  const deviceId = "f".repeat(32);
  const household = service.households.get(adult.householdId);
  service.members.set(temporaryId, { id: temporaryId, householdId: adult.householdId, active: true, kind: "temporary", expiresAt: 1_000_000, credentials: new Set() });
  household.members.add(temporaryId);
  service.devices.set(deviceId, { id: deviceId, householdId: adult.householdId, memberId: temporaryId, label: "Guest device", trustedAt: 1_000_000, revokedAt: null, tokenHash: null });
  const originalVersion = household.version;
  assert.deepEqual(service.expireTemporaryMemberships(), [{ householdId: adult.householdId, memberId: temporaryId, deviceIds: [deviceId] }]);
  assert.equal(service.members.get(temporaryId).active, false);
  assert.equal(service.devices.get(deviceId).revokedAt, 1_000_000);
  assert.equal(household.version, originalVersion + 1);
  assert.deepEqual(service.expireTemporaryMemberships(), []);
  assert.equal(household.version, originalVersion + 1);
});

test("expiry and revocation are terminal and create no membership", () => {
  const { service, adult, advance } = setup();
  const expired = service.createPairing(adult.sessionToken);
  advance(10 * 60_000 + 1);
  assert.throws(
    () =>
      service.claimPairing({
        code: expired.code,
        credential: credential("b"),
        deviceLabel: "B",
      }),
    (error) => error.code === "pairing_expired",
  );
  const fresh = service.createPairing(adult.sessionToken);
  service.revokePairing(adult.sessionToken, fresh.pairingId);
  assert.throws(
    () =>
      service.claimPairing({
        code: fresh.code,
        credential: credential("c"),
        deviceLabel: "C",
      }),
    (error) =>
      error.code === "invalid_code" || error.code === "pairing_revoked",
  );
  assert.equal(service.households.get(adult.householdId).members.size, 1);
});

test("pairing preflight validates codes without claiming or exposing household data", () => {
  const { service, adult, advance } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  assert.deepEqual(
    service.validatePairingCode(invitation.code, { rateKey: "preflight" }),
    { valid: true, purpose: "adult" },
  );
  assert.equal(service.pairings.get(invitation.pairingId).state, "Pending");
  assert.equal(service.pairings.get(invitation.pairingId).attempts, 0);
  assert.equal(service.pairings.get(invitation.pairingId).claimant, null);
  assert.throws(
    () => service.validatePairingCode("NOT-A-CODE", { rateKey: "preflight" }),
    (error) => error.code === "invalid_code",
  );
  advance(PAIRING_TTL_MS);
  assert.throws(
    () =>
      service.validatePairingCode(invitation.code, { rateKey: "preflight" }),
    (error) => error.code === "pairing_expired",
  );
  const next = service.createPairing(adult.sessionToken);
  service.revokePairing(adult.sessionToken, next.pairingId);
  assert.throws(
    () => service.validatePairingCode(next.code, { rateKey: "preflight" }),
    (error) => error.code === "invalid_code",
  );
});

test("duplicate claims, stale approval, full households, and revoked devices fail closed", () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  assert.throws(
    () =>
      service.claimPairing({
        code: invitation.code,
        credential: credential("c"),
        deviceLabel: "C",
      }),
    (error) => error.code === "pairing_claimed",
  );
  assert.throws(
    () =>
      service.approvePairing(
        adult.sessionToken,
        invitation.pairingId,
        invitation.version,
      ),
    (error) => error.code === "stale_pairing",
  );
  const confirmed = service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  const joined = service.pairingForClaim(claim.claimToken);
  assert.equal(joined.state, "Confirmed");
  const activated = service.activateClaim(claim.claimToken);
  assert.equal(service.listDevices(adult.sessionToken).length, 2);
  service.revokeDevice(
    adult.sessionToken,
    confirmed.pairingId === "never" ? "" : activated.deviceId,
    adult.memberId,
  );
  assert.throws(
    () => service.authorize(activated.sessionToken),
    (error) => error.code === "authentication_required",
  );
  const thirdInvite = service.createPairing(adult.sessionToken);
  const thirdClaim = service.claimPairing({ code: thirdInvite.code, credential: credential("c"), deviceLabel: "C" });
  service.approvePairing(adult.sessionToken, thirdInvite.pairingId, thirdClaim.version);
  const third = service.activateClaim(thirdClaim.claimToken);
  assert.throws(() => service.createPairing(third.sessionToken), (error) => error.code === "household_admin_required");
  const fourthInvite = service.createPairing(adult.sessionToken);
  const fourthClaim = service.claimPairing({ code: fourthInvite.code, credential: credential("d"), deviceLabel: "D" });
  service.approvePairing(adult.sessionToken, fourthInvite.pairingId, fourthClaim.version);
  service.activateClaim(fourthClaim.claimToken);
  assert.equal(service.activeMemberCount(service.households.get(adult.householdId)), 4);
  assert.throws(() => service.createPairing(adult.sessionToken), (error) => error.code === "household_full");
});

test("approval does not create a joining session until passkey activation", () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  assert.equal(
    service.pairingForClaim(claim.claimToken).sessionToken,
    undefined,
  );
  assert.equal(service.claimCredential(claim.claimToken).id, "credential-b");
  const activated = service.activateClaim(claim.claimToken);
  assert.equal(
    service.authorize(activated.sessionToken).member.id,
    activated.memberId,
  );
  assert.throws(
    () => service.activateClaim(claim.claimToken),
    (error) => error.code === "claim_not_confirmed",
  );
});

test("approval versus revocation resolves once without partial membership", () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  service.revokePairing(adult.sessionToken, invitation.pairingId);
  assert.throws(
    () =>
      service.approvePairing(
        adult.sessionToken,
        invitation.pairingId,
        claim.version,
      ),
    (error) =>
      error instanceof PairingError && error.code === "pairing_revoked",
  );
  assert.equal(service.households.get(adult.householdId).members.size, 1);
});

test("rate limits repeated invalid guesses without recording secrets", () => {
  const { service } = setup();
  for (let index = 0; index < 12; index += 1)
    assert.throws(
      () =>
        service.claimPairing({
          code: `BAD-${index}`,
          credential: credential(index),
          deviceLabel: "B",
          rateKey: "one",
        }),
      (error) => error.code === "invalid_code",
    );
  assert.throws(
    () =>
      service.claimPairing({
        code: "LAST",
        credential: credential("last"),
        deviceLabel: "B",
        rateKey: "one",
      }),
    (error) => error.code === "rate_limited",
  );
  assert.equal(JSON.stringify(service.events).includes("BAD"), false);
});

test("expired rate buckets are pruned while active buckets remain bounded", () => {
  let now = 5_000_000;
  const service = new PairingService({
    now: () => now,
    secret: Buffer.alloc(32, 17),
    maxRateBuckets: 2,
  });
  const attempt = (rateKey) =>
    assert.throws(
      () => service.validatePairingCode("BAD", { rateKey }),
      (error) => error.code === "invalid_code",
    );
  attempt("first");
  now += RATE_WINDOW_MS / 2;
  attempt("second");
  assert.throws(
    () => service.validatePairingCode("BAD", { rateKey: "overflow" }),
    (error) => error.code === "rate_limited",
  );
  assert.equal(service.rateBuckets.size, 2);
  now += RATE_WINDOW_MS / 2;
  attempt("third");
  assert.equal(service.rateBuckets.has("first"), false);
  assert.equal(service.rateBuckets.has("second"), true);
  assert.equal(service.rateBuckets.has("third"), true);
  assert.equal(service.rateBuckets.size, 2);
});

test("new invitations revoke older live sessions and approval uses server time", () => {
  const { service, adult, advance } = setup();
  const first = service.createPairing(adult.sessionToken);
  const second = service.createPairing(adult.sessionToken);
  assert.equal(
    service.pairingForAdult(adult.sessionToken, first.pairingId).state,
    "Revoked",
  );
  const claim = service.claimPairing({
    code: second.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  advance(CLAIM_TTL_MS + 1);
  assert.throws(
    () =>
      service.approvePairing(
        adult.sessionToken,
        second.pairingId,
        claim.version,
      ),
    (error) => error.code === "pairing_expired",
  );
  assert.equal(service.households.get(adult.householdId).members.size, 1);
});

test("a late claim receives its own full approval window", () => {
  const { service, adult, advance } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  advance(PAIRING_TTL_MS - 500);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  assert.equal(
    claim.expiresAt,
    1_000_000 + PAIRING_TTL_MS - 500 + CLAIM_TTL_MS,
  );
  advance(CLAIM_TTL_MS - 1);
  assert.equal(
    service.approvePairing(
      adult.sessionToken,
      invitation.pairingId,
      claim.version,
    ).state,
    "Confirmed",
  );
});

test("approval after the claim approval window expires is rejected", () => {
  const { service, adult, advance } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  advance(CLAIM_TTL_MS);
  assert.throws(
    () =>
      service.approvePairing(
        adult.sessionToken,
        invitation.pairingId,
        claim.version,
      ),
    (error) => error.code === "pairing_expired",
  );
  assert.equal(service.households.get(adult.householdId).members.size, 1);
});

test("expired and revoked claim tokens return terminal state once, then clear", () => {
  const { service, adult, advance } = setup();
  const expired = service.createPairing(adult.sessionToken);
  const expiredClaim = service.claimPairing({
    code: expired.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  advance(CLAIM_TTL_MS);
  assert.equal(
    service.pairingForClaim(expiredClaim.claimToken).state,
    "Expired",
  );
  assert.throws(
    () => service.pairingForClaim(expiredClaim.claimToken),
    (error) => error.code === "claim_unavailable",
  );

  const revoked = service.createPairing(adult.sessionToken);
  const revokedClaim = service.claimPairing({
    code: revoked.code,
    credential: credential("c"),
    deviceLabel: "C",
  });
  service.revokePairing(adult.sessionToken, revoked.pairingId);
  assert.equal(
    service.pairingForClaim(revokedClaim.claimToken).state,
    "Revoked",
  );
  assert.throws(
    () => service.pairingForClaim(revokedClaim.claimToken),
    (error) => error.code === "claim_unavailable",
  );
});

test("logout invalidates only the session and preserves device trust", () => {
  const { service, adult } = setup();
  service.logout(adult.sessionToken);
  assert.throws(
    () => service.authorize(adult.sessionToken),
    (error) => error.code === "authentication_required",
  );
  assert.equal(service.devices.get(adult.deviceId).revokedAt, null);
  const restored = service.reauthenticate(adult.deviceToken, "credential-a");
  assert.notEqual(restored.sessionToken, adult.sessionToken);
  assert.equal(restored.memberId, adult.memberId);
  assert.equal(restored.deviceId, adult.deviceId);
  assert.equal(restored.householdId, adult.householdId);
  assert.equal(
    service.authorize(restored.sessionToken).member.id,
    adult.memberId,
  );
  assert.notEqual(restored.deviceToken, adult.deviceToken);
  assert.throws(
    () => service.reauthenticate(adult.deviceToken, "credential-a"),
    (error) => error.code === "device_not_trusted",
  );
});

test("device revocation eagerly invalidates all of its sessions and is idempotent", () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  const joined = service.activateClaim(claim.claimToken);
  const second = service.issueSession(joined.memberId, joined.deviceId);

  const firstResult = service.revokeDevice(adult.sessionToken, joined.deviceId, adult.memberId);
  assert.ok(firstResult.revokedAt);
  for (const sessionToken of [joined.sessionToken, second.sessionToken])
    assert.throws(
      () => service.authorize(sessionToken),
      (error) => error.code === "authentication_required",
    );
  assert.equal(
    [...service.sessions.values()].some(
      (session) => session.deviceId === joined.deviceId,
    ),
    false,
  );

  const eventCount = service.events.filter(
    (event) =>
      event.type === "device_revoked" && event.deviceId === joined.deviceId,
  ).length;
  assert.deepEqual(
    service.revokeDevice(adult.sessionToken, joined.deviceId, adult.memberId),
    firstResult,
  );
  assert.equal(
    service.events.filter(
      (event) =>
        event.type === "device_revoked" && event.deviceId === joined.deviceId,
    ).length,
    eventCount,
  );
});

test("confirmed claim capabilities expire and terminal pairing records are collectible", () => {
  const { service, adult, advance } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  assert.equal(service.claimTokens.size, 1);
  advance(CLAIM_TTL_MS);
  service.prunePairingCapabilities();
  assert.equal(service.claimTokens.size, 0);
  assert.throws(
    () => service.activateClaim(claim.claimToken),
    (error) => error.code === "claim_not_confirmed",
  );
  advance(TERMINAL_PAIRING_RETENTION_MS - CLAIM_TTL_MS);
  service.prunePairingCapabilities();
  assert.equal(service.pairings.has(invitation.pairingId), false);
});

test("reauthentication rejects unknown credentials, revoked devices, and removed members", () => {
  const { service, adult } = setup();
  assert.throws(
    () => service.reauthenticate(adult.deviceToken, "unknown-credential"),
    (error) => error.code === "invalid_passkey",
  );
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  const approved = service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  const joined = service.activateClaim(claim.claimToken);
  service.revokeDevice(adult.sessionToken, joined.deviceId, adult.memberId);
  assert.throws(
    () => service.reauthenticate(joined.deviceToken, "credential-b"),
    (error) => error.code === "device_not_trusted",
  );
  service.removeOtherAdult(adult.sessionToken, joined.memberId, adult.memberId);
  assert.throws(
    () => service.reauthenticate(joined.deviceToken, "credential-b"),
    (error) => error.code === "membership_removed",
  );
  assert.equal(service.households.get(adult.householdId).members.size, 2);
  assert.equal(approved.state, "Confirmed");
});

test("membership removal revokes every target device and active session", () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  const joined = service.activateClaim(claim.claimToken);
  assert.throws(
    () => service.removeOtherAdult(adult.sessionToken, joined.memberId),
    (error) => error.code === "fresh_auth_required",
  );
  assert.equal(service.devices.get(joined.deviceId).revokedAt, null);
  service.removeOtherAdult(adult.sessionToken, joined.memberId, adult.memberId);
  assert.throws(
    () => service.authorize(joined.sessionToken),
    (error) => error.code === "authentication_required",
  );
  assert.ok(service.devices.get(joined.deviceId).revokedAt);
  assert.equal(service.events.at(-1).type, "membership_removed");
});

test("a removed adult remains historical while a replacement joins", () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  const joined = service.activateClaim(claim.claimToken);

  service.removeOtherAdult(adult.sessionToken, joined.memberId, adult.memberId);
  const household = service.households.get(adult.householdId);
  assert.equal(household.members.has(joined.memberId), true);
  assert.equal(service.members.get(joined.memberId).active, false);
  assert.equal(service.activeMemberCount(household), 1);

  const replacementInvitation = service.createPairing(adult.sessionToken);
  const replacementClaim = service.claimPairing({
    code: replacementInvitation.code,
    credential: credential("c"),
    deviceLabel: "C",
  });
  service.approvePairing(
    adult.sessionToken,
    replacementInvitation.pairingId,
    replacementClaim.version,
  );
  service.activateClaim(replacementClaim.claimToken);

  assert.equal(household.members.size, 3);
  assert.equal(service.activeMemberCount(household), 2);
  assert.equal(service.members.get(joined.memberId).active, false);
});

test("an adult who leaves remains historical while a replacement joins", () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  const joined = service.activateClaim(claim.claimToken);

  service.leaveHousehold(joined.sessionToken, joined.memberId);
  const household = service.households.get(adult.householdId);
  assert.equal(household.members.has(joined.memberId), true);
  assert.equal(service.members.get(joined.memberId).active, false);
  assert.ok(service.devices.get(joined.deviceId).revokedAt);
  assert.equal(service.activeMemberCount(household), 1);

  const replacementInvitation = service.createPairing(adult.sessionToken);
  const replacementClaim = service.claimPairing({
    code: replacementInvitation.code,
    credential: credential("c-after-leave"),
    deviceLabel: "C",
  });
  service.approvePairing(
    adult.sessionToken,
    replacementInvitation.pairingId,
    replacementClaim.version,
  );
  service.activateClaim(replacementClaim.claimToken);
  assert.equal(service.activeMemberCount(household), 2);
  assert.equal(service.members.get(joined.memberId).active, false);
});

test("approval rejects a newly full household without partial mutation", () => {
  const { service, adult } = setup();
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("pending-third"),
    deviceLabel: "Pending third",
  });
  const household = service.households.get(adult.householdId);
  for (let index = 0; index < 3; index++) {
    const occupyingMemberId = `occupying-member-${index}`;
    household.members.add(occupyingMemberId);
    service.members.set(occupyingMemberId, {
      id: occupyingMemberId,
      householdId: household.id,
      active: true,
      credentials: new Set(),
    });
  }

  const before = {
    members: service.members.size,
    devices: service.devices.size,
    credentials: service.credentials.size,
    householdVersion: household.version,
    pairingVersion: service.pairings.get(invitation.pairingId).version,
    sessions: service.sessions.size,
  };
  assert.throws(
    () =>
      service.approvePairing(
        adult.sessionToken,
        invitation.pairingId,
        claim.version,
      ),
    (error) => error.code === "household_full",
  );
  assert.deepEqual(
    {
      members: service.members.size,
      devices: service.devices.size,
      credentials: service.credentials.size,
      householdVersion: household.version,
      pairingVersion: service.pairings.get(invitation.pairingId).version,
      sessions: service.sessions.size,
    },
    before,
  );
  assert.equal(service.pairings.get(invitation.pairingId).state, "Claimed");
  assert.equal(service.credentials.has("credential-pending-third"), false);
  assert.equal(service.activeMemberCount(household), 4);
});

test("the last adult cannot leave, while a joined adult can leave without removing the household", () => {
  const { service, adult } = setup();
  assert.throws(
    () => service.leaveHousehold(adult.sessionToken, adult.memberId),
    (error) => error.code === "last_adult",
  );
  const invitation = service.createPairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: invitation.code,
    credential: credential("b"),
    deviceLabel: "B",
  });
  service.approvePairing(
    adult.sessionToken,
    invitation.pairingId,
    claim.version,
  );
  const joined = service.activateClaim(claim.claimToken);
  assert.throws(
    () => service.leaveHousehold(joined.sessionToken),
    (error) => error.code === "fresh_auth_required",
  );
  assert.throws(
    () => service.leaveHousehold(joined.sessionToken, adult.memberId),
    (error) => error.code === "fresh_auth_required",
  );
  assert.equal(service.leaveHousehold(joined.sessionToken, joined.memberId).removed, true);
  assert.equal(service.authorize(adult.sessionToken).member.id, adult.memberId);
});

test("Temporary self-leave follows the injected service clock and expires closed", () => {
  let now = 1_000_000;
  const service = new PairingService({ now: () => now, secret: Buffer.alloc(32, 12) });
  const adult = service.bootstrap({ credential: credential("leave-clock-adult"), deviceLabel: "Adult device" });
  const expiry = now + 10_000;
  const invitation = service.createPairing(adult.sessionToken, { kind: "temporary", expiresAt: expiry });
  const claim = service.claimPairing({ code: invitation.code, credential: credential("leave-clock-guest"), deviceLabel: "Guest device" });
  service.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const temporary = service.activateClaim(claim.claimToken);

  // The host clock is far beyond expiry, but service authorization uses its injected clock.
  assert.equal(service.leaveHousehold(temporary.sessionToken, temporary.memberId).removed, true);
  assert.equal(service.members.get(temporary.memberId).active, false);
  assert.throws(() => service.authorize(temporary.sessionToken), (error) => error.code === "authentication_required");

  const second = service.createPairing(adult.sessionToken, { kind: "temporary", expiresAt: expiry + 20_000 });
  const secondClaim = service.claimPairing({ code: second.code, credential: credential("leave-clock-guest-2"), deviceLabel: "Guest device 2" });
  service.approvePairing(adult.sessionToken, second.pairingId, secondClaim.version);
  const unexpired = service.activateClaim(secondClaim.claimToken);
  now = expiry + 20_000;
  assert.throws(() => service.leaveHousehold(unexpired.sessionToken, unexpired.memberId), (error) => error.code === "membership_removed");
  assert.equal(service.members.get(unexpired.memberId).active, true);
  assert.throws(() => service.authorize(unexpired.sessionToken), (error) => error.code === "membership_removed");
});

test("removing an invitation author revokes that adult's pending admission", () => {
  const { service, adult } = setup();
  const initial = service.createPairing(adult.sessionToken);
  const initialClaim = service.claimPairing({ code: initial.code, credential: credential("member-b"), deviceLabel: "B" });
  service.approvePairing(adult.sessionToken, initial.pairingId, initialClaim.version);
  const memberB = service.activateClaim(initialClaim.claimToken);
  service.setHouseholdAdmin(adult.sessionToken, memberB.memberId, true, adult.memberId);
  const invitation = service.createPairing(memberB.sessionToken);
  const claim = service.claimPairing({ code: invitation.code, credential: credential("member-c"), deviceLabel: "C" });

  service.removeOtherAdult(adult.sessionToken, memberB.memberId, adult.memberId);

  assert.equal(service.pairings.get(invitation.pairingId).state, "Revoked");
  assert.throws(() => service.pairingForClaim(claim.claimToken), (error) => error.code === "claim_unavailable");
  assert.equal(service.activeMemberCount(service.households.get(adult.householdId)), 1);
});

test("household admins share one live admission slot and only the inviter approves", () => {
  const { service, adult } = setup();
  const initial = service.createPairing(adult.sessionToken);
  const initialClaim = service.claimPairing({ code: initial.code, credential: credential("member-b"), deviceLabel: "B" });
  service.approvePairing(adult.sessionToken, initial.pairingId, initialClaim.version);
  const memberB = service.activateClaim(initialClaim.claimToken);
  service.setHouseholdAdmin(adult.sessionToken, memberB.memberId, true, adult.memberId);

  const firstInvite = service.createPairing(adult.sessionToken);
  const secondInvite = service.createPairing(memberB.sessionToken);
  assert.equal(service.pairings.get(firstInvite.pairingId).state, "Revoked");
  const claim = service.claimPairing({ code: secondInvite.code, credential: credential("member-c"), deviceLabel: "C" });
  assert.throws(
    () => service.approvePairing(adult.sessionToken, secondInvite.pairingId, claim.version),
    (error) => error.code === "not_found",
  );
  service.approvePairing(memberB.sessionToken, secondInvite.pairingId, claim.version);
  assert.equal(service.activeMemberCount(service.households.get(adult.householdId)), 3);
});

const admit = (service, inviter, suffix, options) => {
  const invitation = service.createPairing(inviter.sessionToken, options);
  const claim = service.claimPairing({ code: invitation.code, credential: credential(suffix), deviceLabel: suffix, rateKey: suffix });
  service.approvePairing(inviter.sessionToken, invitation.pairingId, claim.version);
  return service.activateClaim(claim.claimToken);
};

test("the household founder is the first admin and the household view reports admin authority", () => {
  const { service, adult } = setup();
  const second = admit(service, adult, "second");
  const child = admit(service, adult, "child", { kind: "limited" });
  assert.equal(isHouseholdAdmin(service.members.get(adult.memberId)), true);
  assert.equal(isHouseholdAdmin(service.members.get(second.memberId)), false);
  const founderView = service.householdView(adult.sessionToken);
  assert.equal(founderView.adminRecorded, true);
  assert.equal(founderView.canManageMembers, true);
  assert.deepEqual(founderView.members.map(({ id, admin }) => [id, admin]), [
    [adult.memberId, true], [second.memberId, false], [child.memberId, false],
  ]);
  const secondView = service.householdView(second.sessionToken);
  assert.equal(secondView.adminRecorded, true);
  assert.equal(secondView.canManageMembers, false);
});

test("non-admin adults cannot manage membership, other members' devices, or household lifecycle", () => {
  const { service, adult } = setup();
  const second = admit(service, adult, "second");
  const child = admit(service, adult, "child", { kind: "limited" });
  const denied = (error) => error.code === "household_admin_required";
  assert.throws(() => service.createPairing(second.sessionToken), denied);
  assert.throws(() => service.createPairing(second.sessionToken, { kind: "limited" }), denied);
  assert.throws(() => service.removeOtherAdult(second.sessionToken, child.memberId, second.memberId), denied);
  assert.throws(() => service.deviceRevocationContext(second.sessionToken, adult.deviceId), denied);
  assert.throws(() => service.revokeDevice(second.sessionToken, adult.deviceId, second.memberId), denied);
  assert.throws(() => service.requestHouseholdDeletion(second.sessionToken, second.memberId), denied);
  assert.throws(() => service.setHouseholdAdmin(second.sessionToken, second.memberId, true, second.memberId), denied);
  assert.equal(isHouseholdAdmin(service.members.get(second.memberId)), false);
  assert.equal(service.members.get(child.memberId).active, true);
  assert.ok(!service.devices.get(adult.deviceId).revokedAt);

  // Everyday Adult authority over their own devices remains.
  assert.ok(service.createDevicePairing(second.sessionToken).code);
});

test("an admin can promote and demote adults but never children, guests, or the last admin", () => {
  const { service, adult } = setup();
  const second = admit(service, adult, "second");
  const child = admit(service, adult, "child", { kind: "limited" });
  const sitter = admit(service, adult, "sitter", { kind: "temporary", expiresAt: service.now() + 86_400_000 });

  assert.throws(() => service.setHouseholdAdmin(adult.sessionToken, second.memberId, true, second.memberId), (error) => error.code === "fresh_auth_required");
  assert.throws(() => service.setHouseholdAdmin(adult.sessionToken, second.memberId, "yes", adult.memberId), (error) => error.code === "household_admin_invalid");
  for (const target of [child, sitter])
    assert.throws(() => service.setHouseholdAdmin(adult.sessionToken, target.memberId, true, adult.memberId), (error) => error.code === "household_admin_adult_required");
  assert.throws(() => service.setHouseholdAdmin(adult.sessionToken, adult.memberId, false, adult.memberId), (error) => error.code === "last_household_admin");
  assert.throws(() => service.leaveHousehold(adult.sessionToken, adult.memberId), (error) => error.code === "last_household_admin");

  const version = service.households.get(adult.householdId).version;
  assert.deepEqual(service.setHouseholdAdmin(adult.sessionToken, second.memberId, true, adult.memberId), { memberId: second.memberId, admin: true, changed: true });
  assert.deepEqual(service.setHouseholdAdmin(adult.sessionToken, second.memberId, true, adult.memberId), { memberId: second.memberId, admin: true, changed: false });
  assert.equal(service.households.get(adult.householdId).version, version + 1);
  assert.ok(service.events.some((event) => event.type === "household_admin_granted" && event.memberId === second.memberId && event.actorId === adult.memberId));
  assert.ok(admit(service, second, "invited-by-second"));

  // With two admins either may step down, but not both.
  service.setHouseholdAdmin(second.sessionToken, adult.memberId, false, second.memberId);
  assert.equal(isHouseholdAdmin(service.members.get(adult.memberId)), false);
  assert.throws(() => service.createPairing(adult.sessionToken), (error) => error.code === "household_admin_required");
  assert.throws(() => service.setHouseholdAdmin(second.sessionToken, second.memberId, false, second.memberId), (error) => error.code === "last_household_admin");
  assert.ok(service.events.some((event) => event.type === "household_admin_revoked" && event.memberId === adult.memberId));
});

test("demoting an admin revokes that admin's pending admissions", () => {
  const { service, adult } = setup();
  const second = admit(service, adult, "second");
  service.setHouseholdAdmin(adult.sessionToken, second.memberId, true, adult.memberId);
  const invitation = service.createPairing(second.sessionToken, { kind: "limited" });
  const claim = service.claimPairing({ code: invitation.code, credential: credential("pending-child"), deviceLabel: "Child" });
  service.setHouseholdAdmin(adult.sessionToken, second.memberId, false, adult.memberId);
  assert.equal(service.pairings.get(invitation.pairingId).state, "Revoked");
  assert.throws(() => service.pairingForClaim(claim.claimToken), (error) => error.code === "claim_unavailable");
  assert.throws(() => service.approvePairing(second.sessionToken, invitation.pairingId, claim.version), (error) => error.code === "household_admin_required");
});

test("an admin cannot be removed while they are the only usable admin, and removing a second admin succeeds", () => {
  const { service, adult } = setup();
  const second = admit(service, adult, "second");
  service.setHouseholdAdmin(adult.sessionToken, second.memberId, true, adult.memberId);
  service.removeOtherAdult(adult.sessionToken, second.memberId, adult.memberId);
  assert.equal(service.members.get(second.memberId).active, false);
  assert.equal(isHouseholdAdmin(service.members.get(adult.memberId)), true);
});

test("recovering an admin requires an admin approver", () => {
  const { service, adult } = setup();
  const second = admit(service, adult, "second");
  assert.throws(() => service.createMemberRecoveryPairing(second.sessionToken, adult.memberId), (error) => error.code === "household_admin_required");
  assert.ok(service.createMemberRecoveryPairing(adult.sessionToken, second.memberId).code);
  service.setHouseholdAdmin(adult.sessionToken, second.memberId, true, adult.memberId);
  assert.ok(service.createMemberRecoveryPairing(second.sessionToken, adult.memberId).code);
});

test("legacy households without a recorded admin keep Adult management but cannot self-promote", () => {
  const { service, adult } = setup();
  const second = admit(service, adult, "second");
  delete service.members.get(adult.memberId).householdAdmin;
  service.households.get(adult.householdId).ownerMemberId = null;
  const view = service.householdView(second.sessionToken);
  assert.equal(view.adminRecorded, false);
  assert.equal(view.canManageMembers, true);
  assert.ok(admit(service, second, "legacy-invite"));
  assert.throws(() => service.setHouseholdAdmin(second.sessionToken, second.memberId, true, second.memberId), (error) => error.code === "household_admin_required");
});

test("HTTP household admin changes require a fresh passkey assertion from the acting admin", async () => {
  const { service, adult } = setup();
  const second = admit(service, adult, "second");
  const server = await startTestServer({ service, now: () => service.now() });
  const founderCookie = `kin_session=${adult.sessionToken}`;
  const secondCookie = `kin_session=${second.sessionToken}`;
  const options = (cookie, body) => apiRequest(server, "/api/household/admins/options", { method: "POST", cookie, body });
  const finish = (cookie, flow, id) => apiRequest(server, "/api/household/admins/finish", { method: "POST", cookie, body: { flow, credential: { id, flow } } });
  try {
    assert.equal((await options(founderCookie, { memberId: second.memberId, admin: "true" })).status, 400);
    const forbidden = await options(secondCookie, { memberId: second.memberId, admin: true });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error, "household_admin_required");

    const wrongPasskey = await (await options(founderCookie, { memberId: second.memberId, admin: true })).json();
    assert.equal((await finish(founderCookie, wrongPasskey.flow, "credential-second")).status, 401);
    assert.equal(isHouseholdAdmin(service.members.get(second.memberId)), false);

    const wrongSession = await (await options(founderCookie, { memberId: second.memberId, admin: true })).json();
    assert.equal((await finish(secondCookie, wrongSession.flow, "credential-second")).status, 400);
    assert.equal(isHouseholdAdmin(service.members.get(second.memberId)), false);

    const granted = await (await options(founderCookie, { memberId: second.memberId, admin: true })).json();
    const response = await finish(founderCookie, granted.flow, "credential-a");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { memberId: second.memberId, admin: true, changed: true });
    assert.equal(isHouseholdAdmin(service.members.get(second.memberId)), true);
    assert.equal((await finish(founderCookie, granted.flow, "credential-a")).status, 410);
  } finally {
    await server.close();
  }
});

const addOwnDevice = (service, member, suffix) => {
  const invitation = service.createDevicePairing(member.sessionToken);
  const claim = service.claimPairing({ code: invitation.code, credential: credential(suffix), deviceLabel: suffix, rateKey: suffix });
  service.approvePairing(member.sessionToken, invitation.pairingId, claim.version);
  return service.activateClaim(claim.claimToken);
};

const revocationSnapshot = (service, deviceId) => ({
  revokedAt: service.devices.get(deviceId).revokedAt ?? null,
  sessions: [...service.sessions.values()].filter((session) => session.deviceId === deviceId).length,
  events: service.events.length,
});

test("a sole admin may revoke a redundant device but never their final usable device", () => {
  const { service, adult } = setup();
  const second = addOwnDevice(service, adult, "admin-second-device");
  const partner = admit(service, adult, "partner");

  assert.equal(service.revokeDevice(adult.sessionToken, second.deviceId, adult.memberId).id, second.deviceId);
  assert.ok(service.devices.get(second.deviceId).revokedAt);

  // The remaining device is the acting device, and no other member may revoke it.
  for (const attempt of [
    () => service.deviceRevocationContext(adult.sessionToken, adult.deviceId),
    () => service.revokeDevice(adult.sessionToken, adult.deviceId, adult.memberId),
  ]) assert.throws(attempt, (error) => error.code === "current_device");
  for (const attempt of [
    () => service.deviceRevocationContext(partner.sessionToken, adult.deviceId),
    () => service.revokeDevice(partner.sessionToken, adult.deviceId, partner.memberId),
  ]) assert.throws(attempt, (error) => error.code === "household_admin_required");
  assert.ok(!service.devices.get(adult.deviceId).revokedAt);
  assert.equal(service.hasUsableAdminAccess(service.households.get(adult.householdId)), true);
});

test("an admin's final device may be revoked while another usable admin remains", () => {
  const { service, adult } = setup();
  const partner = admit(service, adult, "partner");
  service.setHouseholdAdmin(adult.sessionToken, partner.memberId, true, adult.memberId);
  service.deviceRevocationContext(adult.sessionToken, partner.deviceId);
  service.revokeDevice(adult.sessionToken, partner.deviceId, adult.memberId);
  assert.ok(service.devices.get(partner.deviceId).revokedAt);
  assert.equal(service.hasUsableAdminAccess(service.households.get(adult.householdId)), true);
});

test("revocation that would leave no usable admin fails closed without mutating state", () => {
  let now = 1_000_000;
  const store = new DurableStore(":memory:");
  try {
    const service = new PairingService({ now: () => now, secret: Buffer.alloc(32, 7), store });
    const adult = service.bootstrap({ credential: credential("a"), deviceLabel: "A phone" });
    const partner = admit(service, adult, "partner");
    service.setHouseholdAdmin(adult.sessionToken, partner.memberId, true, adult.memberId);
    const household = service.households.get(adult.householdId);
    // The acting admin keeps a session but no longer has a passkey, so the
    // admin flag alone does not make them usable.
    service.members.get(adult.memberId).credentials.clear();
    assert.equal(isHouseholdAdmin(service.members.get(adult.memberId)), true);

    const before = revocationSnapshot(service, partner.deviceId);
    const stored = () => store.db.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(partner.deviceId).revoked_at;
    assert.equal(stored(), null);
    for (const attempt of [
      () => service.deviceRevocationContext(adult.sessionToken, partner.deviceId),
      () => service.revokeDevice(adult.sessionToken, partner.deviceId, adult.memberId),
    ]) assert.throws(attempt, (error) => error.code === "last_household_admin" && error.status === 409);
    assert.deepEqual(revocationSnapshot(service, partner.deviceId), before);
    assert.equal(stored(), null);
    assert.equal(service.authorize(partner.sessionToken).member.id, partner.memberId);
    assert.equal(service.hasUsableAdminAccess(household), true);
  } finally {
    store.close();
  }
});

test("revoked devices do not count as usable admin access", () => {
  const { service, adult } = setup();
  const partner = admit(service, adult, "partner");
  service.setHouseholdAdmin(adult.sessionToken, partner.memberId, true, adult.memberId);
  const partnerSecond = addOwnDevice(service, partner, "partner-second-device");
  service.revokeDevice(partnerSecond.sessionToken, partner.deviceId, partner.memberId);
  service.members.get(adult.memberId).credentials.clear();
  const household = service.households.get(adult.householdId);
  assert.equal(service.hasUsableAdminAccess(household), true);
  assert.equal(service.hasUsableAdminAccess(household, [partnerSecond.deviceId]), false);
  assert.throws(
    () => service.revokeDevice(adult.sessionToken, partnerSecond.deviceId, adult.memberId),
    (error) => error.code === "last_household_admin",
  );
  assert.ok(!service.devices.get(partnerSecond.deviceId).revokedAt);
});

test("legacy households without a recorded admin keep Adult device management", () => {
  const { service, adult } = setup();
  const partner = admit(service, adult, "partner");
  delete service.members.get(adult.memberId).householdAdmin;
  service.households.get(adult.householdId).ownerMemberId = null;
  service.deviceRevocationContext(partner.sessionToken, adult.deviceId);
  service.revokeDevice(partner.sessionToken, adult.deviceId, partner.memberId);
  assert.ok(service.devices.get(adult.deviceId).revokedAt);
});

test("HTTP device revocation revalidates usable admin access after the options step", async () => {
  const { service, adult } = setup();
  const partner = admit(service, adult, "partner");
  service.setHouseholdAdmin(adult.sessionToken, partner.memberId, true, adult.memberId);
  const server = await startTestServer({ service, now: () => service.now() });
  const cookie = `kin_session=${adult.sessionToken}`;
  try {
    const optionsResponse = await apiRequest(server, `/api/devices/${partner.deviceId}/revocation/options`, { method: "POST", cookie, body: {} });
    assert.equal(optionsResponse.status, 200);
    const { flow } = await optionsResponse.json();
    // Authorized at the options step; by the final mutation the acting admin's
    // passkey is no longer on the member, so revoking the partner's only
    // device would leave the household without usable admin access.
    service.members.get(adult.memberId).credentials.clear();
    const before = revocationSnapshot(service, partner.deviceId);
    const finish = await apiRequest(server, "/api/devices/revocation/finish", {
      method: "POST", cookie, body: { flow, credential: { id: "credential-a", flow } },
    });
    assert.equal(finish.status, 409);
    assert.equal((await finish.json()).error, "last_household_admin");
    assert.deepEqual(revocationSnapshot(service, partner.deviceId), before);
    assert.equal(server.store.db.prepare("SELECT COUNT(*) AS count FROM devices WHERE revoked_at IS NOT NULL").get().count, 0);
  } finally {
    await server.close();
  }
});
