// The SEA blob made the same on every build machine (scripts/sea/blob.mjs,
// #747, #748): assets in name order whatever order node wrote them in, both
// header forms, and refusals.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalSeaBlob, readSeaBlob, SEA_MAGIC, SeaBlobError } from "./blob.mjs";

const u64 = (value) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
const str = (text) => { const bytes = Buffer.from(text); return [u64(bytes.length), bytes]; };

// A blob as node writes it: header (9 bytes in v24, 8 before), code path,
// main script, then the assets in the given order.
function blob(assets, { headerSize = 9, flags = 0b1001, execArgv = null } = {}) {
  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(SEA_MAGIC, 0);
  header.writeUInt32LE(flags | (execArgv ? 1 << 4 : 0), 4);
  const parts = [header, ...str("main.cjs"), ...str("console.log(1)\n"), u64(assets.length)];
  for (const [name, content] of assets) parts.push(...str(name), ...str(content));
  if (execArgv) { parts.push(u64(execArgv.length)); for (const argument of execArgv) parts.push(...str(argument)); }
  return Buffer.concat(parts);
}

const ASSETS = [["kin/manifest.json", "{}"], ["kin/files/web/index.html", "<html>"], ["kin/files/server/server.mjs", "export {}"]];

test("whatever order node wrote the assets in, the canonical blob is the same, sorted by name", { timeout: 60_000 }, () => {
  const linux = blob(ASSETS);
  const mac = blob([ASSETS[2], ASSETS[0], ASSETS[1]]);
  const windows = blob([ASSETS[1], ASSETS[2], ASSETS[0]]);
  assert.notDeepEqual(linux, mac);
  const canonical = canonicalSeaBlob(linux);
  assert.deepEqual(canonicalSeaBlob(mac), canonical);
  assert.deepEqual(canonicalSeaBlob(windows), canonical);
  assert.equal(canonical.length, linux.length);
  assert.deepEqual(readSeaBlob(canonical).assets.map(({ name }) => name.toString()), ["kin/files/server/server.mjs", "kin/files/web/index.html", "kin/manifest.json"]);
  assert.deepEqual(canonicalSeaBlob(canonical), canonical, "idempotent");
});

test("the older 8-byte header and exec argv are kept as they are", { timeout: 60_000 }, () => {
  const older = blob([ASSETS[1], ASSETS[0]], { headerSize: 8 });
  const parsed = readSeaBlob(older);
  assert.equal(parsed.header.length, 8);
  assert.equal(parsed.main.toString(), "console.log(1)\n");
  assert.deepEqual(canonicalSeaBlob(older), blob([ASSETS[0], ASSETS[1]].sort(([a], [b]) => (a < b ? -1 : 1)), { headerSize: 8 }));
  const withArgv = blob([ASSETS[1], ASSETS[0]], { execArgv: ["--max-old-space-size=64", "--no-warnings"] });
  assert.deepEqual(readSeaBlob(canonicalSeaBlob(withArgv)).execArgv.map(String), ["--max-old-space-size=64", "--no-warnings"]);
});

test("a blob with a code cache or snapshot, an unknown layout or a repeated asset is refused", { timeout: 60_000 }, () => {
  assert.throws(() => canonicalSeaBlob(Buffer.concat([blob(ASSETS), Buffer.from("extra")])), (error) => error instanceof SeaBlobError);
  assert.throws(() => canonicalSeaBlob(blob(ASSETS).subarray(0, 40)), SeaBlobError);
  assert.throws(() => canonicalSeaBlob(Buffer.from("not a blob at all, but long enough")), /isn't a Node SEA blob/);
  assert.throws(() => canonicalSeaBlob(blob(ASSETS, { flags: 0b1001 | 1 << 7 })), /flags/);
  assert.throws(() => canonicalSeaBlob(blob([ASSETS[0], ASSETS[0]])), /asset twice/);
  const snapshot = blob(ASSETS, { flags: 0b1011 });
  assert.throws(() => canonicalSeaBlob(snapshot), /snapshot or code cache/);
});

test("this machine's node writes a blob the parser reads exactly", { timeout: 60_000 }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kin-sea-blob-"));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(directory, "main.cjs"), "console.log(1)\n");
  const assets = {};
  for (const name of ["zeta", "alpha", "mid", "beta"]) {
    writeFileSync(join(directory, `${name}.txt`), name.repeat(3));
    assets[`kin/${name}`] = `${name}.txt`;
  }
  writeFileSync(join(directory, "sea-config.json"), JSON.stringify({ main: "main.cjs", output: "kin.blob", disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }));
  const result = spawnSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], { cwd: directory, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "" } });
  if (result.status !== 0) { t.skip(`this node can't write a SEA blob: ${(result.stderr || result.error?.message || "").trim()}`); return; }
  const written = readFileSync(join(directory, "kin.blob"));
  const canonical = canonicalSeaBlob(written);
  const { main, assets: parsed } = readSeaBlob(canonical);
  assert.equal(main.toString(), "console.log(1)\n");
  assert.deepEqual(parsed.map(({ name, content }) => [name.toString(), content.toString()]), [["kin/alpha", "alphaalphaalpha"], ["kin/beta", "betabetabeta"], ["kin/mid", "midmidmid"], ["kin/zeta", "zetazetazeta"]]);
});
