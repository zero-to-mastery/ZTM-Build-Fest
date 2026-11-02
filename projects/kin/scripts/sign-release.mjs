// Signs a home-server release (ADR 0025 §10, #722): from a build folder
// (scripts/build-sea.mjs's output: the executables, SHA256SUMS and
// build-info.json) it writes kin-home-manifest.json and its detached
// Ed25519 signature, kin-home-manifest.json.sig, beside them. Publish all of
// them in the GitHub release tagged kin-v<version>.
//
//   node scripts/sign-release.mjs DIST --key PRIVATE.pem [--minimum 1.6.0]
//
//   --minimum   the oldest version that may update to this one (default: the
//               same major version's x.0.0, so an update never jumps over a
//               major release's migrations unannounced)
//
// Run it on the offline computer that keeps the release key, with the build
// folder copied over. It re-reads every executable and checks it against
// SHA256SUMS before signing, then checks the signature it made.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILE, MANIFEST_FORMAT, MANIFEST_NAME, SIGNATURE_FILE, parseVersion, releasePublicKey, verifyManifest } from "../server/home/release.mjs";

export class SignReleaseError extends Error {}

const TARGET_OF = /^kin-(\d+\.\d+\.\d+)-((?:linux|darwin)-(?:x64|arm64)|win-x64)(?:\.exe)?$/;

/** The manifest's bytes for the build in `dist`. */
export function buildManifest(dist, { minimumVersion = null, releasedAt = new Date().toISOString() } = {}) {
  const info = JSON.parse(readFileSync(join(dist, "build-info.json"), "utf8"));
  if (!parseVersion(info.version)) throw new SignReleaseError(`build-info.json has no version Kin can read (${info.version}).`);
  const files = {};
  for (const line of readFileSync(join(dist, "SHA256SUMS"), "utf8").split("\n").filter(Boolean)) {
    const [sha256, name] = line.split(/\s+\*?/);
    const match = TARGET_OF.exec(name ?? "");
    if (!match) continue;
    if (match[1] !== info.version) throw new SignReleaseError(`${name} isn't version ${info.version}.`);
    const bytes = readFileSync(join(dist, name));
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new SignReleaseError(`${name} doesn't match SHA256SUMS.`);
    files[match[2]] = { file: name, size: bytes.length, sha256 };
  }
  if (!Object.keys(files).length) throw new SignReleaseError("SHA256SUMS lists no Kin executables.");
  const minimum = minimumVersion ?? `${parseVersion(info.version)[0]}.0.0`;
  if (!parseVersion(minimum)) throw new SignReleaseError(`--minimum ${minimum} isn't a version.`);
  return Buffer.from(`${JSON.stringify({ format: MANIFEST_FORMAT, name: MANIFEST_NAME, version: info.version, releasedAt, minimumVersion: minimum, files }, null, 2)}\n`);
}

/** Signs `bytes` with the PEM private key; checks the result with its
 * public half, as a home server would. Returns the 64-byte signature. */
export function signManifest(bytes, privatePem) {
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new SignReleaseError("The release key must be an Ed25519 key.");
  const signature = sign(null, bytes, privateKey);
  const publicBase64 = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url").toString("base64");
  verifyManifest(bytes, signature, releasePublicKey(publicBase64));
  return signature;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : null; };
  const keyPath = option("--key");
  const minimumVersion = option("--minimum");
  if (args.length !== 1 || !keyPath) {
    process.stderr.write("Usage: node scripts/sign-release.mjs DIST --key PRIVATE.pem [--minimum VERSION]\n");
    process.exit(2);
  }
  const [dist] = args;
  try {
    const bytes = buildManifest(dist, { minimumVersion });
    const signature = signManifest(bytes, readFileSync(keyPath));
    writeFileSync(join(dist, MANIFEST_FILE), bytes);
    writeFileSync(join(dist, SIGNATURE_FILE), signature);
    process.stdout.write(`Signed ${MANIFEST_FILE} in ${dist}. Publish it, ${SIGNATURE_FILE} and the executables in the release.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
