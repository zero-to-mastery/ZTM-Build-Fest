// Makes Node's SEA blob the same on every build machine (#747, #748).
//
// `node --experimental-sea-config` keeps the assets in a
// std::unordered_map<std::string_view, std::string_view> (SeaResource in
// src/node_sea.h) and writes them in that map's iteration order
// (SeaSerializer::Write in src/node_sea.cc). The order depends on the C++
// standard library node was built with: libstdc++ on Linux, libc++ on
// macOS, Microsoft's on Windows. So the same files gave three different
// blobs. Node reads the assets back into the same kind of map, so their
// order in the blob doesn't matter to it; this rewrites them sorted by name.
//
// The blob (Node v24, src/node_sea.cc and blob_serializer_deserializer-inl.h;
// integers in the build machine's byte order, little-endian on every Kin
// target, size_t 8 bytes):
//
//   u32 magic 0x0143da20 | u32 flags | u8 exec_argv_extension (v24; absent
//   in older releases) | string code_path | string main script (or
//   snapshot) | [string code cache, if kUseCodeCache] | [u64 count, then
//   count x (string name, string content), if kIncludeAssets] | [u64
//   count, then count x string, if kIncludeExecArgv]
//
//   where string = u64 length, then the bytes.
//
// The parse must account for every byte, so a format change in a later
// Node release is refused rather than mangled.

export const SEA_MAGIC = 0x0143da20;
const K_USE_SNAPSHOT = 1 << 1;
const K_USE_CODE_CACHE = 1 << 2;
const K_INCLUDE_ASSETS = 1 << 3;
const K_INCLUDE_EXEC_ARGV = 1 << 4;
const KNOWN_FLAGS = 0b11111;

export class SeaBlobError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeaBlobError";
  }
}

function parseWith(blob, headerSize) {
  let at = 0;
  const need = (size) => { if (at + size > blob.length) throw new SeaBlobError("The SEA blob is truncated."); };
  const u64 = () => {
    need(8);
    const value = blob.readBigUInt64LE(at);
    at += 8;
    if (value > BigInt(blob.length)) throw new SeaBlobError("A length in the SEA blob is larger than the blob.");
    return Number(value);
  };
  const string = () => {
    const length = u64();
    need(length);
    const bytes = blob.subarray(at, at + length);
    at += length;
    return bytes;
  };
  need(headerSize);
  if (blob.readUInt32LE(0) !== SEA_MAGIC) throw new SeaBlobError("This isn't a Node SEA blob.");
  const flags = blob.readUInt32LE(4);
  if (flags & ~KNOWN_FLAGS) throw new SeaBlobError(`The SEA blob has flags 0x${flags.toString(16)} this script doesn't know.`);
  at = headerSize;
  const header = blob.subarray(0, headerSize);
  const codePath = string();
  const main = string();
  const codeCache = flags & K_USE_CODE_CACHE ? string() : null;
  const assets = [];
  if (flags & K_INCLUDE_ASSETS) {
    const count = u64();
    for (let index = 0; index < count; index += 1) assets.push({ name: string(), content: string() });
  }
  const execArgv = [];
  if (flags & K_INCLUDE_EXEC_ARGV) {
    const count = u64();
    for (let index = 0; index < count; index += 1) execArgv.push(string());
  }
  if (at !== blob.length) throw new SeaBlobError("The SEA blob has bytes this script doesn't understand.");
  return { header, flags, codePath, main, codeCache, assets, execArgv };
}

/** The blob's parts: { header, flags, codePath, main, codeCache, assets:
 * [{ name, content }], execArgv }. Tries the v24 header (with the exec argv
 * extension byte), then the older one. */
export function readSeaBlob(blob) {
  let firstError;
  for (const headerSize of [9, 8]) {
    try {
      return parseWith(blob, headerSize);
    } catch (error) {
      if (!(error instanceof SeaBlobError)) throw error;
      firstError ??= error;
    }
  }
  throw firstError;
}

const stringBytes = (bytes) => {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  return [length, bytes];
};

/**
 * The same blob with its assets in byte order of their names, so every
 * build machine writes identical bytes. Refuses a blob with a snapshot or a
 * code cache: those are V8 data for the build machine and can't match.
 */
export function canonicalSeaBlob(blob) {
  const parsed = readSeaBlob(blob);
  if (parsed.flags & (K_USE_SNAPSHOT | K_USE_CODE_CACHE)) throw new SeaBlobError("A SEA blob with a snapshot or code cache can't be reproduced on another machine.");
  const assets = [...parsed.assets].sort((left, right) => Buffer.compare(left.name, right.name));
  for (let index = 1; index < assets.length; index += 1)
    if (assets[index].name.equals(assets[index - 1].name)) throw new SeaBlobError("The SEA blob lists an asset twice.");
  const parts = [parsed.header, ...stringBytes(parsed.codePath), ...stringBytes(parsed.main)];
  if (parsed.flags & K_INCLUDE_ASSETS) {
    const count = Buffer.alloc(8);
    count.writeBigUInt64LE(BigInt(assets.length));
    parts.push(count);
    for (const { name, content } of assets) parts.push(...stringBytes(name), ...stringBytes(content));
  }
  if (parsed.flags & K_INCLUDE_EXEC_ARGV) {
    const count = Buffer.alloc(8);
    count.writeBigUInt64LE(BigInt(parsed.execArgv.length));
    parts.push(count);
    for (const argument of parsed.execArgv) parts.push(...stringBytes(argument));
  }
  const canonical = Buffer.concat(parts);
  if (canonical.length !== blob.length) throw new SeaBlobError("Rewriting the SEA blob changed its size.");
  return canonical;
}
