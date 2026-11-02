// Key generation and storage with restrictive permissions (#725, ADR 0025 §10).
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CertificateStore, generateP256Key, publicJwk, spkiSha256, writePrivateFile } from "./keys.mjs";

const posix = process.platform !== "win32";
const mode = (path) => statSync(path).mode & 0o777;

function tempStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "kin-acme-keys-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new CertificateStore(directory) };
}

test("the account key is made once, kept, and written 0600 in a 0700 directory", { skip: !posix && "POSIX modes" }, async (t) => {
  const { store } = tempStore(t);
  const first = await store.accountKey();
  const second = await store.accountKey();
  assert.deepEqual(publicJwk(first), publicJwk(second));
  assert.equal(mode(store.directory), 0o700);
  assert.equal(mode(store.path("acme-account-key.pem")), 0o600);
  assert.equal(first.asymmetricKeyDetails.namedCurve, "prime256v1");
});

test("certificates, the account and history are all 0600, and no temporary files are left", { skip: !posix && "POSIX modes" }, async (t) => {
  const { store } = tempStore(t);
  const key = generateP256Key();
  await store.saveCertificate({ key, chainPem: "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n" });
  await store.saveAccount({ directoryUrl: "https://ca.test/dir", accountUrl: "https://ca.test/acct/1" });
  await store.remember({ spkiSha256: spkiSha256(key), serial: "01", notAfter: null });
  for (const name of readdirSync(store.directory)) assert.equal(mode(store.path(name)), 0o600, name);
  assert.deepEqual(readdirSync(store.directory).sort(), ["acme-account.json", "certificate-history.json", "certificate-key.pem", "certificate.pem"]);
  const loaded = await store.certificate();
  assert.ok(createPublicKey(loaded.key).equals(createPublicKey(key)));
  assert.deepEqual(await store.account(), { directoryUrl: "https://ca.test/dir", accountUrl: "https://ca.test/acct/1" });
  assert.equal((await store.history()).length, 1);
});

test("a key file someone widened is tightened back to 0600 when read", { skip: !posix && "POSIX modes" }, async (t) => {
  const { store } = tempStore(t);
  await store.accountKey();
  chmodSync(store.path("acme-account-key.pem"), 0o644);
  await store.accountKey();
  assert.equal(mode(store.path("acme-account-key.pem")), 0o600);
});

test("a widened home directory is tightened back to 0700", { skip: !posix && "POSIX modes" }, async (t) => {
  const { store } = tempStore(t);
  await store.ensureDirectory();
  chmodSync(store.directory, 0o755);
  await store.accountKey();
  assert.equal(mode(store.directory), 0o700);
});

test("writes replace the file atomically and leave no temporary files", async (t) => {
  const { directory } = tempStore(t);
  const path = join(directory, "file.pem");
  await writePrivateFile(path, "one");
  await writePrivateFile(path, "two");
  const store = new CertificateStore(directory);
  assert.equal(store.directory, join(directory, "home"));
  assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith("file.pem")), ["file.pem"]);
});

test("an empty store has no certificate, account or history", async (t) => {
  const { store } = tempStore(t);
  assert.equal(await store.certificate(), null);
  assert.equal(await store.account(), null);
  assert.deepEqual(await store.history(), []);
});

test("history keeps the newest entries only", async (t) => {
  const { store } = tempStore(t);
  for (let i = 0; i < 5; i += 1) await store.remember({ spkiSha256: String(i), serial: String(i), notAfter: null }, 3);
  assert.deepEqual((await store.history()).map((entry) => entry.serial), ["2", "3", "4"]);
});
