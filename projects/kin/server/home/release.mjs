// Signed releases of the home server (ADR 0025 §10, #722).
//
// The Kin project signs each release with an Ed25519 release key that the
// owner keeps offline (scripts/release/release-key.mjs makes it). Its public
// half is built in (release-key.mjs); without one, updates are off.
//
// A release is two files, published with the executables
// (scripts/release/sign-release.mjs writes them):
//
//   kin-home-manifest.json      the manifest, below
//   kin-home-manifest.json.sig  a detached 64-byte Ed25519 signature over the
//                               manifest file's exact bytes
//
//   {
//     "format": 1,
//     "name": "kin-home",
//     "version": "1.7.0",
//     "releasedAt": "2026-11-02T10:00:00.000Z",
//     "minimumVersion": "1.6.0",          oldest version that may update to it
//     "files": {
//       "linux-x64": { "file": "kin-1.7.0-linux-x64", "size": 98765432, "sha256": "…" },
//       …                                 one per target (see `releaseTarget`)
//     }
//   }
//
// The signature is checked before the manifest is parsed. A file's name must
// be a plain name (no folders), and the version must be newer than this one:
// a signed manifest can't move a home server back to an older release.
//
// Rotating the release key needs nothing here: a release signed with the old
// key carries an executable with the new key built in.
//
// What a signature doesn't protect against: someone who can block or replay
// the download can keep a home server on the release it has (it never
// learns of a newer one), and a stolen release key (THREAT-MODEL).
import { createPublicKey, verify } from "node:crypto";
import { RELEASE_PUBLIC_KEY } from "./release-key.mjs";

export const MANIFEST_FILE = "kin-home-manifest.json";
export const SIGNATURE_FILE = `${MANIFEST_FILE}.sig`;
export const MANIFEST_FORMAT = 1;
export const MANIFEST_NAME = "kin-home";
/** Where releases are published: GitHub Releases of the project's repository
 * (the owner's choice for #722). `latest/download/` is the newest release;
 * an executable is fetched from its own tag. KIN_HOME_RELEASES overrides the
 * base for a fork that publishes its own releases, and for tests. */
export const DEFAULT_RELEASES = "https://github.com/mnichols08/ZTM-Build-Fest/releases";
export const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const TARGETS = Object.freeze(["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "win-x64"]);

export class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseError";
    this.code = code;
  }
}

/** This computer's target, as the release names its files, or null. */
export function releaseTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform === "win32" ? "win" : platform}-${arch}`;
  return TARGETS.includes(target) ? target : null;
}

/** "1.6.0" → [1, 6, 0], or null for anything that isn't MAJOR.MINOR.PATCH. */
export function parseVersion(text) {
  const match = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(String(text ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

/** Negative, zero or positive, as `a` is older, the same or newer. */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new TypeError("not a version");
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
}

/** "major", "minor" or "patch": how `next` differs from `current`. */
export function changeKind(current, next) {
  const [a, b] = [parseVersion(current), parseVersion(next)];
  return a[0] !== b[0] ? "major" : a[1] !== b[1] ? "minor" : "patch";
}

/** The built-in key as a KeyObject, or null when this build has none.
 * `rawBase64` is the 32-byte public key in base64. */
export function releasePublicKey(rawBase64 = RELEASE_PUBLIC_KEY) {
  if (rawBase64 === null || rawBase64 === undefined) return null;
  const raw = Buffer.from(String(rawBase64), "base64");
  if (raw.length !== 32) throw new TypeError("a release public key is 32 bytes");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

const isPlainName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !name.includes("..");

/**
 * Checks `signature` over `bytes` with `key`, then the manifest itself, and
 * returns it frozen. Throws ReleaseError: `release-signature` (wrong or
 * missing signature: nothing else is read), `release-manifest` (signed but
 * not a manifest this Kin understands).
 */
export function verifyManifest(bytes, signature, key) {
  if (!key) throw new ReleaseError("release-no-key", "This build of Kin has no release key, so it can't check updates.");
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_MANIFEST_BYTES || !Buffer.isBuffer(signature) || signature.length !== 64 || !verify(null, bytes, key, signature))
    throw new ReleaseError("release-signature", "The release's signature isn't Kin's.");
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { manifest = null; }
  const bad = () => new ReleaseError("release-manifest", "Kin doesn't understand this release's manifest.");
  if (!manifest || typeof manifest !== "object" || manifest.format !== MANIFEST_FORMAT || manifest.name !== MANIFEST_NAME) throw bad();
  if (!parseVersion(manifest.version) || !parseVersion(manifest.minimumVersion) || Number.isNaN(Date.parse(manifest.releasedAt))) throw bad();
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw bad();
  const files = {};
  for (const [target, file] of Object.entries(manifest.files)) {
    if (!TARGETS.includes(target)) continue;
    if (!isPlainName(file?.file) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_EXECUTABLE_BYTES || !/^[0-9a-f]{64}$/.test(file.sha256)) throw bad();
    files[target] = Object.freeze({ file: file.file, size: file.size, sha256: file.sha256 });
  }
  return Object.freeze({ version: manifest.version, minimumVersion: manifest.minimumVersion, releasedAt: new Date(Date.parse(manifest.releasedAt)).toISOString(), files: Object.freeze(files) });
}

/**
 * What a verified manifest offers this server: null when it isn't newer,
 * else { version, kind, releasedAt, file } where `file` is this target's
 * (null when the release has none for it) and `blocked` is "too-old" when
 * this version is older than the release's minimum.
 */
export function offer(manifest, { current, target }) {
  if (compareVersions(manifest.version, current) <= 0) return null;
  return {
    version: manifest.version,
    kind: changeKind(current, manifest.version),
    releasedAt: manifest.releasedAt,
    file: manifest.files[target] ?? null,
    blocked: compareVersions(current, manifest.minimumVersion) < 0 ? "too-old" : null,
  };
}

/** The URLs of a release's files under `base` (DEFAULT_RELEASES or
 * KIN_HOME_RELEASES). */
export function releaseUrls(base = DEFAULT_RELEASES) {
  const root = String(base).replace(/\/+$/, "");
  return {
    manifest: `${root}/latest/download/${MANIFEST_FILE}`,
    signature: `${root}/latest/download/${SIGNATURE_FILE}`,
    file: (version, name) => `${root}/download/kin-v${version}/${encodeURIComponent(name)}`,
    page: (version) => `${root}/tag/kin-v${version}`,
  };
}
