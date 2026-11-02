// Writes a Node single executable application's blob into a copy of a
// Mach-O `node` binary (macOS arm64 and x64), without the postject npm
// package (ADR 0025 §10, #747).
//
// Where Node looks. src/node_sea_bin.cc (Node v24) on macOS:
//
//   options.macho_segment_name = "NODE_SEA";
//   postject_find_resource("NODE_SEA_BLOB", &size, &options);
//
// and postject-api.h (github.com/nodejs/postject, compiled into Node) prefixes
// "__" to a section name that lacks it and calls
// getsectdata("NODE_SEA", "__NODE_SEA_BLOB", &size), adding the image's ASLR
// slide. getsectdata walks the main executable's LC_SEGMENT_64 commands for
// that segment and section and returns the section's address and size. So
// the blob must be a section `__NODE_SEA_BLOB` of a mapped segment
// `NODE_SEA` (not postject's default `__POSTJECT`, which Node overrides).
//
// The layout. A linked node binary is, in file and address order:
//
//   __TEXT (header and load commands at its start) __DATA_CONST __DATA
//   __LINKEDIT (fixups, export trie, symbols, ..., code signature last)
//
// The result is:
//
//   __TEXT __DATA_CONST __DATA            unchanged, apart from the load
//                                         commands and the flipped fuse
//   NODE_SEA      where __LINKEDIT was: the blob, padded to 16 KiB
//   __LINKEDIT    moved up by NODE_SEA's size, the old code signature cut
//                 off, then a new ad-hoc signature (codesign.mjs)
//
// __LINKEDIT stays the last segment in the file, in memory and in the load
// commands, which codesign and dyld require. Every load command that holds
// a file offset into __LINKEDIT (LC_SYMTAB, LC_DYSYMTAB, LC_DYLD_INFO,
// LC_FUNCTION_STARTS, ...) is moved by the same amount.
//
// Chained fixups. dyld checks that the fixups' dyld_chained_starts_in_image
// lists one entry per segment up to __LINKEDIT (dyld's
// MachOAnalyzer::validChainedFixupsInfo and mach_o/ChainedFixups.cpp:
// "seg_count does not match number of segments"). A new segment before
// __LINKEDIT therefore needs a new, empty (0) entry: the fixups blob grows
// by 8 bytes (4 for the entry and 4 to keep what follows 8-byte aligned) and
// every offset inside it that points past the entry array moves by 8.
// Binaries that use LC_DYLD_INFO instead refer to segments by index only for
// segments with fixups, which all come before __LINKEDIT and keep their index.
//
// Only thin 64-bit little-endian executables are injected; a universal
// (fat) binary is reduced to the slice for the target first (thinSlice).

import { adHocSignature, adHocSignatureSize, verifyAdHocSignature } from "./codesign.mjs";

export const SEA_SEGMENT = "NODE_SEA";
export const SEA_SECTION = "__NODE_SEA_BLOB";
export const CPU_TYPE_X86_64 = 0x01000007;
export const CPU_TYPE_ARM64 = 0x0100000c;

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_EXECUTE = 2;
const HEADER_SIZE = 32;
const SEGMENT_COMMAND_SIZE = 72;
const SECTION_SIZE = 80;
const VM_PROT_READ = 1;
// 16 KiB: arm64's page size, and a multiple of x64's 4 KiB.
const SEGMENT_ALIGN = 0x4000;
const SIGNATURE_ALIGN = 16;

const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x2;
const LC_DYSYMTAB = 0xb;
const LC_CODE_SIGNATURE = 0x1d;
const LC_DYLD_INFO = 0x22;
const LC_DYLD_INFO_ONLY = 0x80000022;
const LC_NOTE = 0x31;
const LC_DYLD_CHAINED_FIXUPS = 0x80000034;
// linkedit_data_command { cmd, cmdsize, dataoff, datasize }.
const LINKEDIT_DATA_COMMANDS = new Set([
  LC_CODE_SIGNATURE,
  0x1e, // LC_SEGMENT_SPLIT_INFO
  0x26, // LC_FUNCTION_STARTS
  0x29, // LC_DATA_IN_CODE
  0x2b, // LC_DYLIB_CODE_SIGN_DRS
  0x2e, // LC_LINKER_OPTIMIZATION_HINT
  0x36, // LC_ATOM_INFO
  0x37, // LC_FUNCTION_VARIANTS
  0x38, // LC_FUNCTION_VARIANT_FIXUPS
  0x80000033, // LC_DYLD_EXPORTS_TRIE
  LC_DYLD_CHAINED_FIXUPS,
]);
// Commands with no file offsets, which injection leaves as they are.
const PLAIN_COMMANDS = new Set([
  0xc, // LC_LOAD_DYLIB
  0xd, // LC_ID_DYLIB
  0xe, // LC_LOAD_DYLINKER
  0x1b, // LC_UUID
  0x20, // LC_LAZY_LOAD_DYLIB
  0x24, // LC_VERSION_MIN_MACOSX
  0x27, // LC_DYLD_ENVIRONMENT
  0x2a, // LC_SOURCE_VERSION
  0x2d, // LC_LINKER_OPTION
  0x32, // LC_BUILD_VERSION
  0x80000018, // LC_LOAD_WEAK_DYLIB
  0x8000001c, // LC_RPATH
  0x8000001f, // LC_REEXPORT_DYLIB
  0x80000023, // LC_LOAD_UPWARD_DYLIB
  0x80000028, // LC_MAIN (entryoff is inside __TEXT, which doesn't move)
]);

export class MachOInjectError extends Error {
  constructor(message) {
    super(message);
    this.name = "MachOInjectError";
  }
}

const alignUp = (value, to) => Math.ceil(value / to) * to;
const fixedName = (buffer, at) => buffer.toString("latin1", at, at + 16).replace(/\0+$/, "");
const toNumber = (value, what) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new MachOInjectError(`${what} is too large.`);
  return number;
};

/**
 * The slice for `cpuType` from a universal binary, or the binary itself if
 * it is already thin. nodejs.org ships thin binaries per architecture; this
 * keeps a universal one (from another source) usable.
 */
export function thinSlice(bytes, cpuType) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 8) throw new MachOInjectError("This is not a Mach-O file.");
  const magic = buffer.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return buffer;
  const wide = magic === FAT_MAGIC_64;
  const count = buffer.readUInt32BE(4);
  const entry = wide ? 32 : 20;
  if (8 + count * entry > buffer.length) throw new MachOInjectError("The universal binary's header is truncated.");
  for (let index = 0; index < count; index += 1) {
    const at = 8 + index * entry;
    if (buffer.readUInt32BE(at) !== cpuType) continue;
    const offset = wide ? toNumber(buffer.readBigUInt64BE(at + 8), "A slice offset") : buffer.readUInt32BE(at + 8);
    const size = wide ? toNumber(buffer.readBigUInt64BE(at + 16), "A slice size") : buffer.readUInt32BE(at + 12);
    if (offset + size > buffer.length) throw new MachOInjectError("A slice of the universal binary runs past its end.");
    return buffer.subarray(offset, offset + size);
  }
  throw new MachOInjectError(`The universal binary has no slice for CPU type 0x${cpuType.toString(16)}.`);
}

/**
 * The header, load commands, segments and sections of a thin 64-bit
 * little-endian Mach-O executable, with every file offset into __LINKEDIT
 * a load command holds (`refs`).
 */
export function readMachO(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < HEADER_SIZE) throw new MachOInjectError("This is not a Mach-O file.");
  const magic = buffer.readUInt32LE(0);
  if (buffer.readUInt32BE(0) === FAT_MAGIC || buffer.readUInt32BE(0) === FAT_MAGIC_64) throw new MachOInjectError("This is a universal binary; take one slice first.");
  if (magic !== MH_MAGIC_64) throw new MachOInjectError("This is not a 64-bit little-endian Mach-O file.");
  const cpuType = buffer.readUInt32LE(4);
  const fileType = buffer.readUInt32LE(12);
  if (fileType !== MH_EXECUTE) throw new MachOInjectError("The Mach-O file is not an executable (MH_EXECUTE).");
  const ncmds = buffer.readUInt32LE(16);
  const sizeofcmds = buffer.readUInt32LE(20);
  if (HEADER_SIZE + sizeofcmds > buffer.length) throw new MachOInjectError("The load commands run past the end of the file.");
  const commands = [];
  const segments = [];
  const refs = [];
  let at = HEADER_SIZE;
  for (let index = 0; index < ncmds; index += 1) {
    if (at + 8 > HEADER_SIZE + sizeofcmds) throw new MachOInjectError("A load command runs past the load commands.");
    const cmd = buffer.readUInt32LE(at);
    const cmdsize = buffer.readUInt32LE(at + 4);
    if (cmdsize < 8 || cmdsize % 8 !== 0 || at + cmdsize > HEADER_SIZE + sizeofcmds) throw new MachOInjectError(`Load command ${index} has a bad size.`);
    const command = { index, cmd, at, size: cmdsize };
    commands.push(command);
    // Offsets (`field`) and lengths (`count` x `unit` bytes) into the file.
    // `align` is the alignment dyld requires (mach_o/Image.cpp).
    const ref = (field, countField, unit = 1, wide = false, align = 8) => {
      const offset = wide ? toNumber(buffer.readBigUInt64LE(at + field), "A file offset") : buffer.readUInt32LE(at + field);
      const count = wide ? toNumber(buffer.readBigUInt64LE(at + countField), "A size") : buffer.readUInt32LE(at + countField);
      refs.push({ command, field, wide, offset, size: count * unit, align });
    };
    if (cmd === LC_SEGMENT_64) {
      if (cmdsize < SEGMENT_COMMAND_SIZE) throw new MachOInjectError("A segment command is too short.");
      const nsects = buffer.readUInt32LE(at + 64);
      if (SEGMENT_COMMAND_SIZE + nsects * SECTION_SIZE > cmdsize) throw new MachOInjectError("A segment's sections run past its command.");
      const segment = {
        command,
        index: segments.length,
        name: fixedName(buffer, at + 8),
        vmaddr: toNumber(buffer.readBigUInt64LE(at + 24), "A segment address"),
        vmsize: toNumber(buffer.readBigUInt64LE(at + 32), "A segment size"),
        fileoff: toNumber(buffer.readBigUInt64LE(at + 40), "A segment offset"),
        filesize: toNumber(buffer.readBigUInt64LE(at + 48), "A segment size"),
        maxprot: buffer.readUInt32LE(at + 56),
        initprot: buffer.readUInt32LE(at + 60),
        sections: [],
      };
      for (let section = 0; section < nsects; section += 1) {
        const s = at + SEGMENT_COMMAND_SIZE + section * SECTION_SIZE;
        segment.sections.push({
          name: fixedName(buffer, s),
          segment: fixedName(buffer, s + 16),
          addr: toNumber(buffer.readBigUInt64LE(s + 32), "A section address"),
          size: toNumber(buffer.readBigUInt64LE(s + 40), "A section size"),
          offset: buffer.readUInt32LE(s + 48),
          flags: buffer.readUInt32LE(s + 64),
        });
      }
      segments.push(segment);
    } else if (cmd === LC_SYMTAB) {
      ref(8, 12, 16); // symoff, nsyms x nlist_64
      ref(16, 20, 1, false, 1); // stroff, strsize
    } else if (cmd === LC_DYSYMTAB) {
      ref(32, 36, 8); // tocoff, ntoc
      ref(40, 44, 56); // modtaboff, nmodtab (dylib_module_64)
      ref(48, 52, 4); // extrefsymoff, nextrefsyms
      ref(56, 60, 4, false, 4); // indirectsymoff, nindirectsyms
      ref(64, 68, 8); // extreloff, nextrel
      ref(72, 76, 8); // locreloff, nlocrel
    } else if (cmd === LC_DYLD_INFO || cmd === LC_DYLD_INFO_ONLY) {
      for (let field = 8; field < 48; field += 8) ref(field, field + 4); // rebase, bind, weak, lazy, export
    } else if (LINKEDIT_DATA_COMMANDS.has(cmd)) {
      ref(8, 12);
    } else if (cmd === LC_NOTE) {
      ref(24, 32, 1, true, 1);
    } else if (!PLAIN_COMMANDS.has(cmd)) {
      throw new MachOInjectError(`Load command 0x${cmd.toString(16)} isn't one the injector knows how to keep.`);
    }
    at += cmdsize;
  }
  return { buffer, cpuType, ncmds, sizeofcmds, commands, segments, refs };
}

/** The blob Node would find (getsectdata("NODE_SEA", "__NODE_SEA_BLOB")),
 * or null. */
export function findMachOSeaBlob(bytes) {
  const { buffer, segments } = readMachO(bytes);
  const segment = segments.find(({ name }) => name === SEA_SEGMENT);
  const section = segment?.sections.find(({ name }) => name === SEA_SECTION);
  if (!section) return null;
  // The section must be mapped where its address says: getsectdata returns
  // the address, and the kernel maps the file at fileoff -> vmaddr.
  if (section.segment !== SEA_SEGMENT || section.offset - segment.fileoff !== section.addr - segment.vmaddr) throw new MachOInjectError("The SEA section isn't mapped at its address.");
  if (section.addr + section.size > segment.vmaddr + segment.filesize || section.offset + section.size > buffer.length) throw new MachOInjectError("The SEA section runs past its segment.");
  return buffer.subarray(section.offset, section.offset + section.size);
}

// The chained fixups blob with an empty entry for a new segment at
// `insertIndex` (dyld_chained_fixups_header and dyld_chained_starts_in_image
// from <mach-o/fixup-chains.h>).
export function addChainedFixupsSegment(fixups, insertIndex) {
  if (fixups.length < 28) throw new MachOInjectError("The chained fixups are too short.");
  const startsOffset = fixups.readUInt32LE(4);
  const importsOffset = fixups.readUInt32LE(8);
  const symbolsOffset = fixups.readUInt32LE(12);
  if (startsOffset + 4 > fixups.length) throw new MachOInjectError("The chained fixups' segment table is outside them.");
  const segCount = fixups.readUInt32LE(startsOffset);
  const arrayEnd = startsOffset + 4 + segCount * 4;
  if (arrayEnd > fixups.length || importsOffset < arrayEnd || symbolsOffset < importsOffset || symbolsOffset > fixups.length)
    throw new MachOInjectError("The chained fixups have an unexpected layout.");
  if (segCount !== insertIndex + 1) throw new MachOInjectError(`The chained fixups list ${segCount} segments, not one per segment up to __LINKEDIT.`);
  const entries = [];
  for (let index = 0; index < segCount; index += 1) {
    const offset = fixups.readUInt32LE(startsOffset + 4 + index * 4);
    if (offset !== 0 && offset < 4 + segCount * 4) throw new MachOInjectError("A chained fixups segment entry points into the segment table.");
    entries.push(offset === 0 ? 0 : offset + 8);
  }
  entries.splice(insertIndex, 0, 0);
  const grown = Buffer.alloc(fixups.length + 8);
  fixups.copy(grown, 0, 0, startsOffset);
  grown.writeUInt32LE(importsOffset + 8, 8);
  grown.writeUInt32LE(symbolsOffset + 8, 12);
  grown.writeUInt32LE(segCount + 1, startsOffset);
  entries.forEach((offset, index) => grown.writeUInt32LE(offset, startsOffset + 4 + index * 4));
  // arrayEnd + 4 .. arrayEnd + 8 stays zero (alignment).
  fixups.copy(grown, arrayEnd + 8, arrayEnd);
  return grown;
}

function writeSegment(target, at, { name, vmaddr, vmsize, fileoff, filesize, sections }) {
  target.fill(0, at, at + SEGMENT_COMMAND_SIZE + sections.length * SECTION_SIZE);
  target.writeUInt32LE(LC_SEGMENT_64, at);
  target.writeUInt32LE(SEGMENT_COMMAND_SIZE + sections.length * SECTION_SIZE, at + 4);
  target.write(name, at + 8, "latin1");
  target.writeBigUInt64LE(BigInt(vmaddr), at + 24);
  target.writeBigUInt64LE(BigInt(vmsize), at + 32);
  target.writeBigUInt64LE(BigInt(fileoff), at + 40);
  target.writeBigUInt64LE(BigInt(filesize), at + 48);
  target.writeUInt32LE(VM_PROT_READ, at + 56);
  target.writeUInt32LE(VM_PROT_READ, at + 60);
  target.writeUInt32LE(sections.length, at + 64);
  sections.forEach((section, index) => {
    const s = at + SEGMENT_COMMAND_SIZE + index * SECTION_SIZE;
    target.write(section.name, s, "latin1");
    target.write(name, s + 16, "latin1");
    target.writeBigUInt64LE(BigInt(section.addr), s + 32);
    target.writeBigUInt64LE(BigInt(section.size), s + 40);
    target.writeUInt32LE(section.offset, s + 48);
    target.writeUInt32LE(section.align, s + 52);
    // reloff, nreloc, flags (S_REGULAR) and reserved1-3 stay zero.
  });
}

/**
 * A new Mach-O image: `executable` (thin) with `blob` added as the
 * NODE_SEA/__NODE_SEA_BLOB section and an ad-hoc signature in place of the
 * old one. Deterministic. Throws MachOInjectError for anything it can't
 * handle safely, including a binary that already carries a blob.
 */
export function injectMachO(executable, blob, { identifier = "kin" } = {}) {
  const macho = readMachO(executable);
  const { buffer, segments, commands, refs } = macho;
  if (!blob?.length) throw new MachOInjectError("The SEA blob is empty.");
  if (segments.some(({ name }) => name === SEA_SEGMENT)) throw new MachOInjectError("This executable already contains a SEA blob. Start from an unmodified node binary.");

  const linkedit = segments.at(-1);
  if (linkedit?.name !== "__LINKEDIT") throw new MachOInjectError("__LINKEDIT isn't the last segment command.");
  const text = segments.find(({ name }) => name === "__TEXT");
  if (!text || text.fileoff !== 0) throw new MachOInjectError("The executable has no __TEXT segment at the start of the file.");
  for (const segment of segments.slice(0, -1)) {
    if (segment.fileoff + segment.filesize > linkedit.fileoff || (segment.vmsize && segment.vmaddr + segment.vmsize > linkedit.vmaddr))
      throw new MachOInjectError(`Segment ${segment.name} lies after __LINKEDIT.`);
  }
  if (linkedit.fileoff + linkedit.filesize !== buffer.length) throw new MachOInjectError("__LINKEDIT doesn't end at the end of the file.");
  if (linkedit.fileoff % 0x1000 !== 0 || linkedit.vmaddr % 0x1000 !== 0) throw new MachOInjectError("__LINKEDIT isn't page aligned.");

  // The old signature is cut off; everything else in __LINKEDIT is kept.
  const signatureCommand = commands.find(({ cmd }) => cmd === LC_CODE_SIGNATURE);
  const signatureRef = refs.find(({ command }) => command === signatureCommand);
  const contentEnd = signatureRef ? signatureRef.offset : buffer.length;
  if (signatureRef && signatureRef.offset + signatureRef.size !== buffer.length) throw new MachOInjectError("The code signature isn't at the end of the file.");
  const moved = refs.filter((ref) => ref !== signatureRef && !(ref.offset === 0 && ref.size === 0));
  for (const ref of moved)
    if (ref.offset < linkedit.fileoff || ref.offset + ref.size > contentEnd) throw new MachOInjectError(`Load command 0x${ref.command.cmd.toString(16)} points outside __LINKEDIT.`);

  // Chained fixups gain an entry for the new segment.
  const fixupsRef = refs.find(({ command }) => command.cmd === LC_DYLD_CHAINED_FIXUPS);
  const fixups = fixupsRef ? addChainedFixupsSegment(buffer.subarray(fixupsRef.offset, fixupsRef.offset + fixupsRef.size), linkedit.index) : null;
  const growth = fixups ? fixups.length - fixupsRef.size : 0;
  const fixupsEnd = fixupsRef ? fixupsRef.offset + fixupsRef.size : Infinity;

  // The load commands: NODE_SEA before __LINKEDIT, and an LC_CODE_SIGNATURE
  // (added at the end if the binary had none). They must still fit before
  // the first section's contents, in what the linker left as zero padding.
  const seaCommandSize = SEGMENT_COMMAND_SIZE + SECTION_SIZE;
  const added = seaCommandSize + (signatureCommand ? 0 : 16);
  const oldEnd = HEADER_SIZE + macho.sizeofcmds;
  const firstContent = Math.min(...segments.flatMap(({ sections }) => sections).filter(({ offset, size }) => offset > 0 && size > 0).map(({ offset }) => offset), linkedit.fileoff);
  if (oldEnd + added > firstContent || !buffer.subarray(oldEnd, oldEnd + added).every((byte) => byte === 0))
    throw new MachOInjectError("There is no room for another load command before the first section.");

  const seaFileoff = linkedit.fileoff;
  const seaVmaddr = linkedit.vmaddr;
  const seaSize = alignUp(blob.length, SEGMENT_ALIGN);
  const newLinkeditFileoff = seaFileoff + seaSize;
  const shift = (offset) => offset + seaSize + (offset >= fixupsEnd ? growth : 0);
  const linkeditContent = contentEnd - linkedit.fileoff + growth;
  const signatureOffset = alignUp(newLinkeditFileoff + linkeditContent, SIGNATURE_ALIGN);
  const signatureSize = alignUp(adHocSignatureSize(signatureOffset, identifier), SIGNATURE_ALIGN);
  const total = signatureOffset + signatureSize;
  const newLinkeditFilesize = total - newLinkeditFileoff;

  const output = Buffer.alloc(total);
  buffer.copy(output, 0, 0, seaFileoff);
  output.fill(0, HEADER_SIZE, oldEnd + added);

  // Load commands, in order, with NODE_SEA inserted before __LINKEDIT.
  let at = HEADER_SIZE;
  const placed = new Map();
  for (const command of commands) {
    if (command === linkedit.command) {
      writeSegment(output, at, {
        name: SEA_SEGMENT, vmaddr: seaVmaddr, vmsize: seaSize, fileoff: seaFileoff, filesize: seaSize,
        sections: [{ name: SEA_SECTION, addr: seaVmaddr, size: blob.length, offset: seaFileoff, align: 4 }],
      });
      at += seaCommandSize;
    }
    buffer.copy(output, at, command.at, command.at + command.size);
    placed.set(command, at);
    at += command.size;
  }
  let signatureAt = signatureCommand ? placed.get(signatureCommand) : at;
  if (!signatureCommand) {
    output.writeUInt32LE(LC_CODE_SIGNATURE, at);
    output.writeUInt32LE(16, at + 4);
    at += 16;
  }
  output.writeUInt32LE(macho.ncmds + 1 + (signatureCommand ? 0 : 1), 16);
  output.writeUInt32LE(macho.sizeofcmds + added, 20);

  const linkeditAt = placed.get(linkedit.command);
  output.writeBigUInt64LE(BigInt(seaVmaddr + seaSize), linkeditAt + 24);
  output.writeBigUInt64LE(BigInt(alignUp(newLinkeditFilesize, SEGMENT_ALIGN)), linkeditAt + 32);
  output.writeBigUInt64LE(BigInt(newLinkeditFileoff), linkeditAt + 40);
  output.writeBigUInt64LE(BigInt(newLinkeditFilesize), linkeditAt + 48);
  for (const ref of moved) {
    const field = placed.get(ref.command) + ref.field;
    if (ref.wide) output.writeBigUInt64LE(BigInt(shift(ref.offset)), field);
    else output.writeUInt32LE(shift(ref.offset), field);
  }
  if (fixupsRef) output.writeUInt32LE(fixups.length, placed.get(fixupsRef.command) + 12);
  output.writeUInt32LE(signatureOffset, signatureAt + 8);
  output.writeUInt32LE(signatureSize, signatureAt + 12);

  // The blob, then __LINKEDIT's contents (with the grown fixups).
  Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).copy(output, seaFileoff);
  if (fixupsRef) {
    buffer.copy(output, newLinkeditFileoff, linkedit.fileoff, fixupsRef.offset);
    fixups.copy(output, shift(fixupsRef.offset));
    buffer.copy(output, shift(fixupsEnd), fixupsEnd, contentEnd);
  } else {
    buffer.copy(output, newLinkeditFileoff, linkedit.fileoff, contentEnd);
  }

  const signature = adHocSignature(output, { codeLimit: signatureOffset, identifier, execSegBase: text.fileoff, execSegLimit: text.filesize });
  signature.copy(output, signatureOffset);
  return output;
}

/**
 * Checks what dyld and the kernel check before running a Mach-O executable
 * Kin built, as far as that can be done without a Mac: segments inside the
 * file, aligned, in order and not overlapping; __LINKEDIT last and ending
 * at the end of the file; every __LINKEDIT table inside it, aligned and not
 * overlapping (dyld's mach_o/Image.cpp); chained fixups with one entry per
 * segment up to __LINKEDIT, each at its segment's address; the SEA blob
 * where getsectdata finds it; and the ad-hoc signature's page hashes.
 * Returns { blob, signature }; throws MachOInjectError or
 * CodeSignatureError.
 */
export function checkMachOExecutable(bytes) {
  const macho = readMachO(bytes);
  const { buffer, segments, refs } = macho;
  const pageSize = macho.cpuType === CPU_TYPE_ARM64 ? 0x4000 : 0x1000;
  const fail = (message) => { throw new MachOInjectError(message); };
  const linkedit = segments.at(-1);
  if (linkedit?.name !== "__LINKEDIT") fail("__LINKEDIT isn't the last segment command.");
  if (linkedit.fileoff + linkedit.filesize !== buffer.length) fail("__LINKEDIT doesn't end at the end of the file.");
  const text = segments.find(({ name }) => name === "__TEXT");
  if (!text || text.fileoff !== 0) fail("__TEXT doesn't start the file.");
  const mapped = segments.filter(({ vmsize }) => vmsize > 0);
  let previous = null;
  for (const segment of mapped) {
    if (segment.fileoff % pageSize || segment.vmaddr % pageSize) fail(`Segment ${segment.name} isn't page aligned.`);
    if (segment.filesize > segment.vmsize) fail(`Segment ${segment.name} is larger in the file than in memory.`);
    if (segment.fileoff + segment.filesize > buffer.length) fail(`Segment ${segment.name} runs past the end of the file.`);
    for (const section of segment.sections) {
      if (section.addr < segment.vmaddr || section.addr + section.size > segment.vmaddr + segment.vmsize) fail(`Section ${section.name} lies outside ${segment.name}.`);
      if (section.offset && section.offset - segment.fileoff !== section.addr - segment.vmaddr) fail(`Section ${section.name} isn't mapped at its address.`);
    }
    if (previous) {
      if (segment.vmaddr < previous.vmaddr + previous.vmsize) fail(`Segments ${previous.name} and ${segment.name} overlap in memory or are out of order.`);
      if (segment.filesize && previous.filesize && segment.fileoff < previous.fileoff + previous.filesize) fail(`Segments ${previous.name} and ${segment.name} overlap in the file or are out of order.`);
    }
    previous = segment;
  }
  const firstContent = Math.min(...segments.flatMap(({ sections }) => sections).filter(({ offset, size }) => offset > 0 && size > 0).map(({ offset }) => offset));
  if (HEADER_SIZE + macho.sizeofcmds > firstContent) fail("The load commands overlap the first section.");

  const chunks = refs.filter(({ size }) => size > 0).sort((left, right) => left.offset - right.offset);
  let end = linkedit.fileoff;
  for (const chunk of chunks) {
    const align = chunk.command.cmd === LC_CODE_SIGNATURE ? SIGNATURE_ALIGN : chunk.align;
    if (chunk.offset < end) fail(`__LINKEDIT tables overlap at file offset ${chunk.offset}.`);
    if (chunk.offset + chunk.size > linkedit.fileoff + linkedit.filesize) fail(`A __LINKEDIT table runs past __LINKEDIT (load command 0x${chunk.command.cmd.toString(16)}).`);
    if (chunk.offset % align) fail(`A __LINKEDIT table is misaligned (load command 0x${chunk.command.cmd.toString(16)}).`);
    end = chunk.offset + chunk.size;
  }

  const fixups = refs.find(({ command }) => command.cmd === LC_DYLD_CHAINED_FIXUPS);
  if (fixups?.size) {
    const data = buffer.subarray(fixups.offset, fixups.offset + fixups.size);
    const starts = data.readUInt32LE(4);
    const segCount = data.readUInt32LE(starts);
    if (segCount !== linkedit.index + 1) fail(`The chained fixups list ${segCount} segments; the executable has ${linkedit.index + 1} up to __LINKEDIT.`);
    for (let index = 0; index < segCount; index += 1) {
      const offset = data.readUInt32LE(starts + 4 + index * 4);
      if (!offset) continue;
      const at = starts + offset;
      if (at + 24 > data.length) fail(`The chained fixups for segment ${index} lie outside them.`);
      if (Number(data.readBigUInt64LE(at + 8)) !== segments[index].vmaddr - text.vmaddr) fail(`The chained fixups for segment ${index} don't match its address.`);
    }
  }

  const signature = refs.find(({ command }) => command.cmd === LC_CODE_SIGNATURE);
  if (!signature?.size) fail("The executable has no code signature.");
  if (signature.offset + signature.size !== buffer.length) fail("The code signature isn't at the end of the file.");
  const parsed = verifyAdHocSignature(buffer, signature.offset);
  if (parsed.codeDirectory.execSegBase !== BigInt(text.fileoff) || parsed.codeDirectory.execSegLimit !== BigInt(text.filesize)) fail("The signature's executable segment isn't __TEXT.");
  const blob = findMachOSeaBlob(buffer);
  if (!blob) fail("Node wouldn't find the SEA blob: there is no NODE_SEA/__NODE_SEA_BLOB section.");
  return { blob, signature: parsed };
}
