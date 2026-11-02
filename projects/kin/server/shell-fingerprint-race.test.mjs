// The page fingerprint walks web/ on each request for "/". A folder or file
// that disappears mid-walk (a test's scratch folder, an editor's temp file)
// once made "/" answer 500 in CI. The walk must skip it instead.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { shellFingerprint } from "./server.mjs";

const CHURN = `
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { workerData } = require("node:worker_threads");
for (;;) {
  const directory = mkdtempSync(join(workerData, "scratch-"));
  writeFileSync(join(directory, "file.js"), "x");
  rmSync(directory, { recursive: true });
}`;

test("the shell fingerprint skips files and folders that vanish while it reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "kin-fingerprint-race-"));
  const churner = new Worker(CHURN, { eval: true, workerData: root });
  try {
    mkdirSync(join(root, "styles"));
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    writeFileSync(join(root, "styles", "app.css"), "body{}");
    const failures = [];
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      try { shellFingerprint(root); } catch (error) { failures.push(error.code ?? error.message); }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(failures, []);
  } finally {
    await churner.terminate();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing web root still fails loudly", () => {
  assert.throws(() => shellFingerprint(join(tmpdir(), "kin-no-such-web-root")), { code: "ENOENT" });
});
