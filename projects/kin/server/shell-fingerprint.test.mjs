import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKinServer, fingerprintedShell, shellFingerprint } from "./server.mjs";
import { DurableStore } from "./durable-store.mjs";

function assertFramingDenied(response) {
  assert.equal(
    response.headers.get("content-security-policy"),
    "frame-ancestors 'none'",
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  // Voice messages (#134) record with the microphone: this origin only.
  assert.equal(response.headers.get("permissions-policy"), "camera=(self), microphone=(self), geolocation=()");
}

test("the shell fingerprint hashes served content deterministically and ignores test files", () => {
  const root = mkdtempSync(join(tmpdir(), "kin-shell-"));
  try {
    mkdirSync(join(root, "components"));
    writeFileSync(join(root, "index.html"), "<html>");
    const shellFile = join(root, "components", "kin-compose.js");
    writeFileSync(shellFile, "old");
    utimesSync(shellFile, new Date(0), new Date(0));
    const first = shellFingerprint(root);
    assert.match(first, /^[a-f0-9]{12}$/);
    assert.equal(shellFingerprint(root), first, "stable while nothing changes");
    writeFileSync(join(root, "components", "kin-compose.test.mjs"), "test only");
    assert.equal(shellFingerprint(root), first, "test files do not affect the shell");
    writeFileSync(shellFile, "new");
    utimesSync(shellFile, new Date(0), new Date(0));
    utimesSync(shellFile, new Date(0), new Date(0));
    assert.notEqual(shellFingerprint(root), first, "a changed shell file changes the fingerprint");
    const changed = shellFingerprint(root);
    utimesSync(shellFile, new Date(1_000_000), new Date(1_000_000));
    assert.equal(shellFingerprint(root), changed, "touching a file without changing its content does not churn the cache");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("index.html is served with the release plus fingerprint while the static file keeps the plain release", async () => {
  assert.equal(
    fingerprintedShell('<meta name="kin-version" content="0.41.0" />', "abc123def456"),
    '<meta name="kin-version" content="0.41.0+abc123def456" />',
  );
  const { server, store } = createKinServer({ port: 0, host: "127.0.0.1", origin: "http://localhost:8000", store: new DurableStore(":memory:") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const path of ["/", "/index.html", "/pair"]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200);
      assertFramingDenied(response);
      const html = await response.text();
      const version = /<meta name="kin-version" content="([^"]+)"/.exec(html)?.[1];
      assert.match(version, /^\d+\.\d+\.\d+\+[a-f0-9]{12}$/, `${path} carries the fingerprint: ${version}`);
      assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(html));
    }
    const worker = await fetch(`${origin}/service-worker.js?v=0.41.0+abc123def456`);
    assert.equal(worker.status, 200);
    assertFramingDenied(worker);
    assert.match(await worker.text(), /kin-static-v\$\{RELEASE\}/);
    const api = await fetch(`${origin}/api/status`);
    assert.equal(api.status, 200);
    assertFramingDenied(api);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("served pages permit same-origin camera access and deny unused capabilities", async () => {
  const { server } = createKinServer({
    port: 0,
    host: "127.0.0.1",
    origin: "http://localhost:8000",
    store: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("permissions-policy"),
      "camera=(self), microphone=(self), geolocation=()",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
