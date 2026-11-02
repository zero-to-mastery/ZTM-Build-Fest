// TLS-ALPN-01 (RFC 8737) answers (#726, ADR 0025 §5).
//
// The CA connects to the name on port 443 with SNI = the name and ALPN
// offering only "acme-tls/1". The home server must negotiate acme-tls/1 and
// present a self-signed certificate that has:
//
//   - subjectAltName with exactly the one dNSName being validated, and
//   - the critical id-pe-acmeIdentifier extension (1.3.6.1.5.5.7.1.31) whose
//     extnValue is the DER of `Authorization ::= OCTET STRING (SIZE (32))`,
//     the SHA-256 of the key authorization (`token.thumbprint`).
//
//   Extension ::= SEQUENCE {
//     06 08 2b 06 01 05 05 07 01 1f      -- OID 1.3.6.1.5.5.7.1.31
//     01 01 ff                            -- critical TRUE
//     04 22 04 20 <32-byte digest> }      -- extnValue { OCTET STRING digest }
//
// The connection carries no application data and is closed after the
// handshake (§3). A fresh key is made for each challenge certificate; it is
// never written to disk and never used for anything else.
import { createHash, createPublicKey } from "node:crypto";
import { createSecureContext } from "node:tls";
import { octetString } from "./der.mjs";
import { generateP256Key } from "./keys.mjs";
import { OID, assertDnsName, buildCertificate, extension, spkiDer, subjectAltNameExtension, toPem } from "./x509.mjs";

export const ACME_TLS_ALPN = "acme-tls/1";

/** SHA-256 of the key authorization, the value the extension carries. */
export const keyAuthorizationDigest = (keyAuthorization) => createHash("sha256").update(String(keyAuthorization), "utf8").digest();

/** The critical acmeIdentifier extension for a key authorization. */
export function acmeIdentifierExtension(keyAuthorization) {
  return extension(OID.acmeIdentifier, octetString(keyAuthorizationDigest(keyAuthorization)), true);
}

/**
 * The self-signed validation certificate for `name` and `keyAuthorization`.
 * Valid from an hour ago (clock skew) for seven days; a challenge lasts
 * minutes.
 *
 * @returns {{ key: import("node:crypto").KeyObject, certificateDer: Buffer, certificatePem: string }}
 */
export function buildChallengeCertificate(name, keyAuthorization, { now = Date.now() } = {}) {
  const host = assertDnsName(name);
  const key = generateP256Key();
  const certificateDer = buildCertificate({
    subjectPublicKeyInfo: spkiDer(createPublicKey(key)),
    subject: host,
    notBefore: now - 60 * 60 * 1000,
    notAfter: now + 7 * 24 * 60 * 60 * 1000,
    extensions: [subjectAltNameExtension([host]), acmeIdentifierExtension(keyAuthorization)],
    signingKey: key,
  });
  return { key, certificateDer, certificatePem: toPem(certificateDer, "CERTIFICATE") };
}

/**
 * The challenge answers the TLS server is currently giving, by name. The ACME
 * flow adds one before it tells the CA to validate and removes it after; the
 * TLS hook (tls-hook.mjs) looks names up here.
 */
export class ChallengeResponder {
  #answers = new Map();

  constructor({ now = Date.now } = {}) { this.now = now; }

  add(name, keyAuthorization) {
    const host = assertDnsName(name);
    const { key, certificatePem } = buildChallengeCertificate(host, keyAuthorization, { now: this.now() });
    this.#answers.set(host, createSecureContext({ key: key.export({ type: "pkcs8", format: "pem" }), cert: certificatePem }));
  }

  remove(name) { this.#answers.delete(String(name).toLowerCase()); }

  /** The SecureContext answering acme-tls/1 for `name`, or null. */
  contextFor(name) { return this.#answers.get(String(name ?? "").toLowerCase()) ?? null; }

  has(name) { return this.#answers.has(String(name ?? "").toLowerCase()); }

  get size() { return this.#answers.size; }
}
