// Keys and the home server's certificate files (#725, ADR 0025 §5 and §10).
//
// Everything lives in `<data directory>/home/`, which the home server creates
// readable only by the account Kin runs as:
//
//   home/                          mode 0700
//     acme-account-key.pem         0600  ES256 account key (PKCS#8)
//     acme-account.json            0600  { directoryUrl, accountUrl }
//     certificate-key.pem          0600  the TLS certificate's key (PKCS#8)
//     certificate.pem              0600  the certificate chain, leaf first
//     certificate-history.json     0600  public facts about every certificate
//                                        this server obtained (for the CT check)
//
// No key ever leaves this directory: the ACME client sends only public keys
// (the JWK, the CSR) and signatures. On Windows, `mode` is mostly ignored;
// the installer's ACL (#713) is what restricts access there.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FILE_MODE = 0o600;
export const DIRECTORY_MODE = 0o700;

export const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

/** The public half of a key object, PEM or private key. */
export const publicKeyOf = (key) => (key?.type === "public" ? key : createPublicKey(key));

/** A new ECDSA P-256 private key (for the ACME account and for each
 * certificate). */
export function generateP256Key() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
}

export const privateKeyPem = (key) => key.export({ type: "pkcs8", format: "pem" });

/** The public JWK of a P-256 key with only the members RFC 7638 hashes, in
 * their required order. */
export function publicJwk(key) {
  const { crv, x, y } = publicKeyOf(key).export({ format: "jwk" });
  if (crv !== "P-256") throw new TypeError("ACME keys must be P-256");
  return { crv, kty: "EC", x, y };
}

/** RFC 7638 JWK thumbprint: SHA-256 over the JSON of the required members in
 * lexicographic order with no whitespace, base64url. */
export function jwkThumbprint(key) {
  const { crv, x, y } = publicJwk(key);
  return b64url(createHash("sha256").update(`{"crv":"${crv}","kty":"EC","x":"${x}","y":"${y}"}`).digest());
}

/** SHA-256 of a key's DER SubjectPublicKeyInfo, hex. The CT check compares
 * certificates by this. */
export function spkiSha256(key) {
  return createHash("sha256").update(publicKeyOf(key).export({ type: "spki", format: "der" })).digest("hex");
}

/** Write `data` to `path` with mode 0600, atomically: a fresh temporary file
 * in the same directory (created with `wx`, so it can't follow a planted
 * link), then rename over the target. */
export async function writePrivateFile(path, data) {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, data, { mode: FILE_MODE, flag: "wx" });
    await chmod(temporary, FILE_MODE);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Read a private file, tightening its mode to 0600 first if someone widened
 * it. Returns null when it doesn't exist. */
export async function readPrivateFile(path, encoding = "utf8") {
  let info;
  try { info = await stat(path); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) await chmod(path, FILE_MODE);
  return readFile(path, encoding);
}

/** The home server's certificate store in `<dataDirectory>/home`. */
export class CertificateStore {
  constructor(dataDirectory) {
    if (!dataDirectory) throw new TypeError("a data directory is required");
    this.directory = join(dataDirectory, "home");
  }

  path(name) { return join(this.directory, name); }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
    if (process.platform !== "win32") await chmod(this.directory, DIRECTORY_MODE);
  }

  async #readKey(name) {
    const pem = await readPrivateFile(this.path(name));
    return pem === null ? null : createPrivateKey(pem);
  }

  async #readJson(name) {
    const text = await readPrivateFile(this.path(name));
    return text === null ? null : JSON.parse(text);
  }

  async #writeJson(name, value) {
    await this.ensureDirectory();
    await writePrivateFile(this.path(name), `${JSON.stringify(value, null, 2)}\n`);
  }

  /** The ACME account key, made and stored on first use. */
  async accountKey() {
    const existing = await this.#readKey("acme-account-key.pem");
    if (existing) return existing;
    const key = generateP256Key();
    await this.ensureDirectory();
    await writePrivateFile(this.path("acme-account-key.pem"), privateKeyPem(key));
    return key;
  }

  /** { directoryUrl, accountUrl } or null. */
  account() { return this.#readJson("acme-account.json"); }
  saveAccount(account) { return this.#writeJson("acme-account.json", { directoryUrl: account.directoryUrl, accountUrl: account.accountUrl }); }

  /** { key, chainPem } for the current certificate, or null. */
  async certificate() {
    const [key, chainPem] = await Promise.all([this.#readKey("certificate-key.pem"), readPrivateFile(this.path("certificate.pem"))]);
    return key && chainPem ? { key, chainPem } : null;
  }

  /** Store a new certificate and its key. The key is written first, so a
   * crash in between leaves the old chain with a key that doesn't match it;
   * `certificate()` callers check the pair (renewal.mjs) and renew. */
  async saveCertificate({ key, chainPem }) {
    await this.ensureDirectory();
    await writePrivateFile(this.path("certificate-key.pem"), privateKeyPem(key));
    await writePrivateFile(this.path("certificate.pem"), chainPem);
  }

  /** Public facts about the certificates this server obtained:
   * [{ spkiSha256, serial, notAfter }], newest last. */
  async history() { return (await this.#readJson("certificate-history.json"))?.certificates ?? []; }

  async remember(entry, limit = 200) {
    const certificates = [...await this.history(), entry].slice(-limit);
    await this.#writeJson("certificate-history.json", { certificates });
  }
}
