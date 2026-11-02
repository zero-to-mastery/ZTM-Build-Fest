// Home-screen icons for a published install identity (#78), drawn in the
// browser so the Kin service never decodes an image or renders a font.
// Either source gives the same four PNGs:
//   icon192, icon512    — "any" icons, full-bleed squares;
//   maskable512         — for launchers that crop to a shape: the content sits
//                          inside the safe zone (a centred circle of 40%
//                          radius) on the household colour;
//   apple180            — opaque, for iPhone and iPad.
// The first-letter icon is the household name's first grapheme on the
// household palette's accent colour, in the system UI font.
import { BACKGROUND_LIMITS, backgroundFileProblem } from "./image.js";
import { contrastRatio, KIN_DEFAULT_SEED, paletteForSeed } from "./palette.js";

export const INSTALL_ICON_SIZES = Object.freeze({ icon192: 192, icon512: 512, maskable512: 512, apple180: 180 });
/** The service accepts icons of at most 512 KB (server/install-identity.mjs). */
export const MAX_INSTALL_ICON_BYTES = 512 * 1024;
/** The maskable safe zone is a centred circle of 40% radius. A letter's ink
 * fits within 80% of the width; a square image must fit inside the circle,
 * so its side is at most 0.8 / √2 ≈ 0.56 of the icon. */
export const MASKABLE_SAFE_ZONE = 0.8;
export const MASKABLE_IMAGE_ZONE = 0.56;

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';

/** The first user-perceived character of `name`, uppercased where the script
 * has case and the uppercase form is still one character ("ß" stays "ß"). */
export function firstGrapheme(name) {
  const text = String(name ?? "").trim();
  if (!text) return "K";
  let first;
  if (typeof Intl?.Segmenter === "function") {
    first = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)[Symbol.iterator]().next().value?.segment;
  }
  first ??= [...text][0];
  const upper = first.toLocaleUpperCase();
  const count = (value) => typeof Intl?.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length
    : [...value].length;
  return count(upper) === 1 ? upper : first;
}

/** Background and letter colours for the household seed: the light
 * palette's accent, with whichever of its ink or white/near-black reads best. */
export function letterColors(seed) {
  const background = paletteForSeed(seed ?? KIN_DEFAULT_SEED, "light").accent;
  const foreground = ["#FFFFFF", "#1B1A19"].sort((left, right) => contrastRatio(background, right) - contrastRatio(background, left))[0];
  return { background, foreground };
}

/** Width and height from a PNG's IHDR chunk, or null if it isn't a PNG. */
export function pngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!(bytes instanceof Uint8Array) || bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR" ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
}

function canvas(size) {
  const value = new OffscreenCanvas(size, size);
  return { value, context: value.getContext("2d", { alpha: true }) };
}

async function encode(target) {
  const blob = await target.convertToBlob({ type: "image/png" });
  if (!blob.size || blob.size > MAX_INSTALL_ICON_BYTES)
    throw new Error("Kin couldn't make a small enough icon from that image. Choose a simpler image.");
  return new Uint8Array(await blob.arrayBuffer());
}

async function render(draw, maskableZone = MASKABLE_SAFE_ZONE) {
  const icons = {};
  for (const [key, size] of Object.entries(INSTALL_ICON_SIZES)) {
    const { value, context } = canvas(size);
    draw(context, size, key === "maskable512" ? maskableZone : 1);
    icons[key] = await encode(value);
  }
  return icons;
}

/** The four icons showing the first grapheme of `name` on the seed colour. */
export function letterIcons({ name, seed }) {
  const letter = firstGrapheme(name);
  const { background, foreground } = letterColors(seed);
  return render((context, size, zone) => {
    context.fillStyle = background;
    context.fillRect(0, 0, size, size);
    context.fillStyle = foreground;
    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    context.font = `600 ${Math.round(size * 0.56 * zone)}px ${FONT}`;
    // Centre the glyph's own ink box, not the font's line box, so letters
    // with and without descenders all sit in the middle.
    const metrics = context.measureText(letter);
    const ascent = metrics.actualBoundingBoxAscent || size * 0.4 * zone;
    const descent = metrics.actualBoundingBoxDescent || 0;
    context.fillText(letter, size / 2, size / 2 + (ascent - descent) / 2);
  });
}

/** The four icons from an uploaded image, centre-cropped to a square. The
 * image is decoded and redrawn here, so no metadata survives. */
export async function uploadIcons(file, { seed }) {
  const problem = backgroundFileProblem(file);
  if (problem) throw new Error(problem);
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw new Error("Kin couldn't decode that image. Choose a valid JPEG, PNG, or WebP file."); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > BACKGROUND_LIMITS.pixels)
      throw new Error("Choose an image no larger than 32 megapixels.");
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2, sy = (bitmap.height - side) / 2;
    const { background } = letterColors(seed);
    return await render((context, size, zone) => {
      // Transparent areas take the household colour on every icon, so no
      // launcher or iOS shows its own colour behind them.
      context.fillStyle = background;
      context.fillRect(0, 0, size, size);
      const drawn = size * zone, inset = (size - drawn) / 2;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, sx, sy, side, side, inset, inset, drawn, drawn);
    }, MASKABLE_IMAGE_ZONE);
  } finally { bitmap.close?.(); }
}

/** Base64url, as the publish request carries each icon. */
export function bytesToBase64Url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
