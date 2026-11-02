// Signed releases (ADR 0025 §10, #722): the manifest, its signature, which
// versions are offered, and the owner's key and signing scripts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeReleaseKey } from "../../scripts/release-key.mjs";
import { buildManifest, signManifest } from "../../scripts/sign-release.mjs";
import { RELEASE_PUBLIC_KEY } from "./release-key.mjs";
import { changeKind, compareVersions, offer, releasePublicKey, releaseTarget, releaseUrls, verifyManifest } from "./release.mjs";

/** A build folder as scripts/build-sea.mjs leaves it, with fake executables. */
function dist(t, version = "1.7.0") {
  const folder = mkdtempSync(join(tmpdir(), "kin-release-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const sums = [];
  for (const [target, suffix] of [["linux-x64", ""], ["win-x64", ".exe"]]) {
    const name = `kin-${version}-${target}${suffix}`;
    const bytes = Buffer.from(`synthetic executable ${target}`);
    writeFileSync(join(folder, name), bytes);
    sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  }
  sums.push(`${"0".repeat(64)}  kin-service-host-${version}-win-x64.exe`);
  writeFileSync(join(folder, "SHA256SUMS"), `${sums.join("\n")}\n`);
  writeFileSync(join(folder, "build-info.json"), JSON.stringify({ name: "kin", version }));
  return folder;
}

test("versions: compared by number, and how a release differs", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.equal(compareVersions("1.6.0", "1.6.0"), 0);
  assert.equal(changeKind("1.6.0", "1.6.1"), "patch");
  assert.equal(changeKind("1.6.3", "1.7.0"), "minor");
  assert.equal(changeKind("1.9.0", "2.0.0"), "major");
  assert.throws(() => compareVersions("1.6", "1.6.0"), TypeError);
  assert.equal(releaseTarget("win32", "x64"), "win-x64");
  assert.equal(releaseTarget("linux", "arm64"), "linux-arm64");
  assert.equal(releaseTarget("freebsd", "x64"), null);
  const urls = releaseUrls("https://github.com/example/kin/releases/");
  assert.equal(urls.manifest, "https://github.com/example/kin/releases/latest/download/kin-home-manifest.json");
  assert.equal(urls.file("1.7.0", "kin-1.7.0-linux-x64"), "https://github.com/example/kin/releases/download/kin-v1.7.0/kin-1.7.0-linux-x64");
});

test("this build has no release key yet, so updates are off", () => {
  assert.equal(RELEASE_PUBLIC_KEY, null, "the owner adds it from an offline computer");
  assert.equal(releasePublicKey(), null);
  assert.throws(() => verifyManifest(Buffer.from("{}"), Buffer.alloc(64), null), { code: "release-no-key" });
});

test("the owner's scripts: a key pair, then a signed manifest from the build folder", (t) => {
  const { privatePem, publicBase64 } = makeReleaseKey();
  assert.equal(Buffer.from(publicBase64, "base64").length, 32);
  const folder = dist(t);
  const bytes = buildManifest(folder, { releasedAt: "2026-11-02T10:00:00.000Z" });
  const signature = signManifest(bytes, privatePem);
  assert.equal(signature.length, 64);
  const manifest = verifyManifest(bytes, signature, releasePublicKey(publicBase64));
  assert.equal(manifest.version, "1.7.0");
  assert.equal(manifest.minimumVersion, "1.0.0", "the same major version's x.0.0 by default");
  assert.deepEqual(Object.keys(manifest.files).sort(), ["linux-x64", "win-x64"], "the service host isn't a target");
  assert.equal(manifest.files["win-x64"].file, "kin-1.7.0-win-x64.exe");
  // A file that doesn't match SHA256SUMS isn't signed.
  writeFileSync(join(folder, "kin-1.7.0-linux-x64"), "changed");
  assert.throws(() => buildManifest(folder), /doesn't match SHA256SUMS/);
});

test("a manifest is trusted only with Kin's signature over its exact bytes", (t) => {
  const { privatePem, publicBase64 } = makeReleaseKey();
  const other = makeReleaseKey();
  const key = releasePublicKey(publicBase64);
  const bytes = buildManifest(dist(t), { releasedAt: "2026-11-02T10:00:00.000Z" });
  const signature = signManifest(bytes, privatePem);
  assert.throws(() => verifyManifest(bytes, signManifest(bytes, other.privatePem), key), { code: "release-signature" }, "another key");
  const changed = Buffer.from(bytes.toString("utf8").replace("1.7.0", "1.7.1"));
  assert.throws(() => verifyManifest(changed, signature, key), { code: "release-signature" }, "a changed byte");
  assert.throws(() => verifyManifest(bytes, signature.subarray(0, 63), key), { code: "release-signature" });
  // Signed, but not a manifest Kin can use: a path in a file name.
  const sneaky = Buffer.from(JSON.stringify({ format: 1, name: "kin-home", version: "1.7.0", releasedAt: "2026-11-02T10:00:00.000Z", minimumVersion: "1.0.0", files: { "linux-x64": { file: "../kin", size: 1, sha256: "a".repeat(64) } } }));
  assert.throws(() => verifyManifest(sneaky, signManifest(sneaky, privatePem), key), { code: "release-manifest" });
});

test("what a release offers: only newer versions, this computer's file, and the minimum version", (t) => {
  const { privatePem, publicBase64 } = makeReleaseKey();
  const bytes = buildManifest(dist(t, "2.0.0"), { minimumVersion: "1.6.0", releasedAt: "2026-11-02T10:00:00.000Z" });
  const manifest = verifyManifest(bytes, signManifest(bytes, privatePem), releasePublicKey(publicBase64));
  assert.equal(offer(manifest, { current: "2.0.0", target: "linux-x64" }), null, "the same version");
  assert.equal(offer(manifest, { current: "2.1.0", target: "linux-x64" }), null, "never backwards");
  const offered = offer(manifest, { current: "1.6.0", target: "linux-x64" });
  assert.equal(offered.kind, "major");
  assert.equal(offered.file.file, "kin-2.0.0-linux-x64");
  assert.equal(offered.blocked, null);
  assert.equal(offer(manifest, { current: "1.5.9", target: "linux-x64" }).blocked, "too-old");
  assert.equal(offer(manifest, { current: "1.6.0", target: "darwin-arm64" }).file, null, "no file for this computer");
});
