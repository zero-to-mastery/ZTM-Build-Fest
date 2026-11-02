// The QR codec (#96): frame-buffer ownership against a substitute export
// table, and a real round trip through the engine.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { KinEngineError } from "./kin-engine.js";
import { createQrCodec, MAX_FRAME_PIXELS, qrCodec, releaseQrCodec } from "./kin-qr.js";

const RESULT_AT = 512;
const encoder = new TextEncoder();

/** An export table that records allocations and reads frames back. */
function substitute({ status = 0, payload = encoder.encode("https://kin.test/pair#code=ABCD"), grow = false } = {}) {
  const memory = new WebAssembly.Memory({ initial: 20, maximum: 200 });
  const live = new Map();
  const log = [];
  let next = 4096;
  let result = [0, 0];
  const setResult = (bytes) => {
    new Uint8Array(memory.buffer, RESULT_AT, bytes.length).set(bytes);
    result = [RESULT_AT, bytes.length];
  };
  const exports = {
    memory,
    kin_alloc(length) {
      const pointer = next;
      next += length + 64;
      live.set(pointer, length);
      log.push(["alloc", length]);
      return pointer;
    },
    kin_free(pointer, length) {
      log.push(["free", length]);
      return live.get(pointer) === length && live.delete(pointer) ? 0 : 1;
    },
    kin_clear() {
      log.push(["clear"]);
      live.clear();
    },
    kin_qr_encode(pointer, length) {
      if (live.get(pointer) !== length) return 1;
      const side = 21;
      const bytes = new Uint8Array(12 + side * side);
      bytes.set(encoder.encode("KQRM"));
      new DataView(bytes.buffer).setUint16(4, 1, true);
      new DataView(bytes.buffer).setUint32(8, side, true);
      bytes[12] = 1;
      setResult(bytes);
      return 0;
    },
    kin_qr_decode(pointer, length) {
      if (live.get(pointer) !== length) return 1;
      const header = new DataView(memory.buffer, pointer, 8);
      const width = header.getUint32(0, true);
      const height = header.getUint32(4, true);
      log.push(["decode", width, height, Array.from(new Uint8Array(memory.buffer, pointer + 8, 3))]);
      if (grow) memory.grow(1);
      if (status !== 0) return status;
      setResult(payload);
      return 0;
    },
    kin_result_ptr: () => result[0],
    kin_result_len: () => result[1],
  };
  return { exports, log, live, memory };
}

const fill = (value) => (target) => target.fill(value);

test("one frame buffer is held per frame size, with its size in the header", () => {
  const engine = substitute();
  const codec = createQrCodec(engine.exports);
  assert.equal(codec.decodeFrame(40, 30, fill(7)), "https://kin.test/pair#code=ABCD");
  assert.equal(codec.decodeFrame(40, 30, fill(9)), "https://kin.test/pair#code=ABCD");
  assert.deepEqual(engine.log.filter(([kind]) => kind === "alloc"), [["alloc", 8 + 40 * 30]], "allocated once for both frames");
  assert.deepEqual(engine.log.filter(([kind]) => kind === "decode"), [
    ["decode", 40, 30, [7, 7, 7]],
    ["decode", 40, 30, [9, 9, 9]],
  ], "each frame's pixels are written straight into the held buffer");
  assert.equal(engine.log.some(([kind]) => kind === "free"), false, "nothing is freed between frames");
});

test("a new frame size replaces the held buffer", () => {
  const engine = substitute();
  const codec = createQrCodec(engine.exports);
  codec.decodeFrame(40, 30, fill(1));
  codec.decodeFrame(64, 48, fill(1));
  assert.deepEqual(engine.log.filter(([kind]) => kind !== "decode"), [
    ["alloc", 8 + 40 * 30],
    ["free", 8 + 40 * 30],
    ["alloc", 8 + 64 * 48],
  ]);
  assert.equal(engine.live.size, 1, "only the current frame buffer is live");
});

test("each frame gets a fresh view, so memory growth during a decode is harmless", () => {
  const engine = substitute({ grow: true });
  const codec = createQrCodec(engine.exports);
  codec.decodeFrame(40, 30, fill(3));
  const seen = [];
  codec.decodeFrame(40, 30, (target) => {
    seen.push(target.byteLength);
    target.fill(4);
  });
  assert.deepEqual(seen, [1200], "the second frame's view is usable after the first grew memory");
  assert.deepEqual(engine.log.filter(([kind]) => kind === "decode").at(-1), ["decode", 40, 30, [4, 4, 4]]);
});

test("no code, an invalid payload and engine errors are told apart", () => {
  assert.equal(createQrCodec(substitute({ status: 7 }).exports).decodeFrame(40, 30, fill(0)), null, "no code in view");
  assert.equal(createQrCodec(substitute({ payload: Uint8Array.from([0xff, 0xfe]) }).exports).decodeFrame(40, 30, fill(0)), "", "not UTF-8: found, but not a Kin link");
  assert.throws(() => createQrCodec(substitute({ status: 5 }).exports).decodeFrame(40, 30, fill(0)), (error) => error instanceof KinEngineError && error.code === 5);
});

test("frames larger than the decoder accepts are refused before any allocation", () => {
  const engine = substitute();
  const codec = createQrCodec(engine.exports);
  for (const [width, height] of [[1281, 10], [10, 1281], [1280, 721], [0, 10], [10.5, 10]]) {
    assert.throws(() => codec.decodeFrame(width, height, fill(0)), (error) => error.code === 5, `${width}×${height}`);
  }
  assert.ok(1280 * 720 <= MAX_FRAME_PIXELS);
  assert.equal(engine.log.length, 0);
});

test("encode returns the module grid and frees its input", () => {
  const engine = substitute();
  const codec = createQrCodec(engine.exports);
  const { side, modules } = codec.encode("https://kin.test/pair#code=ABCD");
  assert.equal(side, 21);
  assert.equal(modules.length, 21 * 21);
  assert.equal(modules[0], 1);
  assert.equal(engine.live.size, 0, "the input is freed");
  assert.throws(() => codec.encode(""), (error) => error.code === 2, "nothing to encode");
});

test("a decoded payload is zeroed in WASM memory once copied out", () => {
  const engine = substitute();
  const codec = createQrCodec(engine.exports);
  assert.equal(codec.decodeFrame(40, 30, fill(1)), "https://kin.test/pair#code=ABCD");
  const length = engine.exports.kin_result_len();
  const left = new Uint8Array(engine.memory.buffer, RESULT_AT, length);
  assert.ok(left.every((byte) => byte === 0), "only the caller's copy holds the payload");
});

test("forget blanks the held frame and decodes it once, replacing what the last frame left", () => {
  const engine = substitute({ status: 7 });
  const codec = createQrCodec(engine.exports);
  codec.decodeFrame(40, 30, fill(200));
  codec.forget();
  assert.deepEqual(engine.log.filter(([kind]) => kind === "decode").at(-1), ["decode", 40, 30, [0, 0, 0]], "a blank frame went through the decoder");
  assert.equal(engine.log.filter(([kind]) => kind === "alloc").length, 1, "the held buffer is reused, not reallocated");
  createQrCodec(substitute().exports).forget(); // nothing held: nothing to do
});

test("a matrix of another version is refused", () => {
  const engine = substitute();
  const original = engine.exports.kin_qr_encode;
  engine.exports.kin_qr_encode = (pointer, length) => {
    const status = original(pointer, length);
    new DataView(engine.memory.buffer, RESULT_AT, 12).setUint16(4, 2, true);
    return status;
  };
  assert.throws(() => createQrCodec(engine.exports).encode("x"), (error) => error.code === 6);
});

test("a disposed codec clears the engine and refuses further use", () => {
  const engine = substitute();
  const codec = createQrCodec(engine.exports);
  codec.decodeFrame(40, 30, fill(0));
  codec.dispose();
  assert.equal(engine.log.at(-1)[0], "clear");
  assert.equal(codec.disposed, true);
  assert.throws(() => codec.decodeFrame(40, 30, fill(0)), (error) => error.code === 6);
  assert.throws(() => codec.encode("x"), (error) => error.code === 6);
  codec.dispose();
});

test("an export table without the QR exports is refused", () => {
  const { exports } = substitute();
  delete exports.kin_qr_decode;
  assert.throws(() => createQrCodec(exports), (error) => error.code === 6);
});

test("the page shares one codec until Kin locks, then loads a new one", async () => {
  let loads = 0;
  const engines = [];
  const load = async () => {
    loads += 1;
    const engine = substitute();
    engines.push(engine);
    return createQrCodec(engine.exports);
  };
  const first = await qrCodec(load);
  assert.equal(await qrCodec(load), first);
  assert.equal(loads, 1);
  await releaseQrCodec();
  assert.equal(first.disposed, true);
  assert.equal(engines[0].log.at(-1)[0], "clear");
  const second = await qrCodec(load);
  assert.notEqual(second, first);
  assert.equal(loads, 2);
  await releaseQrCodec();
});

test("a failed load is not cached", async () => {
  await assert.rejects(qrCodec(async () => { throw new Error("offline"); }));
  const codec = await qrCodec(async () => createQrCodec(substitute().exports));
  assert.equal(codec.disposed, false);
  await releaseQrCodec();
});

test("the real engine encodes a Kin link and reads it back from a drawn frame", async () => {
  const bytes = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const codec = createQrCodec(instance.exports);
  const text = "https://kin.test/pair#code=7KQ4-ZPM2-HR9T-VXB6";
  const { side, modules } = codec.encode(text);
  assert.ok(side >= 25 && (side - 17) % 4 === 0, `side ${side}`);
  // Draw at 5 px per module with a four-module quiet zone, centred in 640×480.
  const scale = 5;
  const total = (side + 8) * scale;
  const [width, height] = [640, 480];
  const luma = new Uint8Array(width * height).fill(255);
  const left = (width - total) / 2 | 0;
  const top = (height - total) / 2 | 0;
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      if (!modules[y * side + x]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        const row = (top + (y + 4) * scale + dy) * width + left + (x + 4) * scale;
        luma.fill(0, row, row + scale);
      }
    }
  }
  assert.equal(codec.decodeFrame(width, height, (target) => target.set(luma)), text);
  assert.equal(codec.decodeFrame(width, height, (target) => target.fill(255)), null, "a blank frame has no code");
  codec.dispose();
});
