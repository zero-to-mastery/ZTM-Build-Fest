// The official node binaries Kin's executables are built from (#714): where
// each target's binary comes from on nodejs.org, checked against the
// release's SHASUMS256.txt, and read out of its .tar.gz with Node's own zlib
// (no tar tool or package).
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const NODE_DIST = "https://nodejs.org/dist";

/** Kin's targets: the node release file and the binary inside it. `format`
 * is the executable format the injector must write; `machine` is the ELF
 * e_machine, Mach-O CPU type or PE machine the binary must have. */
export const TARGETS = Object.freeze({
  "linux-x64": { format: "elf", machine: 62, archive: (v) => `node-v${v}-linux-x64.tar.gz`, entry: (v) => `node-v${v}-linux-x64/bin/node`, suffix: "" },
  "linux-arm64": { format: "elf", machine: 183, archive: (v) => `node-v${v}-linux-arm64.tar.gz`, entry: (v) => `node-v${v}-linux-arm64/bin/node`, suffix: "" },
  "darwin-arm64": { format: "macho", machine: 0x0100000c, archive: (v) => `node-v${v}-darwin-arm64.tar.gz`, entry: (v) => `node-v${v}-darwin-arm64/bin/node`, suffix: "" },
  "darwin-x64": { format: "macho", machine: 0x01000007, archive: (v) => `node-v${v}-darwin-x64.tar.gz`, entry: (v) => `node-v${v}-darwin-x64/bin/node`, suffix: "" },
  "win-x64": { format: "pe", machine: 0x8664, archive: () => "win-x64/node.exe", entry: null, suffix: ".exe" },
});

/** The target this machine can run, or null. */
export function hostTarget(platform = process.platform, arch = process.arch) {
  const name = `${platform === "win32" ? "win" : platform}-${arch}`;
  return Object.hasOwn(TARGETS, name) ? name : null;
}

export class NodeReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "NodeReleaseError";
  }
}

/** SHASUMS256.txt as a Map from file name to SHA-256. */
export function parseShasums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

const ascii = (bytes, start, length) => {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return Buffer.from(end < 0 ? field : field.subarray(0, end)).toString("utf8");
};

/** The bytes of `name` inside a tar archive (ustar, with pax and GNU long
 * names), or null. */
export function readTarEntry(tar, name) {
  let at = 0;
  let longName = null;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(ascii(header, 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new NodeReleaseError("The node archive is damaged.");
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = at + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    if (data.length !== size) throw new NodeReleaseError("The node archive is truncated.");
    at = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = ascii(data, 0, data.length); continue; }
    if (type === "x") {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (path) longName = path[1];
      continue;
    }
    if (type === "g") continue;
    const prefix = ascii(header, 345, 155);
    const entryName = longName ?? (prefix ? `${prefix}/${ascii(header, 0, 100)}` : ascii(header, 0, 100));
    longName = null;
    if ((type === "0" || type === "\0") && entryName === name) return Buffer.from(data);
  }
  return null;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The official node binary for `target` and `version`, downloaded with
 * `fetchImpl` and checked against SHASUMS256.txt. Returns { binary, archive,
 * archiveSha256 }.
 */
export async function downloadNode(target, version, { fetchImpl = fetch } = {}) {
  const spec = TARGETS[target];
  if (!spec) throw new NodeReleaseError(`Unknown target ${target}.`);
  const base = `${NODE_DIST}/v${version}`;
  const get = async (file) => {
    const response = await fetchImpl(`${base}/${file}`);
    if (!response.ok) throw new NodeReleaseError(`nodejs.org answered ${response.status} for ${file}.`);
    return Buffer.from(await response.arrayBuffer());
  };
  const sums = parseShasums((await get("SHASUMS256.txt")).toString("utf8"));
  const archive = spec.archive(version);
  const expected = sums.get(archive);
  if (!expected) throw new NodeReleaseError(`SHASUMS256.txt for node v${version} doesn't list ${archive}.`);
  const bytes = await get(archive);
  const actual = sha256(bytes);
  if (actual !== expected) throw new NodeReleaseError(`${archive} doesn't match its SHA-256 in SHASUMS256.txt.`);
  if (!spec.entry) return { binary: bytes, archive, archiveSha256: actual };
  const binary = readTarEntry(gunzipSync(bytes), spec.entry(version));
  if (!binary) throw new NodeReleaseError(`${archive} has no ${spec.entry(version)}.`);
  return { binary, archive, archiveSha256: actual };
}
