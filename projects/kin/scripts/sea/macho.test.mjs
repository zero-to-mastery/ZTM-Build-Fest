// Kin's Mach-O injector (scripts/sea/macho.mjs, #747): the layout it writes
// on synthetic executables (chained fixups and the older LC_DYLD_INFO), the
// universal-binary slice, refusals, and, when official node binaries for
// macOS are cached (official-binaries.mjs), the real thing parsed back,
// with its page hashes checked against Apple's own signature and, if
// llvm-objdump is installed, an independent reading of the result.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { adHocSignature, readCodeSignature, verifyAdHocSignature } from "./codesign.mjs";
import { flipFuse, fuseFlipped, SEA_FUSE } from "./fuse.mjs";
import { addChainedFixupsSegment, checkMachOExecutable, CPU_TYPE_ARM64, CPU_TYPE_X86_64, findMachOSeaBlob, injectMachO, MachOInjectError, readMachO, SEA_SECTION, SEA_SEGMENT, thinSlice } from "./macho.mjs";
import { officialBinaries } from "./official-binaries.mjs";

const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x2;
const LC_DYSYMTAB = 0xb;
const LC_CODE_SIGNATURE = 0x1d;
const LC_DYLD_INFO_ONLY = 0x80000022;
const LC_DYLD_EXPORTS_TRIE = 0x80000033;
const LC_DYLD_CHAINED_FIXUPS = 0x80000034;
const LC_MAIN = 0x80000028;
const BASE = 0x100000000;
const LINKEDIT = 0xc000;

function segment(name, vmaddr, vmsize, fileoff, filesize, prot, sections = []) {
  const command = Buffer.alloc(72 + sections.length * 80);
  command.writeUInt32LE(LC_SEGMENT_64, 0);
  command.writeUInt32LE(command.length, 4);
  command.write(name, 8, "latin1");
  command.writeBigUInt64LE(BigInt(vmaddr), 24);
  command.writeBigUInt64LE(BigInt(vmsize), 32);
  command.writeBigUInt64LE(BigInt(fileoff), 40);
  command.writeBigUInt64LE(BigInt(filesize), 48);
  command.writeUInt32LE(prot, 56);
  command.writeUInt32LE(prot, 60);
  command.writeUInt32LE(sections.length, 64);
  sections.forEach(([sectname, addr, size, offset], index) => {
    const at = 72 + index * 80;
    command.write(sectname, at, "latin1");
    command.write(name, at + 16, "latin1");
    command.writeBigUInt64LE(BigInt(addr), at + 32);
    command.writeBigUInt64LE(BigInt(size), at + 40);
    command.writeUInt32LE(offset, at + 48);
  });
  return command;
}

const words = (cmd, values) => {
  const command = Buffer.alloc(8 + values.length * 4);
  command.writeUInt32LE(cmd, 0);
  command.writeUInt32LE(command.length, 4);
  values.forEach((value, index) => command.writeUInt32LE(value, 8 + index * 4));
  return command;
};

// dyld_chained_fixups_header, starts_in_image for four segments (__DATA,
// index 2, has one page of fixups), one import and its name.
function chainedFixups() {
  const fixups = Buffer.alloc(96);
  fixups.writeUInt32LE(0, 0); // fixups_version
  fixups.writeUInt32LE(32, 4); // starts_offset
  fixups.writeUInt32LE(80, 8); // imports_offset
  fixups.writeUInt32LE(84, 12); // symbols_offset
  fixups.writeUInt32LE(1, 16); // imports_count
  fixups.writeUInt32LE(1, 20); // DYLD_CHAINED_IMPORT
  fixups.writeUInt32LE(4, 32); // seg_count: __PAGEZERO __TEXT __DATA __LINKEDIT
  [0, 0, 24, 0].forEach((offset, index) => fixups.writeUInt32LE(offset, 36 + index * 4));
  const starts = 56; // dyld_chained_starts_in_segment for __DATA
  fixups.writeUInt32LE(24, starts);
  fixups.writeUInt16LE(0x4000, starts + 4);
  fixups.writeUInt16LE(6, starts + 6); // DYLD_CHAINED_PTR_64_OFFSET
  fixups.writeBigUInt64LE(0x8000n, starts + 8); // segment_offset
  fixups.writeUInt16LE(1, starts + 20); // page_count
  fixups.writeUInt16LE(0, starts + 22); // page_start[0]
  fixups.writeUInt32LE(1 | (1 << 9), 80); // lib 1, name at symbols + 1
  fixups.write("\0_example\0", 84, "latin1");
  return fixups;
}

/**
 * A minimal arm64 (or x64) executable laid out like a linked node binary:
 * __PAGEZERO, __TEXT (header, __text with the fuse), __DATA, __LINKEDIT
 * with fixups, an export trie, symbols, indirect symbols, strings and an
 * old code signature at the end.
 */
function syntheticMachO({ fixups = "chained", cpuType = CPU_TYPE_ARM64, signature = true } = {}) {
  const linkedit = [];
  const place = (size, align = 8) => {
    const at = LINKEDIT + linkedit.reduce((end, [, length]) => end + length, 0);
    const padded = Math.ceil(at / align) * align;
    if (padded > at) linkedit.push(["pad", padded - at]);
    linkedit.push(["chunk", size]);
    return padded;
  };
  const fixupsBytes = fixups === "chained" ? chainedFixups() : Buffer.alloc(16, 0x11);
  const fixupsAt = place(fixupsBytes.length);
  const trieAt = place(8);
  const symbolsAt = place(32);
  const indirectAt = place(8, 4);
  const stringsAt = place(16, 1);
  const oldSignature = Buffer.alloc(48);
  oldSignature.writeUInt32BE(0xfade0cc0, 0);
  const signatureAt = signature ? place(oldSignature.length, 16) : null;
  const end = LINKEDIT + linkedit.reduce((sum, [, length]) => sum + length, 0);

  const commands = [
    segment("__PAGEZERO", 0, BASE, 0, 0, 0),
    segment("__TEXT", BASE, 0x8000, 0, 0x8000, 5, [["__text", BASE + 0x4000, 0x200, 0x4000]]),
    segment("__DATA", BASE + 0x8000, 0x4000, 0x8000, 0x4000, 3, [["__data", BASE + 0x8000, 0x40, 0x8000]]),
    segment("__LINKEDIT", BASE + LINKEDIT, 0x4000, LINKEDIT, end - LINKEDIT, 1),
    fixups === "chained" ? words(LC_DYLD_CHAINED_FIXUPS, [fixupsAt, fixupsBytes.length]) : words(LC_DYLD_INFO_ONLY, [fixupsAt, 16, 0, 0, 0, 0, 0, 0, trieAt, 8]),
    ...(fixups === "chained" ? [words(LC_DYLD_EXPORTS_TRIE, [trieAt, 8])] : []),
    words(LC_SYMTAB, [symbolsAt, 2, stringsAt, 16]),
    words(LC_DYSYMTAB, [0, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0, 0, indirectAt, 2, 0, 0, 0, 0]),
    words(LC_MAIN, [0x4000, 0, 0, 0]),
    ...(signature ? [words(LC_CODE_SIGNATURE, [signatureAt, oldSignature.length])] : []),
  ];
  const buffer = Buffer.alloc(end);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(cpuType, 4);
  buffer.writeUInt32LE(2, 12); // MH_EXECUTE
  buffer.writeUInt32LE(commands.length, 16);
  buffer.writeUInt32LE(commands.reduce((sum, command) => sum + command.length, 0), 20);
  buffer.writeUInt32LE(0x00200085, 24);
  Buffer.concat(commands).copy(buffer, 32);
  buffer.fill(0xc3, 0x4000, 0x4200);
  buffer.write(`${SEA_FUSE}:0`, 0x4100, "latin1");
  buffer.fill(0xda, 0x8000, 0x8040);
  fixupsBytes.copy(buffer, fixupsAt);
  buffer.fill(0x7e, trieAt, trieAt + 8);
  buffer.fill(0x5b, symbolsAt, symbolsAt + 32);
  buffer.fill(0x1d, indirectAt, indirectAt + 8);
  buffer.write("\0_main\0_example\0", stringsAt, "latin1");
  if (signature) oldSignature.copy(buffer, signatureAt);
  return { buffer, fixupsAt, fixupsBytes, trieAt, symbolsAt, indirectAt, stringsAt, signatureAt };
}

const refOf = (macho, cmd, field = 8) => macho.refs.find(({ command, field: at }) => command.cmd === cmd && at === field);

test("the blob becomes NODE_SEA/__NODE_SEA_BLOB where __LINKEDIT was, and __LINKEDIT moves up intact", { timeout: 60_000 }, () => {
  const original = syntheticMachO();
  const blob = Buffer.from("a SEA blob of odd length");
  const injected = injectMachO(flipFuse(Buffer.from(original.buffer)), blob);
  const { signature } = checkMachOExecutable(injected);
  const macho = readMachO(injected);
  assert.deepEqual(macho.segments.map(({ name }) => name), ["__PAGEZERO", "__TEXT", "__DATA", SEA_SEGMENT, "__LINKEDIT"]);
  const [sea, linkedit] = macho.segments.slice(3);
  assert.deepEqual([sea.fileoff, sea.vmaddr, sea.filesize, sea.vmsize, sea.initprot, sea.maxprot], [LINKEDIT, BASE + LINKEDIT, 0x4000, 0x4000, 1, 1]);
  assert.deepEqual(sea.sections.map(({ name, segment: owner, addr, offset, size }) => [name, owner, addr, offset, size]), [[SEA_SECTION, SEA_SEGMENT, BASE + LINKEDIT, LINKEDIT, blob.length]]);
  assert.deepEqual(findMachOSeaBlob(injected), blob);
  assert.deepEqual([linkedit.fileoff, linkedit.vmaddr], [LINKEDIT + 0x4000, BASE + LINKEDIT + 0x4000]);
  assert.equal(linkedit.fileoff + linkedit.filesize, injected.length);

  // Every __LINKEDIT table moved by 16 KiB, and those after the fixups by 8
  // more (the fixups' new segment entry); their contents are unchanged.
  const moved = 0x4000;
  assert.equal(refOf(macho, LC_DYLD_CHAINED_FIXUPS).offset, original.fixupsAt + moved);
  assert.equal(refOf(macho, LC_DYLD_CHAINED_FIXUPS).size, original.fixupsBytes.length + 8);
  for (const [cmd, field, at, size] of [[LC_DYLD_EXPORTS_TRIE, 8, original.trieAt, 8], [LC_SYMTAB, 8, original.symbolsAt, 32], [LC_SYMTAB, 16, original.stringsAt, 16], [LC_DYSYMTAB, 56, original.indirectAt, 8]]) {
    const ref = refOf(macho, cmd, field);
    assert.equal(ref.offset, at + moved + 8, `0x${cmd.toString(16)} +${field}`);
    assert.deepEqual(injected.subarray(ref.offset, ref.offset + size), original.buffer.subarray(at, at + size));
  }
  // The fixups: a fifth segment entry (0, for NODE_SEA) before __LINKEDIT's,
  // and everything after the entry table 8 bytes later.
  const fixups = injected.subarray(refOf(macho, LC_DYLD_CHAINED_FIXUPS).offset, refOf(macho, LC_DYLD_CHAINED_FIXUPS).offset + 104);
  assert.equal(fixups.readUInt32LE(32), 5);
  assert.deepEqual([0, 1, 2, 3, 4].map((index) => fixups.readUInt32LE(36 + index * 4)), [0, 0, 32, 0, 0]);
  assert.deepEqual([fixups.readUInt32LE(8), fixups.readUInt32LE(12)], [88, 92]);
  assert.deepEqual(fixups.subarray(64), original.fixupsBytes.subarray(56));
  assert.deepEqual(addChainedFixupsSegment(original.fixupsBytes, 3), fixups);

  // The old signature is gone; the new one is ad-hoc, last, and covers
  // everything before it.
  const signatureRef = refOf(macho, LC_CODE_SIGNATURE);
  assert.equal(signatureRef.offset % 16, 0);
  assert.equal(signatureRef.offset + signatureRef.size, injected.length);
  assert.equal(signature.codeDirectory.codeLimit, signatureRef.offset);
  assert.equal(signature.codeDirectory.identifier, "kin");
  assert.equal(signature.codeDirectory.execSegLimit, 0x8000n);

  // Nothing before the old __LINKEDIT changed but the load commands and
  // the fuse.
  const commandsEnd = 32 + macho.sizeofcmds;
  assert.equal(macho.ncmds, readMachO(original.buffer).ncmds + 1);
  assert.equal(macho.sizeofcmds, readMachO(original.buffer).sizeofcmds + 152);
  const unchanged = Buffer.from(injected.subarray(commandsEnd, LINKEDIT));
  assert.ok(fuseFlipped(unchanged));
  flipFuseBack(unchanged);
  assert.deepEqual(unchanged, original.buffer.subarray(commandsEnd, LINKEDIT));
});

function flipFuseBack(bytes) {
  const at = bytes.indexOf(Buffer.from(`${SEA_FUSE}:1`)) + SEA_FUSE.length + 1;
  bytes[at] = 0x30;
}

test("a binary using LC_DYLD_INFO, or without a signature, is injected and signed too", { timeout: 60_000 }, () => {
  for (const options of [{ fixups: "info" }, { signature: false }, { cpuType: CPU_TYPE_X86_64 }]) {
    const original = syntheticMachO(options);
    const blob = Buffer.alloc(0x4001, 9);
    const injected = injectMachO(original.buffer, blob);
    const { blob: found } = checkMachOExecutable(injected);
    assert.deepEqual(found, blob, JSON.stringify(options));
    const macho = readMachO(injected);
    assert.equal(macho.segments.find(({ name }) => name === SEA_SEGMENT).filesize, 0x8000, "two 16 KiB pages");
    assert.equal(macho.commands.filter(({ cmd }) => cmd === LC_CODE_SIGNATURE).length, 1);
    if (options.fixups === "info") assert.equal(refOf(macho, LC_DYLD_INFO_ONLY).offset, original.fixupsAt + 0x8000, "nothing grows without chained fixups");
  }
});

test("injection is deterministic and refuses what it can't handle safely", { timeout: 60_000 }, () => {
  const blob = Buffer.alloc(100_000, 7);
  const first = injectMachO(syntheticMachO().buffer, blob);
  assert.deepEqual(injectMachO(syntheticMachO().buffer, blob), first);
  assert.throws(() => injectMachO(first, blob), (error) => error instanceof MachOInjectError && /already contains/.test(error.message));
  assert.throws(() => injectMachO(syntheticMachO().buffer, Buffer.alloc(0)), /empty/);
  assert.throws(() => injectMachO(Buffer.from("\x7fELF and some more bytes to be long enough"), blob), /not a 64-bit little-endian Mach-O/);

  const object = syntheticMachO().buffer;
  object.writeUInt32LE(1, 12);
  assert.throws(() => injectMachO(object, blob), /not an executable/);
  const unknown = syntheticMachO().buffer;
  unknown.writeUInt32LE(0x99, readMachO(unknown).commands.find(({ cmd }) => cmd === LC_MAIN).at);
  assert.throws(() => injectMachO(unknown, blob), /0x99 isn't one the injector knows/);
  const crowded = syntheticMachO().buffer;
  crowded[32 + crowded.readUInt32LE(20) + 8] = 1; // something right after the load commands
  assert.throws(() => injectMachO(crowded, blob), /no room for another load command/);
  const trailing = Buffer.concat([syntheticMachO().buffer, Buffer.alloc(16)]);
  assert.throws(() => injectMachO(trailing, blob), /doesn't end at the end of the file/);
  const fixups = syntheticMachO();
  fixups.buffer.writeUInt32LE(3, fixups.fixupsAt + 32); // seg_count without __LINKEDIT
  assert.throws(() => injectMachO(fixups.buffer, blob), /not one per segment/);
});

test("a universal binary gives the slice for the target", { timeout: 60_000 }, () => {
  const arm = syntheticMachO().buffer;
  const x64 = syntheticMachO({ cpuType: CPU_TYPE_X86_64 }).buffer;
  const header = Buffer.alloc(0x4000);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(2, 4);
  [[CPU_TYPE_X86_64, 0x4000, x64.length], [CPU_TYPE_ARM64, 0x4000 + Math.ceil(x64.length / 0x4000) * 0x4000, arm.length]].forEach(([cpu, offset, size], index) => {
    const at = 8 + index * 20;
    header.writeUInt32BE(cpu, at);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(size, at + 12);
    header.writeUInt32BE(14, at + 16);
  });
  const fat = Buffer.concat([header, x64, Buffer.alloc(Math.ceil(x64.length / 0x4000) * 0x4000 - x64.length), arm]);
  assert.deepEqual(thinSlice(fat, CPU_TYPE_ARM64), arm);
  assert.deepEqual(thinSlice(fat, CPU_TYPE_X86_64), x64);
  assert.deepEqual(thinSlice(arm, CPU_TYPE_ARM64), arm, "a thin binary is returned as it is");
  assert.throws(() => thinSlice(fat, 0x12), /no slice/);
  assert.throws(() => readMachO(fat), /universal binary/);
});

function llvmObjdump(args) {
  const result = spawnSync("llvm-objdump", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
  return result.error ? null : result;
}

for (const target of ["darwin-arm64", "darwin-x64"]) {
  test(`the official node for ${target}, injected, parses back with a valid layout and signature`, { timeout: 120_000 }, (t) => {
    const paths = officialBinaries(target);
    if (!paths.length) { t.skip(`no official node binary for ${target} is cached (run scripts/build-sea.mjs, or set KIN_SEA_NODE_DIR)`); return; }
    for (const path of paths) checkOfficial(t, target, path);
  });
}

function checkOfficial(t, target, path) {
  const base = thinSlice(readFileSync(path), target === "darwin-arm64" ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64);
  const original = readMachO(base);

  // Kin's page hashing matches Apple's: hashed this way, node's own pages
  // give exactly the SHA-256 CodeDirectory Apple's codesign wrote.
  const appleRef = refOf(original, LC_CODE_SIGNATURE);
  const apple = [...readCodeSignature(base.subarray(appleRef.offset, appleRef.offset + appleRef.size)).slots.values()]
    .filter((blob) => blob.readUInt32BE(0) === 0xfade0c02)
    .map((blob) => readCodeSignature(Buffer.concat([superBlobHeader(blob.length), blob])).codeDirectory)
    .find(({ hashType }) => hashType === 2);
  const text = original.segments.find(({ name }) => name === "__TEXT");
  const ours = readCodeSignature(adHocSignature(base, { codeLimit: appleRef.offset, identifier: "kin", execSegBase: 0, execSegLimit: text.filesize })).codeDirectory;
  assert.equal(ours.pageSize, apple.pageSize);
  assert.equal(ours.execSegLimit, apple.execSegLimit);
  assert.deepEqual(ours.bytes.subarray(ours.hashOffset, ours.hashOffset + ours.nCodeSlots * 32), apple.bytes.subarray(apple.hashOffset, apple.hashOffset + apple.nCodeSlots * 32));

  const blob = Buffer.alloc(3_000_001, 0x42);
  const injected = injectMachO(flipFuse(Buffer.from(base)), blob);
  const { signature } = checkMachOExecutable(injected);
  verifyAdHocSignature(injected, signature.codeDirectory.codeLimit);
  assert.ok(fuseFlipped(injected));
  const after = readMachO(injected);
  assert.deepEqual(after.segments.map(({ name }) => name), [...original.segments.map(({ name }) => name).slice(0, -1), SEA_SEGMENT, "__LINKEDIT"]);

  // An independent reader, when there is one: the same fixups, binds,
  // exports and symbols before and after.
  const directory = mkdtempSync(join(tmpdir(), "kin-macho-"));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const before = join(directory, "node");
  const result = join(directory, "kin");
  writeFileSync(before, base);
  writeFileSync(result, injected);
  if (!llvmObjdump(["--version"])) { t.diagnostic("llvm-objdump isn't installed; skipped the independent reading"); return; }
  t.diagnostic(`checked ${basename(path)} with llvm-objdump`);
  const headers = llvmObjdump(["--macho", "--private-headers", result]);
  assert.equal(headers.status, 0, headers.stderr);
  assert.match(headers.stdout, /segname NODE_SEA/);
  assert.match(headers.stdout, /sectname __NODE_SEA_BLOB/);
  const same = (args) => {
    const one = llvmObjdump([...args, before]);
    const two = llvmObjdump([...args, result]);
    assert.equal(two.status, 0, two.stderr);
    return [one.stdout.replaceAll(before, "FILE"), two.stdout.replaceAll(result, "FILE")];
  };
  for (const option of ["--exports-trie", "--bind", "--rebase", "--lazy-bind", "--weak-bind", "--function-starts", "--indirect-symbols"]) {
    const [one, two] = same(["--macho", option]);
    assert.equal(two, one, `${option} for ${basename(path)}`);
  }
  if (original.refs.some(({ command }) => command.cmd === LC_DYLD_CHAINED_FIXUPS)) {
    const [one, two] = same(["--macho", "--dyld-info"]);
    assert.equal(two, one, "--dyld-info");
  }
}

function superBlobHeader(length) {
  const header = Buffer.alloc(20);
  header.writeUInt32BE(0xfade0cc0, 0);
  header.writeUInt32BE(20 + length, 4);
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(0, 12);
  header.writeUInt32BE(20, 16);
  return header;
}
