// A home server for tests, started as server.mjs starts one in home mode,
// against the real connection relay in test mode and the in-process ACME
// server (#719). Used by control-setup-e2e.test.mjs and by the browser
// regression scripts/control-panel-regression.mjs. Nothing reaches the
// internet: the relay listens on loopback with the relay tests' fixture
// certificate, and the CA validates through it.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionRelay } from "../../relay/relay.mjs";
import { startAcmeTestServer } from "../acme/acme-test-server.mjs";
import { createHttpsTransport } from "../acme/transport.mjs";
import { DurableStore } from "../durable-store.mjs";
import { createKinServer } from "../server.mjs";
import { runPendingRestore } from "./backups.mjs";
import { createControlPanel } from "./control-panel.mjs";
import { startHomeServer } from "./home-server.mjs";
import { loadHomeSettings, writeHomeSettings } from "./settings.mjs";

const fixture = (name) => readFileSync(new URL(`../../relay/test-fixtures/${name}`, import.meta.url));
export const RELAY_TLS = Object.freeze({ key: fixture("relay-test.key"), cert: fixture("relay-test.crt") });
const FAST_BACKOFF = { minMs: 50, maxMs: 400, resetMs: 60_000 };

/**
 * The relay (zone home.test), the CA, and a data directory whose settings
 * name that relay. Resolves with { relay, acme, data, boot(port?), close() }.
 * `boot` starts Kin with the directory's current settings and resolves with
 * { application, panel, printed, events, restarted, port, stop() }; when
 * the panel asks for a restart, `restarted` resolves and the caller starts
 * it again, as the launcher would.
 */
export async function startHomeHarness() {
  const relay = new ConnectionRelay({
    zone: "home.test", relayName: "relay.home.test", tls: RELAY_TLS, addresses: ["127.0.0.1"],
    resolveTxt: async () => [], certificateSeen: async () => null,
  });
  await relay.listen({ host: "127.0.0.1", tlsPort: 0, httpPort: null, dnsPort: null });
  const acme = await startAcmeTestServer({ validationPort: relay.ports.tls, holdPolls: 0, accountBase: "https://acme.test" });
  const data = mkdtempSync(join(tmpdir(), "kin-home-harness-"));
  const databasePath = join(data, "kin.sqlite");
  // A household that runs its own relay sets its address and zone; the
  // name is the setup page's to choose.
  await writeHomeSettings(data, { relay: `relay.home.test:${relay.ports.tls}`, zone: "home.test" }, {});
  const acmeTransport = createHttpsTransport({ allowLoopbackHttp: true, timeoutMs: 10_000 });
  const tunnel = { connectHost: "127.0.0.1", ca: RELAY_TLS.cert, backoff: FAST_BACKOFF, interfaces: () => ({}) };
  const running = new Set();

  async function boot(port = 0) {
    // As server.mjs: a restore the panel asked for runs first (#721).
    await runPendingRestore({ dataDirectory: data, databasePath });
    const settings = await loadHomeSettings(data, {});
    const store = new DurableStore(databasePath);
    const application = createKinServer({ store, mode: "home", origin: settings.configured ? `https://${settings.name}` : "http://localhost:8000", host: "127.0.0.1" });
    const printed = [];
    const events = [];
    let restartRequested;
    const restarted = new Promise((resolve) => { restartRequested = resolve; });
    let panel;
    try {
      panel = await createControlPanel({
        application, dataDirectory: data, databasePath, settings, env: {},
        log: (event) => { events.push(event); if (event.event === "home_control_code") printed.push(event); },
        restart: (reason) => restartRequested(reason),
        setup: { tunnel, acmeTransport, directoryUrl: acme.directoryUrl },
      });
      await new Promise((resolve, reject) => {
        application.server.once("error", reject);
        application.server.listen(port, "127.0.0.1", () => { application.server.off("error", reject); resolve(); });
      });
    } catch (error) {
      store.close();
      throw error;
    }
    panel.started();
    if (settings.configured) {
      application.home = await startHomeServer({
        application, dataDirectory: data, settings, log: (event) => events.push(event),
        connectHost: "127.0.0.1", relayCa: RELAY_TLS.cert, directoryUrl: acme.directoryUrl, acmeTransport,
        ctTransport: async () => { throw Object.assign(new Error("no CT search in tests"), { code: "ct-unavailable" }); },
        certificates: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))) },
        tunnel: { backoff: FAST_BACKOFF, interfaces: () => ({}) },
      });
    }
    const instance = {
      application, panel, printed, events, restarted, port: application.server.address().port,
      async stop() {
        if (!running.delete(instance)) return;
        await Promise.all([application.home?.stop(), panel.close()]);
        application.server.closeAllConnections?.();
        await new Promise((resolve) => application.server.close(resolve));
        store.close();
      },
    };
    running.add(instance);
    return instance;
  }

  return {
    relay, acme, data, databasePath, boot,
    async close() {
      for (const instance of [...running]) await instance.stop();
      await relay.close();
      await acme.close();
      rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
