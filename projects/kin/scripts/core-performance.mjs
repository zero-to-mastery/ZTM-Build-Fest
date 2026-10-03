// Raw manual-ABI comparison; browser crypto/storage timings use the storage runner.
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { loadKinEngine, encodeAddedRecord } from "../web/wasm/kin-engine.js";

const current = await readFile(new URL("../web/wasm/kin_engine.wasm", import.meta.url));
const codec = await loadKinEngine(`data:application/wasm;base64,${current.toString("base64")}`);
const id = (value) => {
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};
const records = Array.from({ length: 10_000 }, (_, index) => encodeAddedRecord({
  eventId: id(index + 1), itemId: id(index + 1), householdId: id(100_001),
  actorId: id(100_002), deviceId: id(100_003), timestamp: index + 1,
  logicalTime: index + 1, text: "synthetic household text",
}));
codec.dispose();
const request = (count) => {
  // This benchmark explicitly exercises the stable v7 test fixture framing.
  const data = new Uint8Array(44 + records.slice(0, count).reduce((sum, row) => sum + row.length, 0));
  const view = new DataView(data.buffer);
  data.set([0x4b, 0x49, 0x4e, 0x45]);
  view.setUint16(4, 7, true);
  view.setUint32(8, count, true);
  view.setBigInt64(12, 10_001n, true);
  view.setUint32(40, 20261003, true);
  let offset = 44;
  for (const record of records.slice(0, count)) { data.set(record, offset); offset += record.length; }
  return data;
};
const packets = [request(1000), request(10_000)];
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function measure(bytes) {
  const initialization = [];
  let instance;
  for (let sample = 0; sample < 10; sample++) {
    const start = performance.now();
    ({ instance } = await WebAssembly.instantiate(bytes, {}));
    initialization.push(performance.now() - start);
  }
  const replay = [], results = [];
  const wasm = instance.exports;
  for (const packet of packets) {
    const timings = [];
    let result;
    for (let sample = 0; sample < 6; sample++) {
      const start = performance.now();
      const pointer = wasm.kin_alloc(packet.length);
      new Uint8Array(wasm.memory.buffer, pointer, packet.length).set(packet);
      assert.equal(wasm.kin_apply_events(pointer, packet.length), 0);
      result = new Uint8Array(wasm.memory.buffer, wasm.kin_result_ptr(), wasm.kin_result_len()).slice();
      assert.equal(wasm.kin_free(pointer, packet.length), 0);
      if (sample) timings.push(performance.now() - start);
    }
    replay.push(median(timings));
    results.push(result);
  }
  return { report: { rawBytes: bytes.length, gzip9Bytes: gzipSync(bytes, { level: 9 }).length,
    meanInstantiateMs: initialization.reduce((sum, n) => sum + n, 0) / initialization.length,
    replay1000MedianMs: replay[0], replay10000MedianMs: replay[1] }, results };
}
const baseline = process.argv[2] ? await measure(await readFile(process.argv[2])) : null;
const measured = await measure(current);
if (baseline) assert.deepEqual(measured.results, baseline.results, "baseline/current projections must match exactly");
console.log(JSON.stringify({ baseline: baseline?.report, current: measured.report,
  scope: "Node raw ABI, 24-byte text, 10 instantiations, median 5 replays after warmup, input/output copies included; no storage/crypto/DOM" }, null, 2));
