// Writes a Node single executable application's blob into a copy of an ELF
// `node` binary (Linux x64 and arm64), without the postject npm package
// (ADR 0025 §10, #714).
//
// How Node finds the blob on Linux (postject-api.h, which Node compiles in):
// at startup it walks the program headers of the running executable with
// dl_iterate_phdr, looks in every PT_NOTE segment, and takes the note whose
// name is "NODE_SEA_BLOB". So the blob must be a note that is *mapped into
// memory*: a PT_NOTE inside a PT_LOAD.
//
// The program header table of a linked binary has no room for two more
// entries (sections follow it), so this moves the table to the end of the
// file:
//
//   original bytes (untouched, apart from e_phoff and e_phnum)
//   zero padding up to F, a multiple of the load alignment
//   F: the new program header table (the old entries + PT_LOAD + PT_NOTE)
//      the note: namesz descsz type "NODE_SEA_BLOB\0" (padded to 4) blob
//
// and adds one read-only PT_LOAD at virtual address V that maps all of it,
// one PT_NOTE for the note, and points PT_PHDR at the new table.
//
// V - F equals the first PT_LOAD's (vaddr - offset). That keeps AT_PHDR right
// on every kernel: kernels before 5.18 compute it as load base + e_phoff,
// newer ones from the PT_LOAD that contains e_phoff; both give V. glibc's
// loader then finds the load bias from PT_PHDR, as before.
//
// Only 64-bit little-endian ELF (ET_EXEC or ET_DYN) is accepted; that is
// every Linux target Kin ships. The section header table stays where it was,
// so tools such as readelf still read the result.

export const SEA_NOTE_NAME = "NODE_SEA_BLOB";

const PT_LOAD = 1;
const PT_NOTE = 4;
const PT_PHDR = 6;
const PF_R = 4;
const EHDR_SIZE = 64;
const PHDR_SIZE = 56;
// 64 KiB covers 4, 16 and 64 KiB pages (arm64 kernels use all three).
const MIN_LOAD_ALIGN = 0x10000n;
const MAX_PROGRAM_HEADERS = 0xfffe;

export class ElfInjectError extends Error {
  constructor(message) {
    super(message);
    this.name = "ElfInjectError";
  }
}

const align = (value, to) => (value + to - 1n) / to * to;
const align4 = (value) => (value + 3) & ~3;

/** The header fields and program headers of a 64-bit little-endian ELF. */
export function readElf(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < EHDR_SIZE || buffer.readUInt32BE(0) !== 0x7f454c46) throw new ElfInjectError("This is not an ELF file.");
  if (buffer[4] !== 2) throw new ElfInjectError("Only 64-bit ELF executables are supported.");
  if (buffer[5] !== 1) throw new ElfInjectError("Only little-endian ELF executables are supported.");
  const type = buffer.readUInt16LE(16);
  if (type !== 2 && type !== 3) throw new ElfInjectError("The ELF file is not an executable (ET_EXEC or ET_DYN).");
  const phoff = buffer.readBigUInt64LE(32);
  const phentsize = buffer.readUInt16LE(54);
  const phnum = buffer.readUInt16LE(56);
  if (phentsize !== PHDR_SIZE) throw new ElfInjectError(`Unexpected program header size ${phentsize}.`);
  if (phnum === 0 || phnum > MAX_PROGRAM_HEADERS - 2) throw new ElfInjectError("The ELF file has no usable program header table.");
  const tableEnd = phoff + BigInt(phnum * PHDR_SIZE);
  if (tableEnd > BigInt(buffer.length)) throw new ElfInjectError("The program header table runs past the end of the file.");
  const headers = [];
  for (let index = 0; index < phnum; index += 1) {
    const at = Number(phoff) + index * PHDR_SIZE;
    headers.push({
      type: buffer.readUInt32LE(at),
      flags: buffer.readUInt32LE(at + 4),
      offset: buffer.readBigUInt64LE(at + 8),
      vaddr: buffer.readBigUInt64LE(at + 16),
      paddr: buffer.readBigUInt64LE(at + 24),
      filesz: buffer.readBigUInt64LE(at + 32),
      memsz: buffer.readBigUInt64LE(at + 40),
      align: buffer.readBigUInt64LE(at + 48),
    });
  }
  return { buffer, type, machine: buffer.readUInt16LE(18), phoff, headers };
}

/** Each note in the file's PT_NOTE segments: { name, type, offset, size }
 * (offset and size of the description). */
export function readNotes(bytes) {
  const { buffer, headers } = readElf(bytes);
  const notes = [];
  for (const header of headers) {
    if (header.type !== PT_NOTE) continue;
    let at = Number(header.offset);
    const end = at + Number(header.filesz);
    if (end > buffer.length) throw new ElfInjectError("A note segment runs past the end of the file.");
    while (at + 12 <= end) {
      const nameSize = buffer.readUInt32LE(at);
      const descSize = buffer.readUInt32LE(at + 4);
      const type = buffer.readUInt32LE(at + 8);
      const nameAt = at + 12;
      const descAt = nameAt + align4(nameSize);
      const next = descAt + align4(descSize);
      if (next > end) break;
      const name = buffer.toString("latin1", nameAt, nameAt + nameSize).replace(/\0+$/, "");
      notes.push({ name, type, offset: descAt, size: descSize });
      at = next;
    }
  }
  return notes;
}

/** The blob stored by injectElf, or null. */
export function findSeaBlob(bytes) {
  const note = readNotes(bytes).find(({ name, size }) => name === SEA_NOTE_NAME && size > 0);
  if (!note) return null;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return buffer.subarray(note.offset, note.offset + note.size);
}

function writeHeader(target, at, header) {
  target.writeUInt32LE(header.type, at);
  target.writeUInt32LE(header.flags, at + 4);
  target.writeBigUInt64LE(header.offset, at + 8);
  target.writeBigUInt64LE(header.vaddr, at + 16);
  target.writeBigUInt64LE(header.paddr, at + 24);
  target.writeBigUInt64LE(header.filesz, at + 32);
  target.writeBigUInt64LE(header.memsz, at + 40);
  target.writeBigUInt64LE(header.align, at + 48);
}

/**
 * A new ELF image: `executable` with `blob` added as the NODE_SEA_BLOB note.
 * Deterministic: the same inputs always give the same bytes. Throws
 * ElfInjectError for anything it can't handle safely, including a binary
 * that already carries a blob.
 */
export function injectElf(executable, blob) {
  const elf = readElf(executable);
  const { buffer, headers } = elf;
  if (!blob?.length) throw new ElfInjectError("The SEA blob is empty.");
  if (blob.length > 0xffff_fff0) throw new ElfInjectError("The SEA blob is too large for an ELF note.");
  if (readNotes(buffer).some(({ name }) => name === SEA_NOTE_NAME))
    throw new ElfInjectError("This executable already contains a SEA blob. Start from an unmodified node binary.");

  const loads = headers.filter(({ type }) => type === PT_LOAD);
  if (!loads.length) throw new ElfInjectError("The ELF file has no PT_LOAD segment.");
  const first = loads.reduce((low, header) => (header.vaddr < low.vaddr ? header : low));
  if (first.vaddr < first.offset) throw new ElfInjectError("The first PT_LOAD segment has an unusual layout.");
  const loadAlign = loads.reduce((max, { align: value }) => (value > max ? value : max), MIN_LOAD_ALIGN);
  if (loadAlign & (loadAlign - 1n)) throw new ElfInjectError("The load alignment is not a power of two.");
  const delta = first.vaddr - first.offset;
  if (delta % loadAlign !== 0n) throw new ElfInjectError("The first PT_LOAD segment is not aligned to the load alignment.");
  const memoryEnd = loads.reduce((max, { vaddr, memsz }) => (vaddr + memsz > max ? vaddr + memsz : max), 0n);
  const fileSize = BigInt(buffer.length);
  const fileOffset = align(fileSize > memoryEnd - delta ? fileSize : memoryEnd - delta, loadAlign);
  const address = fileOffset + delta;

  const count = headers.length + 2;
  const tableSize = count * PHDR_SIZE;
  const name = Buffer.from(`${SEA_NOTE_NAME}\0`, "latin1");
  const noteAt = align4(tableSize);
  const noteSize = 12 + align4(name.length) + align4(blob.length);
  const regionSize = noteAt + noteSize;

  const newHeaders = [];
  const lastLoad = headers.lastIndexOf(loads.reduce((high, header) => (header.vaddr > high.vaddr ? header : high)));
  headers.forEach((header, index) => {
    if (header.type === PT_PHDR)
      newHeaders.push({ ...header, offset: fileOffset, vaddr: address, paddr: address, filesz: BigInt(tableSize), memsz: BigInt(tableSize) });
    else newHeaders.push(header);
    // PT_LOAD entries must stay sorted by address; the new one is highest.
    if (index === lastLoad)
      newHeaders.push({ type: PT_LOAD, flags: PF_R, offset: fileOffset, vaddr: address, paddr: address, filesz: BigInt(regionSize), memsz: BigInt(regionSize), align: loadAlign });
  });
  const noteOffset = fileOffset + BigInt(noteAt);
  newHeaders.push({ type: PT_NOTE, flags: PF_R, offset: noteOffset, vaddr: address + BigInt(noteAt), paddr: address + BigInt(noteAt), filesz: BigInt(noteSize), memsz: BigInt(noteSize), align: 4n });

  const total = Number(fileOffset) + regionSize;
  if (!Number.isSafeInteger(total)) throw new ElfInjectError("The result would be too large.");
  const output = Buffer.alloc(total);
  buffer.copy(output, 0);
  output.writeBigUInt64LE(fileOffset, 32);
  output.writeUInt16LE(count, 56);
  const base = Number(fileOffset);
  newHeaders.forEach((header, index) => writeHeader(output, base + index * PHDR_SIZE, header));
  const note = base + noteAt;
  output.writeUInt32LE(name.length, note);
  output.writeUInt32LE(blob.length, note + 4);
  output.writeUInt32LE(0, note + 8);
  name.copy(output, note + 12);
  Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).copy(output, note + 12 + align4(name.length));
  return output;
}
