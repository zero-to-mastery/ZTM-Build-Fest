// DER writer, CSR and challenge certificate (#725, #726). Fixed vectors are in
// docs/TEST-VECTORS.md, "Home server certificates (#723)".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate, createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { certificateExtensions, parseCsr } from "./acme-test-server.mjs";
import { buildCsr, csrPem } from "./csr.mjs";
import {
  bitString, decodeObjectIdentifier, ecdsaRawToDer, encodeLength, integer, objectIdentifier, readChildren, readTlv, time, tlv,
} from "./der.mjs";
import { generateP256Key, jwkThumbprint } from "./keys.mjs";
import { acmeIdentifierExtension, buildChallengeCertificate, keyAuthorizationDigest } from "./tls-alpn.mjs";
import { OID, assertDnsName, fromPemAll } from "./x509.mjs";

// RFC 7515 Appendix A.3 (the ES256 example key).
const RFC7515_KEY = createPrivateKey({
  key: { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0", d: "jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI" },
  format: "jwk",
});
const VECTOR_NAME = "fern.home.kin.journeytocode.io";
const VECTOR_TOKEN = "evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const opensslAvailable = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

test("DER lengths: short form below 128, long form with minimal bytes", () => {
  assert.equal(hex(encodeLength(0)), "00");
  assert.equal(hex(encodeLength(127)), "7f");
  assert.equal(hex(encodeLength(128)), "8180");
  assert.equal(hex(encodeLength(300)), "82012c");
  assert.equal(hex(encodeLength(65_536)), "83010000");
  assert.throws(() => encodeLength(-1), RangeError);
});

test("DER INTEGERs are minimal two's complement and positive", () => {
  assert.equal(hex(integer(0)), "020100");
  assert.equal(hex(integer(127)), "02017f");
  assert.equal(hex(integer(128)), "02020080");
  assert.equal(hex(integer(256)), "02020100");
  assert.equal(hex(integer(Buffer.from("0000ff", "hex"))), "020200ff");
  assert.equal(hex(integer(Buffer.from("000001", "hex"))), "020101");
  assert.throws(() => integer(-1n), RangeError);
});

test("OBJECT IDENTIFIERs encode and decode", () => {
  assert.equal(hex(objectIdentifier("1.3.6.1.5.5.7.1.31")), "06082b0601050507011f");
  assert.equal(hex(objectIdentifier("1.2.840.10045.4.3.2")), "06082a8648ce3d040302");
  assert.equal(hex(objectIdentifier("2.5.29.17")), "0603551d11");
  assert.equal(hex(objectIdentifier("1.2.840.113549.1.9.14")), "06092a864886f70d01090e");
  for (const oid of Object.values(OID)) assert.equal(decodeObjectIdentifier(readTlv(objectIdentifier(oid)).value), oid);
  assert.throws(() => objectIdentifier("3.1"), RangeError);
  assert.throws(() => objectIdentifier("1.40"), RangeError);
});

test("times: UTCTime before 2050, GeneralizedTime from 2050", () => {
  assert.equal(readTlv(time(Date.UTC(2026, 9, 22, 8, 5, 9))).value.toString(), "261022080509Z");
  assert.equal(readTlv(time(Date.UTC(2026, 9, 22))).tag, 0x17);
  const late = readTlv(time(Date.UTC(2050, 0, 1)));
  assert.equal(late.tag, 0x18);
  assert.equal(late.value.toString(), "20500101000000Z");
});

test("the reader refuses truncated, non-minimal and overlong input", () => {
  assert.throws(() => readTlv(Buffer.from("3005020100", "hex")), /past the input/);
  assert.throws(() => readTlv(Buffer.from("30", "hex")), /truncated/);
  assert.throws(() => readTlv(Buffer.from("30817f", "hex")), /not minimal/);
  assert.throws(() => readChildren(Buffer.from("020100ff", "hex")), RangeError);
  const nested = tlv(0x30, integer(1), bitString(Buffer.from([1, 2])));
  assert.deepEqual(readChildren(readTlv(nested).value).map((item) => item.tag), [0x02, 0x03]);
});

test("ECDSA P1363 signatures re-encode as DER that node:crypto verifies", () => {
  for (let i = 0; i < 64; i += 1) {
    const key = generateP256Key();
    const data = Buffer.from(`message ${i}`);
    const der = ecdsaRawToDer(sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }));
    assert.ok(verify("sha256", data, key, der), `signature ${i}`);
  }
  assert.throws(() => ecdsaRawToDer(Buffer.alloc(63)), RangeError);
});

test("DNS names: LDH labels only, no wildcard, no trailing dot", () => {
  assert.equal(assertDnsName("Fern.Home.Kin.Test"), "fern.home.kin.test");
  for (const bad of ["*.kin.test", "kin.test.", "-a.kin.test", "a_b.kin.test", "localhost", "", `${"a".repeat(64)}.test`]) {
    assert.throws(() => assertDnsName(bad), TypeError, bad);
  }
});

test("vector: the RFC 7515 A.3 key's JWK thumbprint (RFC 7638)", () => {
  assert.equal(jwkThumbprint(RFC7515_KEY), "oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U");
  // Independent: hash the canonical JSON written out by hand.
  const { x, y } = RFC7515_KEY.export({ format: "jwk" });
  assert.equal(createHash("sha256").update(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`).digest("base64url"), jwkThumbprint(RFC7515_KEY));
});

test("vector: the CSR's CertificationRequestInfo is fixed for a fixed key and name", () => {
  const csr = buildCsr({ names: [VECTOR_NAME], privateKey: RFC7515_KEY });
  const [info, algorithm, signature] = readChildren(readTlv(csr).value);
  assert.equal(info.raw.length, 202);
  assert.equal(createHash("sha256").update(info.raw).digest("hex"), "2e822352b116789e6ec7f3a1cd998352c9ac6acd69ebe469633e01758eedfa1a");
  assert.equal(hex(algorithm.raw), "300a06082a8648ce3d040302");
  assert.equal(signature.value[0], 0, "no unused bits");
  assert.ok(verify("sha256", info.raw, RFC7515_KEY, signature.value.subarray(1)), "signed by the certificate key");
});

test("CSRs carry the key and every name, and verify", () => {
  const key = generateP256Key();
  const names = ["fern.home.kin.test", "www.fern.example.org"];
  const parsed = parseCsr(buildCsr({ names, privateKey: key }));
  assert.deepEqual(parsed.names, names);
  assert.ok(parsed.publicKey.equals(createPublicKey(key)));
  assert.ok(verify("sha256", parsed.info, parsed.publicKey, parsed.signature));
  // A long name leaves the subject empty and stays in the SAN only.
  const long = `${"a".repeat(60)}.${"b".repeat(10)}.test`;
  assert.deepEqual(parseCsr(buildCsr({ names: [long], privateKey: key })).names, [long]);
  assert.throws(() => buildCsr({ names: [], privateKey: key }), TypeError);
  assert.throws(() => buildCsr({ names: ["*.kin.test"], privateKey: key }), TypeError);
});

test("openssl accepts the CSR (openssl req -verify), when openssl is installed", { skip: !opensslAvailable && "openssl not installed" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "kin-csr-"));
  try {
    for (const names of [[VECTOR_NAME], ["fern.home.kin.test", "www.fern.example.org"], [`${"a".repeat(60)}.${"b".repeat(10)}.test`]]) {
      const path = join(directory, "request.csr");
      writeFileSync(path, csrPem(buildCsr({ names, privateKey: generateP256Key() })));
      const result = spawnSync("openssl", ["req", "-in", path, "-verify", "-noout", "-text"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(`${result.stdout}${result.stderr}`, /verify OK/);
      for (const name of names) assert.match(result.stdout, new RegExp(`DNS:${name.replaceAll(".", "\\.")}`));
      assert.match(result.stdout, /ecdsa-with-SHA256/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("vector: the acmeIdentifier extension for a fixed key authorization", () => {
  const keyAuthorization = `${VECTOR_TOKEN}.${jwkThumbprint(RFC7515_KEY)}`;
  assert.equal(hex(keyAuthorizationDigest(keyAuthorization)), "65a26016d215e16034b7633337b91b4a4d2c7d17761998dac51a9a49300aea52");
  assert.equal(hex(acmeIdentifierExtension(keyAuthorization)),
    "3031" + "06082b0601050507011f" + "0101ff" + "04220420" + "65a26016d215e16034b7633337b91b4a4d2c7d17761998dac51a9a49300aea52");
});

test("the challenge certificate: self-signed, one dNSName, critical acmeIdentifier", () => {
  const keyAuthorization = `${VECTOR_TOKEN}.${jwkThumbprint(generateP256Key())}`;
  const now = Date.UTC(2026, 9, 22, 12);
  const { key, certificateDer, certificatePem } = buildChallengeCertificate("Fern.Home.Kin.Test", keyAuthorization, { now });
  const certificate = new X509Certificate(certificateDer);
  assert.equal(certificate.subjectAltName, "DNS:fern.home.kin.test");
  assert.ok(certificate.verify(certificate.publicKey), "self-signed");
  assert.ok(certificate.checkPrivateKey(key));
  assert.equal(Date.parse(certificate.validFrom), now - 3_600_000);
  assert.deepEqual(fromPemAll(certificatePem), [certificateDer]);
  const identifier = certificateExtensions(certificateDer).find((item) => item.oid === OID.acmeIdentifier);
  assert.ok(identifier.critical);
  assert.equal(hex(identifier.value), `0420${hex(keyAuthorizationDigest(keyAuthorization))}`);
});

test("openssl reads the challenge certificate and its critical extension, when installed", { skip: !opensslAvailable && "openssl not installed" }, () => {
  const { certificatePem } = buildChallengeCertificate("fern.home.kin.test", `${VECTOR_TOKEN}.x`);
  const result = spawnSync("openssl", ["x509", "-noout", "-text"], { input: certificatePem, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\.3\.6\.1\.5\.5\.7\.1\.31: critical/);
  assert.match(result.stdout, /DNS:fern\.home\.kin\.test/);
});
