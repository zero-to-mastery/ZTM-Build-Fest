// Kin's single executable (#714, ADR 0025 §10): the build script's options
// and contents and, on Linux, a full build that is reproducible and runs:
// it serves the app and the engine in home mode, inside the permission
// model, from its unpacked and checked app files.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import test from "node:test";
import { appManifest, BuildSeaError, buildExecutable, buildSea, checkExecutable, collectAppFiles, DEFAULT_TARGETS, parseBuildArguments, PROJECT_ROOT } from "./build-sea.mjs";
import { readElf } from "./sea/elf.mjs";
import { checkMachOExecutable } from "./sea/macho.mjs";
import { officialBinaries } from "./sea/official-binaries.mjs";
import { checkPeExecutable } from "./sea/pe.mjs";
import { findServiceHost } from "../server/service-install.mjs";

// A stand-in for kin-service-host.exe (#749) when no real one is given in
// KIN_SERVICE_HOST_EXE: just enough of a PE32+ x64 console program for
// windows-service-host.mjs's check. Building the real one on Linux needs
// mingw-w64; CI uses the one the service-host job built on Windows.
function standInServiceHost(directory) {
  const bytes = Buffer.alloc(0x200);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x40);
  bytes.writeUInt16LE(0x8664, 0x44);
  bytes.writeUInt16LE(0x20b, 0x58);
  bytes.writeUInt16LE(3, 0x58 + 68);
  const path = join(directory, "kin-service-host.exe");
  writeFileSync(path, bytes);
  return path;
}
import { SEA_FUSE } from "./sea/fuse.mjs";
import { hostTarget } from "./sea/node-release.mjs";

const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const VERSION = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")).version;

function temporary(t, prefix = "kin-sea-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}

test("the build takes all five targets and refuses unknown or repeated ones", { timeout: 60_000 }, () => {
  assert.deepEqual(DEFAULT_TARGETS, ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "win-x64"]);
  assert.deepEqual(parseBuildArguments([]).targets, DEFAULT_TARGETS);
  assert.deepEqual(parseBuildArguments(["--target", "darwin-arm64,darwin-x64,win-x64"]).targets, ["darwin-arm64", "darwin-x64", "win-x64"]);
  const options = parseBuildArguments(["--target", "linux-arm64", "--node-binary", "node-arm64", "--node-version", "v24.22.0", "--measure"]);
  assert.deepEqual(options.targets, ["linux-arm64"]);
  assert.equal(options.nodeVersion, "24.22.0");
  assert.equal(options.measure, true);
  assert.equal(parseBuildArguments([]).nodeVersion, process.version.slice(1));
  for (const [argv, message] of [
    [["--target", "linux-riscv64"], /Unknown target/],
    [["--target", "linux-x64,linux-x64"], /listed twice/],
    [["--node-binary", "node"], /single --target/],
    [["--node-version", "24"], /isn't a node version/],
    [["--sign"], /Unknown argument/],
  ])
    assert.throws(() => parseBuildArguments(argv), (error) => error instanceof BuildSeaError && message.test(error.message), argv.join(" "));
});

test("every file built into the executable keeps LF endings in any checkout (.gitattributes)", { timeout: 60_000 }, (t) => {
  // Otherwise a Windows checkout with core.autocrlf builds a different
  // executable from Linux and macOS (#748).
  const wasm = join(temporary(t), "engine.wasm");
  writeFileSync(wasm, WASM);
  const paths = collectAppFiles({ wasm }).map(({ path }) => path).filter((path) => path !== "web/wasm/kin_engine.wasm");
  const result = spawnSync("git", ["check-attr", "--stdin", "eol"], { cwd: PROJECT_ROOT, input: paths.join("\n"), encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) { t.skip("git isn't available here"); return; }
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, paths.length);
  for (const line of lines) assert.match(line, /: eol: lf$/, line);
});

test("the executable holds the server, the web app, package.json and the engine, not tests", { timeout: 60_000 }, (t) => {
  const wasm = join(temporary(t), "engine.wasm");
  writeFileSync(wasm, WASM);
  const files = collectAppFiles({ wasm });
  const paths = files.map(({ path }) => path);
  for (const path of ["package.json", "server/server.mjs", "server/launcher.mjs", "server/permissions.mjs", "server/durable-store/schema.mjs", "web/index.html", "web/wasm/kin-engine.js", "web/wasm/kin_engine.wasm", "server/home/tunnel-client.mjs", "relay/ktun.mjs"])
    assert.ok(paths.includes(path), path);
  assert.ok(!paths.some((path) => path.endsWith(".test.mjs")), "no tests");
  assert.deepEqual(paths.filter((path) => path.startsWith("relay/")), ["relay/ktun.mjs"], "of the relay, only the codec the tunnel shares");
  assert.ok(!paths.some((path) => path.startsWith("server/test-fixtures/") || path.endsWith("-test-utils.mjs")), "no test helpers");
  assert.deepEqual(paths, [...paths].sort((left, right) => (left < right ? -1 : 1)), "sorted byte-wise");
  assert.equal(files.find(({ path }) => path === "web/wasm/kin_engine.wasm").source, wasm);
  assert.throws(() => collectAppFiles({ wasm: join(tmpdir(), "no-such-engine.wasm") }), /build-wasm\.sh/);

  const loaded = [{ path: "a", bytes: Buffer.from("1") }, { path: "b", bytes: Buffer.from("22") }];
  const manifest = appManifest(loaded, { version: "1.2.3", nodeVersion: "24.22.0" });
  assert.deepEqual(manifest.files, [{ path: "a", size: 1, sha256: sha256("1") }, { path: "b", size: 2, sha256: sha256("22") }]);
  assert.equal(appManifest(loaded, { version: "1.2.3", nodeVersion: "24.22.0" }).bundle, manifest.bundle);
  assert.notEqual(appManifest([loaded[0], { path: "b", bytes: Buffer.from("23") }], { version: "1.2.3", nodeVersion: "24.22.0" }).bundle, manifest.bundle);
});

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

function start(executable, env) {
  const child = spawn(executable, [], { env: { ...process.env, NODE_OPTIONS: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      const line = output.split("\n").find((entry) => entry.includes('"service_ready"'));
      if (line) resolve(JSON.parse(line));
    };
    child.stdout.setEncoding("utf8").on("data", onData);
    child.stderr.setEncoding("utf8").on("data", onData);
    child.once("exit", (code) => reject(new Error(`exited with ${code}: ${output}`)));
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(child.exitCode); return; }
    child.removeAllListeners("exit");
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
  return { child, ready, stop, output: () => output };
}

test("on Linux the executable builds reproducibly and serves Kin in home mode inside the sandbox", { timeout: 180_000 }, async (t) => {
  const target = hostTarget();
  if (process.platform !== "linux") { t.skip("builds and runs only on Linux"); return; }
  let base;
  try {
    base = readFileSync(process.execPath);
    readElf(base);
  } catch {
    t.skip("this machine's node isn't an ELF executable");
    return;
  }
  if (process.platform !== "linux" || !DEFAULT_TARGETS.includes(target)) { t.skip("builds and runs only on Linux x64 and arm64"); return; }
  if (!base.includes(Buffer.from(SEA_FUSE))) { t.skip("this node was built without SEA support"); return; }

  const root = temporary(t);
  const wasm = join(root, "kin_engine.wasm");
  writeFileSync(wasm, WASM);
  const build = (out) => buildSea({ ...parseBuildArguments(["--target", target, "--node-binary", process.execPath, "--wasm", wasm, "--out", out]), work: join(root, "work") }, { log: () => {} });
  const info = await build(join(root, "one"));
  const again = await build(join(root, "two"));
  const file = `kin-${VERSION}-${target}`;
  const executable = join(root, "one", file);
  const bytes = readFileSync(executable);

  // Reproducible, and recorded.
  assert.equal(sha256(readFileSync(join(root, "two", file))), sha256(bytes));
  assert.deepEqual(again, info);
  assert.equal(readFileSync(join(root, "one", "SHA256SUMS"), "utf8"), `${sha256(bytes)}  ${file}\n`);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "one", "build-info.json"), "utf8")), info);
  assert.equal(info.version, VERSION);
  assert.equal(info.targets[0].size, bytes.length);
  assert.equal(info.targets[0].node.sha256, sha256(base));
  assert.ok(bytes.includes(Buffer.from(`${SEA_FUSE}:1`)), "the fuse is flipped");

  const run = (args, env = {}) => spawnSync(executable, args, { encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "", ...env } });
  assert.equal(run(["--version"]).stdout, `${VERSION}\n`);

  const cache = join(root, "cache");
  const port = await freePort();
  // No KIN_MODE: the executable is the home server.
  const env = { KIN_MODE: "", KIN_DATA_DIR: join(root, "data"), KIN_APP_CACHE: cache, KIN_PORT: String(port) };
  const service = start(executable, env);
  t.after(service.stop);
  const ready = await service.ready;
  assert.deepEqual(ready, { event: "service_ready", origin: `http://localhost:${port}`, mode: "home" });
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  assert.deepEqual(Buffer.from(await (await fetch(`http://127.0.0.1:${port}/wasm/kin_engine.wasm`)).arrayBuffer()), WASM);
  assert.equal(run(["--health"], env).status, 0);
  // The service is a second process, started with the permission model in
  // NODE_OPTIONS (server.mjs also refuses to serve without it).
  const children = readFileSync(`/proc/${service.child.pid}/task/${service.child.pid}/children`, "utf8").trim().split(/\s+/);
  assert.equal(children.length, 1);
  const serviceEnv = readFileSync(`/proc/${children[0]}/environ`, "latin1").split("\0");
  const nodeOptions = serviceEnv.find((entry) => entry.startsWith("NODE_OPTIONS="));
  assert.match(nodeOptions, /--permission /);
  assert.ok(nodeOptions.includes(`--allow-fs-write=${join(root, "data")}`), nodeOptions);
  assert.ok(serviceEnv.includes("KIN_SEA_ROLE=service"));
  assert.equal(await service.stop(), 0);
  assert.equal(run(["--health"], env).status, 1);
  assert.ok(existsSync(join(root, "data", "kin.sqlite")));

  // The unpacked app is checked on every start: a changed file is replaced.
  const unpacked = run(["--prepare"], env).stdout.trim();
  assert.equal(unpacked, join(cache, `app-${info.bundle.slice(0, 16)}`));
  const server = join(unpacked, "server", "server.mjs");
  const original = readFileSync(server);
  appendFileSync(server, "\nthrow new Error('tampered');\n");
  assert.equal(run(["--prepare"], env).status, 0);
  assert.deepEqual(readFileSync(server), original);

  // A cache reached through a symlink, as macOS's temporary folders are
  // (/var/folders -> /private/var/folders): the service loads its files by
  // the real path its permission flags allow, so it still starts.
  const realCache = join(root, "real-cache");
  mkdirSync(realCache);
  const linkedCache = join(root, "linked-cache");
  symlinkSync(realCache, linkedCache, "dir");
  const linkedPort = await freePort();
  const linkedEnv = { ...env, KIN_APP_CACHE: linkedCache, KIN_PORT: String(linkedPort), KIN_DATA_DIR: join(root, "data-linked") };
  const linked = start(executable, linkedEnv);
  t.after(linked.stop);
  assert.equal((await linked.ready).event, "service_ready", linked.output());
  assert.equal((await fetch(`http://127.0.0.1:${linkedPort}/health`)).status, 200);
  assert.equal(await linked.stop(), 0);

  // Several copies unpacking into one empty cache at once (the service
  // starting while `kin --health` runs), then again into the full one: all
  // succeed with the same intact folder, and no half-written copy remains.
  const raceEnv = { ...process.env, NODE_OPTIONS: "", ...env, KIN_APP_CACHE: join(root, "race") };
  const prepare = () => new Promise((resolve) => execFile(executable, ["--prepare"], { env: raceEnv, timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout: stdout.trim(), stderr })));
  for (const round of [1, 2]) {
    const results = await Promise.all([prepare(), prepare(), prepare(), prepare()]);
    for (const result of results) assert.equal(result.code, 0, `round ${round}: ${result.stderr}`);
    assert.equal(new Set(results.map(({ stdout }) => stdout)).size, 1);
    assert.deepEqual(readdirSync(join(root, "race")), [basename(results[0].stdout)]);
  }

  // Home mode is the executable's default, with its refusals.
  const refused = run([], { ...env, KIN_ANDROID_PACKAGE: "io.example.kin" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /home_mode_setting_refused/);
  assert.match(run(["--print-service", "--platform", "linux"], env).stdout, /^ExecStart=\/usr\/local\/lib\/kin\/kin$/m);
});

// macOS and Windows (#747, #748): built here, on any machine, from the
// official node binaries the build cached; run on a Mac and on Windows by
// the CI job home-executables-run and the device checks (#717).
for (const target of ["darwin-arm64", "darwin-x64", "win-x64"]) {
  test(`the ${target} executable builds here, reproducibly, and parses back with the blob where Node looks`, { timeout: 120_000 }, async (t) => {
    const version = process.version.slice(1);
    const path = officialBinaries(target).find((candidate) => candidate.includes(`node-v${version}-`));
    if (!path) { t.skip(`no official node v${version} for ${target} is cached (run scripts/build-sea.mjs, or set KIN_SEA_NODE_DIR)`); return; }
    const root = temporary(t);
    const wasm = join(root, "kin_engine.wasm");
    writeFileSync(wasm, WASM);
    if (target === "win-x64" && !process.env.KIN_SERVICE_HOST_EXE) {
      process.env.KIN_SERVICE_HOST_EXE = standInServiceHost(root);
      t.after(() => { delete process.env.KIN_SERVICE_HOST_EXE; });
    }
    const build = (out) => buildSea({ ...parseBuildArguments(["--target", target, "--node-binary", path, "--wasm", wasm, "--out", out]), work: join(root, "work") }, { log: () => {} });
    const info = await build(join(root, "one"));
    await build(join(root, "two"));
    const file = `kin-${VERSION}-${target}${target === "win-x64" ? ".exe" : ""}`;
    const bytes = readFileSync(join(root, "one", file));
    assert.equal(sha256(readFileSync(join(root, "two", file))), sha256(bytes), "reproducible");
    const sums = readFileSync(join(root, "one", "SHA256SUMS"), "utf8");
    assert.ok(sums.startsWith(`${sha256(bytes)}  ${file}\n`), sums);
    if (target === "win-x64") {
      // The service host ships beside kin.exe, under the name
      // --install-service looks for (server/service-install.mjs).
      const host = `kin-service-host-${VERSION}-win-x64.exe`;
      assert.equal(sums, `${sha256(bytes)}  ${file}\n${sha256(readFileSync(join(root, "one", host)))}  ${host}\n`);
      assert.deepEqual(readFileSync(join(root, "one", host)), readFileSync(process.env.KIN_SERVICE_HOST_EXE));
      const folder = "C:\\Downloads";
      const beside = new Set([win32.join(folder, file), win32.join(folder, host)]);
      assert.equal(findServiceHost({ program: { kind: "sea", executable: win32.join(folder, file) }, env: {}, exists: (candidate) => beside.has(candidate) }), win32.join(folder, host));
    } else assert.equal(sums, `${sha256(bytes)}  ${file}\n`);
    assert.equal(info.targets[0].sha256, sha256(bytes));
    const { blob } = target === "win-x64" ? checkPeExecutable(bytes) : checkMachOExecutable(bytes);
    assert.equal(sha256(blob), info.blob.sha256);
    if (target !== "win-x64") assert.equal(checkMachOExecutable(bytes).signature.codeDirectory.identifier, "io.journeytocode.kin");

    // A binary for another processor, and a result without the blob, are refused.
    const other = officialBinaries(target === "darwin-arm64" ? "darwin-x64" : "darwin-arm64").at(-1);
    if (other && target !== "win-x64") assert.throws(() => buildExecutable(target, readFileSync(other), blob), /another processor/);
    assert.throws(() => checkExecutable(target, bytes, Buffer.from("another blob")), /doesn't hold the SEA blob/);
  });
}
