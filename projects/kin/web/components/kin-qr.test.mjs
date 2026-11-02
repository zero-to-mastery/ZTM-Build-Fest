// <kin-qr> (#96): layout, painting, the text code and Copy, failure and
// expiry, without a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { connect, disconnect, installDom, recordEvents, settle } from "./qr-test-dom.mjs";

const defined = installDom();
const { KinQr, QUIET_ZONE, paintModules, qrCanvasSize, qrLayout } = await import("./kin-qr.js");
assert.equal(defined["kin-qr"], KinQr);

/** A codec that returns a fixed 21 × 21 grid with a known pattern. */
function fakeCodec({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    encode(text) {
      calls.push(text);
      if (fail) throw new Error("too long");
      const side = 21;
      const modules = new Uint8Array(side * side);
      modules[0] = 1;
      modules[side * side - 1] = 1;
      return { side, modules };
    },
  };
}

function element({ codec = fakeCodec(), value = "https://kin.test/pair#code=ABCD", code = "ABCD-EFGH" } = {}) {
  const qr = new KinQr();
  qr.codec = codec;
  qr.value = value;
  qr.code = code;
  qr.label = "Scan to join the household";
  return qr;
}

const canvasOf = (qr) => qr.find((node) => node.tagName === "CANVAS");

test("every module is a whole number of pixels, never less than one", () => {
  assert.deepEqual(qrLayout(21, 240), { scale: 8, pixels: 232 }, "21 + 8 quiet modules = 29; 240 / 29 = 8");
  assert.deepEqual(qrLayout(57, 240), { scale: 3, pixels: 195 });
  assert.deepEqual(qrLayout(57, 10), { scale: 1, pixels: 65 }, "a tiny size still draws one pixel per module");
});

test("fractional screen scaling still gets whole device pixels per module", () => {
  // 21 modules + 8 quiet = 29. At 240 CSS px:
  assert.deepEqual(qrCanvasSize(21, 240, 1), { scale: 8, pixels: 232, css: 232 });
  assert.deepEqual(qrCanvasSize(21, 240, 1.25), { scale: 10, pixels: 290, css: 232 });
  assert.deepEqual(qrCanvasSize(21, 240, 2.75), { scale: 22, pixels: 638, css: 232 });
  for (const ratio of [1.5, 2.625, 3]) {
    const { scale, pixels, css } = qrCanvasSize(21, 240, ratio);
    assert.equal(Number.isInteger(scale), true);
    assert.equal(pixels, 29 * scale, "the canvas is a whole number of modules");
    assert.ok(Math.abs(css * ratio - pixels) < 1e-9, "shown at one device pixel per canvas pixel");
    assert.ok(css <= 240);
  }
  assert.deepEqual(qrCanvasSize(21, 240, Number.NaN), qrCanvasSize(21, 240, 1), "an unknown ratio counts as 1");
});

test("modules are painted black on white with the quiet zone around them", () => {
  const fills = [];
  const context = { fillStyle: "", fillRect(x, y, w, h) { fills.push([this.fillStyle, x, y, w, h]); } };
  const side = 3;
  const modules = Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  paintModules(context, side, modules, 2);
  const total = (side + 2 * QUIET_ZONE) * 2;
  assert.deepEqual(fills[0], ["#ffffff", 0, 0, total, total], "the whole symbol starts light");
  assert.deepEqual(fills.slice(1), [
    ["#000000", 8, 8, 2, 2],
    ["#000000", 10, 10, 2, 2],
    ["#000000", 12, 12, 2, 2],
  ], "only dark modules are painted, offset by four modules");
});

test("the code is shown as text with a Copy button, and the QR is a labelled image", async () => {
  const qr = connect(element());
  await settle();
  const canvas = canvasOf(qr);
  assert.equal(canvas.getAttribute("role"), "img");
  assert.equal(canvas.getAttribute("aria-label"), "Scan to join the household");
  assert.equal(qr.byClass("kin-qr-frame").hidden, false, "the QR shows once drawn");
  assert.equal(qr.byClass("kin-qr-code").textContent, "ABCD-EFGH");
  assert.ok(qr.byText("Copy code"), "Copy sits next to the code");
  assert.equal(canvas.width % 29, 0, "the canvas is a whole number of modules wide");
  assert.equal(canvas.context.fills[0][0], "#ffffff");
});

test("Copy puts the code on the clipboard, and says so when it can't", async () => {
  const written = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text) => { written.push(text); } } } });
  const qr = connect(element());
  await settle();
  qr.byText("Copy code").click();
  await settle();
  assert.deepEqual(written, ["ABCD-EFGH"]);
  assert.equal(qr.byClass("kin-qr-status").textContent, "Code copied.");

  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new Error("denied"); } } } });
  qr.byText("Copy code").click();
  await settle();
  assert.equal(qr.byClass("kin-qr-status").textContent, "Copy is unavailable. Select the code and copy it.");
});

test("a QR that can't be drawn leaves the code as the way through", async () => {
  const qr = connect(element({ codec: fakeCodec({ fail: true }) }));
  await settle();
  assert.equal(qr.byClass("kin-qr-frame").hidden, true);
  assert.equal(qr.byClass("kin-qr-code").textContent, "ABCD-EFGH");
  assert.equal(qr.byClass("kin-qr-status").textContent, "The QR code couldn't be drawn. Use the code instead.");
});

test("an expired payload is replaced by refresh when one is given", async () => {
  const codec = fakeCodec();
  const qr = element({ codec });
  qr.refresh = async () => ({ value: "https://kin.test/pair#code=NEW", code: "NEW-CODE", expiresAt: Date.now() + 60_000 });
  connect(qr);
  qr.expiresAt = Date.now() - 1;
  await settle();
  await settle();
  await settle();
  assert.equal(qr.value, "https://kin.test/pair#code=NEW");
  assert.equal(qr.byClass("kin-qr-code").textContent, "NEW-CODE");
  assert.equal(codec.calls.at(-1), "https://kin.test/pair#code=NEW", "the new link is the one drawn");
  disconnect(qr);
});

test("without refresh, an expired payload says so and tells the page", async () => {
  const qr = element();
  const events = recordEvents(qr);
  connect(qr);
  qr.expiresAt = Date.now() - 1;
  await settle();
  await settle();
  assert.ok(events.some((event) => event.type === "kin-qr-expired"));
  assert.equal(qr.byClass("kin-qr-status").textContent, "This code expired. Ask for a new one.");
  assert.equal(qr.byClass("kin-qr-frame").hidden, true, "an expired QR is not shown");
  assert.equal(qr.byClass("kin-qr-code-row").hidden, true, "nor is its code offered for copying");
  disconnect(qr);
});

test("the expired message can be the page's own", async () => {
  const qr = element();
  qr.expiredMessage = "This invitation ended.";
  connect(qr);
  qr.expiresAt = Date.now() - 1;
  await settle();
  await settle();
  assert.equal(qr.byClass("kin-qr-status").textContent, "This invitation ended.");
  disconnect(qr);
});

test("a refresh that returns an already-expired payload ends there, without asking again", async () => {
  let calls = 0;
  const qr = element();
  qr.refresh = async () => { calls += 1; return { value: "https://kin.test/pair#code=STALE", code: "STALE", expiresAt: Date.now() - 1000 }; };
  connect(qr);
  qr.expiresAt = Date.now() - 1;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1, "one refresh, not a loop");
  assert.equal(qr.expired, true);
  assert.notEqual(qr.value, "https://kin.test/pair#code=STALE");
  disconnect(qr);
});

test("a refresh that expires within a second is not shown, so refreshes can't race", async () => {
  let calls = 0;
  const qr = element();
  qr.refresh = async () => { calls += 1; return { value: "https://kin.test/pair#code=BRIEF", code: "BRIEF", expiresAt: Date.now() + 2 }; };
  connect(qr);
  qr.expiresAt = Date.now() - 1;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, 1, "one refresh, not one every few milliseconds");
  assert.equal(qr.expired, true);
  disconnect(qr);
});

test("a refresh that fails shows the expired state", async () => {
  const qr = element();
  qr.refresh = async () => { throw new Error("offline"); };
  connect(qr);
  qr.expiresAt = Date.now() - 1;
  await settle();
  await settle();
  assert.equal(qr.expired, true);
  disconnect(qr);
});

test("the status region and Copy button survive a refresh, so announcements and focus do too", async () => {
  const qr = element();
  qr.refresh = async () => ({ value: "https://kin.test/pair#code=NEW", code: "NEW-CODE", expiresAt: Date.now() + 60_000 });
  connect(qr);
  await settle();
  const status = qr.byClass("kin-qr-status");
  const copy = qr.byText("Copy code");
  qr.expiresAt = Date.now() - 1;
  await settle();
  await settle();
  await settle();
  assert.equal(qr.byClass("kin-qr-code").textContent, "NEW-CODE");
  assert.equal(qr.byClass("kin-qr-status"), status, "the same live region");
  assert.equal(qr.byText("Copy code"), copy, "the same button");
  disconnect(qr);
});

test("a removed element stops waiting for expiry", async () => {
  let refreshed = false;
  const qr = element();
  qr.refresh = async () => { refreshed = true; return null; };
  connect(qr);
  qr.expiresAt = Date.now() + 5;
  disconnect(qr);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(refreshed, false);
});

test("without a code, only the QR and its status are shown", async () => {
  const qr = connect(element({ code: "" }));
  await settle();
  assert.equal(qr.byClass("kin-qr-code-row").hidden, true);
  assert.equal(qr.byClass("kin-qr-code-label").hidden, true);
});
