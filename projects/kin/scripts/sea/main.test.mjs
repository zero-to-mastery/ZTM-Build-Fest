// The executable's unpacking (main.cjs, #714) without building one: the
// script runs here with a stand-in for node:sea that serves a small app.
// The full build runs it for real on Linux (build-sea.test.mjs); these check
// the clean-ups that must outlast Windows holding a file (#785).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { appManifest } from "../build-sea.mjs";
import { holdFor } from "../held-file.mjs";

const MAIN = fileURLToPath(new URL("./main.cjs", import.meta.url));
const FILES = [
  { path: "server/server.mjs", bytes: Buffer.from("// the server\n") },
  { path: "web/index.html", bytes: Buffer.from("<html></html>\n") },
];
const MANIFEST = appManifest(FILES, { version: "1.6.0", nodeVersion: "24.22.0" });
const NAME = `app-${MANIFEST.bundle.slice(0, 16)}`;

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "kin-sea-main-"));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}

/** Runs `kin --prepare` with the app cache `cache`. Resolves with
 * { code, stdout, stderr } once it prints or exits. */
function prepare(cache) {
  const sea = {
    getAsset: (key, encoding) => { assert.equal(key, "kin/manifest.json"); assert.equal(encoding, "utf8"); return JSON.stringify(MANIFEST); },
    getRawAsset: (key) => {
      const { bytes } = FILES.find(({ path }) => `kin/files/${path}` === key);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    },
  };
  const realRequire = createRequire(MAIN);
  const require = (id) => (id === "node:sea" ? sea : realRequire(id));
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let exited = false;
    // process.exit ends the script where it is called, the first time.
    const exit = (code) => {
      if (exited) return;
      exited = true;
      resolve({ code, stdout, stderr });
      throw new Error("exited");
    };
    // What main.cjs uses of process.
    const fakeProcess = {
      pid: process.pid, platform: process.platform, execPath: process.execPath, emitWarning: process.emitWarning,
      argv: ["kin", "kin", "--prepare"],
      env: { KIN_APP_CACHE: cache },
      exit,
      stdout: { write: (text) => { stdout += text; if (!exited) { exited = true; resolve({ code: 0, stdout, stderr }); } } },
      stderr: { write: (text) => { stderr += text; } },
    };
    const main = vm.compileFunction(readFileSync(MAIN, "utf8"), ["require", "module", "exports", "__filename", "__dirname", "process"], { filename: MAIN });
    main(require, { exports: {} }, {}, MAIN, dirname(MAIN), fakeProcess);
  });
}

test("unpacking replaces a damaged copy even while Windows holds one of its files for a moment", async (t) => {
  const cache = join(temporary(t), "cache");
  const damaged = join(cache, NAME, "server");
  mkdirSync(damaged, { recursive: true });
  writeFileSync(join(damaged, "server.mjs"), "throw new Error('tampered');\n");
  const released = holdFor(join(damaged, "server.mjs"), 300);
  const result = await prepare(cache);
  await released;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${realpathSync(join(cache, NAME))}\n`);
  assert.deepEqual(readFileSync(join(cache, NAME, "server", "server.mjs")), FILES[0].bytes);
  assert.deepEqual(readdirSync(cache), [NAME], "no half-written copy is left");
});

test("unpacking removes an older build's copy even while Windows holds one of its files for a moment", async (t) => {
  const cache = join(temporary(t), "cache");
  const older = join(cache, "app-0123456789abcdef");
  mkdirSync(older, { recursive: true });
  writeFileSync(join(older, "kin.sqlite-wal"), "an older version's");
  const released = holdFor(join(older, "kin.sqlite-wal"), 150);
  const result = await prepare(cache);
  await released;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readdirSync(cache), [NAME]);
});
