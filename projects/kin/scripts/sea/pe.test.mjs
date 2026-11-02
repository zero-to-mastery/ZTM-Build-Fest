// Kin's PE injector (scripts/sea/pe.mjs, #748): the layout it writes on a
// synthetic node.exe, the resource lookup Node relies on (FindResource),
// refusals, and, when an official node.exe is cached
// (official-binaries.mjs), the real thing parsed back, with its original
// checksum recomputed and, if llvm-readobj is installed, an independent
// reading of the result.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { flipFuse, fuseFlipped, SEA_FUSE } from "./fuse.mjs";
import { officialBinaries } from "./official-binaries.mjs";
import { buildResourceSection, checkPeExecutable, findPeResource, injectPe, peChecksum, PeInjectError, readPe, readResources, RT_RCDATA, SEA_RESOURCE } from "./pe.mjs";

const RT_ICON = 3;
const RT_MANIFEST = 24;
const RESOURCES = [
  { type: RT_ICON, name: 1, language: 1033, codePage: 0, data: Buffer.from("an icon") },
  { type: RT_RCDATA, name: "ALPHA", language: 1033, codePage: 0, data: Buffer.from("named before the blob") },
  { type: RT_RCDATA, name: "ZULU", language: 0, codePage: 1252, data: Buffer.from("named after the blob") },
  { type: RT_MANIFEST, name: 1, language: 1033, codePage: 0, data: Buffer.from("<assembly/>") },
];

/**
 * A minimal x64 image laid out like node.exe: .text (with the fuse), .rsrc,
 * .reloc, then an Authenticode certificate table at the end of the file.
 */
function syntheticPe({ certificate = true, dllCharacteristics = 0x8160 } = {}) {
  const sections = [
    [".text", 0x1000, 0x400, 0x200],
    [".rsrc", 0x2000, 0x600, 0x400],
    [".reloc", 0x3000, 0xa00, 0x200],
  ];
  const certificateAt = 0xc00;
  const buffer = Buffer.alloc(certificate ? certificateAt + 0x100 : certificateAt);
  buffer.write("MZ", 0, "latin1");
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32BE(0x50450000, 0x80);
  buffer.writeUInt16LE(0x8664, 0x84);
  buffer.writeUInt16LE(sections.length, 0x86);
  buffer.writeUInt16LE(240, 0x94);
  buffer.writeUInt16LE(0x22, 0x96);
  const optional = 0x98;
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeUInt32LE(0x200, optional + 4); // SizeOfCode
  buffer.writeUInt32LE(0x600, optional + 8); // SizeOfInitializedData
  buffer.writeUInt32LE(0x1000, optional + 16); // AddressOfEntryPoint
  buffer.writeBigUInt64LE(0x140000000n, optional + 24);
  buffer.writeUInt32LE(0x1000, optional + 32);
  buffer.writeUInt32LE(0x200, optional + 36);
  buffer.writeUInt32LE(0x4000, optional + 56);
  buffer.writeUInt32LE(0x400, optional + 60);
  buffer.writeUInt16LE(3, optional + 68);
  buffer.writeUInt16LE(dllCharacteristics, optional + 70);
  buffer.writeUInt32LE(16, optional + 108);
  const directory = (index, rva, size) => { buffer.writeUInt32LE(rva, optional + 112 + index * 8); buffer.writeUInt32LE(size, optional + 116 + index * 8); };
  sections.forEach(([name, rva, raw, size], index) => {
    const at = optional + 240 + index * 40;
    buffer.write(name, at, "latin1");
    buffer.writeUInt32LE(size, at + 8);
    buffer.writeUInt32LE(rva, at + 12);
    buffer.writeUInt32LE(size, at + 16);
    buffer.writeUInt32LE(raw, at + 20);
    buffer.writeUInt32LE(index === 0 ? 0x60000020 : 0x40000040, at + 36);
  });
  buffer.fill(0xcc, 0x400, 0x600);
  buffer.write(`${SEA_FUSE}:0`, 0x500, "latin1");
  const resources = buildResourceSection(RESOURCES, 0x2000);
  assert.ok(resources.length <= 0x400);
  resources.copy(buffer, 0x600);
  directory(2, 0x2000, resources.length);
  buffer.fill(0x0e, 0xa00, 0xc00);
  directory(5, 0x3000, 0x200);
  if (certificate) {
    buffer.fill(0x30, certificateAt, certificateAt + 0x100);
    directory(4, certificateAt, 0x100);
  }
  buffer.writeUInt32LE(peChecksum(buffer, optional + 64), optional + 64);
  return buffer;
}

test("the blob becomes the RT_RCDATA resource NODE_SEA_BLOB in a new last section, and the certificate goes", { timeout: 60_000 }, () => {
  const original = syntheticPe();
  const blob = Buffer.from("a SEA blob of odd length");
  const injected = injectPe(flipFuse(Buffer.from(original)), blob);
  const { blob: found, resources } = checkPeExecutable(injected);
  assert.deepEqual(found, blob);
  const pe = readPe(injected);
  assert.deepEqual(pe.sections.map(({ name }) => name), [".text", ".rsrc0", ".reloc", ".rsrc"]);
  const added = pe.sections[3];
  assert.deepEqual([added.virtualAddress, added.rawPointer, added.characteristics], [0x4000, 0xc00, 0x40000040]);
  assert.equal(pe.directories[2].rva, 0x4000);
  assert.deepEqual(pe.directories[4], { rva: 0, size: 0 });
  assert.equal(pe.sizeOfImage, 0x5000);
  assert.equal(injected.readUInt32LE(pe.optionalAt + 8), 0x600 + added.rawSize);
  assert.equal(pe.checksum, peChecksum(injected, pe.optionalAt + 64));
  assert.equal(injected.length, 0xc00 + added.rawSize, "the certificate is gone");

  // Every resource node.exe had is still there, byte for byte, alongside
  // the blob, and FindResource finds each by binary search.
  assert.deepEqual(resources.map(({ type, name, language }) => [type, name, language]), [
    [RT_ICON, 1, 1033], [RT_RCDATA, "ALPHA", 1033], [RT_RCDATA, SEA_RESOURCE, 0], [RT_RCDATA, "ZULU", 0], [RT_MANIFEST, 1, 1033],
  ]);
  for (const { type, name, data } of RESOURCES) assert.deepEqual(findPeResource(injected, type, name), data, `${type}/${name}`);
  assert.equal(resources.find(({ name }) => name === "ZULU").codePage, 1252);
  assert.equal(findPeResource(injected, RT_RCDATA, "node_sea_blob").toString(), blob.toString(), "names are upper-cased, as postject does");
  assert.equal(findPeResource(injected, RT_RCDATA, "MISSING"), null);
  assert.equal(findPeResource(injected, 99, 1), null);

  // The sections and everything in them are where they were; only the
  // headers and the fuse changed.
  const unchanged = Buffer.from(injected.subarray(0x400, 0xc00));
  assert.ok(fuseFlipped(unchanged));
  unchanged[unchanged.indexOf(Buffer.from(`${SEA_FUSE}:1`)) + SEA_FUSE.length + 1] = 0x30;
  assert.deepEqual(unchanged, original.subarray(0x400, 0xc00));
});

test("injection is deterministic and refuses what it can't handle safely", { timeout: 60_000 }, () => {
  const blob = Buffer.alloc(100_000, 7);
  const first = injectPe(syntheticPe(), blob);
  assert.deepEqual(injectPe(syntheticPe(), blob), first);
  assert.deepEqual(checkPeExecutable(injectPe(syntheticPe({ certificate: false }), blob)).blob, blob, "an unsigned node.exe works too");
  assert.throws(() => injectPe(first, blob), (error) => error instanceof PeInjectError && /already contains/.test(error.message));
  assert.throws(() => injectPe(syntheticPe(), Buffer.alloc(0)), /empty/);
  assert.throws(() => injectPe(Buffer.from("\x7fELF".padEnd(128, "\0")), blob), /not a Windows executable/);
  assert.throws(() => injectPe(syntheticPe({ dllCharacteristics: 0x8160 | 0x80 }), blob), /FORCE_INTEGRITY/);
  assert.throws(() => injectPe(Buffer.concat([syntheticPe({ certificate: false }), Buffer.from("overlay")]), blob), /data after its last section/);
  const arm = syntheticPe();
  arm.writeUInt16LE(0xaa64, 0x84);
  assert.throws(() => injectPe(arm, blob), /Only x64/);
  const crowded = syntheticPe();
  crowded[0x98 + 240 + 3 * 40 + 4] = 1;
  assert.throws(() => injectPe(crowded, blob), /no room for another section header/);
});

test("the checker catches a wrong checksum, a certificate, and a resource table out of order", { timeout: 60_000 }, () => {
  const injected = injectPe(syntheticPe(), Buffer.from("blob"));
  const optional = readPe(injected).optionalAt;
  const checksum = Buffer.from(injected);
  checksum.writeUInt32LE(checksum.readUInt32LE(optional + 64) ^ 1, optional + 64);
  assert.throws(() => checkPeExecutable(checksum), /checksum/);
  const signed = Buffer.from(injected);
  signed.writeUInt32LE(0x10, optional + 116 + 4 * 8);
  assert.throws(() => checkPeExecutable(signed), /certificate/);
  // Swap RT_ICON and RT_RCDATA in the root table: the loader's binary
  // search could then miss one.
  const unsorted = Buffer.from(injected);
  const root = readPe(unsorted).sections.at(-1).rawPointer;
  const first = Buffer.from(unsorted.subarray(root + 16, root + 24));
  unsorted.copy(unsorted, root + 16, root + 24, root + 32);
  first.copy(unsorted, root + 24);
  assert.throws(() => readResources(unsorted), /isn't sorted/);
});

test("the official node.exe, injected, parses back with a valid layout, checksum and resources", { timeout: 120_000 }, (t) => {
  const paths = officialBinaries("win-x64");
  if (!paths.length) { t.skip("no official node.exe is cached (run scripts/build-sea.mjs, or set KIN_SEA_NODE_DIR)"); return; }
  for (const path of paths) {
    const base = readFileSync(path);
    const pe = readPe(base);
    // Kin's checksum is the one Microsoft's tools wrote into node.exe.
    assert.equal(peChecksum(base, pe.optionalAt + 64), pe.checksum, `${basename(path)} checksum`);
    assert.ok(pe.directories[4].size > 0, "node.exe is Authenticode-signed");
    const before = readResources(base);
    assert.ok(before.length > 0);

    const blob = Buffer.alloc(3_000_001, 0x42);
    const injected = injectPe(flipFuse(Buffer.from(base)), blob);
    const { blob: found, resources } = checkPeExecutable(injected);
    assert.deepEqual(found, blob);
    assert.ok(fuseFlipped(injected));
    for (const resource of before)
      assert.ok(resources.some(({ type, name, language, data }) => type === resource.type && name === resource.name && language === resource.language && data.equals(resource.data)), `${resource.type}/${resource.name} kept`);
    const after = readPe(injected);
    assert.deepEqual(after.sections.slice(0, -1).map(({ virtualAddress, rawPointer, rawSize }) => [virtualAddress, rawPointer, rawSize]), pe.sections.map(({ virtualAddress, rawPointer, rawSize }) => [virtualAddress, rawPointer, rawSize]));

    const readobj = (args) => spawnSync("llvm-readobj", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
    if (readobj(["--version"]).error) { t.diagnostic("llvm-readobj isn't installed; skipped the independent reading"); continue; }
    const directory = mkdtempSync(join(tmpdir(), "kin-pe-"));
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const original = join(directory, "node.exe");
    const result = join(directory, "kin.exe");
    writeFileSync(original, base);
    writeFileSync(result, injected);
    const listed = readobj(["--coff-resources", result]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /Type: RCDATA \(ID 10\)[\s\S]*?Name: NODE_SEA_BLOB[\s\S]*?DataSize: 3000001/);
    const headers = readobj(["--file-headers", result]).stdout;
    assert.match(headers, /CertificateTableRVA: 0x0/);
    for (const option of ["--coff-imports", "--coff-exports", "--coff-load-config", "--coff-tls-directory"]) {
      const one = readobj([option, original]);
      const two = readobj([option, result]);
      assert.equal(two.status, 0, `${option}: ${two.stderr}`);
      assert.equal(two.stdout.replaceAll(result, "FILE"), one.stdout.replaceAll(original, "FILE"), option);
    }
    t.diagnostic(`checked ${basename(path)} with llvm-readobj`);
  }
});
