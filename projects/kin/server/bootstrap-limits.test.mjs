// Issue #157 (A4): household creation is limited per client and can be capped
// or closed by the operator, without touching existing households.
import assert from "node:assert/strict";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import {
  BOOTSTRAP_LIMIT, BOOTSTRAP_WINDOW_MS, HOUSEHOLD_CREATION_CLOSED,
  PairingError, PairingService, parseHouseholdPolicy,
} from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const refused = (code) => (error) => error instanceof PairingError && error.code === code;

const webauthn = () => ({
  registrationOptions: (flow) => ({ challenge: flow }),
  authenticationOptions: (flow) => ({ challenge: flow }),
  verifyRegistration(response, flow) {
    if (response?.flow !== flow) throw new PairingError("registration_failed", "Invalid registration.", 400);
    return { id: response.id, publicKey: `key-${response.id}`, algorithm: -7, signCount: 0 };
  },
  verifyAuthentication: () => true,
  discardFlow() {},
});

async function startServer(options = {}) {
  const application = createKinServer({
    store: new DurableStore(":memory:"), webauthn: webauthn(), origin: "http://localhost", ...options,
  });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${application.server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  let created = 0;
  const createHousehold = async (headers) => {
    const options = await post("/api/passkeys/register/options", { purpose: "bootstrap", deviceLabel: "Phone" }, headers);
    if (!options.ok) return { status: options.status, body: await options.json() };
    const { flow } = await options.json();
    created += 1;
    const finish = await post("/api/passkeys/register/finish", { flow, credential: { id: `cred-${created}-${flow}`, flow } }, headers);
    return { status: finish.status, body: await finish.json(), cookies: finish.headers.getSetCookie() };
  };
  return {
    ...application, url, createHousehold,
    close: () => new Promise((resolve) => application.server.close(resolve)).finally(() => application.store.close()),
  };
}

test("household creation is rate-limited per client and recovers after the window", () => {
  let now = 1_000_000;
  const service = new PairingService({ now: () => now });
  for (let index = 0; index < BOOTSTRAP_LIMIT; index += 1)
    service.bootstrap({ credential: credential(`a${index}`), rateKey: "203.0.113.7" });
  assert.throws(() => service.bootstrap({ credential: credential("a-over"), rateKey: "203.0.113.7" }), refused("rate_limited"));
  assert.throws(() => service.assertBootstrapAllowed("203.0.113.7"), (error) => error.status === 429);
  // Another client is unaffected.
  service.bootstrap({ credential: credential("b0"), rateKey: "198.51.100.9" });
  assert.equal(service.households.size, BOOTSTRAP_LIMIT + 1, "a refused attempt creates nothing");
  now += BOOTSTRAP_WINDOW_MS + 1;
  service.bootstrap({ credential: credential("a-later"), rateKey: "203.0.113.7" });
});

test("a full limit table refuses new clients instead of letting them through uncharged", () => {
  const service = new PairingService({ maxRateBuckets: 2 });
  service.bootstrap({ credential: credential("x"), rateKey: "a" });
  service.bootstrap({ credential: credential("y"), rateKey: "b" });
  assert.throws(() => service.bootstrap({ credential: credential("z"), rateKey: "c" }), refused("rate_limited"));
  service.bootstrap({ credential: credential("x2"), rateKey: "a" });
});

test("the cap counts live households only and refuses with the plain message", () => {
  const service = new PairingService({ householdPolicy: parseHouseholdPolicy({ maxHouseholds: "2" }) });
  const first = service.bootstrap({ credential: credential("one") });
  service.bootstrap({ credential: credential("two") });
  assert.throws(() => service.bootstrap({ credential: credential("three") }), (error) =>
    refused("household_creation_closed")(error) && error.status === 403 && error.message === HOUSEHOLD_CREATION_CLOSED);
  service.households.get(first.householdId).lifecycleState = "deleted";
  service.bootstrap({ credential: credential("three") });
});

test("the operator settings parse strictly and default to open, uncapped creation", () => {
  assert.deepEqual({ ...parseHouseholdPolicy() }, { allowNew: true, maxHouseholds: null });
  assert.deepEqual({ ...parseHouseholdPolicy({ allowNewHouseholds: "", maxHouseholds: "" }) }, { allowNew: true, maxHouseholds: null });
  assert.deepEqual({ ...parseHouseholdPolicy({ allowNewHouseholds: " FALSE ", maxHouseholds: "0" }) }, { allowNew: false, maxHouseholds: 0 });
  assert.equal(parseHouseholdPolicy({ allowNewHouseholds: "1" }).allowNew, true);
  for (const value of ["off", "nope"])
    assert.throws(() => parseHouseholdPolicy({ allowNewHouseholds: value }), (error) => error.code === "household_policy_invalid");
  for (const value of ["-1", "1.5", "ten", "1e3"])
    assert.throws(() => parseHouseholdPolicy({ maxHouseholds: value }), (error) => error.code === "household_policy_invalid");
});

test("with creation disabled, the server refuses before the passkey prompt and existing households keep working", async () => {
  const service = new PairingService();
  const existing = service.bootstrap({ credential: credential("existing") });
  const server = await startServer({ service, allowNewHouseholds: false });
  try {
    const attempt = await server.createHousehold();
    assert.equal(attempt.status, 403);
    assert.deepEqual(attempt.body, { error: "household_creation_closed", message: HOUSEHOLD_CREATION_CLOSED });
    assert.equal(service.households.size, 1);
    const status = await fetch(`${server.url}/api/status`, { headers: { Cookie: `kin_session=${existing.sessionToken}` } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).identity.householdId, existing.householdId);
    const pairing = service.createPairing(existing.sessionToken);
    assert.ok(pairing.code, "an existing household can still pair devices");
  } finally {
    await server.close();
  }
});

test("over HTTP, each client gets its own allowance behind a trusted proxy", async () => {
  const server = await startServer({ trustedProxies: "127.0.0.1" });
  try {
    const client = { "X-Forwarded-For": "203.0.113.7" };
    for (let index = 0; index < BOOTSTRAP_LIMIT; index += 1)
      assert.equal((await server.createHousehold(client)).status, 201);
    const over = await server.createHousehold(client);
    assert.equal(over.status, 429);
    assert.equal(over.body.error, "rate_limited");
    assert.equal((await server.createHousehold({ "X-Forwarded-For": "198.51.100.9" })).status, 201);
    assert.equal(server.service.households.size, BOOTSTRAP_LIMIT + 1);
  } finally {
    await server.close();
  }
});

test("the household cap applies over HTTP too", async () => {
  const server = await startServer({ maxHouseholds: 1 });
  try {
    assert.equal((await server.createHousehold()).status, 201);
    const over = await server.createHousehold({ "X-Forwarded-For": "203.0.113.50" });
    assert.equal(over.status, 403);
    assert.equal(over.body.message, HOUSEHOLD_CREATION_CLOSED);
  } finally {
    await server.close();
  }
});

test("a passed-in service keeps its own policy unless the server is given a setting", async () => {
  const saved = { allow: process.env.KIN_ALLOW_NEW_HOUSEHOLDS, max: process.env.KIN_MAX_HOUSEHOLDS };
  delete process.env.KIN_ALLOW_NEW_HOUSEHOLDS;
  delete process.env.KIN_MAX_HOUSEHOLDS;
  const service = new PairingService({ householdPolicy: parseHouseholdPolicy({ allowNewHouseholds: false }) });
  const server = await startServer({ service });
  try {
    assert.equal(service.householdPolicy.allowNew, false);
    assert.equal((await server.createHousehold()).status, 403);
  } finally {
    await server.close();
    if (saved.allow !== undefined) process.env.KIN_ALLOW_NEW_HOUSEHOLDS = saved.allow;
    if (saved.max !== undefined) process.env.KIN_MAX_HOUSEHOLDS = saved.max;
  }
});
