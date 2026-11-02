// Renders Kin's Google Play feature graphic (#540, epic #527) from the same
// hand-coded geometry as the app and shortcut icons (scripts/render-icons.mjs),
// with Node's built-ins only, and writes it as a 24-bit PNG: Play refuses
// feature graphics with an alpha channel.
//
//   node scripts/render-play-graphics.mjs          writes play/feature-graphic.png
//   node scripts/render-play-graphics.mjs --check  fails if the committed PNG's
//                                                  pixels differ from this render
//
// The graphic is 1024 × 500 on Kin's page colour: the app icon (web/icon.svg's
// brown tile and cream K), the word "Kin" drawn from the same K and two simple
// letters, and five of the home-screen shortcut icons (Today, Shopping, This
// week, Chat, New journal entry) as the things Kin holds. No text other than
// the name, so it needs no translation and no font, and nothing important sits
// near the edges, where Play may crop or overlay it.
//
// Shapes are pure tests `inside(x, y)`; each pixel takes SAMPLES × SAMPLES
// samples, so edges are anti-aliased by coverage and the output is exactly
// reproducible (--check compares pixels, not deflated bytes).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN, GLYPHS, circle, decodePng, encodePng, intersect, polygon, roundRect, subtract, union } from "./render-icons.mjs";

export const FEATURE_WIDTH = 1024;
export const FEATURE_HEIGHT = 500;
const SAMPLES = 3;

// Kin's colours: the page background (--bg in web/styles/app.css), the app
// icon's brown and cream (web/icon.svg), and the header brown for the name.
const PAGE = [0xf3, 0xf1, 0xe9];
const BROWN = [0x8a, 0x5b, 0x4b];
const CREAM = [0xff, 0xf8, 0xf1];
const HEADER = [0x68, 0x40, 0x33];

/** `shape` drawn in a box: its 192-unit design space scaled to `size` px at (x, y). */
const placed = (shape, x, y, size) => (px, py) => shape(((px - x) * DESIGN) / size, ((py - y) * DESIGN) / size);
/** `shape` (any units) scaled by `factor` and moved by (dx, dy). */
const moved = (shape, factor, dx, dy) => (px, py) => shape((px - dx) / factor, (py - dy) / factor);

// web/icon.svg's tile and K, as render-icons.mjs draws them.
const TILE = roundRect(0, 0, DESIGN, DESIGN, 40);
const K = polygon([[54, 42], [54, 150], [74, 150], [74, 106], [114, 150], [142, 150], [91, 95], [139, 42], [113, 42], [74, 86], [74, 42]]);

// "Kin" in the K's own units: cap height 42–150, x-height from 74, strokes 20
// wide like the K's stem. The "i" is a stem and a dot; the "n" a stem, an arch
// (the top half of a ring) and a shorter right stem.
const below = (y) => (_px, py) => py >= y;
const above = (y) => (_px, py) => py <= y;
const WORD = union(
  K,
  roundRect(160, 74, 20, 76, 3),
  circle(170, 52, 12),
  roundRect(204, 74, 20, 76, 3),
  intersect(subtract(circle(242, 112, 38), circle(242, 112, 18)), above(112)),
  intersect(roundRect(260, 100, 20, 50, 3), below(112)),
);

/** The feature graphic's layers, bottom first, in pixels. */
export function featureLayers() {
  const layers = [{ shape: () => true, color: PAGE }];
  // The app icon, 180 px, centred vertically.
  const icon = { x: 92, y: 160, size: 180 };
  layers.push({ shape: placed(TILE, icon.x, icon.y, icon.size), color: BROWN });
  layers.push({ shape: placed(K, icon.x, icon.y, icon.size), color: CREAM });
  // The name: K's units ×1.25, cap height centred on the icon's middle (250).
  layers.push({ shape: moved(WORD, 1.25, 312 - 54 * 1.25, 250 - 96 * 1.25), color: HEADER });
  // Five shortcut icons, three over two, to the right.
  const tile = 92, gap = 18, left = 640, top = 250 - tile - gap / 2;
  const glyphs = ["today", "shopping", "week", "chat", "new-journal-entry"];
  glyphs.forEach((name, index) => {
    const row = index < 3 ? 0 : 1;
    const column = row === 0 ? index : index - 3 + 0.5;
    const x = left + column * (tile + gap), y = top + row * (tile + gap);
    layers.push({ shape: placed(TILE, x, y, tile), color: BROWN });
    layers.push({ shape: placed(GLYPHS[name], x, y, tile), color: CREAM });
  });
  return layers;
}

/** Paints opaque `layers` ({ shape, color }, bottom first, pixel units) into
 * a width × height RGB buffer. The first layer must cover everything. */
export function rasterizeRgb(width, height, layers) {
  const rgb = new Uint8Array(width * height * 3);
  const total = SAMPLES * SAMPLES;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (const { shape, color } of layers) {
        let hits = 0;
        for (let sy = 0; sy < SAMPLES; sy++) {
          const py = y + (sy + 0.5) / SAMPLES;
          for (let sx = 0; sx < SAMPLES; sx++) if (shape(x + (sx + 0.5) / SAMPLES, py)) hits++;
        }
        if (!hits) continue;
        const coverage = hits / total;
        r = color[0] * coverage + r * (1 - coverage);
        g = color[1] * coverage + g * (1 - coverage);
        b = color[2] * coverage + b * (1 - coverage);
      }
      const offset = (y * width + x) * 3;
      rgb[offset] = Math.round(r);
      rgb[offset + 1] = Math.round(g);
      rgb[offset + 2] = Math.round(b);
    }
  }
  return rgb;
}

export const renderFeatureGraphic = () => rasterizeRgb(FEATURE_WIDTH, FEATURE_HEIGHT, featureLayers());

export const playRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "play");
export const FEATURE_FILE = "feature-graphic.png";

function main(argv) {
  const rgb = renderFeatureGraphic();
  const path = join(playRoot, FEATURE_FILE);
  if (argv.includes("--check")) {
    let committed = null;
    try { committed = decodePng(readFileSync(path)); } catch { /* missing or unreadable: drift */ }
    if (!committed || committed.channels !== 3 || committed.width !== FEATURE_WIDTH || committed.height !== FEATURE_HEIGHT || !Buffer.from(committed.pixels).equals(Buffer.from(rgb))) {
      console.error(`play/${FEATURE_FILE} differs from scripts/render-play-graphics.mjs; run it and commit the result.`);
      process.exitCode = 1;
    } else console.log("The feature graphic matches scripts/render-play-graphics.mjs.");
    return;
  }
  mkdirSync(playRoot, { recursive: true });
  writeFileSync(path, encodePng(FEATURE_WIDTH, FEATURE_HEIGHT, rgb, { channels: 3 }));
  console.log(`wrote play/${FEATURE_FILE}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
