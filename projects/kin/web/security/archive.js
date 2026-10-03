import { LocalVault, serializeProtectedValue, deserializeProtectedValue, VaultError } from "./local-vault.js";
import { EventStore } from "../storage/event-store.js";

export async function exportHouseholdArchive({ store, engine, vault }) {
  await assertCurrentProtection(vault);
  const snapshot = await store.snapshotForArchive();
  const source = await EventStore.securityStatus();
  await assertCurrentProtection(vault);
  const manifest = {
    formatVersion: source.formatVersion, vaultId: source.vaultId, rootVersion: source.rootVersion,
    wrappers: source.wrappers.filter((wrapper) => wrapper.type === "recovery"), verifier: source.verifier,
  };
  if (!manifest.wrappers.length) throw new VaultError("Create a verified recovery path before exporting.");
  const metadata = serializeProtectedValue({ archiveVersion: 1, manifest });
  const envelope = await vault.sealArchive(snapshot, metadata, { rawCiphertext: true });
  await assertCurrentProtection(vault);
  const { ciphertext, ...protection } = envelope;
  // The binary container carries raw ciphertext: base64 would make valid large
  // household histories exceed the archive framing budget unnecessarily.
  const framedMetadata = serializeProtectedValue({ archiveVersion: 1, manifest, protection });
  return engine.encodeArchive(framedMetadata, ciphertext);
}

export async function importHouseholdArchive({ bytes, recoverySecret, engine, vault }) {
  await assertCurrentProtection(vault);
  const { metadata, ciphertext } = engine.decodeArchive(bytes);
  const header = deserializeProtectedValue(metadata);
  if (header.archiveVersion !== 1 || Object.keys(header).sort().join(",") !== "archiveVersion,manifest,protection" ||
      Object.keys(header.protection ?? {}).sort().join(",") !== "nonce,salt,vaultId,version")
    throw new VaultError("This archive version is unsupported.");
  let sourceVault;
  const unsubscribe = vault.onLock(() => sourceVault?.lock());
  try {
    sourceVault = await LocalVault.unlock(header.manifest, recoverySecret);
    await assertCurrentProtection(vault);
    const authenticatedMetadata = serializeProtectedValue({ archiveVersion: 1, manifest: header.manifest });
    const snapshot = await sourceVault.openArchive({ ...header.protection, ciphertext }, authenticatedMetadata, { ownedCiphertext: true });
    await assertCurrentProtection(vault);
    // EventStore validates and replays the whole corpus and rejects a nonempty
    // target inside the same transaction that publishes the imported history.
    return await EventStore.restoreEmpty({ vault, engine, snapshot, ownedSnapshot: true });
  } finally {
    unsubscribe();
    sourceVault?.lock();
  }
}

async function assertCurrentProtection(vault) {
  vault.assertUnlocked();
  // Broadcast delivery is advisory. A tab that missed it must still reject an
  // archive result after a durable lock or root-rotation epoch change.
  await vault.checkSecurityEpoch?.();
  vault.assertUnlocked();
}
