// The release WASM must reproduce the native protocol-24 golden projections
// byte for byte (see rust/src/golden_tests.rs).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { replayRequest, resultBytes } from "./abi-test-support.mjs";

const fixtures = new URL("../../rust/fixtures/golden/", import.meta.url);
const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));

// Section revisions count per engine instance; the fixtures hold a fresh
// instance's first projection, where every section is revision 1. The
// instance replays its own history, so the request's records are appended
// first (abi-test-support.mjs).
async function replay(request) {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const abi = instance.exports;
  assert.equal(replayRequest(abi, request), 0);
  return resultBytes(abi);
}

const names = (await readdir(fixtures)).filter((name) => name.endsWith(".kine")).map((name) => name.slice(0, -5));

test("golden fixtures are present", () => {
  assert.deepEqual(names.sort(), ["bulk", "distributed", "empty", "full", "pulse-expiry"]);
});

for (const name of names) {
  test(`WASM reproduces the ${name} golden projection`, async () => {
    const request = new Uint8Array(await readFile(new URL(`${name}.kine`, fixtures)));
    const expected = new Uint8Array(await readFile(new URL(`${name}.kins`, fixtures)));
    assert.deepEqual(await replay(request), expected);
  });
}
