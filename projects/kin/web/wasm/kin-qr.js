// QR encoding and decoding through the engine's own QR code (rust/src/qr/,
// docs/ABI.md "QR codes"). The browser only draws modules and reads camera
// pixels; Rust does the symbol work.
//
// The codec runs in its own engine instance, separate from the household
// engine: scanning never touches household state, and dropping the codec
// (releaseQrCodec, on lock) frees the decoder's working memory and any
// payload it read without disturbing the session.
//
// Frames are written straight into one input buffer kept in WASM memory, so
// a camera loop copies each frame once (RGBA → luma into WASM) and allocates
// nothing per frame. The buffer is replaced only when the frame size changes.
import { KinEngineError } from "./kin-engine.js";

/** Largest frame the decoder accepts (rust/src/qr/decode.rs). */
export const MAX_FRAME_WIDTH = 1280;
export const MAX_FRAME_HEIGHT = 1280;
export const MAX_FRAME_PIXELS = 1280 * 720;

const NO_SYMBOL = 7;
const FRAME_HEADER = 8;
const MATRIX_HEADER = 12;
const REQUIRED_EXPORTS = [
  "memory", "kin_alloc", "kin_free", "kin_clear",
  "kin_qr_encode", "kin_qr_decode",
  "kin_result_ptr", "kin_result_len",
];
const CLOSED = "The QR reader was closed. Open it again to continue.";
const MESSAGES = new Map([
  [2, "That QR request was not valid."],
  [5, "That is too much to fit in a QR code, or the camera frame is too large."],
]);

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export async function loadQrCodec(wasmUrl = new URL("./kin_engine.wasm", import.meta.url)) {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new KinEngineError(6, "Kin could not load its QR reader. Try again.");
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  return createQrCodec(instance.exports);
}

/** Wraps engine exports in the QR codec. Exposed for Node tests, which pass
 * a substitute export table. */
export function createQrCodec(instanceExports) {
  let exports = instanceExports;
  if (REQUIRED_EXPORTS.some((name) => !(name in exports)) || !(exports.memory instanceof WebAssembly.Memory)) {
    throw new KinEngineError(6, "Kin loaded an incompatible QR reader.");
  }
  // The held frame input: pointer and length of a live kin_alloc buffer, with
  // the width and height already written into its header.
  let frame = null;

  const live = () => {
    if (!exports) throw new KinEngineError(6, CLOSED);
    return exports;
  };
  const fail = (status) => new KinEngineError(status, MESSAGES.get(status) ?? "Kin could not read that QR code. Try again.");
  // Copies the result out, then zeroes it in WASM memory: a decoded payload
  // can carry a pairing secret, and only the copy handed to the caller
  // should hold it.
  const result = (engine) => {
    const pointer = engine.kin_result_ptr();
    const length = engine.kin_result_len();
    if (pointer === 0 || length === 0) return new Uint8Array(0);
    const view = new Uint8Array(engine.memory.buffer, pointer, length);
    const bytes = view.slice();
    view.fill(0);
    return bytes;
  };

  const frameBuffer = (engine, width, height) => {
    if (frame && frame.width === width && frame.height === height) return frame;
    if (frame) {
      engine.kin_free(frame.pointer, frame.length);
      frame = null;
    }
    const length = FRAME_HEADER + width * height;
    const pointer = engine.kin_alloc(length);
    if (!pointer) throw fail(5);
    const header = new DataView(engine.memory.buffer, pointer, FRAME_HEADER);
    header.setUint32(0, width, true);
    header.setUint32(4, height, true);
    frame = { pointer, length, width, height };
    return frame;
  };

  return {
    /** The module grid for `text`: `side` × `side` bytes, 1 dark, row-major. */
    encode(text) {
      const engine = live();
      const input = encoder.encode(String(text));
      if (input.length === 0) throw fail(2);
      const pointer = engine.kin_alloc(input.length);
      if (!pointer) throw fail(5);
      try {
        new Uint8Array(engine.memory.buffer, pointer, input.length).set(input);
        const status = engine.kin_qr_encode(pointer, input.length);
        if (status !== 0) throw fail(status);
        const bytes = result(engine);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const side = bytes.length >= MATRIX_HEADER ? view.getUint32(8, true) : 0;
        const magic = String.fromCharCode(...bytes.subarray(0, 4));
        const version = bytes.length >= MATRIX_HEADER ? view.getUint16(4, true) : 0;
        if (magic !== "KQRM" || version !== 1 || side === 0 || bytes.length !== MATRIX_HEADER + side * side) throw fail(6);
        return { side, modules: bytes.subarray(MATRIX_HEADER) };
      } finally {
        engine.kin_free(pointer, input.length);
      }
    },

    /** Decodes one `width` × `height` grayscale frame. `write(target)` fills
     * `target` (a view of WASM memory, one byte per pixel, row-major) with
     * the frame's luma; it must not keep the view. Returns the payload text,
     * an empty string when the payload isn't valid UTF-8, or null when the
     * frame has no readable code. */
    decodeFrame(width, height, write) {
      const engine = live();
      if (
        !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > MAX_FRAME_WIDTH || height > MAX_FRAME_HEIGHT || width * height > MAX_FRAME_PIXELS
      ) throw fail(5);
      const held = frameBuffer(engine, width, height);
      // A fresh view each frame: the decoder may grow memory, which detaches
      // earlier views without moving the buffer.
      write(new Uint8Array(engine.memory.buffer, held.pointer + FRAME_HEADER, width * height));
      const status = engine.kin_qr_decode(held.pointer, held.length);
      if (status === NO_SYMBOL) return null;
      if (status !== 0) throw fail(status);
      try {
        return utf8.decode(result(engine));
      } catch {
        return "";
      }
    },

    /** Overwrites what the last frame left behind: the held frame is blanked
     * and decoded once, which replaces the decoder's working image of the
     * frame and its result. The scanner calls this when it stops. Like
     * kin_clear, this doesn't promise physical erasure of memory the engine
     * freed earlier (docs/ABI.md). */
    forget() {
      if (!exports || !frame) return;
      new Uint8Array(exports.memory.buffer, frame.pointer + FRAME_HEADER, frame.width * frame.height).fill(0);
      exports.kin_qr_decode(frame.pointer, frame.length);
    },

    /** Releases the frame buffer and the decoder's working memory. The codec
     * can't be used afterwards. */
    dispose() {
      if (!exports) return;
      exports.kin_clear();
      frame = null;
      exports = null;
    },

    get disposed() {
      return exports === null;
    },
  };
}

// One codec per page, created on first use.
let shared = null;

/** The page's QR codec, loading it on first use. */
export function qrCodec(load = loadQrCodec) {
  shared ??= load().catch((error) => {
    shared = null;
    throw error;
  });
  return shared;
}

/** Drops the page's QR codec (Kin locking). The next qrCodec() loads a new
 * one; any component still holding the old one gets "closed" errors. */
export async function releaseQrCodec() {
  const current = shared;
  shared = null;
  if (!current) return;
  const codec = await current.catch(() => null);
  codec?.dispose();
}
