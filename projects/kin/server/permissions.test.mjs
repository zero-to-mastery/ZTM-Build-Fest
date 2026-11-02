// The service's sandbox (#106): Node's permission model with read access to
// the app, read and write access to the data directory only, and no child
// processes, workers, addons or WASI.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { APP_ROOT, configuredDatabasePath, permissionFlags, permissionProblem, serviceDataDirectory } from "./permissions.mjs";
import { canonicalPath } from "./path-safety.mjs";

const NETWORK_TEST = { timeout: 30_000 };

// What each test has to stop before its temporary folders are removed.
const stopFirst = new WeakMap();

function temporary(t) {
  const directory = canonicalPath(mkdtempSync(join(tmpdir(), "kin-permission-")));
  t.after(async () => {
    // node:test runs t.after hooks in the order they were added, and this one
    // is added before the test starts its service. So it stops the service
    // itself; otherwise a failing test would remove the folder under it.
    for (const stop of stopFirst.get(t)?.splice(0) ?? []) await stop();
    // Windows can report a killed process tree as exited just before SQLite's
    // file handles are released. Keep cleanup bounded while allowing that brief
    // OS-level delay; other platforms normally succeed on the first attempt.
    // The promise rm, not rmSync: on Windows, rmSync in Node 24.18 and earlier
    // (and 25.1) gives up on the first EPERM without retrying.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return directory;
}

// Stops a test's service when the test ends, before its folders are removed.
function stopBeforeCleanup(t, stop) {
  if (!stopFirst.has(t)) stopFirst.set(t, []);
  stopFirst.get(t).push(stop);
}

test("the flags allow reading the app and reading and writing the data directory only", (t) => {
  const root = temporary(t);
  const database = join(root, "data", "kin.sqlite");
  mkdirSync(join(root, "data"));
  assert.deepEqual(permissionFlags(database), [
    "--permission",
    `--allow-fs-read=${canonicalPath(APP_ROOT)}`,
    `--allow-fs-read=${join(root, "data")}`,
    `--allow-fs-write=${join(root, "data")}`,
  ]);
  assert.equal(serviceDataDirectory(database), join(root, "data"));
  assert.equal(configuredDatabasePath({}, { KIN_DATA_DIR: join(root, "data") }), database);
  assert.equal(configuredDatabasePath({}, { KIN_DATABASE_PATH: join(root, "other.sqlite"), KIN_DATA_DIR: join(root, "data") }), join(root, "other.sqlite"));
});

test("startup explains what is missing from the sandbox", (t) => {
  const root = temporary(t);
  const database = join(root, "kin.sqlite");
  assert.match(permissionProblem(database, undefined), /permission model/);
  const allowing = (allowed) => ({ has: (scope, path) => allowed.some(([s, p]) => s === scope && (p === undefined || p === path)) });
  const app = canonicalPath(APP_ROOT);
  assert.match(permissionProblem(database, allowing([["fs.read", app], ["fs.read", root]])), /--allow-fs-write=/);
  assert.match(permissionProblem(database, allowing([["fs.read", root], ["fs.write", root]])), new RegExp(`--allow-fs-read=${app.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
  const complete = [["fs.read", app], ["fs.read", root], ["fs.write", root]];
  assert.equal(permissionProblem(database, allowing(complete)), null);
  assert.match(permissionProblem(database, allowing([...complete, ["child"]])), /"child"/);
  assert.match(permissionProblem(database, allowing([...complete, ["worker"]])), /"worker"/);
  // Broader write access is refused, wherever the data directory is.
  const everywhere = { has: (scope) => scope !== "child" && scope !== "worker" && scope !== "addon" && scope !== "wasi" };
  assert.match(permissionProblem(database, everywhere), /may write only its data directory/);
  assert.match(permissionProblem(join(app, ".kin-data", "kin.sqlite"), everywhere), /may write only its data directory/);
  // A data directory that is (or contains) the app could rewrite its code.
  assert.match(permissionProblem(join(app, "kin.sqlite"), allowing([["fs.read", app], ["fs.write", app]])), /contains the app/);
});

test("inside the sandbox, writes outside the data directory, processes and workers are denied", NETWORK_TEST, (t) => {
  const root = temporary(t);
  const data = join(root, "data");
  mkdirSync(data);
  const database = join(data, "kin.sqlite");
  const outside = join(root, "outside.txt");
  const probe = `
    import { writeFileSync } from "node:fs";
    import { spawnSync } from "node:child_process";
    import { Worker } from "node:worker_threads";
    const { permissionProblem } = await import(${JSON.stringify(pathToFileURL(join(APP_ROOT, "server", "permissions.mjs")).href)});
    const attempt = (action) => { try { action(); return "allowed"; } catch (error) { return error.code; } };
    console.log(JSON.stringify({
      problem: permissionProblem(${JSON.stringify(database)}),
      inside: attempt(() => writeFileSync(${JSON.stringify(join(data, "probe.txt"))}, "ok")),
      outside: attempt(() => writeFileSync(${JSON.stringify(outside)}, "no")),
      appRoot: attempt(() => writeFileSync(${JSON.stringify(join(APP_ROOT, "permission-probe.txt"))}, "no")),
      child: attempt(() => { const result = spawnSync(process.execPath, ["--version"]); if (result.error) throw result.error; }),
      worker: attempt(() => new Worker("1", { eval: true })),
    }));
  `;
  const result = spawnSync(process.execPath, [...permissionFlags(database), "--input-type=module", "-e", probe], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    problem: null,
    inside: "allowed",
    outside: "ERR_ACCESS_DENIED",
    appRoot: "ERR_ACCESS_DENIED",
    child: "ERR_ACCESS_DENIED",
    worker: "ERR_ACCESS_DENIED",
  });
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(join(APP_ROOT, "permission-probe.txt")), false);
});

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

function waitForLine(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += chunk;
      if (pattern.test(output)) { child.stdout.off("data", onData); resolve(output); }
    };
    child.stdout.setEncoding("utf8").on("data", onData);
    child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.once("exit", (code) => reject(new Error(`exited ${code} before ${pattern}: ${output}`)));
  });
}

function stop(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  // Windows has no signals to forward: end the launcher and the service together.
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill("SIGTERM");
  return exited;
}

test("server/start.mjs creates the data directory and serves inside the sandbox", NETWORK_TEST, async (t) => {
  const root = temporary(t);
  const port = await freePort();
  const database = join(root, "new", "kin.sqlite");
  const child = spawn(process.execPath, [join(APP_ROOT, "server", "start.mjs")], {
    env: { ...process.env, KIN_DATABASE_PATH: database, KIN_PORT: String(port), KIN_HOST: "127.0.0.1" },
  });
  stopBeforeCleanup(t, () => stop(child));
  await waitForLine(child, /service_ready/);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.ok(existsSync(database));
  const code = await stop(child);
  if (process.platform !== "win32") assert.equal(code, 0, "a stop signal reaches the service, which shuts down cleanly");
});

test("Ctrl+C in a terminal stops the service cleanly and releases its lock", { ...NETWORK_TEST, skip: process.platform === "win32" && "a POSIX process group" }, async (t) => {
  const root = temporary(t);
  const port = await freePort();
  const database = join(root, "kin.sqlite");
  // A terminal delivers SIGINT to the whole process group: launcher and service.
  const child = spawn(process.execPath, [join(APP_ROOT, "server", "start.mjs")], {
    detached: true,
    env: { ...process.env, KIN_DATABASE_PATH: database, KIN_PORT: String(port), KIN_HOST: "127.0.0.1" },
  });
  stopBeforeCleanup(t, () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  await waitForLine(child, /service_ready/);
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  process.kill(-child.pid, "SIGINT");
  assert.equal(await exited, 0);
  assert.equal(existsSync(`${database}.service.lock`), false, "the lock is released");
});

test("a symlinked data directory works through the launcher", { ...NETWORK_TEST, skip: process.platform === "win32" && "symlinks need privileges on Windows" }, async (t) => {
  const root = temporary(t);
  mkdirSync(join(root, "real"));
  symlinkSync(join(root, "real"), join(root, "link"));
  const port = await freePort();
  const child = spawn(process.execPath, [join(APP_ROOT, "server", "start.mjs")], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "KIN_DATABASE_PATH")), KIN_DATA_DIR: join(root, "link"), KIN_PORT: String(port), KIN_HOST: "127.0.0.1" },
  });
  stopBeforeCleanup(t, () => stop(child));
  await waitForLine(child, /service_ready/);
  assert.ok(existsSync(join(root, "real", "kin.sqlite")));
  await stop(child);
});

test("a test's service is stopped before its temporary folder is removed, even if the test ends first", NETWORK_TEST, async (t) => {
  let directory, child, folderWhenStopped;
  await t.test("a test that ends without stopping its service", async (inner) => {
    directory = temporary(inner);
    // Stands in for the service: it holds a file open in the folder until stopped.
    child = spawn(process.execPath, ["-e", "require('fs').openSync(process.argv[1], 'w'); console.log('open'); setInterval(() => {}, 1000)", join(directory, "held")]);
    stopBeforeCleanup(inner, async () => { folderWhenStopped = existsSync(directory); await stop(child); });
    await once(child.stdout, "data");
  });
  assert.equal(folderWhenStopped, true, "the service was stopped while its folder was still there");
  assert.ok(child.exitCode !== null || child.signalCode !== null, "the service has exited");
  assert.equal(existsSync(directory), false, "the folder is removed");
});

test("the service refuses to start outside the sandbox unless asked to for development", NETWORK_TEST, (t) => {
  const root = temporary(t);
  const env = { ...process.env, KIN_DATABASE_PATH: join(root, "kin.sqlite"), KIN_PORT: "1" };
  const refused = spawnSync(process.execPath, [join(APP_ROOT, "server", "server.mjs")], { env, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /"outcome":"permission_model_required"/);
  assert.equal(existsSync(join(root, "kin.sqlite")), false, "nothing was opened");
});
