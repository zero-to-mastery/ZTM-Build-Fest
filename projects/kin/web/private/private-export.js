// A member's own export of their private things (#493: #494, #495; ADR
// 0019 "Exports"): their private log (journal, Just for me, reminders and
// settings that follow them) and, as space allows, their journal photos,
// sealed under their member key (MK). Only they can open it: on one of their
// own devices (the member key comes from their vault, as always), or with
// their account backup code (which wraps the vault key VK, which the file
// carries the member keys under). A household export never includes any of
// it (security/archive.js reads only household stores), and this file holds
// nothing of the household's: no household event, key or setting.
//
// File format 1 ("KPEX"), all integers big-endian:
//
//   "KPEX"  u8 format (1)  u32 header length H  H bytes header (UTF-8 JSON)
//   12-byte nonce  ciphertext with its 16-byte tag
//
//   header  { kind: "kin-private-export", version: 1, kinVersion, exportedAt,
//             householdId, memberId, keyEpoch, eventCount, blobCount,
//             blobBytes, blobsLeftOut, backupCode }
//   body    AES-256-GCM under the member key of `keyEpoch` (the newest),
//           AAD = every byte before the nonce (magic, format, length,
//           header), so the header can't change without the file failing
//           to open. Plaintext: local-vault.js serializeProtectedValue of
//           { envelopes, blobs }: the private envelopes exactly as this
//           device keeps them (each already sealed under its own member-key
//           epoch and bound to this member, private-envelope.js), and blobs
//           as `{ ref, ciphertext }` (sealed per photo, private-blobs.js).
//   backupCode  null, or, for a member with an account backup code:
//           { wrapperId, version, wrapped }  the backup code's vault wrapper
//                                            (VK under the code), as the
//                                            service keeps it
//           keys: { salt, nonce, ciphertext } the member-key epochs (account
//                 vault contents format 2 with only member keys), AES-256-GCM
//                 under HKDF-SHA-256(VK, salt, "kin/private-export-keys/v1"),
//                 AAD ["kin/private-export-keys/v1", "1", householdId,
//                 memberId, exportedAt]
//           so the code alone opens the file: code -> VK -> member keys -> body.
//
// Restoring puts the private things back only for the same member (the
// header names them, the envelopes' encryption binds them, and the member
// key is theirs), merges by event ID (nothing is duplicated; restoring twice
// adds nothing), and keeps the photos as pending uploads. Envelopes the
// service no longer has stay on this device: the relay takes only a device's
// own envelopes (PORTABILITY, "A member's private things").
//
// Every primitive is Web Crypto (AES-256-GCM, HKDF-SHA-256); nothing is
// hand-written.
import {
  backupCodeKek,
  decodeVaultContents,
  encodeVaultContents,
  unwrapVaultKey,
  WRAPPED_KEY_BYTES,
} from "../security/account-vault.js";
import { parseBackupCode } from "../security/backup-code.js";
import { deserializeProtectedValue, fromBase64Url, serializeProtectedValue, toBase64Url } from "../security/local-vault.js";
import { decryptStoredPrivateEvent } from "./private-envelope.js";
import { blobRef, isRef, MAX_PRIVATE_BLOB_BYTES, MIN_PRIVATE_BLOB_BYTES } from "./private-blobs.js";

export const PRIVATE_EXPORT_FORMAT = 1;
/** The largest file Kin writes or reads: room for the whole private log
 * (50,000 events) and a good number of photos. */
export const MAX_PRIVATE_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_PRIVATE_EXPORT_EVENTS = 50_000;
export const MAX_PRIVATE_EXPORT_BLOBS = 4096;
const KIN_VERSION = "1.3.0";
const MAGIC = [0x4b, 0x50, 0x45, 0x58]; // "KPEX"
const PREFIX_BYTES = 4 + 1 + 4;
const MAX_HEADER_BYTES = 4096;
const ID = /^[a-f0-9]{32}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEADER_KEYS = ["kind", "version", "kinVersion", "exportedAt", "householdId", "memberId", "keyEpoch", "eventCount",
  "blobCount", "blobBytes", "blobsLeftOut", "backupCode"];

export class PrivateExportError extends Error {
  constructor(message, code = "private_export_invalid", cause) {
    super(message, { cause });
    this.name = "PrivateExportError";
    this.code = code;
    this.userMessage = message;
  }
}

const damaged = (cause) => new PrivateExportError("This file is damaged, or isn't a Kin export of private things.", "private_export_invalid", cause);

/** A suggested file name: kin-private-2026-10-21.kinp. */
export function privateExportFileName(exportedAt) {
  const date = new Date(exportedAt);
  if (Number.isNaN(date.getTime())) throw new TypeError("An export file name needs the export time.");
  return `kin-private-${date.toISOString().slice(0, 10)}.kinp`;
}

/**
 * Chooses which photos fit: newest first, while the file stays under
 * `budget` bytes. `blobs` is `[{ ref, ciphertext, storedAt? }]`. Returns
 * `{ chosen, leftOut }`.
 */
export function choosePrivateBlobs(blobs, budget) {
  const sorted = [...blobs].sort((left, right) => (right.storedAt ?? 0) - (left.storedAt ?? 0));
  const chosen = [];
  let used = 0;
  let leftOut = 0;
  for (const blob of sorted) {
    const size = Math.ceil(blob.ciphertext.length * 4 / 3) + 128;
    if (chosen.length < MAX_PRIVATE_EXPORT_BLOBS && used + size <= budget) { chosen.push(blob); used += size; } else leftOut += 1;
  }
  return { chosen, leftOut };
}

/**
 * The export file (#494). `identity` `{ householdId, memberId }`;
 * `envelopes` every private envelope this device keeps; `memberKey`
 * `{ epoch, key }` (the newest epoch, a CryptoKey; MemberKeyRing.current());
 * `blobs` candidate photos `[{ ref, ciphertext, storedAt }]`; `backupCode`
 * null or `{ vaultKey, wrapper, memberKeys }` (VK and the raw member-key
 * epochs from the vault, the service's backup-code wrapper with `wrapped` in
 * base64url); the caller zeroes VK and the raw keys. Resolves to
 * `{ bytes, header }`.
 */
export async function exportPrivateArchive({ identity, envelopes, memberKey, blobs = [], backupCode = null, now = Date.now(), maxBytes = MAX_PRIVATE_EXPORT_BYTES }) {
  const { householdId, memberId } = identity ?? {};
  if (!ID.test(householdId ?? "") || !ID.test(memberId ?? "")) throw new PrivateExportError("Private storage needs this device's household and member.");
  if (!memberKey?.key || !Number.isSafeInteger(memberKey.epoch)) throw new PrivateExportError("Your private things aren't open on this device.", "private_key_unavailable");
  if (!Array.isArray(envelopes) || envelopes.length > MAX_PRIVATE_EXPORT_EVENTS) throw new PrivateExportError("There are too many private changes to export.");
  const exportedAt = new Date(now).toISOString();
  const eventBytes = serializeProtectedValue(envelopes).length;
  if (eventBytes + 64 * 1024 > maxBytes) throw new PrivateExportError("Your private things are too large to export in one file.");
  const { chosen, leftOut } = choosePrivateBlobs(blobs.filter((blob) => isRef(blob.ref) && blob.ciphertext instanceof Uint8Array), maxBytes - eventBytes - 64 * 1024);
  const header = {
    kind: "kin-private-export", version: PRIVATE_EXPORT_FORMAT, kinVersion: KIN_VERSION, exportedAt, householdId, memberId,
    keyEpoch: memberKey.epoch, eventCount: envelopes.length, blobCount: chosen.length,
    blobBytes: chosen.reduce((total, blob) => total + blob.ciphertext.length, 0), blobsLeftOut: leftOut,
    backupCode: backupCode ? await sealKeysForCode(backupCode, { householdId, memberId, exportedAt }) : null,
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER_BYTES) throw new PrivateExportError("Kin couldn't write this export.");
  const prefix = new Uint8Array(PREFIX_BYTES + headerBytes.length);
  prefix.set(MAGIC, 0);
  prefix[4] = PRIVATE_EXPORT_FORMAT;
  new DataView(prefix.buffer).setUint32(5, headerBytes.length);
  prefix.set(headerBytes, PREFIX_BYTES);
  const plaintext = serializeProtectedValue({ envelopes, blobs: chosen.map(({ ref, ciphertext }) => ({ ref, ciphertext })) });
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: prefix, tagLength: 128 }, memberKey.key, plaintext));
    const bytes = new Uint8Array(prefix.length + 12 + ciphertext.length);
    bytes.set(prefix, 0);
    bytes.set(nonce, prefix.length);
    bytes.set(ciphertext, prefix.length + 12);
    if (bytes.length > maxBytes) throw new PrivateExportError("Your private things are too large to export in one file.");
    return { bytes, header };
  } finally {
    plaintext.fill(0);
  }
}

async function keysKey(vaultKey, salt, usage) {
  const material = await crypto.subtle.importKey("raw", vaultKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("kin/private-export-keys/v1") },
    material, { name: "AES-GCM", length: 256 }, false, [usage]);
}

const keysAad = ({ householdId, memberId, exportedAt }) => encoder.encode(JSON.stringify(["kin/private-export-keys/v1", "1", householdId, memberId, exportedAt]));

async function sealKeysForCode({ vaultKey, wrapper, memberKeys }, context) {
  if (wrapper?.type !== "backup-code" || typeof wrapper.wrapped !== "string" || !ID.test(wrapper.wrapperId ?? "") || !Number.isSafeInteger(wrapper.version))
    throw new PrivateExportError("Your account's backup code couldn't be read. Try the export again.");
  const plaintext = encodeVaultContents({ memberKeys });
  try {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: keysAad(context), tagLength: 128 },
      await keysKey(vaultKey, salt, "encrypt"), plaintext));
    return { wrapperId: wrapper.wrapperId, version: wrapper.version, wrapped: wrapper.wrapped,
      keys: { salt: toBase64Url(salt), nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) } };
  } finally {
    plaintext.fill(0);
  }
}

/** The file's parts, checked, with no key: `{ header, prefix, nonce, ciphertext }`. */
function readFile(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < PREFIX_BYTES + 2 + 12 + 16 || bytes.length > MAX_PRIVATE_EXPORT_BYTES ||
      MAGIC.some((value, index) => bytes[index] !== value)) throw damaged();
  if (bytes[4] !== PRIVATE_EXPORT_FORMAT) throw new PrivateExportError("This export was made by a newer version of Kin.", "private_export_unsupported");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5);
  if (length < 2 || length > MAX_HEADER_BYTES || PREFIX_BYTES + length + 12 + 16 > bytes.length) throw damaged();
  let header;
  try { header = JSON.parse(decoder.decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + length))); } catch (error) { throw damaged(error); }
  validateHeader(header);
  const prefix = bytes.slice(0, PREFIX_BYTES + length);
  return { header, prefix, nonce: bytes.slice(prefix.length, prefix.length + 12), ciphertext: bytes.subarray(prefix.length + 12) };
}

function validateHeader(header) {
  const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
  if (!header || typeof header !== "object" || Array.isArray(header) ||
      Object.keys(header).sort().join() !== [...HEADER_KEYS].sort().join() ||
      header.kind !== "kin-private-export" || header.version !== PRIVATE_EXPORT_FORMAT ||
      typeof header.kinVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(header.kinVersion) ||
      typeof header.exportedAt !== "string" || Number.isNaN(Date.parse(header.exportedAt)) ||
      !ID.test(header.householdId ?? "") || !ID.test(header.memberId ?? "") ||
      !Number.isSafeInteger(header.keyEpoch) || header.keyEpoch < 1 || header.keyEpoch > 128 ||
      !count(header.eventCount, MAX_PRIVATE_EXPORT_EVENTS) || !count(header.blobCount, MAX_PRIVATE_EXPORT_BLOBS) ||
      !count(header.blobBytes, MAX_PRIVATE_EXPORT_BYTES) || !count(header.blobsLeftOut, 1_000_000))
    throw damaged();
  const code = header.backupCode;
  if (code !== null && (typeof code !== "object" || !ID.test(code.wrapperId ?? "") || !Number.isSafeInteger(code.version) || code.version < 1 ||
      typeof code.wrapped !== "string" || typeof code.keys?.salt !== "string" || typeof code.keys?.nonce !== "string" || typeof code.keys?.ciphertext !== "string"))
    throw damaged();
}

/** What the restore screen shows before anything is opened. */
export function describePrivateArchive(bytes) {
  const { header } = readFile(bytes);
  return Object.freeze({ exportedAt: header.exportedAt, householdId: header.householdId, memberId: header.memberId,
    eventCount: header.eventCount, blobCount: header.blobCount, blobsLeftOut: header.blobsLeftOut, backupCode: header.backupCode !== null });
}

/**
 * Opens the file for `identity` (the member restoring). `memberKey(epoch)`
 * resolves to this device's CryptoKey for an epoch, or null; `code` is the
 * account backup code as typed, used only when the device has no key for
 * the file's epoch. Resolves to `{ header, envelopes, blobs, memberKeys }`:
 * `memberKeys` are the raw epochs the backup code opened (the caller zeroes
 * them), or null.
 */
export async function openPrivateArchive(bytes, { identity, memberKey = async () => null, code = null }) {
  const { header, prefix, nonce, ciphertext } = readFile(bytes);
  if (header.householdId !== identity?.householdId || header.memberId !== identity?.memberId)
    throw new PrivateExportError("This file holds someone else's private things, or another household's. Kin restores private things only for the member who saved them.", "private_export_other_member");
  let key = await memberKey(header.keyEpoch).catch(() => null);
  let memberKeys = null;
  if (!key) {
    if (!header.backupCode) throw new PrivateExportError("This device doesn't hold the key this file was saved with. Open it on one of your devices that has your account.", "private_export_key_missing");
    if (!code) throw new PrivateExportError("Enter your account backup code to open this file.", "private_export_needs_code");
    memberKeys = await keysFromCode(header, code);
    const entry = memberKeys.find((candidate) => candidate.epoch === header.keyEpoch);
    if (!entry) { wipeKeys(memberKeys); throw damaged(); }
    key = await crypto.subtle.importKey("raw", entry.key, { name: "AES-GCM" }, false, ["decrypt"]);
  }
  let plaintext;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: prefix, tagLength: 128 }, key, ciphertext));
  } catch (error) {
    wipeKeys(memberKeys);
    throw damaged(error);
  }
  try {
    const body = deserializeProtectedValue(plaintext);
    if (!body || !Array.isArray(body.envelopes) || !Array.isArray(body.blobs) || body.envelopes.length !== header.eventCount ||
        body.blobs.length !== header.blobCount || body.blobs.some((blob) => !isRef(blob?.ref) || !(blob.ciphertext instanceof Uint8Array)))
      throw damaged();
    return { header, envelopes: body.envelopes, blobs: body.blobs, memberKeys };
  } catch (error) {
    wipeKeys(memberKeys);
    throw error instanceof PrivateExportError ? error : damaged(error);
  } finally {
    plaintext.fill(0);
  }
}

async function keysFromCode(header, code) {
  const { householdId, memberId, exportedAt } = header;
  const { wrapperId, version, wrapped, keys } = header.backupCode;
  const codeBytes = await parseBackupCode(code);
  let kek, vaultKey, plaintext;
  try {
    kek = await backupCodeKek(codeBytes);
    const wrappedBytes = fromBase64Url(wrapped);
    if (wrappedBytes.length !== WRAPPED_KEY_BYTES) throw damaged();
    try {
      vaultKey = await unwrapVaultKey(wrappedBytes, kek, { householdId, memberId, type: "backup-code", wrapperId, version });
    } catch (error) {
      throw new PrivateExportError("This file opens with the account backup code that was current when it was saved, and Kin couldn't open it with the code you entered.", "private_export_code_mismatch", error);
    }
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(keys.nonce), additionalData: keysAad({ householdId, memberId, exportedAt }), tagLength: 128 },
        await keysKey(vaultKey, fromBase64Url(keys.salt), "decrypt"), fromBase64Url(keys.ciphertext)));
    } catch (error) { throw damaged(error); }
    const contents = decodeVaultContents(plaintext);
    for (const entry of contents.epochs) entry.key.fill(0);
    contents.certificationKey?.fill(0);
    return contents.memberKeys;
  } finally {
    codeBytes.fill(0);
    kek?.fill(0);
    vaultKey?.fill(0);
    plaintext?.fill(0);
  }
}

function wipeKeys(memberKeys) {
  for (const entry of memberKeys ?? []) entry.key?.fill(0);
}

/**
 * Puts an opened file's private things back (#495) into this member's log
 * on this device: every envelope it doesn't have yet (by event ID), after
 * checking each opens under this member's key for its epoch, and every
 * photo it doesn't have, as a pending upload. `log` is the open PrivateLog;
 * `blobStore` the member's PrivateBlobStore (or null: photos are then left
 * out and counted); `addMemberKeys(memberKeys)` adds epochs the backup code
 * opened that this member's vault doesn't hold (account-vault-sync.js
 * refreshVault), then reloads the ring. Resolves to
 * `{ added, alreadyHere, blobsAdded, blobsSkipped }`.
 */
export async function restorePrivateArchive({ opened, log, blobStore = null, addMemberKeys = async () => {} }) {
  const memberId = log.identity.memberId;
  try {
    if (opened.memberKeys?.some((entry) => log.ring.revokedThrough(entry.epoch) === null)) await addMemberKeys(opened.memberKeys);
  } finally {
    wipeKeys(opened.memberKeys);
  }
  const fresh = [];
  let alreadyHere = 0;
  const seen = new Set();
  for (const envelope of opened.envelopes) {
    if (!ID.test(envelope?.eventId ?? "") || seen.has(envelope.eventId)) throw damaged();
    seen.add(envelope.eventId);
    if (envelope.householdId !== log.identity.householdId) throw damaged();
    if (await log.store.eventById(envelope.eventId)) { alreadyHere += 1; continue; }
    // Opens for this member under their key, or the whole file is refused.
    const plaintext = await decryptStoredPrivateEvent({ envelope, memberId, memberKey: await log.ring.key(envelope.keyEpoch) }).catch((error) => { throw damaged(error); });
    plaintext.fill(0);
    fresh.push(envelope);
  }
  const added = fresh.length ? await log.store.addImported(fresh) : 0;
  let blobsAdded = 0;
  let blobsSkipped = 0;
  for (const blob of opened.blobs) {
    if (!blobStore || blob.ciphertext.length < MIN_PRIVATE_BLOB_BYTES || blob.ciphertext.length > MAX_PRIVATE_BLOB_BYTES ||
        await blobRef(blob.ciphertext) !== blob.ref) { blobsSkipped += 1; continue; }
    if (await blobStore.get(blob.ref)) continue;
    await blobStore.put(blob.ref, blob.ciphertext, { pending: true });
    blobsAdded += 1;
  }
  await log.refresh();
  return { added, alreadyHere: alreadyHere + (fresh.length - added), blobsAdded, blobsSkipped };
}
