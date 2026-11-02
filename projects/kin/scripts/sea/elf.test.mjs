// Kin's ELF injector (scripts/sea/elf.mjs, #714): the layout it writes on a
// synthetic executable, and, on Linux, that a real node binary with a note
// added this way still loads and runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ElfInjectError, findSeaBlob, injectElf, readElf, readNotes, SEA_NOTE_NAME } from "./elf.mjs";

const PT_LOAD = 1;
const PT_NOTE = 4;
const PT_PHDR = 6;

// A minimal 64-bit little-endian executable: PT_PHDR, a read-only PT_LOAD
// from offset 0, a data PT_LOAD with .bss, and a PT_NOTE with one note.
function syntheticElf({ type = 2, base = 0x400000n, machine = 62 } = {}) {
  const buffer = Buffer.alloc(0x1100);
  buffer.writeUInt32BE(0x7f454c46, 0);
  buffer[4] = 2;
  buffer[5] = 1;
  buffer[6] = 1;
  buffer.writeUInt16LE(type, 16);
  buffer.writeUInt16LE(machine, 18);
  buffer.writeUInt32LE(1, 20);
  buffer.writeBigUInt64LE(base + 0x200n, 24);
  buffer.writeBigUInt64LE(64n, 32);
  buffer.writeUInt16LE(64, 52);
  buffer.writeUInt16LE(56, 54);
  buffer.writeUInt16LE(4, 56);
  const headers = [
    [PT_PHDR, 4, 64n, base + 64n, 224n, 224n, 8n],
    [PT_LOAD, 5, 0n, base, 0x400n, 0x400n, 0x1000n],
    [PT_LOAD, 6, 0x1000n, base + 0x1000n, 0x100n, 0x2000n, 0x1000n],
    [PT_NOTE, 4, 0x300n, base + 0x300n, 0x20n, 0x20n, 4n],
  ];
  headers.forEach(([kind, flags, offset, vaddr, filesz, memsz, align], index) => {
    const at = 64 + index * 56;
    buffer.writeUInt32LE(kind, at);
    buffer.writeUInt32LE(flags, at + 4);
    buffer.writeBigUInt64LE(offset, at + 8);
    buffer.writeBigUInt64LE(vaddr, at + 16);
    buffer.writeBigUInt64LE(vaddr, at + 24);
    buffer.writeBigUInt64LE(filesz, at + 32);
    buffer.writeBigUInt64LE(memsz, at + 40);
    buffer.writeBigUInt64LE(align, at + 48);
  });
  // A GNU ABI-tag style note: namesz 4 "GNU\0", descsz 16.
  buffer.writeUInt32LE(4, 0x300);
  buffer.writeUInt32LE(16, 0x304);
  buffer.writeUInt32LE(1, 0x308);
  buffer.write("GNU\0", 0x30c, "latin1");
  buffer.fill(0xab, 0x1000, 0x1100);
  return buffer;
}

test("the blob becomes a note in a new read-only segment with a moved program header table", { timeout: 60_000 }, () => {
  const original = syntheticElf();
  const blob = Buffer.from("a SEA blob of odd length");
  const injected = injectElf(original, blob);
  const { phoff, headers } = readElf(injected);
  // Past the end of the file and of memory (.bss ends at 0x403000), aligned
  // to 64 KiB, at the address the first PT_LOAD's base implies.
  assert.equal(phoff, 0x10000n);
  assert.equal(headers.length, 6);
  const phdr = headers[0];
  assert.deepEqual([phdr.type, phdr.offset, phdr.vaddr, phdr.filesz], [PT_PHDR, 0x10000n, 0x410000n, 6n * 56n]);
  const loads = headers.filter(({ type }) => type === PT_LOAD);
  assert.deepEqual(loads.map(({ vaddr }) => vaddr), [0x400000n, 0x401000n, 0x410000n], "PT_LOADs stay in address order");
  const added = loads[2];
  assert.equal(added.flags, 4, "read-only");
  assert.equal(added.offset % added.align, added.vaddr % added.align);
  assert.equal(added.vaddr - added.offset, 0x400000n, "the same base as the first PT_LOAD");
  assert.ok(added.offset + added.filesz === BigInt(injected.length));
  const note = headers.at(-1);
  assert.equal(note.type, PT_NOTE);
  assert.ok(note.offset >= added.offset && note.offset + note.filesz <= added.offset + added.filesz, "the note is mapped");
  assert.ok(phdr.offset >= added.offset && phdr.offset + phdr.filesz <= added.offset + added.filesz, "the table is mapped");
  assert.deepEqual(findSeaBlob(injected), blob);
  assert.deepEqual(readNotes(injected).map(({ name }) => name), ["GNU", SEA_NOTE_NAME]);
  // Nothing before the end of the original moved, apart from e_phoff/e_phnum.
  const unchanged = Buffer.from(injected.subarray(0, original.length));
  original.copy(unchanged, 32, 32, 40);
  original.copy(unchanged, 56, 56, 58);
  assert.deepEqual(unchanged, original);
  assert.ok(injected.subarray(original.length, 0x10000).every((byte) => byte === 0));
});

test("a position-independent executable gets the note at the same file offset and address", { timeout: 60_000 }, () => {
  const injected = injectElf(syntheticElf({ type: 3, base: 0n }), Buffer.from("blob"));
  const added = readElf(injected).headers.filter(({ type }) => type === PT_LOAD).at(-1);
  assert.equal(added.offset, added.vaddr);
  assert.equal(added.offset, 0x10000n);
});

test("injection is deterministic and refuses a binary that already has a blob", { timeout: 60_000 }, () => {
  const blob = Buffer.alloc(100_000, 7);
  const first = injectElf(syntheticElf(), blob);
  assert.deepEqual(injectElf(syntheticElf(), blob), first);
  assert.throws(() => injectElf(first, blob), (error) => error instanceof ElfInjectError && /already contains/.test(error.message));
});

test("anything but a 64-bit little-endian executable is refused", { timeout: 60_000 }, () => {
  const blob = Buffer.from("x");
  assert.throws(() => injectElf(Buffer.from("MZ not an ELF file at all, padded to sixty-four bytes........"), blob), /not an ELF file/);
  const thirtyTwo = syntheticElf();
  thirtyTwo[4] = 1;
  assert.throws(() => injectElf(thirtyTwo, blob), /64-bit/);
  const bigEndian = syntheticElf();
  bigEndian[5] = 2;
  assert.throws(() => injectElf(bigEndian, blob), /little-endian/);
  const object = syntheticElf({ type: 1 });
  assert.throws(() => injectElf(object, blob), /not an executable/);
  const truncated = syntheticElf().subarray(0, 100);
  assert.throws(() => injectElf(truncated, blob), /past the end/);
  assert.throws(() => injectElf(syntheticElf(), Buffer.alloc(0)), /empty/);
});

test("a real node binary with an injected note still loads and runs", { timeout: 60_000 }, (t) => {
  if (process.platform !== "linux") { t.skip("only Linux runs ELF executables"); return; }
  let binary;
  try {
    binary = readFileSync(process.execPath);
    readElf(binary);
  } catch {
    t.skip("this machine's node isn't a 64-bit ELF executable");
    return;
  }
  if (process.platform !== "linux") { t.skip("only Linux runs ELF executables"); return; }
  const directory = mkdtempSync(join(tmpdir(), "kin-elf-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // The fuse stays unflipped, so node ignores the note: this checks only that
  // the kernel and the dynamic loader accept the new program headers.
  const blob = Buffer.from("not a real SEA blob");
  const copy = join(directory, "node");
  writeFileSync(copy, injectElf(binary, blob));
  chmodSync(copy, 0o755);
  const result = spawnSync(copy, ["-p", "process.version"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.version);
  assert.deepEqual(findSeaBlob(readFileSync(copy)), blob);
});
