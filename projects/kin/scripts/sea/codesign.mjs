// A minimal ad-hoc code signature for a Mach-O executable, written without
// Apple's codesign tool (#747, ADR 0025 §10). arm64 macOS refuses to run any
// binary without a valid signature, and injecting the SEA blob invalidates
// node's own (Developer ID) signature, so the injector strips that one and
// writes this instead. It is what `codesign --sign -` would write for a
// plain executable: no certificate, no team, no entitlements, no hardened
// runtime. Gatekeeper still treats a downloaded copy as unsigned
// (docs/HOME-SERVER.md, "Unsigned builds").
//
// The layout follows Apple's published cs_blobs.h (xnu, osfmk/kern/cs_blobs.h
// at github.com/apple-oss-distributions/xnu). Every field is big-endian:
//
//   SuperBlob  CSMAGIC_EMBEDDED_SIGNATURE 0xfade0cc0, length, count,
//              then count x { type, offset } (offsets from the SuperBlob)
//     slot 0        CodeDirectory   CSMAGIC_CODEDIRECTORY 0xfade0c02
//     slot 2        Requirements    CSMAGIC_REQUIREMENTS 0xfade0c01, empty
//     slot 0x10000  BlobWrapper     CSMAGIC_BLOBWRAPPER 0xfade0b01, empty
//                                   (where a CMS signature would go)
//
//   CodeDirectory, version 0x20400 (CS_SUPPORTSEXECSEG), 88-byte header:
//     magic length version flags hashOffset identOffset nSpecialSlots
//     nCodeSlots codeLimit | hashSize hashType platform pageSize (u8 each) |
//     spare2 scatterOffset teamOffset spare3 | codeLimit64 execSegBase
//     execSegLimit execSegFlags (u64 each)
//   then the identifier (NUL-terminated), then the special slot hashes
//   (slot -n at hashOffset - n * hashSize), then one SHA-256 per 4 KiB page
//   of the file from offset 0 up to codeLimit (the last page may be short).
//
// codeLimit is where the signature starts: the hashes cover every byte
// before it, including the load commands that point at the signature.

import { createHash } from "node:crypto";

export const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
export const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
export const CSMAGIC_REQUIREMENTS = 0xfade0c01;
export const CSMAGIC_BLOBWRAPPER = 0xfade0b01;
export const CSSLOT_CODEDIRECTORY = 0;
export const CSSLOT_REQUIREMENTS = 2;
export const CSSLOT_SIGNATURESLOT = 0x10000;
export const CS_ADHOC = 0x2;
export const CS_EXECSEG_MAIN_BINARY = 0x1;
const CS_SUPPORTSEXECSEG = 0x20400;
const CS_HASHTYPE_SHA256 = 2;
const HASH_SIZE = 32;
const PAGE_SHIFT = 12;
const PAGE_SIZE = 1 << PAGE_SHIFT;
const CODE_DIRECTORY_HEADER = 88;
// Only the requirements slot (-2) is used, so slots -1 and -2 are present
// (-1, Info.plist, is all zeros), as codesign writes them.
const SPECIAL_SLOTS = 2;

export class CodeSignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodeSignatureError";
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const EMPTY_REQUIREMENTS = (() => {
  const blob = Buffer.alloc(12);
  blob.writeUInt32BE(CSMAGIC_REQUIREMENTS, 0);
  blob.writeUInt32BE(12, 4);
  blob.writeUInt32BE(0, 8);
  return blob;
})();
const EMPTY_WRAPPER = (() => {
  const blob = Buffer.alloc(8);
  blob.writeUInt32BE(CSMAGIC_BLOBWRAPPER, 0);
  blob.writeUInt32BE(8, 4);
  return blob;
})();

function codeDirectoryLength(codeLimit, identifier) {
  const slots = Math.ceil(codeLimit / PAGE_SIZE);
  return CODE_DIRECTORY_HEADER + Buffer.byteLength(identifier, "utf8") + 1 + (SPECIAL_SLOTS + slots) * HASH_SIZE;
}

/** The size of the signature adHocSignature() writes for these inputs, so
 * the load commands can point at it before the pages are hashed. */
export function adHocSignatureSize(codeLimit, identifier) {
  return 12 + 3 * 8 + codeDirectoryLength(codeLimit, identifier) + EMPTY_REQUIREMENTS.length + EMPTY_WRAPPER.length;
}

/**
 * The ad-hoc signature (a SuperBlob) for `file`, whose first `codeLimit`
 * bytes are the signed code. `execSegBase`/`execSegLimit` are the __TEXT
 * segment's file offset and size.
 */
export function adHocSignature(file, { codeLimit, identifier, execSegBase, execSegLimit }) {
  if (!Number.isSafeInteger(codeLimit) || codeLimit <= 0 || codeLimit > file.length) throw new CodeSignatureError("The code limit is outside the file.");
  if (codeLimit > 0xffff_ffff) throw new CodeSignatureError("The executable is too large for a 32-bit code limit.");
  if (!/^[\w.-]+$/.test(identifier)) throw new CodeSignatureError("The signing identifier must be plain ASCII.");
  const nCodeSlots = Math.ceil(codeLimit / PAGE_SIZE);
  const ident = Buffer.from(`${identifier}\0`, "utf8");
  const length = codeDirectoryLength(codeLimit, identifier);
  const identOffset = CODE_DIRECTORY_HEADER;
  const hashOffset = identOffset + ident.length + SPECIAL_SLOTS * HASH_SIZE;
  const directory = Buffer.alloc(length);
  directory.writeUInt32BE(CSMAGIC_CODEDIRECTORY, 0);
  directory.writeUInt32BE(length, 4);
  directory.writeUInt32BE(CS_SUPPORTSEXECSEG, 8);
  directory.writeUInt32BE(CS_ADHOC, 12);
  directory.writeUInt32BE(hashOffset, 16);
  directory.writeUInt32BE(identOffset, 20);
  directory.writeUInt32BE(SPECIAL_SLOTS, 24);
  directory.writeUInt32BE(nCodeSlots, 28);
  directory.writeUInt32BE(codeLimit, 32);
  directory[36] = HASH_SIZE;
  directory[37] = CS_HASHTYPE_SHA256;
  directory[38] = 0; // platform: not a platform binary
  directory[39] = PAGE_SHIFT;
  // spare2, scatterOffset, teamOffset, spare3 and codeLimit64 stay zero.
  directory.writeBigUInt64BE(BigInt(execSegBase), 64);
  directory.writeBigUInt64BE(BigInt(execSegLimit), 72);
  directory.writeBigUInt64BE(BigInt(CS_EXECSEG_MAIN_BINARY), 80);
  ident.copy(directory, identOffset);
  // Special slot -2: the requirements blob. Slot -1 (Info.plist) is absent.
  sha256(EMPTY_REQUIREMENTS).copy(directory, hashOffset - CSSLOT_REQUIREMENTS * HASH_SIZE);
  for (let page = 0; page < nCodeSlots; page += 1) {
    const start = page * PAGE_SIZE;
    sha256(file.subarray(start, Math.min(start + PAGE_SIZE, codeLimit))).copy(directory, hashOffset + page * HASH_SIZE);
  }

  const blobs = [[CSSLOT_CODEDIRECTORY, directory], [CSSLOT_REQUIREMENTS, EMPTY_REQUIREMENTS], [CSSLOT_SIGNATURESLOT, EMPTY_WRAPPER]];
  const total = 12 + blobs.length * 8 + blobs.reduce((sum, [, blob]) => sum + blob.length, 0);
  const signature = Buffer.alloc(total);
  signature.writeUInt32BE(CSMAGIC_EMBEDDED_SIGNATURE, 0);
  signature.writeUInt32BE(total, 4);
  signature.writeUInt32BE(blobs.length, 8);
  let at = 12 + blobs.length * 8;
  blobs.forEach(([type, blob], index) => {
    signature.writeUInt32BE(type, 12 + index * 8);
    signature.writeUInt32BE(at, 16 + index * 8);
    blob.copy(signature, at);
    at += blob.length;
  });
  return signature;
}

/** The SuperBlob's slots and its parsed CodeDirectory. */
export function readCodeSignature(signature) {
  if (signature.length < 12 || signature.readUInt32BE(0) !== CSMAGIC_EMBEDDED_SIGNATURE) throw new CodeSignatureError("This isn't an embedded code signature.");
  const length = signature.readUInt32BE(4);
  const count = signature.readUInt32BE(8);
  if (length > signature.length || 12 + count * 8 > length) throw new CodeSignatureError("The code signature is truncated.");
  const slots = new Map();
  for (let index = 0; index < count; index += 1) {
    const type = signature.readUInt32BE(12 + index * 8);
    const offset = signature.readUInt32BE(16 + index * 8);
    if (offset + 8 > length) throw new CodeSignatureError("A code signature blob lies outside the signature.");
    const blobLength = signature.readUInt32BE(offset + 4);
    if (blobLength < 8 || offset + blobLength > length) throw new CodeSignatureError("A code signature blob runs past the signature.");
    slots.set(type, signature.subarray(offset, offset + blobLength));
  }
  const directory = slots.get(CSSLOT_CODEDIRECTORY);
  if (!directory || directory.readUInt32BE(0) !== CSMAGIC_CODEDIRECTORY) throw new CodeSignatureError("The code signature has no CodeDirectory.");
  if (directory.length < CODE_DIRECTORY_HEADER) throw new CodeSignatureError("The CodeDirectory is too short.");
  const identOffset = directory.readUInt32BE(20);
  const identEnd = directory.indexOf(0, identOffset);
  return {
    length,
    slots,
    codeDirectory: {
      bytes: directory,
      version: directory.readUInt32BE(8),
      flags: directory.readUInt32BE(12),
      hashOffset: directory.readUInt32BE(16),
      identifier: directory.toString("utf8", identOffset, identEnd),
      nSpecialSlots: directory.readUInt32BE(24),
      nCodeSlots: directory.readUInt32BE(28),
      codeLimit: directory.readUInt32BE(32),
      hashSize: directory[36],
      hashType: directory[37],
      pageSize: directory[39] ? 1 << directory[39] : 0,
      teamOffset: directory.readUInt32BE(48),
      execSegBase: directory.readBigUInt64BE(64),
      execSegLimit: directory.readBigUInt64BE(72),
      execSegFlags: directory.readBigUInt64BE(80),
    },
  };
}

/**
 * Checks an ad-hoc signature the way the kernel does when it pages the file
 * in: every page hash, the requirements slot, and the code limit. Throws
 * CodeSignatureError on the first mismatch; returns the parsed signature.
 */
export function verifyAdHocSignature(file, signatureOffset) {
  const signature = readCodeSignature(file.subarray(signatureOffset));
  const cd = signature.codeDirectory;
  if (cd.version < CS_SUPPORTSEXECSEG) throw new CodeSignatureError(`CodeDirectory version 0x${cd.version.toString(16)} has no executable segment.`);
  if (!(cd.flags & CS_ADHOC)) throw new CodeSignatureError("The signature isn't ad-hoc.");
  if (cd.hashType !== CS_HASHTYPE_SHA256 || cd.hashSize !== HASH_SIZE) throw new CodeSignatureError("The CodeDirectory doesn't use SHA-256.");
  if (cd.pageSize !== PAGE_SIZE) throw new CodeSignatureError(`Unexpected code signing page size ${cd.pageSize}.`);
  if (cd.codeLimit !== signatureOffset) throw new CodeSignatureError(`The code limit ${cd.codeLimit} isn't where the signature starts (${signatureOffset}).`);
  if (cd.nCodeSlots !== Math.ceil(cd.codeLimit / PAGE_SIZE)) throw new CodeSignatureError("The number of page hashes doesn't match the code limit.");
  if (cd.hashOffset + cd.nCodeSlots * HASH_SIZE > cd.bytes.length || cd.hashOffset < cd.nSpecialSlots * HASH_SIZE) throw new CodeSignatureError("The page hashes lie outside the CodeDirectory.");
  if (cd.execSegFlags !== BigInt(CS_EXECSEG_MAIN_BINARY)) throw new CodeSignatureError("The executable segment isn't marked as the main binary.");
  for (let page = 0; page < cd.nCodeSlots; page += 1) {
    const start = page * PAGE_SIZE;
    const expected = cd.bytes.subarray(cd.hashOffset + page * HASH_SIZE, cd.hashOffset + (page + 1) * HASH_SIZE);
    if (!sha256(file.subarray(start, Math.min(start + PAGE_SIZE, cd.codeLimit))).equals(expected))
      throw new CodeSignatureError(`Page ${page} (file offset ${start}) doesn't match its hash.`);
  }
  const requirements = signature.slots.get(CSSLOT_REQUIREMENTS);
  if (requirements) {
    if (cd.nSpecialSlots < CSSLOT_REQUIREMENTS) throw new CodeSignatureError("The requirements blob has no special slot.");
    const slot = cd.bytes.subarray(cd.hashOffset - CSSLOT_REQUIREMENTS * HASH_SIZE, cd.hashOffset - (CSSLOT_REQUIREMENTS - 1) * HASH_SIZE);
    if (!sha256(requirements).equals(slot)) throw new CodeSignatureError("The requirements blob doesn't match its special slot.");
  }
  return signature;
}
