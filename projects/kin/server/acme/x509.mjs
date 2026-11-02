// X.509 building blocks on the DER writer (#725, #726): names, extensions,
// ECDSA P-256 / SHA-256 signing, and a certificate builder used for the
// TLS-ALPN-01 challenge certificate (and by the tests' ACME server to issue).
//
// Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature BIT STRING }
// TBSCertificate ::= SEQUENCE {
//   [0] EXPLICIT version (2 = v3), serialNumber INTEGER, signature AlgorithmIdentifier,
//   issuer Name, validity SEQUENCE { notBefore, notAfter }, subject Name,
//   subjectPublicKeyInfo, [3] EXPLICIT extensions SEQUENCE OF Extension }
// (RFC 5280 §4.1)
import { createPublicKey, randomBytes, sign } from "node:crypto";
import {
  bitString, boolean, decodeObjectIdentifier, ecdsaRawToDer, explicit, ia5String, implicitPrimitive, integer,
  objectIdentifier, octetString, readChildren, readTlv, sequence, set, time, utf8String,
} from "./der.mjs";

export const OID = Object.freeze({
  commonName: "2.5.4.3",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  subjectKeyIdentifier: "2.5.29.14",
  subjectAltName: "2.5.29.17",
  authorityKeyIdentifier: "2.5.29.35",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  extensionRequest: "1.2.840.113549.1.9.14",
  acmeIdentifier: "1.3.6.1.5.5.7.1.31",
});

/** A DNS name Kin will put in a certificate: lowercase LDH labels of 1–63
 * characters, 1–253 in all, no trailing dot, at least two labels, no
 * wildcard. Returns the lowercased name or throws. */
export function assertDnsName(value) {
  const name = String(value ?? "").toLowerCase();
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  if (name.length < 1 || name.length > 253 || !name.includes(".") || !name.split(".").every((part) => label.test(part))) {
    throw new TypeError("not a valid DNS name for a certificate");
  }
  return name;
}

/** AlgorithmIdentifier for ecdsa-with-SHA256: the OID alone, parameters
 * absent (RFC 5758 §3.2). */
export const ecdsaSha256Algorithm = () => sequence(objectIdentifier(OID.ecdsaWithSha256));

/** A Name with at most one RDN, CN=<commonName> as UTF8String; an empty
 * SEQUENCE when `commonName` is empty. A CN is limited to 64 characters
 * (RFC 5280 ub-common-name), so longer names leave the subject empty and rely
 * on subjectAltName, as RFC 5280 §4.2.1.6 allows. */
export function distinguishedName(commonName = "") {
  if (!commonName || commonName.length > 64) return sequence();
  return sequence(set(sequence(objectIdentifier(OID.commonName), utf8String(commonName))));
}

/** Extension ::= SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE, extnValue
 * OCTET STRING }; DER omits `critical` when false. */
export function extension(oid, valueDer, critical = false) {
  return critical
    ? sequence(objectIdentifier(oid), boolean(true), octetString(valueDer))
    : sequence(objectIdentifier(oid), octetString(valueDer));
}

/** subjectAltName with one dNSName ([2] IMPLICIT IA5String) per name. */
export function subjectAltNameExtension(names) {
  return extension(OID.subjectAltName, sequence(...names.map((name) => implicitPrimitive(2, Buffer.from(assertDnsName(name), "ascii")))));
}

/** subjectKeyIdentifier: KeyIdentifier ::= OCTET STRING (RFC 5280 §4.2.1.2). */
export const subjectKeyIdentifierExtension = (keyIdentifier) => extension(OID.subjectKeyIdentifier, octetString(keyIdentifier));

/** authorityKeyIdentifier ::= SEQUENCE { keyIdentifier [0] IMPLICIT
 * KeyIdentifier OPTIONAL, … } with only the keyIdentifier (RFC 5280
 * §4.2.1.1), which is what Let's Encrypt and most CAs write. */
export const authorityKeyIdentifierExtension = (keyIdentifier) => extension(OID.authorityKeyIdentifier, sequence(implicitPrimitive(0, keyIdentifier)));

/** SHA-256 ECDSA over `data` with a P-256 private key, DER-encoded. Node
 * signs in P1363 form here and the DER is written by `ecdsaRawToDer`, so the
 * encoding on the wire is Kin's own. */
export function signEcdsaSha256(privateKey, data) {
  return ecdsaRawToDer(sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" }));
}

/** The DER SubjectPublicKeyInfo of a key object (public or private). */
export function spkiDer(key) {
  return (key?.type === "public" ? key : createPublicKey(key)).export({ type: "spki", format: "der" });
}

/** A positive serial number of 16 random bytes (RFC 5280 allows up to 20). */
export function randomSerial() {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  if (bytes[0] === 0) bytes[0] = 1;
  return bytes;
}

/**
 * A DER X.509 v3 certificate.
 *
 * @param {object} options
 * @param {Buffer} options.subjectPublicKeyInfo DER SPKI of the certified key
 * @param {string} [options.subject] subject common name ("" for empty)
 * @param {string} [options.issuer] issuer common name (defaults to subject)
 * @param {Buffer} [options.serial] serial number bytes
 * @param {Date|number} options.notBefore
 * @param {Date|number} options.notAfter
 * @param {Buffer[]} [options.extensions] complete Extension TLVs
 * @param {import("node:crypto").KeyObject} options.signingKey P-256 private key
 */
export function buildCertificate({ subjectPublicKeyInfo, subject = "", issuer = subject, serial = randomSerial(), notBefore, notAfter, extensions = [], signingKey }) {
  const algorithm = ecdsaSha256Algorithm();
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial),
    algorithm,
    distinguishedName(issuer),
    sequence(time(notBefore), time(notAfter)),
    distinguishedName(subject),
    Buffer.from(subjectPublicKeyInfo),
    ...(extensions.length ? [explicit(3, sequence(...extensions))] : []),
  );
  return sequence(tbs, algorithm, bitString(signEcdsaSha256(signingKey, tbs)));
}

/** DER to PEM with 64-character lines. */
export function toPem(der, label) {
  const body = Buffer.from(der).toString("base64").replace(/.{1,64}/g, "$&\n");
  return `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
}

/** Every PEM block with `label` in `text`, as DER buffers. */
export function fromPemAll(text, label = "CERTIFICATE") {
  const pattern = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+?)-----END ${label}-----`, "g");
  return [...String(text).matchAll(pattern)].map((match) => Buffer.from(match[1].replace(/\s+/g, ""), "base64"));
}

// ---- Reading certificates ------------------------------------------------------

/** The two TBSCertificate fields Kin reads from a DER certificate, as views
 * into `der` (nothing is copied):
 *
 *   serial      the serialNumber INTEGER's content octets, exactly as encoded
 *               (with the leading 0x00 a positive number whose top bit is set
 *               carries in DER);
 *   extensions  [{ oid, critical, value }], `value` being extnValue's content.
 *
 * TBSCertificate starts `[0] EXPLICIT version` (absent for v1), then
 * `serialNumber`, so the serial is the first or second child. Throws a
 * RangeError on anything that isn't that shape. */
export function readCertificate(der) {
  const bytes = Buffer.isBuffer(der) ? der : Buffer.from(der.buffer, der.byteOffset, der.byteLength);
  const certificate = readTlv(bytes);
  if (certificate.tag !== 0x30 || certificate.end !== bytes.length) throw new RangeError("not a DER certificate");
  const [tbs] = readChildren(certificate.value);
  if (tbs?.tag !== 0x30) throw new RangeError("not a DER certificate");
  const fields = readChildren(tbs.value);
  const serialField = fields[fields[0]?.tag === 0xa0 ? 1 : 0];
  if (serialField?.tag !== 0x02 || serialField.length === 0) throw new RangeError("certificate has no serial number");
  const extensionsField = fields.find((item) => item.tag === 0xa3);
  const extensions = [];
  if (extensionsField) {
    const [list] = readChildren(extensionsField.value);
    if (list?.tag !== 0x30) throw new RangeError("malformed certificate extensions");
    for (const item of readChildren(list.value)) {
      const parts = readChildren(item.value);
      const value = parts[parts.length - 1];
      if (parts.length < 2 || parts[0].tag !== 0x06 || value.tag !== 0x04) throw new RangeError("malformed certificate extension");
      const critical = parts.length === 3 && parts[1].tag === 0x01 && parts[1].value[0] === 0xff;
      extensions.push({ oid: decodeObjectIdentifier(parts[0].value), critical, value: value.value });
    }
  }
  return { serial: serialField.value, extensions };
}

/** The authorityKeyIdentifier's keyIdentifier ([0] IMPLICIT OCTET STRING,
 * tag 0x80) of a DER certificate, or null when it has none. */
export function authorityKeyIdentifier(der) {
  const aki = readCertificate(der).extensions.find((item) => item.oid === OID.authorityKeyIdentifier);
  if (!aki) return null;
  const [body] = readChildren(aki.value);
  if (body?.tag !== 0x30) throw new RangeError("malformed authorityKeyIdentifier");
  const keyIdentifier = readChildren(body.value).find((item) => item.tag === 0x80);
  return keyIdentifier && keyIdentifier.length > 0 ? keyIdentifier.value : null;
}

/** The ARI certificate identifier (RFC 9773 §4.1): base64url (no padding) of
 * the AKI keyIdentifier octets, ".", base64url of the serial number's DER
 * content octets (leading zero included). */
export function ariCertificateIdentifier(keyIdentifier, serial) {
  if (!keyIdentifier?.length || !serial?.length) throw new RangeError("an ARI identifier needs a key identifier and a serial");
  return `${Buffer.from(keyIdentifier).toString("base64url")}.${Buffer.from(serial).toString("base64url")}`;
}

/** The ARI identifier of a DER certificate, or null when it has no
 * authorityKeyIdentifier keyIdentifier (then ARI can't name it). */
export function certificateIdentifier(der) {
  const keyIdentifier = authorityKeyIdentifier(der);
  return keyIdentifier ? ariCertificateIdentifier(keyIdentifier, readCertificate(der).serial) : null;
}
