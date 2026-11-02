import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync, crc32 } from "node:zlib";
import { FetchWasmError, checkedEngine, readZip, sha256 } from "./fetch-wasm.mjs";

/** A minimal ZIP writer for the tests: each entry stored (0) or deflated (8). */
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, bytes, method = 8 } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const data = method === 8 ? new Uint8Array(deflateRawSync(bytes)) : bytes;
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, method, true);
    lv.setUint32(14, crc32(bytes), true); lv.setUint32(18, data.length, true); lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, nameBytes.length, true); local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, method, true);
    cv.setUint32(16, crc32(bytes), true); cv.setUint32(20, data.length, true); cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true); central.set(nameBytes, 46);
    locals.push(local, data); centrals.push(central);
    offset += local.length + data.length;
  }
  const directory = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directory, true); ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

const engine = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...new Array(500).fill(7)]);
const record = (hash) => new TextEncoder().encode(`${hash}  web/wasm/kin_engine.wasm\n`);

test("reads stored and deflated entries and accepts an engine that matches its hash", () => {
  for (const method of [0, 8]) {
    const entries = readZip(zip([
      { name: "kin_engine.wasm", bytes: engine, method },
      { name: "kin_engine.wasm.sha256", bytes: record(sha256(engine)), method },
    ]));
    assert.deepEqual(entries.map((entry) => entry.name), ["kin_engine.wasm", "kin_engine.wasm.sha256"]);
    const checked = checkedEngine(entries);
    assert.deepEqual(checked.bytes, engine);
    assert.equal(checked.hash, sha256(engine));
  }
});

test("refuses a mismatched hash, a missing file, a non-WASM file and a non-ZIP", () => {
  const other = engine.slice(); other[100] = 8;
  assert.throws(() => checkedEngine(readZip(zip([{ name: "kin_engine.wasm", bytes: other }, { name: "kin_engine.wasm.sha256", bytes: record(sha256(engine)) }]))),
    (error) => error instanceof FetchWasmError && /doesn't match/.test(error.message));
  assert.throws(() => checkedEngine(readZip(zip([{ name: "kin_engine.wasm", bytes: engine }]))), /missing/);
  const text = new TextEncoder().encode("not an engine");
  assert.throws(() => checkedEngine(readZip(zip([{ name: "kin_engine.wasm", bytes: text }, { name: "kin_engine.wasm.sha256", bytes: record(sha256(text)) }]))), /not a WebAssembly module/);
  assert.throws(() => checkedEngine(readZip(zip([{ name: "kin_engine.wasm", bytes: engine }, { name: "kin_engine.wasm.sha256", bytes: new TextEncoder().encode("nope") }]))), /not a SHA-256/);
  assert.throws(() => readZip(new Uint8Array(100)), /not a ZIP/);
});
