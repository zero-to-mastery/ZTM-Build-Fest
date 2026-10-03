import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import {
  CLAIM_TTL_MS,
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

function testWebAuthn() {
  return {
    registrationCalls: 0,
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
  };
}

async function startTestServer({
  service = new PairingService(),
  now = () => Date.now(),
  origin = "http://localhost",
  maxFlows,
} = {}) {
  const webauthn = testWebAuthn();
  const store = new DurableStore(":memory:");
  const application = createKinServer({
    service,
    store,
    webauthn,
    now,
    origin,
    maxFlows,
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
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  return fetch(`${server.url}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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
    const devices = (await directory.json()).devices;
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
  );
  assert.throws(
    () => service.authorize(activated.sessionToken),
    (error) => error.code === "authentication_required",
  );
  assert.throws(
    () => service.createPairing(adult.sessionToken),
    (error) => error.code === "household_full",
  );
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

  const firstResult = service.revokeDevice(adult.sessionToken, joined.deviceId);
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
    service.revokeDevice(adult.sessionToken, joined.deviceId),
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
  service.revokeDevice(adult.sessionToken, joined.deviceId);
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

  service.leaveHousehold(joined.sessionToken);
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
  const occupyingMemberId = "occupying-member";
  household.members.add(occupyingMemberId);
  service.members.set(occupyingMemberId, {
    id: occupyingMemberId,
    householdId: household.id,
    active: true,
    credentials: new Set(),
  });

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
  assert.equal(service.activeMemberCount(household), 2);
});

test("the last adult cannot leave, while a joined adult can leave without removing the household", () => {
  const { service, adult } = setup();
  assert.throws(
    () => service.leaveHousehold(adult.sessionToken),
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
  assert.equal(service.leaveHousehold(joined.sessionToken).removed, true);
  assert.equal(service.authorize(adult.sessionToken).member.id, adult.memberId);
});
