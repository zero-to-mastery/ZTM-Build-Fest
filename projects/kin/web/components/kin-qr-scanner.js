// <kin-qr-scanner>: reads a Kin code with the camera (#96).
//
// The camera starts only when the person taps "Scan a code", and stops on a
// result, Cancel, the page being hidden, an in-app route change (Kin's
// ROUTE_CHANGE_EVENT; views are hidden, not removed), browser navigation,
// leaving the page, the camera ending, or the element being removed (which
// is what locking Kin does). When it stops, the codec overwrites the last
// frame and payload it held. Frames are
// downscaled to 640 pixels wide, turned to grayscale straight into the
// engine's frame buffer, and decoded by the engine (wasm/kin-qr.js). No frame
// is stored or sent anywhere.
//
// Only links for this Kin's own origin and a known path, with no query (Kin's
// secrets travel in the fragment), are accepted; anything else says "This
// isn't a Kin code." and scanning continues. "Type the code instead" is always
// offered.
//
// Events (bubbling):
//   kin-qr-scan    detail { url }: a Kin link was read; the camera is off
//   kin-qr-manual  the person chose to type the code instead
//   kin-qr-cancel  the person cancelled scanning
//
// For tests, `codec` (used instead of the page's shared codec), `media`
// (navigator.mediaDevices) and `environment` ({ isSecureContext }) can be
// replaced before use.
import { ROUTE_CHANGE_EVENT } from "../routes.js";
import { MAX_FRAME_HEIGHT, MAX_FRAME_PIXELS, MAX_FRAME_WIDTH, qrCodec } from "../wasm/kin-qr.js";

/** Kin paths a code may lead to: pairing a device and signing in. */
export const KIN_PATHS = Object.freeze(["/pair", "/link"]);
/** Frames are scaled down to at most this width before decoding. */
export const SCAN_WIDTH = 640;
/** Minimum time between decodes: about ten a second. */
export const SCAN_INTERVAL_MS = 100;

const MESSAGES = {
  idle: ["", "Point your camera at the code on the other device. The camera turns on only when you tap Scan a code, and nothing it sees leaves this device."],
  starting: ["Starting the camera…", ""],
  scanning: ["Looking for a code…", "Hold the code steady inside the frame."],
  found: ["Code found.", ""],
  stopped: ["Scanning stopped.", "Tap Scan a code to start again."],
  insecure: ["The camera can't be used here.", "The camera needs a secure connection (https). Type the code instead."],
  "no-camera": ["No camera is available.", "This device has no camera Kin can use. Type the code instead."],
  denied: ["Camera access is blocked.", "Allow the camera for this site in your browser's settings, then try again. Or type the code instead."],
  error: ["The camera couldn't start.", "Try again, or type the code instead."],
  lost: ["The camera stopped.", "It was turned off or disconnected. Try again, or type the code instead."],
  reader: ["The code reader couldn't start.", "Try again, or type the code instead."],
};
const PAGE_EVENTS = ["hashchange", "popstate", "pagehide", ROUTE_CHANGE_EVENT];
const NOT_KIN = "This isn't a Kin code.";

/** The Kin link in a decoded payload, or null when it isn't one: an absolute
 * http(s) URL on `origin` whose path is one of `paths`, with no credentials
 * and no query. Kin puts secrets in the fragment, which browsers never send
 * to a server; a query would be. */
export function kinLink(text, origin, paths = KIN_PATHS) {
  if (typeof text !== "string" || text.length === 0) return null;
  if (typeof origin !== "string" || origin === "null") return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.origin !== origin || !paths.includes(url.pathname)) return null;
  if (url.username || url.password || url.search) return null;
  // An empty query ("/pair?#…") leaves url.search empty; refuse it too.
  if (text.split("#")[0].includes("?")) return null;
  return url.href;
}

/** Whether a camera can be asked for at all. */
export function cameraSupport({ isSecureContext, media }) {
  if (!isSecureContext) return "insecure";
  if (typeof media?.getUserMedia !== "function") return "no-camera";
  return "available";
}

/** The state a getUserMedia failure leaves the scanner in. A camera that is
 * busy in another app (NotReadableError) is worth trying again, so it is an
 * error rather than "no camera". */
export function cameraErrorState(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no-camera";
    default:
      return "error";
  }
}

/** The decode size for a `videoWidth` × `videoHeight` frame: at most
 * SCAN_WIDTH wide, aspect kept, and within the decoder's frame limits. */
export function frameSize(videoWidth, videoHeight, maxWidth = SCAN_WIDTH) {
  if (!(videoWidth > 0 && videoHeight > 0)) return null;
  let scale = Math.min(1, maxWidth / videoWidth);
  scale = Math.min(
    scale,
    MAX_FRAME_WIDTH / videoWidth,
    MAX_FRAME_HEIGHT / videoHeight,
    Math.sqrt(MAX_FRAME_PIXELS / (videoWidth * videoHeight)),
  );
  const width = Math.max(1, Math.floor(videoWidth * scale));
  const height = Math.max(1, Math.floor(videoHeight * scale));
  return { width, height };
}

/** RGBA pixels to 8-bit luma (BT.601 weights, in integers). */
export function rgbaToLuma(rgba, target) {
  for (let pixel = 0, byte = 0; pixel < target.length; pixel += 1, byte += 4) {
    target[pixel] = (rgba[byte] * 77 + rgba[byte + 1] * 150 + rgba[byte + 2] * 29) >> 8;
  }
}

export class KinQrScanner extends HTMLElement {
  constructor() {
    super();
    this.state = "idle";
    this.notice = "";
    this.codec = null;
    this.reader = null;
    this.media = globalThis.navigator?.mediaDevices ?? null;
    this.environment = globalThis;
    this.stream = null;
    this.frame = null;
    this.canvas = null;
    this.lastDecode = -Infinity;
    this.generation = 0;
    this.parts = null;
    this.onPageChange = () => {
      if (this.active) this.stop("stopped");
    };
    this.onVisibility = () => {
      if (globalThis.document?.visibilityState === "hidden") this.onPageChange();
    };
  }

  get active() {
    return this.state === "starting" || this.state === "scanning";
  }

  connectedCallback() {
    globalThis.document?.addEventListener("visibilitychange", this.onVisibility);
    for (const type of PAGE_EVENTS) globalThis.addEventListener?.(type, this.onPageChange);
    this.build();
    this.update();
  }

  disconnectedCallback() {
    globalThis.document?.removeEventListener("visibilitychange", this.onVisibility);
    for (const type of PAGE_EVENTS) globalThis.removeEventListener?.(type, this.onPageChange);
    this.stop("idle");
  }

  build() {
    const section = document.createElement("section");
    section.className = "kin-qr-scanner";
    section.setAttribute("aria-label", "Scan a Kin code");
    const view = document.createElement("div");
    view.className = "kin-qr-scanner-view";
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-hidden", "true");
    const guide = document.createElement("div");
    guide.className = "kin-qr-scanner-guide";
    guide.setAttribute("aria-hidden", "true");
    view.append(video, guide);
    const status = document.createElement("p");
    status.className = "kin-qr-scanner-status";
    status.setAttribute("role", "status");
    const help = document.createElement("p");
    help.className = "kin-qr-scanner-help";
    const actions = document.createElement("div");
    actions.className = "kin-qr-scanner-actions";
    const start = this.button("Scan a code", "primary-action", () => this.start());
    const cancel = this.button("Cancel", "", () => {
      this.stop("idle");
      this.dispatchEvent(new CustomEvent("kin-qr-cancel", { bubbles: true }));
    });
    const manual = this.button("Type the code instead", "kin-qr-scanner-manual", () => {
      this.stop("idle");
      this.dispatchEvent(new CustomEvent("kin-qr-manual", { bubbles: true }));
    });
    actions.append(start, cancel, manual);
    section.append(view, status, help, actions);
    this.replaceChildren(section);
    this.parts = { view, video, status, help, start, cancel, manual };
  }

  button(text, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    if (className) button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  update() {
    if (!this.parts) return;
    const [status, help] = MESSAGES[this.state] ?? MESSAGES.error;
    const { view, status: statusNode, help: helpNode, start, cancel } = this.parts;
    statusNode.textContent = this.notice || status;
    helpNode.textContent = help;
    helpNode.hidden = !help;
    view.hidden = !this.active;
    view.dataset.state = this.state;
    cancel.hidden = !this.active;
    start.hidden = this.active || this.state === "found" || this.state === "insecure" || this.state === "no-camera";
    start.textContent = this.state === "idle" ? "Scan a code" : "Try again";
  }

  setState(state, notice = "") {
    this.state = state;
    this.notice = notice;
    this.update();
  }

  async start() {
    if (this.active) return;
    const support = cameraSupport({ isSecureContext: this.environment.isSecureContext, media: this.media });
    if (support !== "available") {
      this.setState(support);
      return;
    }
    const generation = ++this.generation;
    this.setState("starting");
    // The codec loads alongside the camera prompt. The shared codec is asked
    // for on every start: one released by a lock is replaced, never reused.
    const codecReady = this.codec ? Promise.resolve(this.codec) : qrCodec();
    // If the camera fails first, the codec's own failure is not reported.
    codecReady.catch(() => {});
    let stream;
    try {
      stream = await this.media.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch (error) {
      if (generation === this.generation) this.stop(cameraErrorState(error));
      return;
    }
    if (generation !== this.generation) {
      stopTracks(stream);
      return;
    }
    this.stream = stream;
    for (const track of stream.getTracks?.() ?? []) {
      track.addEventListener?.("ended", () => {
        if (generation === this.generation) this.stop("lost");
      });
    }
    try {
      this.reader = await codecReady;
      if (this.reader?.disposed) throw new Error("The QR reader was closed.");
    } catch {
      if (generation === this.generation) this.stop("reader");
      return;
    }
    if (generation !== this.generation) return;
    try {
      const { video } = this.parts;
      video.srcObject = stream;
      await video.play?.();
    } catch {
      if (generation === this.generation) this.stop("error");
      return;
    }
    if (generation !== this.generation) return;
    this.lastDecode = -Infinity;
    this.setState("scanning");
    this.schedule(generation);
  }

  schedule(generation) {
    const video = this.parts?.video;
    if (!video || generation !== this.generation) return;
    const tick = (now) => this.tick(generation, typeof now === "number" ? now : performance.now());
    if (typeof video.requestVideoFrameCallback === "function") {
      const handle = video.requestVideoFrameCallback(tick);
      this.frame = () => video.cancelVideoFrameCallback?.(handle);
    } else {
      const handle = requestAnimationFrame(tick);
      this.frame = () => cancelAnimationFrame(handle);
    }
  }

  tick(generation, now) {
    if (generation !== this.generation || this.state !== "scanning") return;
    if (now - this.lastDecode >= SCAN_INTERVAL_MS) {
      this.lastDecode = now;
      let text = null;
      try {
        text = this.readFrame();
      } catch {
        // The reader was closed (Kin locked) or failed; the camera goes off.
        this.stop("reader");
        return;
      }
      if (text !== null) {
        const url = kinLink(text, globalThis.location?.origin);
        if (url) {
          this.stop("found");
          this.dispatchEvent(new CustomEvent("kin-qr-scan", { bubbles: true, detail: { url } }));
          return;
        }
        if (this.notice !== NOT_KIN) this.setState("scanning", NOT_KIN);
      }
    }
    this.schedule(generation);
  }

  /** Decodes the current video frame; the payload text, or null. */
  readFrame() {
    const video = this.parts.video;
    const size = frameSize(video.videoWidth, video.videoHeight);
    if (!size) return null;
    const { width, height } = size;
    if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas = typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement("canvas"), { width, height });
    }
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    return this.reader.decodeFrame(width, height, (target) => rgbaToLuma(data, target));
  }

  /** Turns the camera off and forgets every frame. */
  stop(state) {
    this.generation += 1;
    this.frame?.();
    this.frame = null;
    stopTracks(this.stream);
    this.stream = null;
    if (this.parts?.video) this.parts.video.srcObject = null;
    try {
      this.reader?.forget?.();
    } catch {
      // A closed reader holds nothing to forget.
    }
    this.reader = null;
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas = null;
    }
    this.setState(state);
  }
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}

customElements.define("kin-qr-scanner", KinQrScanner);
