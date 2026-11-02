// Encrypted household archives (.kin): export, then validate and restore.
//
// Kin writes package format 3 (security/archive-stream.js): the household
// sealed as a stream of segments, 256 events per segment, inside the KARC v1
// container. It still reads package format 2 (one sealed value holding the
// whole snapshot), which v0.47 and earlier wrote.
//
// Both formats decode to the same "archive parts" (event-store.js): the
// local context row, the attachment records and the history as a view of an
// event arena. Validation, staging and restore work on parts, so the
// history is held once, as canonical bytes in one arena.
import { LocalVault, validateManifest, serializeProtectedValue, deserializeProtectedValue, VaultError, fromBase64Url, toBase64Url } from "./local-vault.js";
import { EventStore } from "../storage/event-store.js";
import { readArchive, writeArchive } from "./archive-stream.js";
import { manifestRecoveryLabels } from "./key-label.js";
import { backupCodeKek, exportUnlockSecret, unwrapVaultKey } from "./account-vault.js";
import { looksLikeBackupCode, parseBackupCode } from "./backup-code.js";
import {
  appendChatBlob, appendChatEvents, blobSegment, blobSegmentLength, chatBlobBudget, chatEventsView, chooseChatBlobs,
  discardChatSection, importChatSection, MAX_ARCHIVE_CHAT_BLOBS, MAX_ARCHIVE_CHAT_EVENTS, openChatSection, validateChatSection,
} from "../chat/chat-archive.js";
import { appendBoardEvents, boardEventsView, discardBoardSection, importBoardSection, MAX_ARCHIVE_BOARD_EVENTS, openBoardSection, validateBoardSection } from "../board/board-archive.js";

const KIN_VERSION = "1.6.0";
const PACKAGE_FORMAT = 3;
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_EVENT_COUNT = 10_000;
const MAX_ATTACHMENT_COUNT = 64;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const stagedArchives = new WeakMap();
// The chat section of an archive's parts (#136), kept apart: the parts are
// checked against the household store's exact field list.
const chatSections = new WeakMap();
// The fridge section (#363), kept apart the same way.
const boardSections = new WeakMap();

/**
 * The household as a package-format-3 archive. `onProgress({ done, total })`
 * reports events sealed. The history is read from the store's session arena
 * and sealed a chunk at a time into an output allocated once.
 *
 * `chat` (a ChatRoom.chatExportPlan(), #136) adds the household chat: its
 * events, and as many of its blobs as fit under the archive size limit,
 * newest first. `report`, if given, is filled with what went in:
 * `{ chatEvents, chatBlobs, chatBlobsSkipped, boardEvents }`.
 *
 * `board` (a BoardRoom.exportPlan(), #363) adds the family fridge's events.
 */
/**
 * A sync ID from the local context as lowercase hex, or null. The context
 * keeps sync IDs as 16 bytes (event-store.js); hex is accepted as well. The
 * chat and fridge sections once tested for hex only, so a synced household's
 * export refused its own chat and fridge (#372).
 */
function syncId(value) {
  if (typeof value === "string") return /^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value) ? value : null;
  if (!(value instanceof Uint8Array) || value.length !== 16 || !value.some(Boolean)) return null;
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function exportHouseholdArchive({ store, engine, vault, portableMembership, chat = null, board = null, report = null, backupCode = null, onProgress }) {
  await assertCurrentProtection(vault);
  const parts = await store.archiveParts({ portableMembership });
  const context = parts.local_context[0];
  if (context?.sync_household_id && !Array.isArray(context?.portable_membership))
    throw new VaultError("Connect to your household before exporting so its membership history can be included.");
  const source = await EventStore.securityStatus();
  await assertCurrentProtection(vault);
  const manifest = {
    formatVersion: source.formatVersion, vaultId: source.vaultId, rootVersion: source.rootVersion,
    wrappers: source.wrappers.filter((wrapper) => wrapper.type === "recovery" && !wrapper.backupCode), verifier: source.verifier,
  };
  // An export opens with this device's backup key, and, for a member with
  // an account backup code (#572), with that code: one more recovery-type
  // wrapper, after the device's, carrying the code's vault wrapper
  // (backupCodeExportWrapper). Older Kin sees an ordinary recovery wrapper
  // it can't open, and still opens the device's key, which comes first.
  if (backupCode) manifest.wrappers.push(await backupCodeExportWrapper(vault, backupCode));
  if (!manifest.wrappers.length)
    throw new VaultError(source.wrappers.some((wrapper) => wrapper.type === "password" || wrapper.type === "prf")
      ? "Make a backup code for your account first (Security → Backup code): exports from this device open with it. Your household stays on this device and syncs as usual."
      : "Create a verified recovery path before exporting.");
  const household = await EventStore.validateArchiveParts({ parts, engine, vault });
  let included = null;
  if (chat?.view?.length > 0) {
    if (!syncId(context?.sync_household_id))
      throw new VaultError("Connect to your household before exporting its chat.");
    // Everything below comes from the plan's own snapshot of the chat, so the
    // counts in the manifest are the events the stream carries.
    const view = chatEventsView(chat.view);
    if (view.length > MAX_ARCHIVE_CHAT_EVENTS) throw new VaultError("This household's chat is too large to export.");
    let householdBytes = 0;
    for (let index = 0; index < parts.history.length; index += 1) householdBytes += parts.history.recordLength(index) + 12;
    householdBytes += Math.ceil(household.attachmentBytes * 1.4) + 4096;
    let chatEventBytes = 0;
    for (let index = 0; index < view.length; index += 1) chatEventBytes += view.recordLength(index) + 12;
    if (householdBytes + chatEventBytes + 4 * 1024 * 1024 > MAX_ARCHIVE_BYTES)
      throw new VaultError("The chat is too large to include. Export without chat.");
    const choice = chooseChatBlobs(chat.blobs, chatBlobBudget(MAX_ARCHIVE_BYTES, householdBytes + chatEventBytes));
    included = { choice, view };
  }
  let boardView = null;
  if (board?.view?.length > 0) {
    if (!syncId(context?.sync_household_id))
      throw new VaultError("Connect to your household before exporting its fridge.");
    boardView = boardEventsView(board.view);
    if (boardView.length > MAX_ARCHIVE_BOARD_EVENTS) throw new VaultError("This household's fridge is too large to export.");
  }
  if (report) Object.assign(report, { chatEvents: included ? included.view.length : 0, chatBlobs: included?.choice.chosen.length ?? 0, chatBlobsSkipped: included?.choice.skipped ?? 0, boardEvents: boardView?.length ?? 0 });
  const packageManifest = {
    packageFormatVersion: PACKAGE_FORMAT,
    kinVersion: KIN_VERSION,
    exportedAt: new Date().toISOString(),
    eventCount: household.eventCount,
    attachmentCount: household.attachmentCount,
    attachmentBytes: household.attachmentBytes,
    integrityVersion: 1,
    ...(included ? { chatEventCount: included.view.length, chatBlobCount: included.choice.chosen.length, chatBlobBytes: included.choice.chosen.reduce((total, blob) => total + blob.size, 0) } : {}),
    ...(boardView ? { boardEventCount: boardView.length } : {}),
  };
  // The key is bound to this metadata; the framed metadata adds how to
  // derive it again (salt) and the segments' nonce prefix.
  const authenticatedMetadata = serializeProtectedValue({ archiveVersion: PACKAGE_FORMAT, manifest, packageManifest });
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
  const key = await vault.archiveStreamKey(salt, authenticatedMetadata);
  await assertCurrentProtection(vault);
  // The key derivation and the segments name the unlocked vault's ID, which
  // is the manifest's; restore checks they agree.
  const protection = { version: 1, vaultId: vault.vaultId, salt: toBase64Url(salt), noncePrefix: toBase64Url(noncePrefix) };
  const metadata = serializeProtectedValue({ archiveVersion: PACKAGE_FORMAT, manifest, packageManifest, protection });
  return writeArchive({
    engine, metadata, key, noncePrefix, vaultId: vault.vaultId,
    context, attachments: parts.attachments, view: parts.history,
    chat: included && { notes: chat.notes, view: included.view, blobs: included.choice.chosen, loadBlob: chat.loadBlob, blobSegmentLength, blobSegment },
    board: boardView && { view: boardView },
    check: () => assertCurrentProtection(vault), onProgress,
  });
}

/**
 * The export root wrapper for a member's backup code (#572, PORTABILITY):
 * an ordinary recovery-type root wrapper whose 32-byte secret is
 * exportUnlockSecret(VK, vaultId), with the code's vault wrapper beside it
 * (`backupCode: { householdId, memberId, wrapperId, version, wrapped }`),
 * so the code alone opens the export, offline: code -> VK -> secret -> root.
 * `backupCode` is `{ vaultKey, householdId, memberId, wrapper }`, the
 * wrapper as the service sent it (wrapped key in base64url). The whole
 * manifest is authenticated by the archive key, so the extra field can't
 * be swapped without the export failing to open.
 */
export async function backupCodeExportWrapper(vault, { vaultKey, householdId, memberId, wrapper }) {
  if (wrapper?.type !== "backup-code" || typeof wrapper.wrapped !== "string")
    throw new VaultError("Your account's backup code couldn't be read. Try the export again.");
  const secret = await exportUnlockSecret(vaultKey, vault.vaultId);
  try {
    const rootWrapper = await vault.createWrapper(secret, { type: "recovery" });
    return { ...rootWrapper, backupCode: { householdId, memberId, wrapperId: wrapper.wrapperId, version: wrapper.version, wrapped: wrapper.wrapped } };
  } finally {
    secret.fill(0);
  }
}

/** Whether a manifest (an export's) opens with an account backup code. */
export function manifestBackupCode(manifest) {
  return (manifest?.wrappers ?? []).find((wrapper) => wrapper?.type === "recovery" && wrapper.backupCode) ?? null;
}

/**
 * Opens an archive with its recovery key, validates it and stages it for
 * restoreValidatedHouseholdArchive. Nothing is written. Local attachment
 * data is re-sealed for `vault`. `onProgress({ done, total })` reports
 * events read (package format 3).
 */
export async function validateHouseholdArchive({ bytes, recoverySecret, engine, vault, onProgress }) {
  await assertCurrentProtection(vault);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new VaultError("Choose a Kin export no larger than 160 MiB.");
  const { header, metadataLength, ciphertextLength } = readArchiveHeader(bytes, engine);
  const archiveVersion = header.archiveVersion;
  const packageManifest = validatePackageManifest(header.packageManifest, archiveVersion);
  let sourceVault;
  let parts;
  const unsubscribe = vault.onLock(() => sourceVault?.lock());
  try {
    sourceVault = await openArchiveVault(header.manifest, recoverySecret);
    await assertCurrentProtection(vault);
    const authenticatedMetadata = serializeProtectedValue({ archiveVersion, manifest: header.manifest, packageManifest });
    const source = { header, authenticatedMetadata, packageManifest, sourceVault, engine, vault };
    const offset = 16 + metadataLength;
    parts = archiveVersion === 3
      ? await openStreamPackage({ ...source, bytes, offset, length: ciphertextLength, onProgress })
      : await openWholePackage({ ...source, ciphertext: bytes.slice(offset) });

    const sourceSummary = await EventStore.validateArchiveParts({
      parts, engine, vault: sourceVault,
    });
    if ((
      packageManifest.eventCount !== sourceSummary.eventCount ||
      packageManifest.attachmentCount !== sourceSummary.attachmentCount ||
      packageManifest.attachmentBytes !== sourceSummary.attachmentBytes
    ))
      throw new VaultError("This file is damaged or incomplete.");

    let chatSummary = null;
    const chatSection = chatSections.get(parts);
    if (chatSection) {
      const context = parts.local_context[0];
      const householdId = syncId(context?.sync_household_id);
      if (!householdId) throw new VaultError("This file is damaged or incomplete.");
      chatSummary = await validateChatSection(chatSection, {
        engine, householdId, memberId: syncId(context.sync_member_id),
        counts: { eventCount: packageManifest.chatEventCount, blobCount: packageManifest.chatBlobCount },
      });
      if (chatSummary.blobBytes !== packageManifest.chatBlobBytes) throw new VaultError("This file is damaged or incomplete.");
    }

    let boardSummary = null;
    const boardSection = boardSections.get(parts);
    if (boardSection) {
      const context = parts.local_context[0];
      const householdId = syncId(context?.sync_household_id);
      if (!householdId) throw new VaultError("This file is damaged or incomplete.");
      boardSummary = validateBoardSection(boardSection, { engine, eventCount: packageManifest.boardEventCount, householdId });
    }

    parts.attachments = await rewrapLocalAttachments(parts.attachments, sourceVault, vault);
    // Same history and context: the bindings found above save a replay.
    const summary = await EventStore.validateArchiveParts({ parts, engine, vault, bindings: sourceSummary.bindings });
    await assertCurrentProtection(vault);
    const stage = Object.freeze({});
    stagedArchives.set(stage, {
      parts,
      engine,
      vault,
      vaultId: vault.vaultId,
      generation: vault.generation,
      summary,
      chatSummary,
      chatSection,
      boardSummary,
      boardSection,
      packageFormatVersion: archiveVersion,
    });
    return Object.freeze({
      stage,
      eventCount: summary.eventCount,
      attachmentCount: summary.attachmentCount,
      attachmentBytes: summary.attachmentBytes,
      chatEventCount: chatSummary?.eventCount ?? 0,
      chatBlobCount: chatSummary?.blobCount ?? 0,
      boardEventCount: boardSummary?.eventCount ?? 0,
      packageFormatVersion: archiveVersion,
    });
  } catch (error) {
    if (parts) discardParts(parts);
    throw error;
  } finally {
    unsubscribe();
    sourceVault?.lock();
  }
}

// The framed header, readable without any key. Its manifest and package
// manifest are authenticated later, when the archive key is derived.
function readArchiveHeader(bytes, engine) {
  const { metadataLength, ciphertextLength } = engine.archiveLayout(bytes);
  const header = deserializeProtectedValue(bytes.slice(16, 16 + metadataLength));
  if (!header || typeof header !== "object" || Array.isArray(header))
    throw new VaultError("This file is damaged or incomplete.");
  // Package formats 2 and 3 are read; development-era format 1 is refused.
  const archiveVersion = header.archiveVersion;
  if (archiveVersion !== 2 && archiveVersion !== 3)
    throw new VaultError("This Kin export version is not supported.");
  if (!hasExactKeys(header, ["archiveVersion", "manifest", "packageManifest", "protection"]) ||
      !hasExactKeys(header.protection, ["salt", "vaultId", "version", archiveVersion === 3 ? "noncePrefix" : "nonce"]))
    throw new VaultError("This file is damaged or incomplete.");
  return { header, metadataLength, ciphertextLength };
}

/**
 * What the restore screen shows before asking for a key: when the export was
 * made and which recovery key labels open it (key-label.js). Nothing is
 * unlocked, and the header is not yet authenticated: a wrong label can only
 * mislead the person into trying a key, which then fails to open it.
 */
export async function describeHouseholdArchive(bytes, engine) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new VaultError("Choose a Kin export no larger than 160 MiB.");
  const { header } = readArchiveHeader(bytes, engine);
  const packageManifest = validatePackageManifest(header.packageManifest, header.archiveVersion);
  // Bounded first (at most 16 wrappers), so a crafted header can't make
  // file selection hash without limit.
  let labels;
  let backupCode;
  try {
    validateManifest(header.manifest);
    labels = await manifestRecoveryLabels(header.manifest);
    backupCode = manifestBackupCode(header.manifest) !== null;
  } catch { throw new VaultError("This file is damaged or incomplete."); }
  if (!labels.length && !backupCode) throw new VaultError("This file is damaged or incomplete.");
  return Object.freeze({ exportedAt: packageManifest.exportedAt, labels: Object.freeze(labels), backupCode, packageFormatVersion: header.archiveVersion });
}

/**
 * Unlocks an export's own vault with its recovery key, or with the account
 * backup code it was made for (#572). A wrong key names the label of the
 * key that does open it, since after a key replacement older exports still
 * need the key their device had when they were made.
 */
export async function openArchiveVault(manifest, recoverySecret) {
  const codeWrapper = manifestBackupCode(manifest);
  if (codeWrapper && looksLikeBackupCode(recoverySecret)) return openWithBackupCode(manifest, codeWrapper, recoverySecret);
  if (!manifest.wrappers.some((wrapper) => wrapper.type === "recovery" && !wrapper.backupCode))
    throw new VaultError("This export opens with your account's backup code. Enter the code (8 groups of 7 letters and numbers).", "archive_key_mismatch");
  try {
    return await LocalVault.unlock(manifest, recoverySecret);
  } catch (error) {
    if (error?.code !== "unlock_failed") throw error;
    // unlock tries the first recovery wrapper, so that is the key to name.
    let labels = [];
    try { labels = await manifestRecoveryLabels(manifest); } catch { /* fall back to the generic message */ }
    if (!labels.length) throw error;
    throw new VaultError(
      `This export opens with backup key ${labels[0]} from the device that made it, and Kin couldn't open it with the key you entered. Check that you're using that key. Saved data was not changed.`,
      "archive_key_mismatch", error,
    );
  }
}

// code -> the code's vault wrapper -> VK -> exportUnlockSecret -> the root.
async function openWithBackupCode(manifest, wrapper, code) {
  const mismatch = (cause) => new VaultError(
    "This export opens with the account backup code that was current when it was made, and Kin couldn't open it with the code you entered. Saved data was not changed.",
    "archive_key_mismatch", cause);
  const { householdId, memberId, wrapperId, version, wrapped } = wrapper.backupCode ?? {};
  const codeBytes = await parseBackupCode(code);
  let kek, vaultKey, secret;
  try {
    kek = await backupCodeKek(codeBytes);
    try {
      vaultKey = await unwrapVaultKey(fromBase64Url(String(wrapped ?? "")), kek, { householdId, memberId, type: "backup-code", wrapperId, version });
    } catch (error) { throw mismatch(error); }
    secret = await exportUnlockSecret(vaultKey, manifest.vaultId);
    try {
      return await LocalVault.unlock(manifest, secret, wrapper.id);
    } catch (error) { throw mismatch(error); }
  } finally {
    codeBytes.fill(0);
    kek?.fill(0);
    vaultKey?.fill(0);
    secret?.fill(0);
  }
}

// Package format 3: segments opened in order into the archive's own arena.
async function openStreamPackage({ header, authenticatedMetadata, packageManifest, sourceVault, engine, vault, bytes, offset, length, onProgress }) {
  const { protection } = header;
  let salt, noncePrefix;
  try {
    salt = fromBase64Url(protection.salt);
    noncePrefix = fromBase64Url(protection.noncePrefix);
  } catch { throw new VaultError("This file is damaged or incomplete."); }
  if (protection.version !== 1 || protection.vaultId !== header.manifest.vaultId ||
      salt.length !== 32 || noncePrefix.length !== 8)
    throw new VaultError("This file is damaged or incomplete.");
  const key = await sourceVault.archiveStreamKey(salt, authenticatedMetadata);
  await assertCurrentProtection(vault);
  const history = EventStore.archiveHistory(engine);
  const parts = { formatVersion: 2, history: null, local_context: [], attachments: [], arena: history.arena };
  const withChat = packageManifest.chatEventCount !== undefined;
  const chatSection = withChat ? openChatSection() : null;
  if (chatSection) chatSections.set(parts, chatSection);
  const boardEventCount = packageManifest.boardEventCount ?? 0;
  const boardSection = boardEventCount ? openBoardSection() : null;
  if (boardSection) boardSections.set(parts, boardSection);
  try {
    await readArchive({
      bytes, offset, length, key, noncePrefix, vaultId: protection.vaultId,
      attachmentCount: packageManifest.attachmentCount, eventCount: packageManifest.eventCount,
      chatPresent: withChat, chatEventCount: packageManifest.chatEventCount ?? 0, chatBlobCount: packageManifest.chatBlobCount ?? 0,
      onChatNotes: (value) => { chatSection.notes = value; },
      onChatEvents: (sequences, records) => appendChatEvents(chatSection, sequences, records),
      onChatBlob: (bytes) => appendChatBlob(chatSection, bytes),
      boardEventCount,
      onBoardEvents: (sequences, records) => appendBoardEvents(boardSection, sequences, records),
      onContext: (row) => parts.local_context.push(row),
      onAttachment: (row) => parts.attachments.push(row),
      onEvents: (sequences, records, remaining) => {
        // The rest of the stream bounds the history's bytes: reserve them
        // once, at the first chunk.
        if (!history.arena.length) history.reserve(packageManifest.eventCount, remaining);
        history.append(sequences, records);
      },
      check: async () => { sourceVault.assertUnlocked(); await assertCurrentProtection(vault); },
      onProgress,
    });
  } catch (error) {
    discardParts(parts);
    throw error;
  }
  parts.history = history.arena.view();
  return parts;
}

// Package format 2: one sealed value holding the whole snapshot.
async function openWholePackage({ header, authenticatedMetadata, sourceVault, engine, vault, ciphertext }) {
  const decoded = await sourceVault.openArchive(
    { ...header.protection, ciphertext },
    authenticatedMetadata,
    { ownedCiphertext: true },
  );
  await assertCurrentProtection(vault);
  if (!hasExactKeys(decoded, ["packageFormatVersion", "snapshot"]) ||
      decoded.packageFormatVersion !== 2)
    throw new VaultError("This Kin export version is not supported.");
  try {
    return EventStore.archivePartsFromSnapshot(decoded.snapshot, engine);
  } finally {
    // The arena holds the history now; these decoded rows go either way.
    for (const row of Array.isArray(decoded.snapshot?.events) ? decoded.snapshot.events : [])
      if (row?.encoded_event instanceof Uint8Array) row.encoded_event.fill(0);
  }
}

/**
 * Restores a staged archive into an empty household, or reports that this
 * household already holds it. `onProgress({ done, total })` reports events
 * protected for storage.
 */
export async function restoreValidatedHouseholdArchive({ stage, engine, vault, store, onProgress }) {
  await assertCurrentProtection(vault);
  const staged = stagedArchives.get(stage);
  if (!staged || staged.engine !== engine || staged.vault !== vault ||
      staged.vaultId !== vault.vaultId || staged.generation !== vault.generation)
    throw new VaultError("Check this Kin export again before restoring it.");
  try {
    if (store && await store.containsSameHouseholdArchive(staged.parts, { engine, vault })) {
      const eventCount = staged.parts.history.length;
      // The chat and fridge are put right too, if they need it (idempotent).
      const chat = await restoreChat(staged, vault);
      const board = await restoreBoard(staged, vault);
      discardValidatedHouseholdArchive(stage);
      return { eventCount, alreadyPresent: true, chat, board };
    }
    const result = await EventStore.restoreArchive({ vault, engine, parts: staged.parts, bindings: staged.summary.bindings, onProgress });
    // The household is restored; its chat is written next. The chat log and
    // blob store are separate databases, so this is a second step: a failure
    // here leaves the household restored and says so (restoring the same
    // export again completes the chat).
    let chat = null, board = null;
    try {
      chat = await restoreChat(staged, vault);
      board = await restoreBoard(staged, vault);
    } catch (error) {
      error.householdRestored = true;
      discardValidatedHouseholdArchive(stage);
      throw error;
    }
    discardValidatedHouseholdArchive(stage);
    return { ...result, chat, board };
  } catch (error) {
    await assertCurrentProtection(vault);
    throw error;
  }
}

async function restoreChat(staged, vault) {
  if (!staged.chatSection || !staged.chatSummary) return null;
  const householdId = syncId(staged.parts.local_context[0].sync_household_id);
  return importChatSection(staged.chatSection, { householdId, vault, hidden: staged.chatSummary.hidden });
}

async function restoreBoard(staged, vault) {
  if (!staged.boardSection || !staged.boardSummary) return null;
  const householdId = syncId(staged.parts.local_context[0].sync_household_id);
  return importBoardSection(staged.boardSection, { householdId, vault });
}

export function discardValidatedHouseholdArchive(stage) {
  const staged = stagedArchives.get(stage);
  if (!staged) return;
  stagedArchives.delete(stage);
  discardParts(staged.parts);
}

function discardParts(parts) {
  parts.arena?.wipe();
  discardChatSection(chatSections.get(parts));
  discardBoardSection(boardSections.get(parts));
  zeroByteValues({ context: parts.local_context, attachments: parts.attachments }, new Set());
}

export async function importHouseholdArchive({ bytes, recoverySecret, engine, vault, store }) {
  const staged = await validateHouseholdArchive({ bytes, recoverySecret, engine, vault });
  return restoreValidatedHouseholdArchive({ stage: staged.stage, engine, vault, store });
}

function validatePackageManifest(value, packageFormatVersion) {
  const exportedAtIsCanonical = typeof value?.exportedAt === "string" &&
    value.exportedAt.length <= 32 &&
    Number.isFinite(Date.parse(value.exportedAt)) &&
    new Date(value.exportedAt).toISOString() === value.exportedAt;
  if (!hasExactKeys(value, [
    "packageFormatVersion", "kinVersion", "exportedAt", "eventCount",
    "attachmentCount", "attachmentBytes", "integrityVersion",
    ...(value && typeof value === "object" && "chatEventCount" in value ? ["chatEventCount", "chatBlobCount", "chatBlobBytes"] : []),
    ...(value && typeof value === "object" && "boardEventCount" in value ? ["boardEventCount"] : []),
  ]) || value.packageFormatVersion !== packageFormatVersion || value.integrityVersion !== 1 ||
      typeof value.kinVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.kinVersion) ||
      !exportedAtIsCanonical ||
      !Number.isSafeInteger(value.eventCount) || value.eventCount < 0 ||
      value.eventCount > MAX_EVENT_COUNT ||
      !Number.isSafeInteger(value.attachmentCount) || value.attachmentCount < 0 ||
      value.attachmentCount > MAX_ATTACHMENT_COUNT ||
      !Number.isSafeInteger(value.attachmentBytes) || value.attachmentBytes < 0 ||
      value.attachmentBytes > MAX_ATTACHMENT_BYTES ||
      // The household chat (#136): only version 3 archives carry it, with
      // the events and at least the notes segment.
      ("chatEventCount" in value && (packageFormatVersion !== 3 ||
        !Number.isSafeInteger(value.chatEventCount) || value.chatEventCount < 1 || value.chatEventCount > MAX_ARCHIVE_CHAT_EVENTS ||
        !Number.isSafeInteger(value.chatBlobCount) || value.chatBlobCount < 0 || value.chatBlobCount > MAX_ARCHIVE_CHAT_BLOBS ||
        !Number.isSafeInteger(value.chatBlobBytes) || value.chatBlobBytes < 0 || value.chatBlobBytes > MAX_ARCHIVE_BYTES)) ||
      // The family fridge (#363): version 3 only, at least one event.
      ("boardEventCount" in value && (packageFormatVersion !== 3 ||
        !Number.isSafeInteger(value.boardEventCount) || value.boardEventCount < 1 || value.boardEventCount > MAX_ARCHIVE_BOARD_EVENTS)))
    throw new VaultError("This Kin export manifest is damaged or unsupported.");
  return value;
}

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

async function rewrapLocalAttachments(attachments, sourceVault, targetVault) {
  const staged = structuredClone(attachments);
  for (const attachment of staged) {
    if (attachment.ciphertext) continue;
    const saved = await sourceVault.open(attachment.localSealed, {
      store: "attachment-file", id: attachment.attachment_id,
    });
    try {
      attachment.localSealed = await targetVault.seal(saved, {
        store: "attachment-file", id: attachment.attachment_id,
      });
    } finally {
      saved?.bytes?.fill(0);
    }
    await assertCurrentProtection(targetVault);
  }
  return staged;
}

function zeroByteValues(value, seen) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof ArrayBuffer) {
    new Uint8Array(value).fill(0);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0);
    return;
  }
  for (const child of Object.values(value)) zeroByteValues(child, seen);
}

async function assertCurrentProtection(vault) {
  vault.assertUnlocked();
  await vault.checkSecurityEpoch?.();
  vault.assertUnlocked();
}
