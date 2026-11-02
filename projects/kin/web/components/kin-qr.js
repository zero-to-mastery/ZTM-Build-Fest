// <kin-qr>: a QR code and its text code, side by side (#96).
//
// The QR is an enhancement. The text code is always shown as selectable text
// with a Copy button, so anyone who can't scan, or whose camera can't see the
// screen, still has the whole path. The engine draws the module grid
// (wasm/kin-qr.js); this element only paints it.
//
// Properties:
//   value           the text to encode (a Kin link)
//   code            the text code shown beside it
//   label           the QR image's accessible name
//   size            the largest side to draw, in CSS pixels (default 240)
//   expiresAt       when the payload stops working (epoch ms), or null
//   expiredMessage  what to say once it has (default "This code expired.
//                   Ask for a new one.")
//   refresh         optional async () => ({ value, code, expiresAt }) | null,
//                   called when the payload expires; without it, when it
//                   fails, returns null, or returns a payload that has
//                   already expired, the element shows the expired state
//                   and dispatches "kin-qr-expired"
//   codec           the QR codec (tests); defaults to the page's shared codec
//
// The element is built once and updated in place, so its status region keeps
// announcing changes and focus on Copy survives a refresh.
import { qrCodec } from "../wasm/kin-qr.js";

/** Light modules around the symbol, as the standard requires. */
export const QUIET_ZONE = 4;
const DEFAULT_SIZE = 240;
const DEFAULT_EXPIRED = "This code expired. Ask for a new one.";
// setTimeout's longest delay; longer expiries are re-armed in steps.
const MAX_TIMER = 2_147_483_647;
/** A refreshed payload must stay valid at least this long to be shown, so a
 * clock that runs ahead can't drive refreshes faster than once a second. */
export const MIN_REFRESH_LIFETIME_MS = 1_000;

/** Whole pixels per module so every module edge lands on a pixel boundary.
 * Never below one pixel per module. */
export function qrLayout(side, maxPixels) {
  const total = side + 2 * QUIET_ZONE;
  const scale = Math.max(1, Math.floor(maxPixels / total));
  return { scale, pixels: total * scale };
}

/** The canvas for `side` modules at most `maxCss` CSS pixels wide on a screen
 * with `ratio` device pixels per CSS pixel: whole device pixels per module,
 * and the CSS size that shows the canvas at exactly one device pixel per
 * canvas pixel, even at fractional ratios such as 1.25 or 2.75. */
export function qrCanvasSize(side, maxCss, ratio = 1) {
  const density = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const { scale, pixels } = qrLayout(side, maxCss * density);
  return { scale, pixels, css: pixels / density };
}

/** Paints a module grid at `scale` pixels per module, quiet zone included.
 * Always black on white: scanners expect dark modules on a light ground,
 * whatever the page's colour scheme. */
export function paintModules(context, side, modules, scale) {
  const pixels = (side + 2 * QUIET_ZONE) * scale;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, pixels, pixels);
  context.fillStyle = "#000000";
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      if (modules[y * side + x] === 1) {
        context.fillRect((x + QUIET_ZONE) * scale, (y + QUIET_ZONE) * scale, scale, scale);
      }
    }
  }
}

export class KinQr extends HTMLElement {
  constructor() {
    super();
    this._value = "";
    this._code = "";
    this._label = "QR code";
    this._size = DEFAULT_SIZE;
    this._expiresAt = null;
    this.expiredMessage = DEFAULT_EXPIRED;
    this.refresh = null;
    this.codec = null;
    this.expired = false;
    this.generation = 0;
    this.timer = null;
    this.parts = null;
  }

  connectedCallback() {
    this.render();
  }

  disconnectedCallback() {
    this.disarm();
    this.generation += 1;
  }

  set value(text) { this._value = String(text ?? ""); this.expired = false; this.render(); }
  get value() { return this._value; }
  set code(text) { this._code = String(text ?? ""); this.render(); }
  get code() { return this._code; }
  set label(text) { this._label = String(text || "QR code"); this.render(); }
  get label() { return this._label; }
  set size(pixels) { this._size = Number(pixels) > 0 ? Number(pixels) : DEFAULT_SIZE; this.render(); }
  get size() { return this._size; }
  set expiresAt(time) { this._expiresAt = Number.isFinite(time) ? time : null; this.expired = false; this.render(); }
  get expiresAt() { return this._expiresAt; }

  /** Builds the element's structure once. */
  build() {
    const figure = document.createElement("figure");
    figure.className = "kin-qr";
    const frame = document.createElement("div");
    frame.className = "kin-qr-frame";
    frame.hidden = true;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    frame.append(canvas);
    const caption = document.createElement("figcaption");
    const heading = document.createElement("p");
    heading.className = "kin-qr-code-label";
    heading.textContent = "Or enter this code";
    const row = document.createElement("div");
    row.className = "kin-qr-code-row";
    const code = document.createElement("code");
    code.className = "kin-qr-code";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "kin-qr-copy";
    copy.textContent = "Copy code";
    copy.addEventListener("click", () => this.copyCode());
    row.append(code, copy);
    const status = document.createElement("p");
    status.className = "kin-qr-status";
    status.setAttribute("role", "status");
    caption.append(heading, row, status);
    figure.append(frame, caption);
    this.replaceChildren(figure);
    this.parts = { frame, canvas, heading, row, code, status };
  }

  render() {
    if (!this.isConnected) return;
    if (!this.parts) this.build();
    const generation = ++this.generation;
    const { frame, canvas, heading, row, code, status } = this.parts;
    canvas.setAttribute("aria-label", this._label);
    canvas.textContent = this._label;
    code.textContent = this._code;
    // An expired code is not offered for copying either.
    heading.hidden = row.hidden = !this._code || this.expired;
    this.arm();
    if (this.expired) {
      frame.hidden = true;
      status.textContent = this.expiredMessage;
      return;
    }
    status.textContent = "";
    if (!this._value) {
      frame.hidden = true;
      return;
    }
    this.draw(generation);
  }

  async draw(generation) {
    const { frame, canvas, status } = this.parts;
    try {
      const codec = this.codec ?? (await qrCodec());
      if (generation !== this.generation) return;
      const { side, modules } = codec.encode(this._value);
      const { scale, pixels, css } = qrCanvasSize(side, this._size, globalThis.devicePixelRatio);
      canvas.width = pixels;
      canvas.height = pixels;
      canvas.style.width = `${css}px`;
      canvas.style.height = `${css}px`;
      paintModules(canvas.getContext("2d"), side, modules, scale);
      frame.hidden = false;
    } catch {
      if (generation !== this.generation) return;
      frame.hidden = true;
      status.textContent = this._code
        ? "The QR code couldn't be drawn. Use the code instead."
        : "The QR code couldn't be drawn.";
    }
  }

  async copyCode() {
    const { status } = this.parts;
    try {
      await navigator.clipboard.writeText(this._code);
      status.textContent = "Code copied.";
    } catch {
      status.textContent = "Copy is unavailable. Select the code and copy it.";
    }
  }

  arm() {
    this.disarm();
    if (this._expiresAt === null || this.expired) return;
    const wait = this._expiresAt - Date.now();
    if (wait <= 0) {
      this.timer = setTimeout(() => this.expire(), 0);
      return;
    }
    this.timer = setTimeout(() => (wait > MAX_TIMER ? this.arm() : this.expire()), Math.min(wait, MAX_TIMER));
  }

  disarm() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  async expire() {
    this.timer = null;
    const generation = this.generation;
    let next = null;
    try {
      next = typeof this.refresh === "function" ? await this.refresh() : null;
    } catch {
      next = null;
    }
    if (generation !== this.generation || !this.isConnected) return;
    // A replacement that has already expired, or is about to (say, a clock
    // running ahead of the service), ends here rather than asking again.
    const usable = next?.value &&
      !(Number.isFinite(next.expiresAt) && next.expiresAt <= Date.now() + MIN_REFRESH_LIFETIME_MS);
    if (usable) {
      this._value = String(next.value);
      this._code = String(next.code ?? "");
      this._expiresAt = Number.isFinite(next.expiresAt) ? next.expiresAt : null;
      this.expired = false;
    } else {
      this.expired = true;
      this.dispatchEvent(new CustomEvent("kin-qr-expired", { bubbles: true }));
    }
    this.render();
  }
}

customElements.define("kin-qr", KinQr);
