// Getting the official node binaries (scripts/sea/node-release.mjs, #714):
// SHASUMS256.txt, reading a .tar.gz, and refusing a download that doesn't
// match its checksum. No network: fetch is a stand-in.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { downloadNode, hostTarget, NodeReleaseError, parseShasums, readTarEntry, TARGETS } from "./node-release.mjs";

function tarHeader(name, size, type = "0", prefix = "") {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(prefix, 345, "utf8");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}
const pad = (bytes) => Buffer.concat([bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
function tar(entries) {
  const parts = [];
  for (const { name, data, type = "0", prefix = "" } of entries) parts.push(tarHeader(name, data.length, type, prefix), pad(data));
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("SHASUMS256.txt is read as file name to hash", { timeout: 60_000 }, () => {
  const sums = parseShasums(`${"a".repeat(64)}  node-v24.22.0-linux-x64.tar.gz\n${"b".repeat(64)} *win-x64/node.exe\r\nnot a line\n`);
  assert.equal(sums.get("node-v24.22.0-linux-x64.tar.gz"), "a".repeat(64));
  assert.equal(sums.get("win-x64/node.exe"), "b".repeat(64));
  assert.equal(sums.size, 2);
});

test("a tar entry is found by its plain, prefixed, pax or GNU long name", { timeout: 60_000 }, () => {
  const long = `node-v24.22.0-linux-x64/${"deep/".repeat(30)}node`;
  const archive = tar([
    { name: "node-v24.22.0-linux-x64/README.md", data: Buffer.from("readme") },
    { name: "bin/node", prefix: "node-v24.22.0-linux-x64", data: Buffer.from("the binary") },
    { name: "././@PaxHeader", type: "x", data: Buffer.from(`${(` path=${long}\n`).length + 3} path=${long}\n`) },
    { name: "truncated-name", data: Buffer.from("pax named") },
    { name: "././@LongLink", type: "L", data: Buffer.from(`${long}-gnu\0`) },
    { name: "truncated", data: Buffer.from("gnu named") },
  ]);
  assert.equal(readTarEntry(archive, "node-v24.22.0-linux-x64/bin/node").toString(), "the binary");
  assert.equal(readTarEntry(archive, "node-v24.22.0-linux-x64/README.md").toString(), "readme");
  assert.equal(readTarEntry(archive, long).toString(), "pax named");
  assert.equal(readTarEntry(archive, `${long}-gnu`).toString(), "gnu named");
  assert.equal(readTarEntry(archive, "missing"), null);
  assert.throws(() => readTarEntry(archive.subarray(0, 515), "node-v24.22.0-linux-x64/bin/node"), /truncated/);
});

function fakeDist(files) {
  return async (url) => {
    const name = url.replace(/^https:\/\/nodejs\.org\/dist\/v24\.22\.0\//, "");
    if (!Object.hasOwn(files, name)) return new Response("missing", { status: 404 });
    return new Response(files[name]);
  };
}

test("a downloaded node is checked against SHASUMS256.txt before it is used", { timeout: 60_000 }, async () => {
  const archive = gzipSync(tar([{ name: "node-v24.22.0-linux-arm64/bin/node", data: Buffer.from("arm64 node") }]));
  const shasums = `${sha256(archive)}  node-v24.22.0-linux-arm64.tar.gz\n`;
  const result = await downloadNode("linux-arm64", "24.22.0", { fetchImpl: fakeDist({ "SHASUMS256.txt": shasums, "node-v24.22.0-linux-arm64.tar.gz": archive }) });
  assert.equal(result.binary.toString(), "arm64 node");
  assert.equal(result.archiveSha256, sha256(archive));

  const tampered = Buffer.from(archive);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(downloadNode("linux-arm64", "24.22.0", { fetchImpl: fakeDist({ "SHASUMS256.txt": shasums, "node-v24.22.0-linux-arm64.tar.gz": tampered }) }),
    (error) => error instanceof NodeReleaseError && /doesn't match its SHA-256/.test(error.message));
  await assert.rejects(downloadNode("linux-x64", "24.22.0", { fetchImpl: fakeDist({ "SHASUMS256.txt": shasums }) }), /doesn't list node-v24\.22\.0-linux-x64\.tar\.gz/);
  await assert.rejects(downloadNode("linux-x64", "24.22.0", { fetchImpl: fakeDist({}) }), /answered 404/);

  const exe = Buffer.from("MZ windows node");
  const windows = await downloadNode("win-x64", "24.22.0", { fetchImpl: fakeDist({ "SHASUMS256.txt": `${sha256(exe)}  win-x64/node.exe\n`, "win-x64/node.exe": exe }) });
  assert.deepEqual(windows.binary, exe);
});

test("the targets are the five ADR 0025 names", { timeout: 60_000 }, () => {
  assert.deepEqual(Object.keys(TARGETS), ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "win-x64"]);
  assert.equal(hostTarget("linux", "x64"), "linux-x64");
  assert.equal(hostTarget("win32", "x64"), "win-x64");
  assert.equal(hostTarget("linux", "ia32"), null);
});
