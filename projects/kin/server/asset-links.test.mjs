// Digital Asset Links for the Google Play app (#532): configured per
// deployment, 404 without it, and a partial or malformed configuration stops
// startup instead of publishing a file Android would reject.
import assert from "node:assert/strict";
import test from "node:test";
import { AssetLinksError, parseAssetLinks } from "./asset-links.mjs";
import { PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";

const PRINT = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join(":");

async function start(t, options = {}) {
  const app = createKinServer({ service: new PairingService(), acquireProcessLock: false, ...options });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  return `http://127.0.0.1:${app.server.address().port}`;
}

test("asset links parse a package and its fingerprints, upper-casing and de-duplicating", () => {
  assert.equal(parseAssetLinks({}), null);
  assert.equal(parseAssetLinks({ packageName: " ", fingerprints: " , " }), null);
  assert.deepEqual(parseAssetLinks({ packageName: "org.example.kin", fingerprints: `${PRINT}, ${PRINT.toUpperCase()}` }), [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: "org.example.kin", sha256_cert_fingerprints: [PRINT.toUpperCase()] },
  }]);
});

test("a partial or malformed configuration is refused with an explanation", () => {
  for (const settings of [
    { packageName: "org.example.kin" },
    { fingerprints: PRINT },
    { packageName: "kin", fingerprints: PRINT },
    { packageName: "org.example.kin", fingerprints: "AA:BB" },
    { packageName: "org.example.kin", fingerprints: PRINT.replaceAll(":", "") },
    { packageName: "org.example.kin", fingerprints: Array(9).fill(0).map((_, n) => PRINT.slice(0, -2) + n.toString(16).padStart(2, "0")).join(",") },
  ]) assert.throws(() => parseAssetLinks(settings), AssetLinksError, JSON.stringify(settings));
});

test("the route answers 404 without configuration", async (t) => {
  const url = await start(t, { androidPackage: "", androidCertSha256: "" });
  const response = await fetch(`${url}/.well-known/assetlinks.json`);
  assert.equal(response.status, 404);
});

test("the route serves the statements as JSON, cached, for GET and HEAD", async (t) => {
  const url = await start(t, { androidPackage: "org.example.kin", androidCertSha256: PRINT });
  const response = await fetch(`${url}/.well-known/assetlinks.json`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
  const [statement] = await response.json();
  assert.equal(statement.target.package_name, "org.example.kin");
  const head = await fetch(`${url}/.well-known/assetlinks.json`, { method: "HEAD" });
  assert.equal(head.status, 200);
});

test("a server with a bad configuration doesn't start", () => {
  assert.throws(() => createKinServer({ service: new PairingService(), acquireProcessLock: false, androidPackage: "org.example.kin" }), AssetLinksError);
});
