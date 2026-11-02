// Makes Kin's release key pair (ADR 0025 §10, #722). Run it once, on an
// offline computer that will keep the private key:
//
//   node scripts/release-key.mjs PATH
//
// It writes the private key to PATH (PKCS#8 PEM, mode 0600; it refuses to
// overwrite a file) and prints the public key to put in
// server/home/release-key.mjs. Anyone with the private key can publish an
// update every home server installs, so it never goes online, into the
// repository or into CI. Keep a second copy somewhere as safe.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A new key pair: { privatePem, publicBase64 } (the raw 32-byte public key). */
export function makeReleaseKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicBase64: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64"),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path || process.argv.length > 3) {
    process.stderr.write("Usage: node scripts/release-key.mjs PATH  (where the private key is written)\n");
    process.exit(2);
  }
  const { privatePem, publicBase64 } = makeReleaseKey();
  try {
    writeFileSync(path, privatePem, { mode: 0o600, flag: "wx" });
  } catch (error) {
    process.stderr.write(`${error.code === "EEXIST" ? `${path} already exists; Kin never overwrites a release key.` : error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`Private key written to ${path}. Keep it offline.\n\nPut this in server/home/release-key.mjs:\n\nexport const RELEASE_PUBLIC_KEY = "${publicBase64}";\n`);
}
