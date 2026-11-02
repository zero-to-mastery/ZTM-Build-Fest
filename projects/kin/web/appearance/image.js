export const BACKGROUND_LIMITS = Object.freeze({ inputBytes: 12 * 1024 * 1024, pixels: 32_000_000, longestEdge: 2560, storedBytes: 3 * 1024 * 1024 });
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function backgroundFileProblem(file) {
  if (!file || file.size === 0) return "Choose a non-empty JPEG, PNG, or WebP image.";
  if (!TYPES.has(file.type)) return "Choose a JPEG, PNG, or WebP image. SVG, PDF, and remote images aren't supported.";
  if (file.size > BACKGROUND_LIMITS.inputBytes) return "Choose an image smaller than 12 MiB.";
  return null;
}

export function dominantColorFromPixels(data) {
  const buckets = new Map();
  for (let index = 0; index + 3 < data.length; index += 4) {
    const alpha = data[index + 3];
    if (!alpha) continue;
    const key = (data[index] >> 4) << 8 | (data[index + 1] >> 4) << 4 | (data[index + 2] >> 4);
    const entry = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    entry.count += 1; entry.r += data[index]; entry.g += data[index + 1]; entry.b += data[index + 2];
    buckets.set(key, entry);
  }
  const winner = [...buckets].sort(([leftKey, left], [rightKey, right]) => right.count - left.count || leftKey - rightKey)[0]?.[1];
  if (!winner) return null;
  return `#${[winner.r, winner.g, winner.b].map((sum) => Math.round(sum / winner.count).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export async function processBackground(file) {
  const problem = backgroundFileProblem(file);
  if (problem) throw new Error(problem);
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw new Error("Kin couldn't decode that image. Choose a valid JPEG, PNG, or WebP file."); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > BACKGROUND_LIMITS.pixels)
      throw new Error("Choose an image no larger than 32 megapixels.");
    const scale = Math.min(1, BACKGROUND_LIMITS.longestEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d", { alpha: true });
    context.drawImage(bitmap, 0, 0, width, height);
    let blob = await canvas.convertToBlob({ type: "image/webp", quality: .86 });
    let finalCanvas = canvas;
    if (blob.size > BACKGROUND_LIMITS.storedBytes) {
      // JPEG has no alpha channel. Flatten explicitly against Kin's light
      // canvas color so transparent pixels never acquire a browser-dependent color.
      finalCanvas = new OffscreenCanvas(width, height);
      const finalContext = finalCanvas.getContext("2d", { alpha: false });
      finalContext.fillStyle = "#F3F1E9";
      finalContext.fillRect(0, 0, width, height);
      finalContext.drawImage(canvas, 0, 0);
      blob = await finalCanvas.convertToBlob({ type: "image/jpeg", quality: .8 });
    }
    if (!blob.size || blob.size > BACKGROUND_LIMITS.storedBytes) throw new Error("Kin couldn't make this image small enough. Choose a simpler or smaller image.");
    const sample = new OffscreenCanvas(32, 32), sampleContext = sample.getContext("2d", { willReadFrequently: true });
    sampleContext.drawImage(finalCanvas, 0, 0, 32, 32);
    const seed = dominantColorFromPixels(sampleContext.getImageData(0, 0, 32, 32).data);
    if (!seed) throw new Error("That image has no visible color to use. Kin kept the current theme.");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type, width, height, seed };
  } finally { bitmap.close?.(); }
}
