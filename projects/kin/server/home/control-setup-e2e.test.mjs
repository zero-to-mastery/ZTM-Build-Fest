// Setup end to end on loopback (#719): the real connection relay in test
// mode (relay/relay.mjs), the in-process ACME server, and a Kin server in
// home mode with its control panel, driven over HTTP as the setup page
// drives it. The person enters the printed code, checks and chooses a
// name (the relay answers CHECK over a sign-in-only tunnel), agrees to the
// CA's terms and connects; Kin writes its settings and asks for a restart;
// the test starts it again as the launcher would, and the same browser
// session follows the claim and the certificate to "done". A phone then
// reaches https://<name> through the relay, while the loopback panel and
// the app keep their separate origins.
//
// Nothing reaches the internet. Every step has a time limit, and the test
// closes what it opened (servers, tunnels, the database before its folder
// is removed), so a failure can't leave Windows CI waiting.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import test from "node:test";
import { keyHash } from "../../relay/ktun.mjs";
import { homeSettingsPath } from "./settings.mjs";
import { startHomeHarness } from "./home-test-utils.mjs";

const TIMEOUT = { timeout: 90_000 };

async function waitFor(check, what, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await check();
    if (last?.done) return last.value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last?.value ?? last)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function call(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({ host: "127.0.0.1", port, path, method, agent: false, headers: {
      host: `localhost:${port}`,
      ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload), origin: `http://localhost:${port}`, "sec-fetch-site": "same-origin" } : {}),
      ...headers,
    } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end(payload);
  });
}

/** An HTTPS request from a phone: TCP to the relay, SNI `name`, TLS with
 * the home server, trusting only `ca`. */
function phone(relayPort, name, ca, { path = "/health", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ host: "127.0.0.1", port: relayPort, servername: name, ca, path, agent: false, headers: { host: name, ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error("phone request timed out")));
    request.on("error", reject);
    request.end();
  });
}

test("setup on loopback: code, name check, terms, connect, restart, certificate, done", TIMEOUT, async (t) => {
  const harness = await startHomeHarness();
  t.after(() => harness.close());
  const { relay, acme, data, boot } = harness;

  // First run: no name, a setup code, the app's API closed.
  const first = await boot();
  assert.equal(first.printed.length, 1);
  assert.equal(first.printed[0].purpose, "setup");
  assert.equal((await call(first.port, "/api/status")).body.error, "home_setup_required");
  const signIn = await call(first.port, "/control/api/sign-in", { method: "POST", body: { code: first.printed[0].code } });
  assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
  const cookie = signIn.headers["set-cookie"][0].split(";")[0];
  const post = (instance, route, body = {}) => call(instance.port, `/control/api/${route}`, { method: "POST", body, headers: { cookie } });

  // The live check, through the relay.
  relay.registry.sql.insertName.run("taken.home.test", keyHash(Buffer.alloc(32, 7)), relay.registry.today, relay.registry.today);
  const taken = await post(first, "setup/check-name", { name: "taken" });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.deepEqual(taken.body, { name: "taken.home.test", freeName: true, answer: "taken" });
  assert.equal((await post(first, "setup/check-name", { name: "www" })).body.answer, "not-allowed", "the relay's reserved names");
  assert.equal((await post(first, "setup/check-name", { name: "fern" })).body.answer, "available");
  assert.equal(relay.registry.keyOf("fern.home.test"), null, "checking claims nothing");
  assert.equal((await post(first, "setup/name", { name: "taken" })).body.error, "setup-name-taken");

  // Choose, agree, connect.
  let view = (await post(first, "setup/name", { name: "Fern" })).body;
  assert.equal(view.step, "terms");
  assert.equal(view.name, "fern.home.test");
  assert.equal((await post(first, "setup/terms-url")).body.url, `${new URL(acme.directoryUrl).origin}/terms`);
  view = (await post(first, "setup/terms", { agreed: true })).body;
  assert.equal(view.step, "connect");
  view = (await post(first, "setup/connect")).body;
  assert.equal(view.step, "connecting");
  assert.equal(await first.restarted, "setup");
  const written = JSON.parse(readFileSync(homeSettingsPath(data), "utf8"));
  assert.deepEqual(written, { format: 1, relay: `relay.home.test:${relay.ports.tls}`, zone: "home.test", name: "fern.home.test", acmeTermsAgreed: true });
  if (process.platform !== "win32") assert.equal(statSync(homeSettingsPath(data)).mode & 0o777, 0o600);

  // The launcher starts Kin again: now it is https://fern.home.test, and the
  // same browser on this computer keeps its control session.
  await first.stop();
  const second = await boot();
  assert.equal(second.application.origin, "https://fern.home.test");
  assert.equal(second.printed.length, 0, "no setup code once there is a name");
  const done = await waitFor(async () => {
    const state = await call(second.port, "/control/api/state", { headers: { cookie } });
    return { done: state.body.signedIn && state.body.setup?.step === "done", value: state.body };
  }, "setup to finish");
  assert.equal(done.setup.origin, "https://fern.home.test");
  assert.equal(done.status.setupComplete, true);
  assert.equal(done.status.relay.connected, true);
  assert.equal(done.status.relay.routed, true);
  assert.ok(Date.parse(done.status.certificate.notAfter) > Date.now());
  assert.deepEqual(done.status.counts, { households: 0, devices: 0 });
  assert.ok(done.status.storage.databaseBytes > 0);
  assert.equal(relay.registry.dnsInfo("fern.home.test").caaAccountUri, second.application.home.status().certificate.accountUrl, "CAA names this server's account");

  // A phone reaches Kin through the relay, with the new certificate; the
  // app's API is open there, and the loopback panel's API is not.
  assert.equal((await phone(relay.ports.tls, "fern.home.test", acme.caPem)).status, 200);
  const page = await phone(relay.ports.tls, "fern.home.test", acme.caPem, { path: "/control/" });
  assert.equal(page.status, 200);
  assert.match(page.body, /<kin-control-panel>/);
  const appStatus = await phone(relay.ports.tls, "fern.home.test", acme.caPem, { path: "/api/status", headers: { origin: "https://fern.home.test" } });
  assert.equal(appStatus.status, 200, JSON.stringify(appStatus.body));
  const throughTunnel = await phone(relay.ports.tls, "fern.home.test", acme.caPem, { path: "/control/api/state", headers: { host: `localhost:${second.port}` } });
  assert.equal(throughTunnel.status, 403);
  assert.equal(throughTunnel.body.reason, "not-loopback", "a tunnel stream never counts as this computer, whatever its Host says");
  // On this computer the app's API refuses the loopback origin: the panel
  // uses its own API instead of widening the app's.
  assert.equal((await call(second.port, "/api/status", { headers: { origin: `http://localhost:${second.port}` } })).body.error, "origin_rejected");
  // After setup, the name is the server's for good.
  assert.equal((await post(second, "setup/name", { name: "bracken" })).body.error, "setup-finished");
  for (const event of [...first.events, ...second.events]) assert.doesNotMatch(JSON.stringify(event), /127\.0\.0\.1/, "no address in the log");
});
