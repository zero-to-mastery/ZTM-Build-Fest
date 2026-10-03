import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";
import { DurableStore, hasDatabaseProcessLock } from "./durable-store.mjs";

const workerPath = fileURLToPath(
  new URL("./durable-restart-worker.mjs", import.meta.url),
);

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function startWorker(databasePath) {
  const port = await unusedPort();
  const child = spawn(process.execPath, [workerPath], {
    env: {
      ...process.env,
      KIN_RESTART_DATABASE_PATH: databasePath,
      KIN_RESTART_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const errors = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => errors.push(chunk));
  let startupTimeout;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        lines.on("line", (line) => {
          try {
            if (JSON.parse(line).event === "test_worker_ready") resolve();
          } catch (error) {
            reject(error);
          }
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`test server exited ${code}: ${errors.join("")}`)),
        );
      }),
      new Promise((_, reject) =>
        (startupTimeout = setTimeout(
          () => reject(new Error("test server startup timed out")),
          10_000,
        )),
      ),
    ]);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(startupTimeout);
  }
  return {
    child,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error(`test server shutdown timed out: ${errors.join("")}`));
        }, 10_000);
        child.once("exit", (code) => {
          clearTimeout(timeout);
          lines.close();
          if (code === 0) resolve();
          else reject(new Error(`test server exited ${code}: ${errors.join("")}`));
        });
        child.stdin.end("shutdown\n");
      }),
  };
}

async function api(port, path, { method = "GET", cookie, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    response,
    body: response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : null,
  };
}

function cookieValue(response, name) {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";", 1)[0])
    .find((entry) => entry.startsWith(`${name}=`));
  assert.ok(value, `expected ${name} cookie`);
  return value;
}

test("HTTP identity and encrypted relay survive a real service-process restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-http-restart-"));
  const databasePath = join(directory, "kin.sqlite");
  let first;
  let second;
  try {
    first = await startWorker(databasePath);
    assert.equal(hasDatabaseProcessLock(databasePath), true);
    assert.throws(
      () =>
        new DurableStore(databasePath, {
          acquireProcessLock: true,
        }),
      /lock already exists/,
    );
    const ready = await api(first.port, "/readiness");
    assert.equal(ready.response.status, 200);
    assert.deepEqual(ready.body, { ready: true });

    const options = await api(first.port, "/api/passkeys/register/options", {
      method: "POST",
      body: { purpose: "bootstrap", deviceLabel: "Restart test device" },
    });
    assert.equal(options.response.status, 200);
    const bootstrap = await api(first.port, "/api/passkeys/register/finish", {
      method: "POST",
      body: {
        flow: options.body.flow,
        credential: {
          id: "process-restart-credential",
          publicKey: "process-restart-public-key",
          algorithm: -7,
        },
      },
    });
    assert.equal(bootstrap.response.status, 201);
    const sessionCookie = cookieValue(bootstrap.response, "kin_session");
    const deviceCookie = cookieValue(bootstrap.response, "kin_device");
    const envelope = {
      protocolVersion: 1,
      envelopeVersion: 1,
      eventId: "c".repeat(32),
      householdId: bootstrap.body.householdId,
      deviceId: bootstrap.body.deviceId,
      deviceSequence: 1,
      logicalTime: "1",
      keyEpoch: 1,
      nonce: Buffer.alloc(12, 4).toString("base64url"),
      ciphertext: Buffer.alloc(32, 5).toString("base64url"),
      signature: Buffer.alloc(64, 6).toString("base64url"),
    };
    const accepted = await api(first.port, "/api/sync/events", {
      method: "POST",
      cookie: sessionCookie,
      body: { events: [envelope] },
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.durable, true);
    await first.close();
    first = undefined;

    second = await startWorker(databasePath);
    const loginOptions = await api(second.port, "/api/login/options", {
      method: "POST",
      cookie: deviceCookie,
    });
    assert.equal(loginOptions.response.status, 200);
    const login = await api(second.port, "/api/login/finish", {
      method: "POST",
      cookie: deviceCookie,
      body: {
        flow: loginOptions.body.flow,
        credential: { id: "process-restart-credential" },
      },
    });
    assert.equal(login.response.status, 200);
    const renewedSession = cookieValue(login.response, "kin_session");
    const status = await api(second.port, "/api/sync/status", {
      cookie: renewedSession,
    });
    assert.equal(status.response.status, 200);
    assert.equal(status.body.acceptance, "durable");
    assert.equal(status.body.eventCount, 1);
    const pulled = await api(second.port, "/api/sync/events", {
      cookie: renewedSession,
    });
    assert.equal(pulled.response.status, 200);
    assert.deepEqual(pulled.body.events[0].envelope, envelope);

    const retry = await api(second.port, "/api/sync/events", {
      method: "POST",
      cookie: renewedSession,
      body: { events: [envelope] },
    });
    assert.equal(retry.response.status, 200);
    assert.equal(retry.body.durable, true);

    const conflict = await api(second.port, "/api/sync/events", {
      method: "POST",
      cookie: renewedSession,
      body: {
        events: [{ ...envelope, ciphertext: Buffer.alloc(32, 9).toString("base64url") }],
      },
    });
    assert.equal(conflict.response.status, 409);

    const nextEnvelope = {
      ...envelope,
      eventId: "d".repeat(32),
      deviceSequence: 2,
      ciphertext: Buffer.alloc(32, 7).toString("base64url"),
    };
    const nextAccepted = await api(second.port, "/api/sync/events", {
      method: "POST",
      cookie: renewedSession,
      body: { events: [nextEnvelope] },
    });
    assert.equal(nextAccepted.response.status, 200);
    const gap = await api(second.port, "/api/sync/events", {
      method: "POST",
      cookie: renewedSession,
      body: {
        events: [
          {
            ...nextEnvelope,
            eventId: "e".repeat(32),
            deviceSequence: 4,
          },
        ],
      },
    });
    assert.equal(gap.response.status, 409);
    await second.close();
    second = undefined;
    assert.equal(hasDatabaseProcessLock(databasePath), false);
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
