// Issue #160 (C1): recovery key labels tie exports to the key that opens them.
import assert from "node:assert/strict";
import test from "node:test";
import { openArchiveVault } from "./archive.js";
import { EXPORT_STORAGE_RULE, exportFileName, joinLabels, manifestRecoveryLabels, recoveryKeyLabel } from "./key-label.js";
import { LocalVault, randomRecoverySecret } from "./local-vault.js";

const ID = "0123456789abcdef0123456789abcdef";

test("a label is stable, short, and depends on the wrapper and root version", async () => {
  const label = await recoveryKeyLabel(ID, 1);
  assert.match(label, /^K-[0-9A-F]{4}$/);
  assert.equal(await recoveryKeyLabel(ID, 1), label, "stable");
  assert.notEqual(await recoveryKeyLabel(ID, 2), label, "a new root version gets a new label");
  assert.notEqual(await recoveryKeyLabel("f".repeat(32), 1), label, "another wrapper gets a new label");
  await assert.rejects(recoveryKeyLabel("not-an-id", 1), TypeError);
  await assert.rejects(recoveryKeyLabel(ID, 0), TypeError);
});

test("a label is derived only from public manifest fields, never the key", async () => {
  const secret = randomRecoverySecret();
  const { vault, manifest } = await LocalVault.create(secret);
  try {
    const [label] = await manifestRecoveryLabels(manifest);
    assert.equal(label, await recoveryKeyLabel(manifest.wrappers[0].id, manifest.rootVersion));
    // Another key with the same wrapper ID and root version gets the same
    // label, so the label carries no information about the key.
    const other = await LocalVault.create(randomRecoverySecret(), { recoveryWrapperId: manifest.wrappers[0].id });
    try {
      assert.deepEqual(await manifestRecoveryLabels(other.manifest), [label]);
    } finally { other.vault.lock(); }
  } finally { vault.lock(); }
});

test("a key's label is known before its vault exists, as the setup screen shows it", async () => {
  const wrapperId = LocalVault.newWrapperId();
  const shown = await recoveryKeyLabel(wrapperId, 1);
  const { vault, manifest } = await LocalVault.create(randomRecoverySecret(), { recoveryWrapperId: wrapperId });
  try {
    assert.deepEqual(await manifestRecoveryLabels(manifest), [shown]);
    const rotated = await LocalVault.createRotation(vault, randomRecoverySecret(), { recoveryWrapperId: LocalVault.newWrapperId() });
    try {
      assert.deepEqual(await manifestRecoveryLabels(rotated.manifest), [await recoveryKeyLabel(rotated.manifest.wrappers[0].id, 2)]);
    } finally { rotated.vault.lock(); }
  } finally { vault.lock(); }
});

test("export file names carry the date and the label", () => {
  assert.equal(exportFileName("2026-10-16T23:59:00.000Z", "K-7F3A"), "kin-2026-10-16-K-7F3A.kin");
  assert.equal(exportFileName("2026-01-02T00:00:00.000Z"), "kin-2026-01-02.kin");
  assert.throws(() => exportFileName("not a date", "K-7F3A"), TypeError);
  assert.equal(joinLabels(["K-0001", "K-0002"]), "K-0001 or K-0002");
  assert.match(EXPORT_STORAGE_RULE, /different places/);
});

test("after a key replacement, an older export's wrong-key error names the old label; the right key opens it", async () => {
  const oldSecret = randomRecoverySecret();
  const original = await LocalVault.create(oldSecret);
  const exportManifest = structuredClone(original.manifest);
  const [oldLabel] = await manifestRecoveryLabels(exportManifest);
  const newSecret = randomRecoverySecret();
  const rotated = await LocalVault.createRotation(original.vault, newSecret);
  const [newLabel] = await manifestRecoveryLabels(rotated.manifest);
  try {
    await assert.rejects(openArchiveVault(exportManifest, newSecret), (error) =>
      error.code === "archive_key_mismatch" && error.message.includes(oldLabel) &&
      (oldLabel === newLabel || !error.message.includes(newLabel)));
    const opened = await openArchiveVault(exportManifest, oldSecret);
    assert.equal(opened.vaultId, exportManifest.vaultId);
    opened.lock();
  } finally {
    original.vault.lock();
    rotated.vault.lock();
  }
});

test("the restore preview refuses an unbounded header instead of hashing it", async () => {
  const { validateManifest } = await import("./local-vault.js");
  const wrappers = Array.from({ length: 17 }, (_, index) => ({ version: 1, id: index.toString(16).padStart(32, "0"), type: "recovery", sealed: {} }));
  assert.throws(() => validateManifest({ formatVersion: 1, vaultId: ID, rootVersion: 1, wrappers, verifier: {} }));
});
