#!/usr/bin/env node
// Starts the Kin connection relay from environment settings (relay/README.md).
//
//   node relay/start.mjs          production: settings from KIN_RELAY_*
//   node relay/start.mjs --test   test mode: the test certificate, zone
//                                 home.test, loopback ports 8443/8080/8053,
//                                 an in-memory registry. Never for real use.
//
// SIGHUP reloads the relay's own certificate from its files (it renews);
// SIGTERM and SIGINT close every tunnel with GOAWAY 8 and stop.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_LIMITS } from "./limits.mjs";
import { ConnectionRelay, ctLookup } from "./relay.mjs";

const list = (value) => String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
const port = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  if (value === "off") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65_535) throw new Error(`"${value}" is not a port number (or "off")`);
  return number;
};
const positive = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a number ≥ 0`);
  return number;
};

/** The relay's settings from the environment (or test mode). */
export function relayConfig(env = process.env, argv = process.argv.slice(2)) {
  if (argv.includes("--test") || env.KIN_RELAY_TEST === "1") {
    const fixtures = new URL("./test-fixtures/", import.meta.url);
    return {
      test: true,
      zone: "home.test", relayName: "relay.home.test",
      certPath: new URL("relay-test.crt", fixtures), keyPath: new URL("relay-test.key", fixtures),
      registryPath: ":memory:", addresses: ["127.0.0.1", "::1"],
      listen: { host: "127.0.0.1", tlsPort: port(env.KIN_RELAY_TLS_PORT, 8443), httpPort: port(env.KIN_RELAY_HTTP_PORT, 8080), dnsPort: port(env.KIN_RELAY_DNS_PORT, 8053) },
      limits: {}, abuseContact: "abuse@home.test", certificateSeen: async () => null,
    };
  }
  const required = (name) => {
    if (!env[name]) throw new Error(`${name} is required (relay/README.md lists the settings).`);
    return env[name];
  };
  const limits = {};
  if (env.KIN_RELAY_CONNECTIONS_PER_NAME) limits.connectionsPerName = positive(env.KIN_RELAY_CONNECTIONS_PER_NAME, "KIN_RELAY_CONNECTIONS_PER_NAME");
  if (env.KIN_RELAY_MBIT_PER_NAME) limits.bytesPerSecondPerName = (positive(env.KIN_RELAY_MBIT_PER_NAME, "KIN_RELAY_MBIT_PER_NAME") * 1e6) / 8;
  if (env.KIN_RELAY_GB_PER_30_DAYS) limits.bytesPer30DaysPerName = positive(env.KIN_RELAY_GB_PER_30_DAYS, "KIN_RELAY_GB_PER_30_DAYS") * 1e9;
  if (env.KIN_RELAY_NEW_NAMES_PER_WEEK !== undefined) limits.newNamesPerWeek = positive(env.KIN_RELAY_NEW_NAMES_PER_WEEK, "KIN_RELAY_NEW_NAMES_PER_WEEK");
  const dataDir = env.KIN_RELAY_DATA_DIR || "/var/lib/kin-relay";
  const ct = env.KIN_RELAY_CT_URL ?? "https://crt.sh/";
  const zone = required("KIN_RELAY_ZONE");
  return {
    test: false,
    zone,
    relayName: required("KIN_RELAY_NAME"),
    certPath: required("KIN_RELAY_TLS_CERT"),
    keyPath: required("KIN_RELAY_TLS_KEY"),
    dataDir,
    registryPath: join(dataDir, "registry.sqlite"),
    addresses: list(required("KIN_RELAY_ADDRESSES")),
    nameServers: list(env.KIN_RELAY_NAME_SERVERS),
    hostmaster: env.KIN_RELAY_HOSTMASTER || undefined,
    abuseContact: env.KIN_RELAY_ABUSE || `abuse@${zone}`,
    reserved: list(env.KIN_RELAY_RESERVED),
    listen: { host: env.KIN_RELAY_HOST || "::", tlsPort: port(env.KIN_RELAY_TLS_PORT, 443), httpPort: port(env.KIN_RELAY_HTTP_PORT, 80), dnsPort: port(env.KIN_RELAY_DNS_PORT, 53) },
    limits: { ...limits },
    // "off": never free an uncertified name (the safe choice without CT).
    certificateSeen: ct === "off" ? async () => null : ctLookup(ct),
  };
}

/** Starts a relay from `config`; resolves with it once it listens. */
export async function startRelay(config, { log = (line) => console.log(line) } = {}) {
  if (!config.test) {
    process.umask(0o077);
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  }
  const readTls = () => ({ cert: readFileSync(config.certPath), key: readFileSync(config.keyPath) });
  const relay = new ConnectionRelay({
    zone: config.zone, relayName: config.relayName, tls: readTls(), registryPath: config.registryPath,
    addresses: config.addresses, nameServers: config.nameServers, hostmaster: config.hostmaster,
    abuseContact: config.abuseContact, reserved: config.reserved, limits: { ...DEFAULT_LIMITS, ...config.limits },
    certificateSeen: config.certificateSeen, log,
  });
  await relay.listen(config.listen);
  if (config.test) log("TEST MODE: a test certificate and an in-memory registry. Never use this for real households.");
  relay.reloadCertificate = () => relay.setCertificate(readTls());
  return relay;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let relay;
  try {
    relay = await startRelay(relayConfig());
  } catch (error) {
    console.error(`Kin connection relay could not start: ${error.message}`);
    process.exit(1);
  }
  process.on("SIGHUP", () => {
    try { relay.reloadCertificate(); console.log("Reloaded the relay's certificate."); }
    catch (error) { console.error(`Could not reload the relay's certificate: ${error.message}`); }
  });
  const stop = async () => { await relay.close(); process.exit(0); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
