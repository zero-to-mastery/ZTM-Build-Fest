// Writes a Node single executable application's blob into a copy of the
// Windows `node.exe` (PE32+, x64) as a resource, without the postject npm
// package (ADR 0025 §10, #748).
//
// Where Node looks. src/node_sea_bin.cc calls
// postject_find_resource("NODE_SEA_BLOB", ...), which on Windows
// (postject-api.h, github.com/nodejs/postject, compiled into Node) upper-
// cases the name and calls
//
//   FindResourceA(NULL, "NODE_SEA_BLOB", MAKEINTRESOURCEA(10) /* RT_RCDATA */)
//
// then LoadResource, LockResource and SizeofResource. So the blob must be an
// RT_RCDATA resource named NODE_SEA_BLOB in the executable's resource tree
// (data directory entry 2). Any language matches: when the requested
// language isn't present the loader falls back to the first one listed.
//
// The layout. node.exe's sections end with .rsrc and .reloc, followed only
// by the Authenticode certificate table (data directory entry 4, which
// holds a *file offset*, not an address). The result:
//
//   headers        one more section header, the new resource directory,
//                  no certificate table, SizeOfImage, SizeOfInitializedData
//                  and CheckSum updated
//   sections       unchanged, apart from the flipped fuse in .rdata; the old
//                  resource section is renamed .rsrc0 and no longer used
//   .rsrc (new)    a complete resource tree: every resource node.exe had
//                  (icons, version information, the manifest) plus
//                  RT_RCDATA/NODE_SEA_BLOB, each with its data copied in
//
// Building a new section at the end keeps every existing section where it
// was, so nothing that refers to an address (relocations, the exception
// table, the import table) has to change. The certificate is dropped: the
// injection invalidates node's signature anyway, and Kin's builds are
// unsigned by the owner's decision (docs/HOME-SERVER.md: Windows
// SmartScreen will warn). The checksum is recomputed as ImageHlp's
// CheckSumMappedFile does.
//
// Resource directories (Microsoft PE format, "The .rsrc Section"): three
// levels (type, name, language); in each table the named entries come
// first, sorted by name, then the ID entries in ascending order, because
// the loader binary-searches them.

export const SEA_RESOURCE = "NODE_SEA_BLOB";
export const RT_RCDATA = 10;
export const IMAGE_FILE_MACHINE_AMD64 = 0x8664;

const PE32_PLUS = 0x20b;
const SECTION_HEADER = 40;
const DIRECTORY_RESOURCE = 2;
const DIRECTORY_SECURITY = 4;
const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x40;
const IMAGE_SCN_MEM_READ = 0x40000000;
const SUBDIRECTORY = 0x80000000;
const NAMED = 0x80000000;
const LANG_NEUTRAL = 0;
const MAX_RESOURCES = 4096;

export class PeInjectError extends Error {
  constructor(message) {
    super(message);
    this.name = "PeInjectError";
  }
}

const alignUp = (value, to) => Math.ceil(value / to) * to;

/** The headers, sections and data directories of a PE32+ x64 image. */
export function readPe(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 0x40 || buffer.toString("latin1", 0, 2) !== "MZ") throw new PeInjectError("This is not a Windows executable.");
  const peAt = buffer.readUInt32LE(0x3c);
  if (peAt + 24 > buffer.length || buffer.readUInt32BE(peAt) !== 0x50450000) throw new PeInjectError("This is not a PE file.");
  const machine = buffer.readUInt16LE(peAt + 4);
  const sectionCount = buffer.readUInt16LE(peAt + 6);
  const optionalSize = buffer.readUInt16LE(peAt + 20);
  const optionalAt = peAt + 24;
  if (optionalAt + optionalSize > buffer.length || optionalSize < 112) throw new PeInjectError("The PE optional header is truncated.");
  if (buffer.readUInt16LE(optionalAt) !== PE32_PLUS) throw new PeInjectError("Only 64-bit (PE32+) executables are supported.");
  const directoryCount = buffer.readUInt32LE(optionalAt + 108);
  if (directoryCount <= DIRECTORY_SECURITY || 112 + directoryCount * 8 > optionalSize) throw new PeInjectError("The PE file has too few data directories.");
  const directories = [];
  for (let index = 0; index < directoryCount; index += 1)
    directories.push({ rva: buffer.readUInt32LE(optionalAt + 112 + index * 8), size: buffer.readUInt32LE(optionalAt + 116 + index * 8) });
  const sectionTableAt = optionalAt + optionalSize;
  if (sectionTableAt + sectionCount * SECTION_HEADER > buffer.length) throw new PeInjectError("The section table runs past the end of the file.");
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const at = sectionTableAt + index * SECTION_HEADER;
    sections.push({
      headerAt: at,
      name: buffer.toString("latin1", at, at + 8).replace(/\0+$/, ""),
      virtualSize: buffer.readUInt32LE(at + 8),
      virtualAddress: buffer.readUInt32LE(at + 12),
      rawSize: buffer.readUInt32LE(at + 16),
      rawPointer: buffer.readUInt32LE(at + 20),
      characteristics: buffer.readUInt32LE(at + 36),
    });
  }
  return {
    buffer,
    peAt,
    machine,
    optionalAt,
    sectionTableAt,
    sections,
    directories,
    sectionAlignment: buffer.readUInt32LE(optionalAt + 32),
    fileAlignment: buffer.readUInt32LE(optionalAt + 36),
    sizeOfImage: buffer.readUInt32LE(optionalAt + 56),
    sizeOfHeaders: buffer.readUInt32LE(optionalAt + 60),
    checksum: buffer.readUInt32LE(optionalAt + 64),
    dllCharacteristics: buffer.readUInt16LE(optionalAt + 70),
  };
}

/** The file offset of `size` bytes at `rva`, which must lie in one
 * section's raw data. */
export function rvaToOffset(pe, rva, size = 1) {
  for (const section of pe.sections) {
    const start = section.virtualAddress;
    if (rva >= start && rva + size <= start + Math.max(section.virtualSize, section.rawSize)) {
      if (rva + size > start + section.rawSize) throw new PeInjectError(`RVA 0x${rva.toString(16)} isn't backed by the file.`);
      return section.rawPointer + rva - start;
    }
  }
  throw new PeInjectError(`RVA 0x${rva.toString(16)} isn't inside any section.`);
}

/** The PE checksum (ImageHlp CheckSumMappedFile): the 16-bit one's
 * complement-style sum of the file with the CheckSum field taken as zero,
 * plus the file's length. */
export function peChecksum(buffer, checksumAt) {
  let sum = 0;
  const words = buffer.length >>> 1;
  for (let index = 0; index < words; index += 1) {
    const at = index * 2;
    if (at === checksumAt || at === checksumAt + 2) continue;
    sum += buffer.readUInt16LE(at);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (buffer.length & 1) {
    sum += buffer[buffer.length - 1];
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + buffer.length) >>> 0;
}

const compareKeys = (left, right) => {
  // Named entries first, sorted by their (upper-case) UTF-16 code units,
  // then IDs in ascending order.
  if (typeof left === "string" && typeof right === "string") {
    const a = left.toUpperCase();
    const b = right.toUpperCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof left === "string") return -1;
  if (typeof right === "string") return 1;
  return left - right;
};

/**
 * Every resource in the image: { type, name, language, codePage, data },
 * with type and name a number (an ID) or a string. Walks the tree the way
 * the loader does and checks each table's sort order, which the loader's
 * binary search relies on.
 */
export function readResources(bytes) {
  const pe = readPe(bytes);
  const { rva, size } = pe.directories[DIRECTORY_RESOURCE];
  if (!rva || !size) return [];
  const base = rvaToOffset(pe, rva, size);
  const { buffer } = pe;
  const resources = [];
  const visited = new Set();
  const readName = (offset) => {
    const at = base + offset;
    if (offset + 2 > size) throw new PeInjectError("A resource name lies outside the resource directory.");
    const length = buffer.readUInt16LE(at);
    if (offset + 2 + length * 2 > size) throw new PeInjectError("A resource name runs past the resource directory.");
    return buffer.toString("utf16le", at + 2, at + 2 + length * 2);
  };
  const walk = (offset, path) => {
    if (visited.has(offset) || visited.size > MAX_RESOURCES) throw new PeInjectError("The resource directory is malformed (a loop or too many tables).");
    visited.add(offset);
    if (offset + 16 > size) throw new PeInjectError("A resource table lies outside the resource directory.");
    const at = base + offset;
    const named = buffer.readUInt16LE(at + 12);
    const ids = buffer.readUInt16LE(at + 14);
    if (offset + 16 + (named + ids) * 8 > size) throw new PeInjectError("A resource table runs past the resource directory.");
    let previous;
    for (let index = 0; index < named + ids; index += 1) {
      const entry = at + 16 + index * 8;
      const nameField = buffer.readUInt32LE(entry);
      const dataField = buffer.readUInt32LE(entry + 4);
      const isNamed = (nameField & NAMED) !== 0;
      if (isNamed !== index < named) throw new PeInjectError("A resource table mixes named and ID entries out of order.");
      const key = isNamed ? readName(nameField & ~NAMED) : nameField & 0xffff;
      if (index > 0 && compareKeys(previous, key) >= 0) throw new PeInjectError("A resource table isn't sorted, so the loader's search could miss entries.");
      previous = key;
      const next = [...path, key];
      if (dataField & SUBDIRECTORY) {
        if (next.length >= 3) throw new PeInjectError("The resource tree is deeper than type, name, language.");
        walk(dataField & ~SUBDIRECTORY, next);
      } else {
        if (next.length !== 3) throw new PeInjectError("A resource's data sits above the language level.");
        const dataOffset = dataField;
        if (dataOffset + 16 > size) throw new PeInjectError("A resource data entry lies outside the resource directory.");
        const dataRva = buffer.readUInt32LE(base + dataOffset);
        const dataSize = buffer.readUInt32LE(base + dataOffset + 4);
        const codePage = buffer.readUInt32LE(base + dataOffset + 8);
        const fileAt = dataSize ? rvaToOffset(pe, dataRva, dataSize) : 0;
        resources.push({ type: next[0], name: next[1], language: next[2], codePage, rva: dataRva, data: buffer.subarray(fileAt, fileAt + dataSize) });
      }
    }
  };
  walk(0, []);
  return resources;
}

/**
 * The resource Node would find: FindResource(NULL, name, type) followed by
 * LoadResource. Searches the tree level by level as the loader does
 * (binary search by key), takes LANG_NEUTRAL or else the first language.
 * Returns the data or null.
 */
export function findPeResource(bytes, type = RT_RCDATA, name = SEA_RESOURCE) {
  const pe = readPe(bytes);
  const { rva, size } = pe.directories[DIRECTORY_RESOURCE];
  if (!rva || !size) return null;
  const base = rvaToOffset(pe, rva, size);
  const { buffer } = pe;
  const keyAt = (entry) => {
    const field = buffer.readUInt32LE(entry);
    if (!(field & NAMED)) return field & 0xffff;
    const at = base + (field & ~NAMED);
    return buffer.toString("utf16le", at + 2, at + 2 + buffer.readUInt16LE(at) * 2);
  };
  const search = (offset, key) => {
    const at = base + offset;
    const named = buffer.readUInt16LE(at + 12);
    const ids = buffer.readUInt16LE(at + 14);
    let [low, high] = typeof key === "string" ? [0, named - 1] : [named, named + ids - 1];
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const order = compareKeys(keyAt(at + 16 + middle * 8), key);
      if (order === 0) return buffer.readUInt32LE(at + 16 + middle * 8 + 4);
      if (order < 0) low = middle + 1;
      else high = middle - 1;
    }
    return null;
  };
  const typeEntry = search(0, type);
  if (typeEntry === null || !(typeEntry & SUBDIRECTORY)) return null;
  const nameEntry = search(typeEntry & ~SUBDIRECTORY, typeof name === "string" ? name.toUpperCase() : name);
  if (nameEntry === null || !(nameEntry & SUBDIRECTORY)) return null;
  const languages = nameEntry & ~SUBDIRECTORY;
  let dataEntry = search(languages, LANG_NEUTRAL);
  if (dataEntry === null) {
    if (buffer.readUInt16LE(base + languages + 12) + buffer.readUInt16LE(base + languages + 14) === 0) return null;
    dataEntry = buffer.readUInt32LE(base + languages + 16 + 4);
  }
  if (dataEntry & SUBDIRECTORY) return null;
  const dataRva = buffer.readUInt32LE(base + dataEntry);
  const dataSize = buffer.readUInt32LE(base + dataEntry + 4);
  const fileAt = rvaToOffset(pe, dataRva, dataSize);
  return buffer.subarray(fileAt, fileAt + dataSize);
}

/** A resource section for `resources` placed at `sectionRva`. */
export function buildResourceSection(resources, sectionRva) {
  // type -> name -> language -> resource, each level sorted as the loader
  // expects.
  const tree = new Map();
  for (const resource of resources) {
    if (!tree.has(resource.type)) tree.set(resource.type, new Map());
    const names = tree.get(resource.type);
    if (!names.has(resource.name)) names.set(resource.name, new Map());
    const languages = names.get(resource.name);
    if (languages.has(resource.language)) throw new PeInjectError("A resource is listed twice.");
    languages.set(resource.language, resource);
  }
  const sorted = (map) => [...map.keys()].sort(compareKeys);
  const tableSize = (map) => 16 + map.size * 8;

  // Tables breadth-first, then data entries, then names, then data.
  let tablesSize = tableSize(tree);
  for (const names of tree.values()) {
    tablesSize += tableSize(names);
    for (const languages of names.values()) tablesSize += tableSize(languages);
  }
  const strings = new Map();
  let stringsSize = 0;
  for (const type of tree.keys()) for (const name of [type, ...tree.get(type).keys()]) {
    if (typeof name !== "string" || strings.has(name)) continue;
    strings.set(name, stringsSize);
    stringsSize += 2 + Buffer.byteLength(name, "utf16le");
  }
  const entriesAt = tablesSize;
  const stringsAt = entriesAt + resources.length * 16;
  let dataAt = alignUp(stringsAt + stringsSize, 16);
  const ordered = [];
  for (const type of sorted(tree)) for (const name of sorted(tree.get(type))) for (const language of sorted(tree.get(type).get(name))) ordered.push(tree.get(type).get(name).get(language));
  const placements = ordered.map((resource) => {
    const at = dataAt;
    dataAt = alignUp(at + resource.data.length, 8);
    return at;
  });
  const section = Buffer.alloc(dataAt);
  for (const [name, offset] of strings) {
    section.writeUInt16LE(name.length, stringsAt + offset);
    section.write(name, stringsAt + offset + 2, "utf16le");
  }
  const keyField = (key) => (typeof key === "string" ? (NAMED | (stringsAt + strings.get(key))) >>> 0 : key);
  const writeTable = (at, keys) => {
    // Characteristics, TimeDateStamp and version stay zero (reproducible).
    section.writeUInt16LE(keys.filter((key) => typeof key === "string").length, at + 12);
    section.writeUInt16LE(keys.filter((key) => typeof key !== "string").length, at + 14);
  };
  let nextTable = 0;
  let nextEntry = 0;
  const allocate = (map) => { const at = nextTable; nextTable += tableSize(map); return at; };
  const rootAt = allocate(tree);
  const typeKeys = sorted(tree);
  writeTable(rootAt, typeKeys);
  const typeTables = typeKeys.map((type) => allocate(tree.get(type)));
  const nameTables = [];
  typeKeys.forEach((type, typeIndex) => {
    const names = tree.get(type);
    const nameKeys = sorted(names);
    section.writeUInt32LE(keyField(type), rootAt + 16 + typeIndex * 8);
    section.writeUInt32LE((SUBDIRECTORY | typeTables[typeIndex]) >>> 0, rootAt + 20 + typeIndex * 8);
    writeTable(typeTables[typeIndex], nameKeys);
    nameKeys.forEach((name, nameIndex) => {
      const at = allocate(names.get(name));
      nameTables.push([at, names.get(name)]);
      section.writeUInt32LE(keyField(name), typeTables[typeIndex] + 16 + nameIndex * 8);
      section.writeUInt32LE((SUBDIRECTORY | at) >>> 0, typeTables[typeIndex] + 20 + nameIndex * 8);
    });
  });
  let resourceIndex = 0;
  for (const [at, languages] of nameTables) {
    const languageKeys = sorted(languages);
    writeTable(at, languageKeys);
    languageKeys.forEach((language, index) => {
      const entry = entriesAt + nextEntry * 16;
      nextEntry += 1;
      const resource = languages.get(language);
      const placed = placements[resourceIndex];
      resourceIndex += 1;
      section.writeUInt32LE(language, at + 16 + index * 8);
      section.writeUInt32LE(entry, at + 20 + index * 8);
      section.writeUInt32LE(sectionRva + placed, entry);
      section.writeUInt32LE(resource.data.length, entry + 4);
      section.writeUInt32LE(resource.codePage ?? 0, entry + 8);
      resource.data.copy(section, placed);
    });
  }
  return section;
}

/**
 * A new PE image: `executable` with `blob` added as the RT_RCDATA resource
 * NODE_SEA_BLOB in a new resource section and the certificate table
 * removed. Deterministic. Throws PeInjectError for anything it can't handle
 * safely, including an image that already carries a blob.
 */
export function injectPe(executable, blob) {
  const pe = readPe(executable);
  const { buffer, sections, directories } = pe;
  if (!blob?.length) throw new PeInjectError("The SEA blob is empty.");
  if (pe.machine !== IMAGE_FILE_MACHINE_AMD64) throw new PeInjectError(`Only x64 executables are supported (machine 0x${pe.machine.toString(16)}).`);
  if (pe.dllCharacteristics & 0x80) throw new PeInjectError("The executable requires a valid signature (FORCE_INTEGRITY), which an injected copy can't keep.");
  const resources = readResources(buffer);
  if (resources.some(({ type, name }) => type === RT_RCDATA && name === SEA_RESOURCE)) throw new PeInjectError("This executable already contains a SEA blob. Start from an unmodified node binary.");

  // Nothing may follow the sections but the certificate table.
  const rawEnd = Math.max(...sections.map(({ rawPointer, rawSize }) => rawPointer + rawSize));
  const certificate = directories[DIRECTORY_SECURITY];
  let contentEnd = buffer.length;
  if (certificate.size) {
    if (certificate.rva < rawEnd || certificate.rva + certificate.size !== buffer.length) throw new PeInjectError("The certificate table isn't at the end of the file.");
    contentEnd = certificate.rva;
  }
  if (contentEnd > alignUp(rawEnd, 8) || !buffer.subarray(rawEnd, contentEnd).every((byte) => byte === 0))
    throw new PeInjectError("The executable has data after its last section that the injector would lose.");

  const tableEnd = pe.sectionTableAt + sections.length * SECTION_HEADER;
  const firstRaw = Math.min(...sections.filter(({ rawSize }) => rawSize > 0).map(({ rawPointer }) => rawPointer));
  if (tableEnd + SECTION_HEADER > Math.min(pe.sizeOfHeaders, firstRaw) || !buffer.subarray(tableEnd, tableEnd + SECTION_HEADER).every((byte) => byte === 0))
    throw new PeInjectError("There is no room for another section header.");

  const virtualEnd = Math.max(...sections.map(({ virtualAddress, virtualSize, rawSize }) => virtualAddress + Math.max(virtualSize, rawSize)));
  const sectionRva = alignUp(virtualEnd, pe.sectionAlignment);
  const sectionRaw = alignUp(rawEnd, pe.fileAlignment);
  const content = buildResourceSection([
    ...resources.map(({ type, name, language, codePage, data }) => ({ type, name, language, codePage, data })),
    { type: RT_RCDATA, name: SEA_RESOURCE, language: LANG_NEUTRAL, codePage: 0, data: Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength) },
  ], sectionRva);
  const rawSize = alignUp(content.length, pe.fileAlignment);
  const total = sectionRaw + rawSize;
  if (sectionRva + content.length > 0xffff_ffff || total > 0xffff_ffff) throw new PeInjectError("The result would be too large for a PE image.");

  const output = Buffer.alloc(total);
  buffer.copy(output, 0, 0, Math.min(rawEnd, buffer.length));
  content.copy(output, sectionRaw);

  const header = tableEnd;
  output.write(".rsrc", header, "latin1");
  output.writeUInt32LE(content.length, header + 8);
  output.writeUInt32LE(sectionRva, header + 12);
  output.writeUInt32LE(rawSize, header + 16);
  output.writeUInt32LE(sectionRaw, header + 20);
  output.writeUInt32LE((IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ) >>> 0, header + 36);
  // The old resource section stays mapped but unused; renamed so ".rsrc"
  // names the live one for tools that look sections up by name.
  const old = directories[DIRECTORY_RESOURCE].rva ? sections.find(({ virtualAddress, virtualSize }) => directories[DIRECTORY_RESOURCE].rva >= virtualAddress && directories[DIRECTORY_RESOURCE].rva < virtualAddress + virtualSize) : null;
  if (old?.name === ".rsrc") output.write(".rsrc0\0\0", old.headerAt, "latin1");

  const optional = pe.optionalAt;
  output.writeUInt16LE(sections.length + 1, pe.peAt + 6);
  output.writeUInt32LE(output.readUInt32LE(optional + 8) + rawSize, optional + 8); // SizeOfInitializedData
  output.writeUInt32LE(alignUp(sectionRva + content.length, pe.sectionAlignment), optional + 56); // SizeOfImage
  output.writeUInt32LE(sectionRva, optional + 112 + DIRECTORY_RESOURCE * 8);
  output.writeUInt32LE(content.length, optional + 116 + DIRECTORY_RESOURCE * 8);
  output.writeUInt32LE(0, optional + 112 + DIRECTORY_SECURITY * 8);
  output.writeUInt32LE(0, optional + 116 + DIRECTORY_SECURITY * 8);
  output.writeUInt32LE(0, optional + 64);
  output.writeUInt32LE(peChecksum(output, optional + 64), optional + 64);
  return output;
}

/**
 * Checks what the Windows loader checks before running an x64 image Kin
 * built, as far as that can be done without Windows: sections aligned, in
 * order, inside the file and not overlapping; SizeOfImage and SizeOfHeaders
 * consistent; every data directory inside a section; no certificate table;
 * the checksum; every resource table sorted; and the SEA blob findable as
 * FindResource would find it. Returns { blob, resources }.
 */
export function checkPeExecutable(bytes) {
  const pe = readPe(bytes);
  const { buffer, sections, directories } = pe;
  const fail = (message) => { throw new PeInjectError(message); };
  if (pe.machine !== IMAGE_FILE_MACHINE_AMD64) fail("The executable isn't x64.");
  const tableEnd = pe.sectionTableAt + sections.length * SECTION_HEADER;
  if (pe.sizeOfHeaders % pe.fileAlignment || pe.sizeOfHeaders < tableEnd) fail("SizeOfHeaders doesn't cover the section table.");
  let previous = null;
  for (const section of sections) {
    if (section.virtualAddress % pe.sectionAlignment) fail(`Section ${section.name} isn't aligned in memory.`);
    if (section.rawPointer % pe.fileAlignment || section.rawSize % pe.fileAlignment) fail(`Section ${section.name} isn't aligned in the file.`);
    if (section.rawPointer + section.rawSize > buffer.length) fail(`Section ${section.name} runs past the end of the file.`);
    if (section.rawSize && section.rawPointer < pe.sizeOfHeaders) fail(`Section ${section.name} overlaps the headers.`);
    if (previous) {
      if (section.virtualAddress < alignUp(previous.virtualAddress + Math.max(previous.virtualSize, previous.rawSize), pe.sectionAlignment)) fail(`Sections ${previous.name} and ${section.name} overlap in memory or are out of order.`);
      if (section.rawSize && section.rawPointer < previous.rawPointer + previous.rawSize) fail(`Sections ${previous.name} and ${section.name} overlap in the file.`);
    }
    previous = section;
  }
  const last = sections.at(-1);
  if (pe.sizeOfImage !== alignUp(last.virtualAddress + Math.max(last.virtualSize, last.rawSize), pe.sectionAlignment)) fail("SizeOfImage doesn't match the last section.");
  if (last.rawPointer + last.rawSize !== buffer.length) fail("The file doesn't end with the last section.");
  directories.forEach(({ rva, size }, index) => {
    if (index === DIRECTORY_SECURITY) { if (rva || size) fail("The executable still has a certificate table."); return; }
    if (!rva || !size) return;
    if (!sections.some(({ virtualAddress, virtualSize, rawSize }) => rva >= virtualAddress && rva + size <= virtualAddress + Math.max(virtualSize, rawSize))) fail(`Data directory ${index} lies outside the sections.`);
  });
  if (pe.checksum !== peChecksum(buffer, pe.optionalAt + 64)) fail("The PE checksum is wrong.");
  const resources = readResources(buffer);
  const blob = findPeResource(buffer, RT_RCDATA, SEA_RESOURCE);
  if (!blob) fail("FindResource wouldn't find the SEA blob: there is no RT_RCDATA resource NODE_SEA_BLOB.");
  return { blob, resources };
}
