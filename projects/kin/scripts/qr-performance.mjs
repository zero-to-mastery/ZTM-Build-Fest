// Release-WASM benchmark for the QR decoder (issue #95: at most 25 ms for a
// 640×480 frame on a mid-range phone; this runs the same engine on this host).
//
// Usage (after ./build-wasm.sh or build-wasm.ps1 has produced
// web/wasm/kin_engine.wasm from a release build):
//   node scripts/qr-performance.mjs [--iterations 60]
//
// The script drives the raw ABI the way the host does: kin_alloc, write, call,
// copy the result, kin_free. Frames are made by kin_qr_encode and drawn with a
// four-module quiet zone, so the decoder sees what a camera would show a
// screen. Exits 1 when the 640×480 median exceeds the budget.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BUDGET_MS = 25;
const WASM = fileURLToPath(new URL("../web/wasm/kin_engine.wasm", import.meta.url));
const iterations = Number(process.argv[process.argv.indexOf("--iterations") + 1]) || 60;

const { instance } = await WebAssembly.instantiate(await readFile(WASM), {});
const engine = instance.exports;
const encoder = new TextEncoder();

// Runs one ABI operation and returns a copy of its result bytes.
function call(operation, input) {
  const pointer = engine.kin_alloc(input.length);
  if (pointer === 0) throw new Error("kin_alloc failed");
  new Uint8Array(engine.memory.buffer, pointer, input.length).set(input);
  const status = engine[operation](pointer, input.length);
  engine.kin_free(pointer, input.length);
  if (status !== 0) throw new Error(`${operation} failed with status ${status}`);
  const resultPointer = engine.kin_result_ptr();
  return new Uint8Array(engine.memory.buffer, resultPointer, engine.kin_result_len()).slice();
}

// KQRM matrix from kin_qr_encode: magic, version, reserved, side, modules.
function matrixOf(text) {
  const bytes = call("kin_qr_encode", encoder.encode(text));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const side = view.getUint32(8, true);
  return { side, modules: bytes.subarray(12, 12 + side * side) };
}

// A width × height grayscale frame with the symbol at `scale` pixels per module.
function frameOf(text, width, height, scale) {
  const { side, modules } = matrixOf(text);
  const quiet = 4;
  const luma = new Uint8Array(width * height).fill(255);
  const x0 = Math.floor((width - (side + 2 * quiet) * scale) / 2) + quiet * scale;
  const y0 = Math.floor((height - (side + 2 * quiet) * scale) / 2) + quiet * scale;
  for (let my = 0; my < side; my += 1) {
    for (let mx = 0; mx < side; mx += 1) {
      if (!modules[my * side + mx]) continue;
      for (let py = 0; py < scale; py += 1) {
        const row = (y0 + my * scale + py) * width + x0 + mx * scale;
        luma.fill(0, row, row + scale);
      }
    }
  }
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  const frame = new Uint8Array(8 + luma.length);
  frame.set(header);
  frame.set(luma, 8);
  return frame;
}

function measure(frame, expected) {
  const times = [];
  for (let i = 0; i < iterations + 5; i += 1) {
    const started = performance.now();
    const payload = call("kin_qr_decode", frame);
    const elapsed = performance.now() - started;
    if (new TextDecoder().decode(payload) !== expected) throw new Error("decoded payload differs");
    if (i >= 5) times.push(elapsed); // the first calls warm the instance
  }
  times.sort((a, b) => a - b);
  return {
    median: times[Math.floor(times.length / 2)],
    p90: times[Math.floor(times.length * 0.9)],
  };
}

const text = "https://kin.example.org/#sign-in=q7tk-2mzp-vx8r-3hdn-4wjb";
const cases = [
  { label: "640×480", width: 640, height: 480, scale: 5, budgeted: true },
  { label: "1280×720", width: 1280, height: 720, scale: 8, budgeted: false },
];

let overBudget = false;
for (const { label, width, height, scale, budgeted } of cases) {
  const result = measure(frameOf(text, width, height, scale), text);
  const verdict = budgeted && result.median > BUDGET_MS ? "OVER BUDGET" : "ok";
  if (budgeted && result.median > BUDGET_MS) overBudget = true;
  console.log(
    `${label}: median ${result.median.toFixed(2)} ms, p90 ${result.p90.toFixed(2)} ms ` +
      `(${iterations} iterations, budget ${BUDGET_MS} ms for 640×480) ${verdict}`,
  );
}
process.exitCode = overBudget ? 1 : 0;
