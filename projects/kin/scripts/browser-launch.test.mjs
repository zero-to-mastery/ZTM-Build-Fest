// Waiting for a browser to be ready (#327), against a stand-in browser: a
// Node script that writes DevToolsActivePort, or fails, the way Chrome does.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BROWSER_STDIO, devToolsPort, waitForDevTools } from "./browser-launch.mjs";

const fake = (profile, script) => spawn(process.execPath, ["-e", script, profile], BROWSER_STDIO);

test("the port is read from DevToolsActivePort's first line", () => {
  assert.equal(devToolsPort("41235\n/devtools/browser/abc\n"), "41235");
  assert.equal(devToolsPort(""), null);
  assert.equal(devToolsPort("\n"), null);
  assert.equal(devToolsPort("0\n"), null);
  assert.equal(devToolsPort("not a port"), null);
});

test("a browser that writes its port late is still waited for", async () => {
  const profile = await mkdtemp(join(tmpdir(), "kin-launch-"));
  try {
    const child = fake(profile, `setTimeout(() => require("fs").writeFileSync(require("path").join(process.argv[1], "DevToolsActivePort"), "50123\\n/devtools/browser/x"), 300); setTimeout(() => {}, 5000);`);
    assert.equal(await waitForDevTools(child, profile, { timeoutMs: 5_000 }), "50123");
    child.kill();
  } finally { await rm(profile, { recursive: true, force: true }); }
});

test("a browser that exits first is reported at once, with its own last words", async () => {
  const profile = await mkdtemp(join(tmpdir(), "kin-launch-"));
  try {
    const child = fake(profile, `process.stderr.write("[0101/000000.000:FATAL:zygote_host_impl_linux.cc] No usable sandbox!\\n"); process.exit(3);`);
    const started = Date.now();
    await assert.rejects(waitForDevTools(child, profile, { label: "Browser adult-a", timeoutMs: 20_000 }),
      (error) => /^Browser adult-a did not start: it exited \(code 3/.test(error.message) && /No usable sandbox/.test(error.message));
    assert.ok(Date.now() - started < 10_000, "it didn't wait out the timeout");
  } finally { await rm(profile, { recursive: true, force: true }); }
});

test("a browser that never gets ready times out with a plain message", async () => {
  const profile = await mkdtemp(join(tmpdir(), "kin-launch-"));
  const child = fake(profile, `setTimeout(() => {}, 10000);`);
  try {
    await assert.rejects(waitForDevTools(child, profile, { timeoutMs: 300 }), /did not start within 0 s/);
  } finally {
    child.kill();
    await rm(profile, { recursive: true, force: true });
  }
});
