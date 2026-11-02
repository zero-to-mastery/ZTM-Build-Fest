// PKCS#10 certificate signing request (RFC 2986), hand-encoded in DER (#725).
//
// CertificationRequest ::= SEQUENCE {
//   certificationRequestInfo SEQUENCE {
//     version INTEGER (0),
//     subject Name,                      -- CN=<first name> when it fits
//     subjectPKInfo SubjectPublicKeyInfo, -- the certificate key, P-256
//     attributes [0] IMPLICIT SET OF Attribute {
//       extensionRequest (1.2.840.113549.1.9.14) SET { Extensions { subjectAltName } } } },
//   signatureAlgorithm ecdsa-with-SHA256,
//   signature BIT STRING }               -- DER ECDSA-Sig-Value over the info
//
// Let's Encrypt reads only the public key and the names (it takes names from
// SAN and CN); everything else here is the minimum a strict parser accepts.
import { bitString, integer, objectIdentifier, sequence, set, tlv } from "./der.mjs";
import { OID, assertDnsName, distinguishedName, ecdsaSha256Algorithm, signEcdsaSha256, spkiDer, subjectAltNameExtension, toPem } from "./x509.mjs";

/**
 * A DER CSR for `names`, signed with `privateKey` (the certificate's own P-256
 * key: the CSR's signature proves possession of it).
 *
 * @param {{ names: string[], privateKey: import("node:crypto").KeyObject }} options
 * @returns {Buffer}
 */
export function buildCsr({ names, privateKey }) {
  if (!Array.isArray(names) || names.length === 0 || names.length > 100) throw new TypeError("a CSR needs 1–100 names");
  const checked = [...new Set(names.map(assertDnsName))];
  const attributes = tlv(0xa0, // [0] IMPLICIT SET OF Attribute: constructed, context 0
    sequence(objectIdentifier(OID.extensionRequest), set(sequence(subjectAltNameExtension(checked)))));
  const info = sequence(integer(0), distinguishedName(checked[0]), spkiDer(privateKey), attributes);
  return sequence(info, ecdsaSha256Algorithm(), bitString(signEcdsaSha256(privateKey, info)));
}

export const csrPem = (der) => toPem(der, "CERTIFICATE REQUEST");
