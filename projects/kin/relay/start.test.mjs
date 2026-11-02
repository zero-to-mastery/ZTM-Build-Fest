// Starting the relay from its settings, test mode, and the operator's
// commands (#732).
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect } from "node:tls";
import { fileURLToPath } from "node:url";
import { runAdmin } from "./admin.mjs";
import { Registry } from "./registry.mjs";
import { relayConfig, startRelay } from "./start.mjs";

const fixtures = fileURLToPath(new URL("./test-fixtures/", import.meta.url));

test("settings: required values, ports, limits and CT", () => {
  assert.throws(() => relayConfig({}, []), /KIN_RELAY_ZONE is required/);
  const env = {
    KIN_RELAY_ZONE: "home.kin.example", KIN_RELAY_NAME: "relay.kin.example", KIN_RELAY_TLS_CERT: "/c", KIN_RELAY_TLS_KEY: "/k",
    KIN_RELAY_ADDRESSES: "192.0.2.1, 2001:db8::1", KIN_RELAY_HTTP_PORT: "off", KIN_RELAY_MBIT_PER_NAME: "40", KIN_RELAY_NEW_NAMES_PER_WEEK: "0",
    KIN_RELAY_CT_URL: "off", KIN_RELAY_RESERVED: "family,mail2",
  };
  const config = relayConfig(env, []);
  assert.equal(config.test, false);
  assert.deepEqual(config.addresses, ["192.0.2.1", "2001:db8::1"]);
  assert.deepEqual(config.listen, { host: "::", tlsPort: 443, httpPort: null, dnsPort: 53 });
  assert.deepEqual(config.limits, { bytesPerSecondPerName: 5_000_000, newNamesPerWeek: 0 });
  assert.equal(config.registryPath, join("/var/lib/kin-relay", "registry.sqlite"));
  assert.equal(config.abuseContact, "abuse@home.kin.example");
  assert.deepEqual(config.reserved, ["family", "mail2"]);
  assert.throws(() => relayConfig({ ...env, KIN_RELAY_TLS_PORT: "70000" }, []), /port/);
  assert.equal(relayConfig({}, ["--test"]).test, true);
});

test("test mode starts on loopback with the test certificate", async () => {
  const config = relayConfig({ KIN_RELAY_TLS_PORT: "0", KIN_RELAY_HTTP_PORT: "off", KIN_RELAY_DNS_PORT: "off" }, ["--test"]);
  const lines = [];
  const relay = await startRelay(config, { log: (line) => lines.push(line) });
  try {
    assert.ok(lines.some((line) => line.includes("TEST MODE")));
    assert.ok(lines.every((line) => !line.includes("127.0.0.1")), "the log names no address");
    const socket = connect({ port: relay.ports.tls, host: "127.0.0.1", servername: "relay.home.test", rejectUnauthorized: false });
    let text = "";
    socket.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
    await once(socket, "end");
    assert.match(text, /Kin connection relay for home\.test/);
    relay.reloadCertificate();
  } finally { await relay.close(); }
});

test("production settings: the registry file is private to the relay's account", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kin-relay-data-"));
  try {
    const config = relayConfig({
      KIN_RELAY_ZONE: "home.test", KIN_RELAY_NAME: "relay.home.test", KIN_RELAY_TLS_CERT: join(fixtures, "relay-test.crt"),
      KIN_RELAY_TLS_KEY: join(fixtures, "relay-test.key"), KIN_RELAY_ADDRESSES: "127.0.0.1", KIN_RELAY_DATA_DIR: join(dataDir, "relay"),
      KIN_RELAY_HOST: "127.0.0.1", KIN_RELAY_TLS_PORT: "0", KIN_RELAY_HTTP_PORT: "off", KIN_RELAY_DNS_PORT: "off", KIN_RELAY_CT_URL: "off",
    }, []);
    const umask = process.umask();
    const relay = await startRelay(config, { log: () => {} });
    process.umask(umask);
    await relay.close();
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dataDir, "relay")).mode & 0o777, 0o700);
      assert.equal(statSync(join(dataDir, "relay", "registry.sqlite")).mode & 0o077, 0, "no access for group or others");
    }
  } finally { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("the operator suspends and lifts a name, and reads error counts", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kin-relay-admin-"));
  try {
    const registry = new Registry({ zone: "home.test", path: join(dataDir, "registry.sqlite"), newNamesPerWeek: 0 });
    registry.claim(Buffer.alloc(32, 1), "smith.home.test");
    registry.error("unrouted", 3);
    registry.close();
    const env = { KIN_RELAY_ZONE: "home.test", KIN_RELAY_DATA_DIR: dataDir };
    const out = [];
    assert.equal(runAdmin(["suspend", "smith.home.test"], env, (line) => out.push(line)), 0);
    assert.equal(JSON.parse((runAdmin(["status", "smith.home.test"], env, (line) => out.push(line)), out.at(-1))).suspended, true);
    assert.equal(runAdmin(["unsuspend", "Smith.home.test"], env, (line) => out.push(line)), 0);
    assert.equal(JSON.parse((runAdmin(["status", "smith.home.test"], env, (line) => out.push(line)), out.at(-1))).suspended, false);
    assert.throws(() => runAdmin(["suspend", "nobody.home.test"], env, () => {}), /No free name/);
    runAdmin(["errors"], env, (line) => out.push(line));
    assert.deepEqual(JSON.parse(out.at(-1)), { unrouted: 3 });
    assert.equal(runAdmin(["bogus"], env, () => {}), 2);
  } finally { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
