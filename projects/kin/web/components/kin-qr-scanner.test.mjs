// <kin-qr-scanner> (#96): which payloads count as Kin links, camera states,
// frame sizing, and that the camera stops on every exit, without a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { connect, disconnect, FakeElement, installDom, recordEvents, settle } from "./qr-test-dom.mjs";

const defined = installDom();
const windowListeners = {};
globalThis.addEventListener = (type, listener) => (windowListeners[type] ??= []).push(listener);
globalThis.removeEventListener = (type, listener) => { windowListeners[type] = (windowListeners[type] ?? []).filter((l) => l !== listener); };
const fireWindow = (type) => { for (const listener of windowListeners[type] ?? []) listener({ type }); };
Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://kin.test" } });

const {
  KinQrScanner, SCAN_INTERVAL_MS, cameraErrorState, cameraSupport, frameSize, kinLink, rgbaToLuma,
} = await import("./kin-qr-scanner.js");
const { ROUTE_CHANGE_EVENT } = await import("../routes.js");
const { qrCodec, releaseQrCodec } = await import("../wasm/kin-qr.js");
assert.equal(defined["kin-qr-scanner"], KinQrScanner);

test("only links to this Kin's pairing and sign-in paths are accepted", () => {
  const origin = "https://kin.test";
  assert.equal(kinLink("https://kin.test/pair#code=ABCD", origin), "https://kin.test/pair#code=ABCD");
  assert.equal(kinLink("https://kin.test/link#r=1&s=2&f=3", origin), "https://kin.test/link#r=1&s=2&f=3");
  assert.equal(kinLink("http://127.0.0.1:8080/pair#code=ABCD", "http://127.0.0.1:8080"), "http://127.0.0.1:8080/pair#code=ABCD");
  for (const text of [
    "https://kin.test/pair?code=ABCD", // a query reaches the server; Kin's secrets ride in the fragment
    "https://kin.test/pair?#code=ABCD", // an empty query is still a query
    "https://evil.test/pair#code=ABCD", // another origin
    "http://kin.test/pair#code=ABCD", // the same host without TLS is another origin
    "https://kin.test.evil.test/pair", // a look-alike host
    "https://kin.test/settings", // a Kin page, but not a code path
    "https://kin.test/pair/extra", // not exactly the path
    "https://user:pass@kin.test/pair", // credentials in the link
    "javascript:alert(1)",
    "ABCD-EFGH", // a bare code is typed, not scanned
    "",
    null,
  ]) assert.equal(kinLink(text, origin), null, String(text));
  // An opaque origin (a sandboxed frame) matches no Kin link, whatever the scheme.
  assert.equal(kinLink("data:/pair", "null"), null);
  assert.equal(kinLink("javascript:/pair", "null"), null);
});

test("each reason a camera can't be used has its own state", () => {
  const media = { getUserMedia() {} };
  assert.equal(cameraSupport({ isSecureContext: true, media }), "available");
  assert.equal(cameraSupport({ isSecureContext: false, media }), "insecure");
  assert.equal(cameraSupport({ isSecureContext: true, media: null }), "no-camera");
  assert.equal(cameraErrorState({ name: "NotAllowedError" }), "denied");
  assert.equal(cameraErrorState({ name: "SecurityError" }), "denied");
  assert.equal(cameraErrorState({ name: "NotFoundError" }), "no-camera");
  assert.equal(cameraErrorState({ name: "OverconstrainedError" }), "no-camera");
  assert.equal(cameraErrorState({ name: "NotReadableError" }), "error", "a camera busy elsewhere can be retried");
  assert.equal(cameraErrorState(new Error("other")), "error");
});

test("frames are scaled to 640 wide and kept within the decoder's limits", () => {
  assert.deepEqual(frameSize(1920, 1080), { width: 640, height: 360 });
  assert.deepEqual(frameSize(1080, 1920), { width: 640, height: 1137 }, "portrait keeps its aspect");
  assert.deepEqual(frameSize(320, 240), { width: 320, height: 240 }, "small frames are not enlarged");
  const tall = frameSize(200, 9000);
  assert.ok(tall.height <= 1280 && tall.width * tall.height <= 1280 * 720, "an extreme aspect still fits");
  assert.equal(frameSize(0, 480), null, "no picture yet");
});

test("RGBA becomes luma with integer BT.601 weights", () => {
  const rgba = Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
  const luma = new Uint8Array(4);
  rgbaToLuma(rgba, luma);
  assert.deepEqual([...luma], [255, 0, 149, 76]);
});

// A camera whose frames are delivered by hand, and a codec that returns
// whatever the test queues.
function rig({ secure = true, cameraError = null, payloads = [] } = {}) {
  const tracks = [];
  const requests = [];
  let releaseCamera;
  const cameraHeld = new Promise((resolve) => { releaseCamera = resolve; });
  let holdCamera = false;
  const media = {
    async getUserMedia(constraints) {
      requests.push(constraints);
      if (holdCamera) await cameraHeld;
      if (cameraError) throw cameraError;
      const listeners = {};
      const track = {
        stopped: false,
        stop() { this.stopped = true; },
        addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
        fire(type) { for (const listener of listeners[type] ?? []) listener({ type }); },
      };
      tracks.push(track);
      return { getTracks: () => [track] };
    },
  };
  const decoded = [];
  const codec = {
    decodeFrame(width, height, write) {
      const target = new Uint8Array(width * height);
      write(target);
      decoded.push([width, height]);
      return payloads.length ? payloads.shift() : null;
    },
  };
  const scanner = new KinQrScanner();
  scanner.media = media;
  scanner.codec = codec;
  scanner.environment = { isSecureContext: secure };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return { drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8Array(w * h * 4) }) };
    }
  };
  connect(scanner);
  // The video element: frames arrive only when the test calls frame(time).
  const video = scanner.parts.video;
  let pending = null;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.play = async () => {};
  video.requestVideoFrameCallback = (callback) => { pending = callback; return 1; };
  video.cancelVideoFrameCallback = () => { pending = null; };
  const frame = (time) => { const callback = pending; pending = null; callback?.(time); };
  return {
    scanner, tracks, requests, decoded, frame, video,
    hold() { holdCamera = true; },
    release: () => releaseCamera(),
    get waiting() { return pending !== null; },
  };
}

const press = (scanner, label) => scanner.find((node) => node.tagName === "BUTTON" && node._text === label).click();
const status = (scanner) => scanner.byClass("kin-qr-scanner-status").textContent;

test("the camera is asked for only after a tap, with the rear camera", async () => {
  const { scanner, requests } = rig();
  assert.equal(requests.length, 0, "nothing on connect");
  assert.ok(scanner.byText("Type the code instead"), "typing is offered before scanning");
  press(scanner, "Scan a code");
  await settle();
  assert.deepEqual(requests, [{ video: { facingMode: "environment" }, audio: false }]);
  assert.equal(scanner.state, "scanning");
  assert.equal(status(scanner), "Looking for a code…");
  assert.ok(scanner.byText("Type the code instead"), "typing stays offered while scanning");
});

test("an insecure page or a missing camera never asks for the camera", async () => {
  const insecure = rig({ secure: false });
  press(insecure.scanner, "Scan a code");
  await settle();
  assert.equal(insecure.requests.length, 0);
  assert.equal(insecure.scanner.state, "insecure");
  assert.match(insecure.scanner.byClass("kin-qr-scanner-help").textContent, /secure connection/);

  const missing = rig();
  missing.scanner.media = null;
  press(missing.scanner, "Scan a code");
  await settle();
  assert.equal(missing.scanner.state, "no-camera");
});

test("a refused camera explains how to allow it", async () => {
  const { scanner, tracks } = rig({ cameraError: Object.assign(new Error("no"), { name: "NotAllowedError" }) });
  press(scanner, "Scan a code");
  await settle();
  assert.equal(scanner.state, "denied");
  assert.match(scanner.byClass("kin-qr-scanner-help").textContent, /Allow the camera/);
  assert.equal(tracks.length, 0);
  assert.ok(scanner.byText("Try again"));
});

test("a Kin link stops the camera and is handed to the page", async () => {
  const { scanner, tracks, frame, video } = rig({ payloads: ["https://kin.test/pair#code=ABCD"] });
  const events = recordEvents(scanner);
  press(scanner, "Scan a code");
  await settle();
  frame(1000);
  assert.deepEqual(events.filter((event) => event.type === "kin-qr-scan").map((event) => event.detail), [{ url: "https://kin.test/pair#code=ABCD" }]);
  assert.equal(scanner.state, "found");
  assert.equal(status(scanner), "Code found.");
  assert.ok(tracks.every((track) => track.stopped), "the camera is off");
  assert.equal(video.srcObject, null);
  assert.equal(scanner.canvas, null, "the frame canvas is dropped");
});

test("a code that isn't Kin's is refused and scanning goes on", async () => {
  const r = rig({ payloads: ["https://evil.test/pair#code=ABCD"] });
  const { scanner, tracks, frame } = r;
  const events = recordEvents(scanner);
  press(scanner, "Scan a code");
  await settle();
  frame(1000);
  assert.equal(status(scanner), "This isn't a Kin code.");
  assert.equal(scanner.state, "scanning");
  assert.ok(tracks.every((track) => !track.stopped), "the camera stays on");
  assert.equal(events.some((event) => event.type === "kin-qr-scan"), false);
  assert.ok(r.waiting, "the next frame is requested");
});

test("frames are decoded about ten times a second, at 640 wide", async () => {
  const { scanner, decoded, frame } = rig();
  press(scanner, "Scan a code");
  await settle();
  frame(1000);
  frame(1000 + SCAN_INTERVAL_MS / 2);
  frame(1000 + SCAN_INTERVAL_MS);
  assert.equal(decoded.length, 2, "the frame in between is skipped");
  assert.deepEqual(decoded[0], [640, 360]);
});

for (const [trigger, act] of [
  ["Cancel", (r) => press(r.scanner, "Cancel")],
  ["Type the code instead", (r) => press(r.scanner, "Type the code instead")],
  ["the page being hidden", () => { document.visibilityState = "hidden"; document.fire("visibilitychange"); document.visibilityState = "visible"; }],
  ["an in-app route change", () => fireWindow(ROUTE_CHANGE_EVENT)],
  ["a hash route change", () => fireWindow("hashchange")],
  ["history navigation", () => fireWindow("popstate")],
  ["leaving the page", () => fireWindow("pagehide")],
  ["removal (Kin locking)", (r) => disconnect(r.scanner)],
]) {
  test(`${trigger} turns the camera off`, async () => {
    const r = rig();
    press(r.scanner, "Scan a code");
    await settle();
    assert.equal(r.tracks.length, 1);
    act(r);
    assert.ok(r.tracks[0].stopped, "the track is stopped");
    assert.equal(r.video.srcObject, null);
    assert.equal(r.scanner.active, false);
    r.frame(5000);
    assert.equal(r.decoded.length, 0, "no frame is decoded afterwards");
    disconnect(r.scanner);
  });
}

test("Cancel and Type the code instead tell the page", async () => {
  const r = rig();
  const events = recordEvents(r.scanner);
  press(r.scanner, "Scan a code");
  await settle();
  press(r.scanner, "Cancel");
  press(r.scanner, "Type the code instead");
  assert.deepEqual(events.map((event) => event.type), ["kin-qr-cancel", "kin-qr-manual"]);
});

test("cancelling while the camera prompt is open releases the camera it returns", async () => {
  const r = rig();
  r.hold();
  press(r.scanner, "Scan a code");
  await settle();
  assert.equal(r.scanner.state, "starting");
  press(r.scanner, "Cancel");
  r.release();
  await settle();
  await settle();
  assert.equal(r.tracks.length, 1);
  assert.ok(r.tracks[0].stopped, "the late stream is stopped at once");
  assert.equal(r.scanner.state, "idle");
});

test("removing the scanner removes every page listener it added", () => {
  const counts = () => [document.listenerCount("visibilitychange"),
    ...["hashchange", "popstate", "pagehide", ROUTE_CHANGE_EVENT].map((type) => (windowListeners[type] ?? []).length)];
  const before = counts();
  const r = rig();
  assert.deepEqual(counts(), before.map((count) => count + 1), "one of each while connected");
  disconnect(r.scanner);
  assert.deepEqual(counts(), before);
  assert.ok(r.scanner instanceof FakeElement);
});

test("a camera that ends mid-scan stops the scanner and says so", async () => {
  const r = rig();
  press(r.scanner, "Scan a code");
  await settle();
  const track = r.tracks[0];
  assert.equal(r.scanner.state, "scanning");
  track.fire("ended");
  assert.equal(r.scanner.state, "lost");
  assert.ok(track.stopped);
  assert.ok(r.scanner.byText("Try again"));
});

test("a code reader that fails after the camera was granted turns the camera off", async () => {
  const r = rig();
  r.scanner.codec = { disposed: true, decodeFrame() { throw new Error("closed"); } };
  press(r.scanner, "Scan a code");
  await settle();
  assert.equal(r.scanner.state, "reader");
  assert.equal(status(r.scanner), "The code reader couldn't start.");
  assert.ok(r.tracks.every((track) => track.stopped));
});

test("a preview that won't play turns the camera off", async () => {
  const r = rig();
  r.video.play = async () => { throw new Error("NotAllowedError"); };
  press(r.scanner, "Scan a code");
  await settle();
  assert.equal(r.scanner.state, "error");
  assert.ok(r.tracks.every((track) => track.stopped));
});

test("stopping asks the reader to forget the last frame", async () => {
  const r = rig();
  let forgotten = 0;
  r.scanner.codec.forget = () => { forgotten += 1; };
  press(r.scanner, "Scan a code");
  await settle();
  press(r.scanner, "Cancel");
  assert.equal(forgotten, 1);
});

test("a shared reader released by a lock is replaced on the next start, never reused", async () => {
  const made = [];
  const load = async () => {
    const codec = {
      disposed: false, decoded: 0,
      decodeFrame(width, height, write) { this.decoded += 1; write(new Uint8Array(width * height)); return null; },
      forget() {}, dispose() { this.disposed = true; },
    };
    made.push(codec);
    return codec;
  };
  await qrCodec(load);
  const r = rig();
  r.scanner.codec = null; // use the page's shared reader
  press(r.scanner, "Scan a code");
  await settle();
  r.frame(1000);
  press(r.scanner, "Cancel");
  await releaseQrCodec(); // Kin locks
  assert.equal(made[0].disposed, true);
  await qrCodec(load); // the next use loads a new one
  press(r.scanner, "Scan a code");
  await settle();
  r.frame(3000);
  assert.equal(r.scanner.state, "scanning", "the new reader works");
  assert.deepEqual(made.map((codec) => codec.decoded), [1, 1], "each start used the live reader");
  press(r.scanner, "Cancel");
  await releaseQrCodec();
});
