// The home key (ADR 0025 §2, §3, §10): the Ed25519 key pair that signs the
// home server into its connection relay and to which its name is bound for
// good. It is made on first run and kept in `<data directory>/home/home-key.pem`
// (PKCS#8, mode 0600, in the 0700 `home/` directory), next to the ACME keys.
// It never leaves the home server; only its public half and signatures go to
// the relay. Whoever holds it (or a backup of `home/`) can claim the name's
// tunnel, so backups are as sensitive as the computer (§7).
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { CertificateStore, readPrivateFile, writePrivateFile } from "../acme/keys.mjs";

export const HOME_KEY_FILE = "home-key.pem";

/** The home key, made and stored on first use. Throws when the stored file
 * isn't an Ed25519 private key: a damaged key must never be silently
 * replaced, because the name is bound to it. */
export async function loadOrCreateHomeKey(dataDirectory) {
  const store = new CertificateStore(dataDirectory);
  await store.ensureDirectory();
  const path = join(store.directory, HOME_KEY_FILE);
  const existing = await readPrivateFile(path);
  if (existing !== null) {
    let key;
    try { key = createPrivateKey(existing); } catch { key = null; }
    if (key?.asymmetricKeyType !== "ed25519")
      throw Object.assign(new Error(`${path} is not an Ed25519 private key. Restore it from a backup; a new key can't take over this home server's name.`), { code: "home_key_invalid" });
    return key;
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  await writePrivateFile(path, privateKey.export({ type: "pkcs8", format: "pem" }));
  return privateKey;
}
