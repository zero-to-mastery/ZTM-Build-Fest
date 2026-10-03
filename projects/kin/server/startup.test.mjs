import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DurableStore, hasDatabaseProcessLock } from "./durable-store.mjs";

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "kin-startup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "kin.sqlite");
}

function startServer(databasePath, port, args = []) {
  return spawnSync(
    process.execPath,
    [...args, fileURLToPath(new URL("./server.mjs", import.meta.url))],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        KIN_DATABASE_PATH: databasePath,
        KIN_PORT: String(port),
        KIN_HOST: "127.0.0.1",
        KIN_ORIGIN: "http://localhost:8000",
      },
    },
  );
}

function assertFailedStartup(result, databasePath) {
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(hasDatabaseProcessLock(databasePath), false);
  const reopened = new DurableStore(databasePath);
  try {
    assert.equal(reopened.validate(), true);
  } finally {
    reopened.close();
  }
  return JSON.parse(result.stderr.trim());
}

test("an occupied port reports the attempted listener and releases its database lock", async (t) => {
  const databasePath = temporaryDatabase(t);
  const occupied = createServer();
  try {
    await new Promise((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const port = occupied.address().port;
    const failure = assertFailedStartup(startServer(databasePath, port), databasePath);
    assert.deepEqual(Object.keys(failure).sort(), [
      "code", "event", "host", "message", "outcome", "port",
    ]);
    assert.equal(failure.event, "startup_failed");
    assert.equal(failure.outcome, "listen_failed");
    assert.equal(failure.code, "EADDRINUSE");
    assert.equal(failure.host, "127.0.0.1");
    assert.equal(failure.port, port);
    assert.match(failure.message, /already listening/);
    assert.match(failure.message, /KIN_PORT/);
  } finally {
    if (occupied.listening)
      await new Promise((resolve) => occupied.close(resolve));
  }
});

for (const [code, expectedCode, guidance] of [
  ["EACCES", "EACCES", /port reservations and permissions/],
  ["EADDRNOTAVAIL", "EADDRNOTAVAIL", /available loopback address/],
  ["ENOTFOUND", "ENOTFOUND", /Check KIN_HOST and KIN_PORT/],
  ["private diagnostic\nwith details", "UNKNOWN", /Check KIN_HOST and KIN_PORT/],
]) {
  test(`listener failure ${expectedCode} reports safe guidance and releases its database lock`, (t) => {
    const databasePath = temporaryDatabase(t);
    // Inject errors that cannot be produced reliably on every operating system.
    const preload = `
      import { Server } from "node:net";
      Server.prototype.listen = function () {
        process.nextTick(() => this.emit("error", Object.assign(
          new Error("private diagnostic with details"),
          { code: ${JSON.stringify(code)}, path: "private database path" },
        )));
        return this;
      };
    `;
    const result = startServer(databasePath, 8000, [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
    ]);
    const failure = assertFailedStartup(result, databasePath);
    assert.equal(failure.event, "startup_failed");
    assert.equal(failure.outcome, "listen_failed");
    assert.equal(failure.code, expectedCode);
    assert.equal(failure.host, "127.0.0.1");
    assert.equal(failure.port, 8000);
    assert.match(failure.message, guidance);
    assert.doesNotMatch(result.stderr, /private|stack|node_modules/);
  });
}

test("a synchronous listener configuration failure releases its database lock", (t) => {
  const databasePath = temporaryDatabase(t);
  const failure = assertFailedStartup(startServer(databasePath, -1), databasePath);
  assert.equal(failure.event, "startup_failed");
  assert.equal(failure.outcome, "configuration_or_storage");
});
