// Node's SEA fuse (scripts/sea/fuse.mjs, #714).
import assert from "node:assert/strict";
import test from "node:test";
import { flipFuse, fuseFlipped, FuseError, SEA_FUSE } from "./fuse.mjs";

const binary = (state) => Buffer.from(`\x7fELF...${SEA_FUSE}:${state}...rest`, "latin1");

test("the fuse is found, flipped once and read back", { timeout: 60_000 }, () => {
  const bytes = binary("0");
  assert.equal(fuseFlipped(bytes), false);
  flipFuse(bytes);
  assert.equal(fuseFlipped(bytes), true);
  assert.ok(bytes.toString("latin1").includes(`${SEA_FUSE}:1`));
  assert.throws(() => flipFuse(bytes), (error) => error instanceof FuseError && /already flipped/.test(error.message));
});

test("a missing, repeated or odd fuse is refused", { timeout: 60_000 }, () => {
  assert.throws(() => flipFuse(Buffer.from("no fuse here")), /isn't in this binary/);
  assert.throws(() => flipFuse(Buffer.concat([binary("0"), binary("0")])), /more than once/);
  assert.throws(() => flipFuse(binary("x")), /unexpected value/);
});

test("this machine's node binary carries an unflipped fuse", { timeout: 60_000 }, async (t) => {
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(process.execPath);
  if (!bytes.includes(Buffer.from(SEA_FUSE))) { t.skip("this node was built without SEA support"); return; }
  assert.equal(fuseFlipped(bytes), false);
});
