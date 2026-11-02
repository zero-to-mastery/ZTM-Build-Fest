// Exports that open with the account backup code (#572, PORTABILITY): the
// export's extra root wrapper, opened offline from the code alone, beside
// (and after) a device's own backup key, which keeps working.
import assert from "node:assert/strict";
import test from "node:test";
import { generateVaultKey } from "./account-vault.js";
import { backupCodeChange, wrapperChangeBody } from "./account-wrappers.js";
import { backupCodeExportWrapper, manifestBackupCode, openArchiveVault } from "./archive.js";
import { generateBackupCode } from "./backup-code.js";
import { manifestRecoveryLabels } from "./key-label.js";
import { LocalVault, validateManifest } from "./local-vault.js";

const householdId = "a".repeat(32);
const memberId = "b".repeat(32);

/** The member's backup-code wrapper as the service sends it. */
async function accountCode() {
  const vaultKey = generateVaultKey();
  const code = await generateBackupCode();
  const change = await backupCodeChange({ vaultKey, householdId, memberId, wrappers: [], codeBytes: code.bytes });
  const [wrapper] = wrapperChangeBody(change).put;
  const { verifier: _verifier, ...params } = wrapper.params;
  return { vaultKey, code, wrapper: { ...wrapper, params } };
}

/** An export manifest as exportHouseholdArchive builds it. */
async function exportManifest(source, recoveryWrappers, backupCode) {
  const manifest = { formatVersion: source.manifest.formatVersion, vaultId: source.vault.vaultId, rootVersion: source.vault.rootVersion,
    wrappers: [...recoveryWrappers], verifier: source.manifest.verifier };
  if (backupCode) manifest.wrappers.push(await backupCodeExportWrapper(source.vault, backupCode));
  return manifest;
}

test("an export from a device with no backup key opens with the account backup code alone", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const source = await LocalVault.createWithPasskey(secret, { credentialId: "credential-A", prfSalt: "salt-A" });
  const sealed = await source.vault.seal({ text: "milk" }, { store: "events", id: "one" });
  const account = await accountCode();
  const manifest = await exportManifest(source, [], { vaultKey: account.vaultKey, householdId, memberId, wrapper: account.wrapper });
  source.vault.lock();
  validateManifest(manifest);
  assert.ok(manifestBackupCode(manifest), "the export says it opens with a backup code");
  assert.deepEqual(await manifestRecoveryLabels(manifest), [], "no device key label for the code's wrapper");
  assert.equal(JSON.stringify(manifest).includes(account.code.text.replaceAll("-", "")), false, "the code isn't in the export");

  const opened = await openArchiveVault(manifest, account.code.text.toLowerCase());
  assert.deepEqual(await opened.open(sealed, { store: "events", id: "one" }), { text: "milk" });
  opened.lock();
  // Another code, or a device backup key, doesn't open it.
  const other = await generateBackupCode();
  await assert.rejects(openArchiveVault(manifest, other.text), { code: "archive_key_mismatch", message: /backup code that was current/ });
  await assert.rejects(openArchiveVault(manifest, "a".repeat(64)), { code: "archive_key_mismatch", message: /account's backup code/ });
  // Its embedded wrapper is bound to the member: moving it to another member fails.
  const moved = structuredClone(manifest);
  moved.wrappers[0].backupCode.memberId = "c".repeat(32);
  await assert.rejects(openArchiveVault(moved, account.code.text), { code: "archive_key_mismatch" });
});

test("a device that has its own backup key: either opens the export, and older Kin still finds the device key first", async () => {
  const recovery = "0123456789abcdef".repeat(4);
  const source = await LocalVault.create(recovery);
  const account = await accountCode();
  const manifest = await exportManifest(source, source.manifest.wrappers.filter((wrapper) => wrapper.type === "recovery"),
    { vaultKey: account.vaultKey, householdId, memberId, wrapper: account.wrapper });
  source.vault.lock();
  assert.equal(manifest.wrappers[0].backupCode, undefined, "the device's key comes first");
  assert.equal((await manifestRecoveryLabels(manifest)).length, 1);
  (await openArchiveVault(manifest, recovery)).lock();
  (await openArchiveVault(manifest, account.code.text)).lock();
  // An export from before #572 is untouched: the backup key, as before.
  const old = await exportManifest(await LocalVault.create(recovery), [], null);
  assert.equal(manifestBackupCode(old), null);
});
