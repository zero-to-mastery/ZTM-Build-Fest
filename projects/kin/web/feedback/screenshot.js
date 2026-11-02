// The optional screenshot on a problem report (#633, ADR 0021 §3): off by
// default, taken only when the person turns it on, shown to them, croppable,
// and sent only with the report they press Send on.
//
// How it is taken: Kin draws its own page. The visible part of the document
// is copied into an inert document (so no component code runs), form fields
// get their current values as attributes (password fields stay empty), open
// dialogs (the report itself among them) are left out, canvases and images
// become inline data, and the page's own style sheets are inlined. That copy
// is wrapped in an SVG <foreignObject>, loaded as an image from a blob: URL
// and drawn on a canvas, which is encoded as PNG. No extension, permission
// prompt or screen-capture API is involved, so it works on phones, and it
// can only ever show Kin's own page, never another tab or app.
//
// Chosen over the browser's screen-sharing API, which asks to share a screen
// (unavailable on phones, and able to capture other windows). The cost is
// fidelity: a CSS background image or a cross-origin image doesn't appear,
// sticky headers may sit where they would unscrolled, and a browser that
// refuses to read back such an image (one that "taints" the canvas) can't
// take one; the dialog then says so and the report goes without it.
//
// Size: at most 1 MiB. The PNG is scaled down step by step to fit, and as a
// last resort becomes a JPEG; the service checks the type from the bytes.
import { MAX_SCREENSHOT_BYTES, sniffImageType } from "./format.js";

const SVG = "http://www.w3.org/2000/svg";
const XHTML = "http://www.w3.org/1999/xhtml";
/** The narrowest a screenshot is scaled to before trying JPEG. */
export const MIN_SCREENSHOT_WIDTH = 320;
/** The smallest crop, in source pixels. */
export const MIN_CROP = 16;

export class ScreenshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScreenshotError";
    this.code = code;
  }
}

/** A crop rectangle made whole and kept inside `bounds`, at least MIN_CROP
 * on each side (or the whole image if it is smaller). */
export function clampCrop(rect, bounds) {
  const minWidth = Math.min(MIN_CROP, bounds.width);
  const minHeight = Math.min(MIN_CROP, bounds.height);
  const x = Math.max(0, Math.min(Math.round(rect.x ?? 0), bounds.width - minWidth));
  const y = Math.max(0, Math.min(Math.round(rect.y ?? 0), bounds.height - minHeight));
  const width = Math.max(minWidth, Math.min(Math.round(rect.width ?? bounds.width), bounds.width - x));
  const height = Math.max(minHeight, Math.min(Math.round(rect.height ?? bounds.height), bounds.height - y));
  return { x, y, width, height };
}

/** A crop from percentages trimmed off each side ({ left, top, right, bottom },
 * 0–90 each), as the crop sliders give them. */
export function cropFromTrim(trim, bounds) {
  const part = (value) => Math.max(0, Math.min(90, Number(value) || 0)) / 100;
  const left = part(trim.left) * bounds.width;
  const top = part(trim.top) * bounds.height;
  const right = part(trim.right) * bounds.width;
  const bottom = part(trim.bottom) * bounds.height;
  return clampCrop({ x: left, y: top, width: bounds.width - left - right, height: bounds.height - top - bottom }, bounds);
}

/**
 * Encodes `crop` of `source` (a canvas or image) as an image of at most
 * `maxBytes`: PNG, scaled down by a fifth at a time to MIN_SCREENSHOT_WIDTH,
 * then JPEG. `makeCanvas(width, height)` and `encode(canvas, type, quality)`
 * (a Blob) are the browser's; tests pass stand-ins. Resolves
 * { blob, type, width, height }.
 */
export async function encodeWithinLimit({ source, crop, maxBytes = MAX_SCREENSHOT_BYTES, makeCanvas = defaultCanvas, encode = defaultEncode }) {
  const draw = (scale) => {
    const width = Math.max(1, Math.round(crop.width * scale));
    const height = Math.max(1, Math.round(crop.height * scale));
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext("2d");
    context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
    return canvas;
  };
  let scale = 1;
  let canvas = draw(scale);
  for (;;) {
    const blob = await encode(canvas, "image/png");
    if (blob.size <= maxBytes) return { blob, type: "image/png", width: canvas.width, height: canvas.height };
    const next = scale * 0.8;
    if (crop.width * next < MIN_SCREENSHOT_WIDTH) break;
    scale = next;
    canvas = draw(scale);
  }
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await encode(canvas, "image/jpeg", quality);
    if (blob.size <= maxBytes) return { blob, type: "image/jpeg", width: canvas.width, height: canvas.height };
  }
  throw new ScreenshotError("too_large", "This screenshot is too detailed to send. Crop it to a smaller part of the screen.");
}

function defaultCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function defaultEncode(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new ScreenshotError("unsupported", "This browser couldn't make the screenshot."))), type, quality);
    } catch {
      // A canvas the browser won't read back ("tainted").
      reject(new ScreenshotError("unsupported", "This browser can't take a picture of Kin. Send the report without one."));
    }
  });
}

/** The image as the report carries it: { type, data } in base64, its type
 * checked from its bytes. */
export async function screenshotPayload(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > MAX_SCREENSHOT_BYTES) throw new ScreenshotError("too_large", "The screenshot is larger than 1 MB.");
  const type = sniffImageType(bytes);
  if (!type || type !== blob.type) throw new ScreenshotError("unsupported", "The screenshot isn't a PNG or JPEG image.");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { type, data: btoa(binary) };
}

/** The page's own style sheets as text (same-origin sheets only). */
function inlineStyles(doc) {
  const parts = [];
  for (const sheet of doc.styleSheets) {
    try { parts.push([...sheet.cssRules].map((rule) => rule.cssText).join("\n")); } catch { /* not readable: left out */ }
  }
  return parts.join("\n");
}

/** A data: URL for a canvas or a loaded image, or "" when unreadable. */
function dataUrl(node) {
  try {
    if (node instanceof HTMLCanvasElement) return node.toDataURL("image/png");
    if (!node.complete || !node.naturalWidth) return "";
    const canvas = defaultCanvas(node.naturalWidth, node.naturalHeight);
    canvas.getContext("2d").drawImage(node, 0, 0);
    return canvas.toDataURL("image/png");
  } catch { return ""; }
}

/** Copies what the person sees in form fields, canvases and images onto the
 * inert copy; password fields stay empty. */
function carryState(original, copy) {
  const selector = "input, textarea, select, canvas, img";
  const from = original.querySelectorAll(selector);
  const to = copy.querySelectorAll(selector);
  for (let index = 0; index < from.length && index < to.length; index++) {
    const source = from[index];
    const target = to[index];
    if (source instanceof HTMLInputElement) {
      if (source.type === "password" || source.type === "file" || source.type === "hidden") target.setAttribute("value", "");
      else if (source.type === "checkbox" || source.type === "radio") target.toggleAttribute("checked", source.checked);
      else target.setAttribute("value", source.value);
    } else if (source instanceof HTMLTextAreaElement) target.textContent = source.value;
    else if (source instanceof HTMLSelectElement) {
      [...target.options].forEach((option, position) => option.toggleAttribute("selected", position === source.selectedIndex));
    } else if (source instanceof HTMLCanvasElement) {
      const image = copy.ownerDocument.createElement("img");
      image.setAttribute("src", dataUrl(source));
      image.setAttribute("style", `width:${source.clientWidth}px;height:${source.clientHeight}px`);
      if (source.className) image.setAttribute("class", source.className);
      target.replaceWith(image);
    } else if (source instanceof HTMLImageElement) {
      const url = dataUrl(source);
      if (url) target.setAttribute("src", url);
      else target.removeAttribute("src");
      target.removeAttribute("srcset");
    }
  }
}

/**
 * Draws the visible part of the page on a canvas (device pixels, at most
 * twice CSS pixels). Leaves out open dialogs and anything marked
 * `data-kin-screenshot-exclude`.
 */
export async function captureViewport(win = globalThis) {
  const doc = win.document;
  const width = Math.max(1, Math.round(win.innerWidth));
  const height = Math.max(1, Math.round(win.innerHeight));
  const scale = Math.min(Math.max(win.devicePixelRatio || 1, 1), 2);
  // An inert document: custom elements there are never upgraded, so no
  // component constructor runs for the copy.
  const inert = doc.implementation.createHTMLDocument("");
  const body = inert.importNode(doc.body, true);
  carryState(doc.body, body);
  for (const node of body.querySelectorAll("dialog, script, template, [data-kin-screenshot-exclude]")) node.remove();
  const svg = inert.createElementNS(SVG, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  // :root rules (colors, text size, motion) match the SVG root as they match
  // <html> on the page.
  for (const { name, value } of doc.documentElement.attributes) if (!name.startsWith("xmlns")) svg.setAttribute(name, value);
  const object = inert.createElementNS(SVG, "foreignObject");
  object.setAttribute("x", "0");
  object.setAttribute("y", "0");
  object.setAttribute("width", String(width));
  object.setAttribute("height", String(height));
  const html = inert.createElementNS(XHTML, "html");
  for (const { name, value } of doc.documentElement.attributes) if (!name.startsWith("xmlns")) html.setAttribute(name, value);
  const style = inert.createElementNS(XHTML, "style");
  style.textContent = inlineStyles(doc);
  // The copy is scrolled to where the page is.
  body.setAttribute("style", `${body.getAttribute("style") ?? ""};margin-top:${-Math.round(win.scrollY)}px;margin-left:${-Math.round(win.scrollX)}px;width:${doc.documentElement.clientWidth}px`);
  html.append(style, body);
  object.append(html);
  svg.append(object);
  const markup = new XMLSerializer().serializeToString(svg);
  // First as a blob: URL; a browser that won't draw that one cleanly is
  // given the same markup as a data: URL, which some treat as same-origin.
  let failure = null;
  const attempts = [];
  for (const source of ["blob", "data"]) {
    const url = source === "blob"
      ? URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }))
      : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    try {
      return await drawSvg(url, Math.round(width * scale), Math.round(height * scale));
    } catch (error) {
      failure = error;
      attempts.push(`${source}:${error.code ?? "other"}`);
    } finally {
      if (source === "blob") URL.revokeObjectURL(url);
    }
  }
  failure.attempts = attempts;
  throw failure;
}

/** Loads an SVG image and draws it on a new canvas the page can read. */
async function drawSvg(url, width, height) {
  const unsupported = (code) => new ScreenshotError(code, "This browser can't take a picture of Kin. Send the report without one.");
  const image = new Image();
  image.src = url;
  try { await image.decode(); } catch { throw unsupported("decode_failed"); }
  const canvas = defaultCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  // Reading one pixel back finds a canvas the browser won't let Kin read.
  try { canvas.getContext("2d").getImageData(0, 0, 1, 1); } catch { throw unsupported("tainted"); }
  return canvas;
}
