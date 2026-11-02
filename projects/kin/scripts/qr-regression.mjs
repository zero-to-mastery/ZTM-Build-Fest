// Browser regression for the QR components (#96).
//
// writeQrCamera() runs in Node before the browser starts: it draws QR codes
// with the real engine into a .y4m file that Chromium plays as its camera
// (--use-file-for-fake-video-capture). The file shows a code for another
// origin for five seconds, then this Kin's pairing link for one, and loops.
//
// qrRegressions() runs in the page, so it must stay self-contained (it is
// serialised with toString). It checks that:
// - <kin-qr> draws pure black-and-white modules that the engine reads back;
// - <kin-qr-scanner> keeps the camera off until a tap, refuses the foreign
//   code, hands over the Kin link, and ends the camera track on a result;
// - Cancel, an in-app route change (the app's own navigation, which uses
//   history.pushState) and removal each end the real camera track.
import { readFile, writeFile } from "node:fs/promises";

// The foreign code shows for five seconds, so even a slow CI runner decodes it
// before the Kin link appears.
export const QR_CAMERA = Object.freeze({ width: 320, height: 240, fps: 10, rejectSeconds: 5, acceptSeconds: 1 });

/** Writes the fake camera file showing `reject`, then `accept`. */
export async function writeQrCamera(path, { reject, accept }, camera = QR_CAMERA) {
  const { createQrCodec } = await import("../web/wasm/kin-qr.js");
  const bytes = await readFile(new URL("../web/wasm/kin_engine.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const codec = createQrCodec(instance.exports);
  const { width, height, fps } = camera;
  // Full-range luma (C420jpeg): white 255, black 0, centred, quiet zone kept.
  const lumaOf = (text) => {
    const { side, modules } = codec.encode(text);
    const scale = Math.floor(Math.min(width, height) / (side + 8));
    const left = Math.floor((width - side * scale) / 2);
    const top = Math.floor((height - side * scale) / 2);
    const plane = Buffer.alloc(width * height, 255);
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        if (!modules[y * side + x]) continue;
        for (let dy = 0; dy < scale; dy += 1) {
          const row = (top + y * scale + dy) * width + left + x * scale;
          plane.fill(0, row, row + scale);
        }
      }
    }
    return plane;
  };
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  const frame = (plane) => Buffer.concat([Buffer.from("FRAME\n"), plane, chroma]);
  const rejectFrame = frame(lumaOf(reject));
  const acceptFrame = frame(lumaOf(accept));
  codec.dispose();
  const frames = [
    ...Array(fps * camera.rejectSeconds).fill(rejectFrame),
    ...Array(fps * camera.acceptSeconds).fill(acceptFrame),
  ];
  await writeFile(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`), ...frames]));
}

/** Runs in the page. `expected.accept` is the Kin link the camera shows. */
export async function qrRegressions(expected) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (predicate, message, timeout = 10_000) => {
    const started = performance.now();
    while (!predicate()) {
      if (performance.now() - started > timeout) throw new Error(message());
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await import("/components/kin-qr.js");
  await import("/components/kin-qr-scanner.js");
  const { qrCodec, releaseQrCodec } = await import("/wasm/kin-qr.js");
  const host = document.createElement("div");
  document.body.append(host);
  try {
    // <kin-qr>: what is drawn is what the engine reads back.
    const qr = document.createElement("kin-qr");
    qr.value = expected.accept;
    qr.code = "QRRG-TEST";
    qr.label = "Scan to join the household";
    host.append(qr);
    await until(() => qr.querySelector(".kin-qr-frame")?.hidden === false, () => `the QR is drawn (${qr.textContent})`);
    const canvas = qr.querySelector("canvas");
    check(canvas.getAttribute("role") === "img" && canvas.getAttribute("aria-label") === "Scan to join the household", "the QR is a labelled image");
    check(getComputedStyle(canvas).imageRendering === "pixelated", `modules keep sharp edges (${getComputedStyle(canvas).imageRendering})`);
    check(qr.querySelector(".kin-qr-code").textContent === "QRRG-TEST", "the code is shown as text");
    check([...qr.querySelectorAll("button")].some((button) => button.textContent === "Copy code"), "Copy sits beside the code");
    const { width, height } = canvas;
    const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    let impure = 0;
    for (let index = 0; index < rgba.length; index += 4) if (rgba[index] !== 0 && rgba[index] !== 255) impure += 1;
    check(impure === 0, `every pixel is pure black or white (${impure} are not)`);
    const codec = await qrCodec();
    const read = codec.decodeFrame(width, height, (target) => {
      for (let pixel = 0, byte = 0; pixel < target.length; pixel += 1, byte += 4)
        target[pixel] = (rgba[byte] * 77 + rgba[byte + 1] * 150 + rgba[byte + 2] * 29) >> 8;
    });
    check(read === expected.accept, `the drawn QR reads back (got ${read})`);

    // <kin-qr-scanner> through the browser's camera.
    const streams = [];
    const scanner = document.createElement("kin-qr-scanner");
    scanner.media = {
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        streams.push(stream);
        return stream;
      }),
    };
    host.append(scanner);
    check(streams.length === 0 && scanner.state === "idle", "the camera stays off until a tap");
    const status = scanner.querySelector(".kin-qr-scanner-status");
    const statuses = [];
    const observer = new MutationObserver(() => statuses.push(status.textContent));
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    let found = null;
    scanner.addEventListener("kin-qr-scan", (event) => { found = event.detail.url; });
    scanner.querySelector("button.primary-action").click();
    await until(() => found !== null, () => `the scanner reads the Kin code from the camera (state ${scanner.state}; statuses: ${statuses.join(" | ")})`, 20_000);
    observer.disconnect();
    check(found === expected.accept, `the Kin link is handed over (got ${found})`);
    check(statuses.includes("This isn't a Kin code."), `the foreign code was refused first (statuses: ${statuses.join(" | ")})`);
    check(streams.length === 1 && streams[0].getTracks().every((track) => track.readyState === "ended"), "a result ends the camera track");
    check(scanner.querySelector("video").srcObject === null, "the preview is cleared");

    // Every other way out ends the real camera track too. A codec that never
    // finds a code keeps the scanner scanning until the exit under test.
    scanner.codec = { decodeFrame: () => null };
    const exits = [
      ["Cancel", () => [...scanner.querySelectorAll("button")].find((button) => button.textContent === "Cancel").click()],
      ["an in-app route change", () => {
        const app = document.querySelector("kin-app");
        app.ctx.navigation.navigate(app.route?.page === "today" ? "#routines" : "#today");
      }],
      ["removal", () => scanner.remove()],
    ];
    for (const [label, exit] of exits) {
      const before = streams.length;
      scanner.start();
      await until(() => streams.length > before && scanner.state === "scanning", () => `${label}: the camera restarts (state ${scanner.state})`);
      const stream = streams.at(-1);
      check(stream.getTracks().every((track) => track.readyState === "live"), `${label}: the camera is live`);
      exit();
      check(stream.getTracks().every((track) => track.readyState === "ended"), `${label} ends the camera track`);
      check(!scanner.active, `${label} leaves the scanner inactive`);
    }
  } finally {
    host.remove();
    await releaseQrCodec();
  }
  return "QR display and scanner regressions passed";
}
