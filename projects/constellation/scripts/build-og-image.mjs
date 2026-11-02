// Builds assets/og-image.png, the 1200×630 preview that social sites and chat
// apps show for links to the Studio. Social sites don't render SVG, so the
// Studio's own example sky is drawn by the engine, framed with the headline,
// and captured as a PNG with a headless browser.
//
//   node scripts/build-og-image.mjs
//
// Rerun after changing the default look, the example sky or the headline.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createEngine, defaultOptions } from '../src/app/engine.mjs';
import { applyMotion } from '../src/app/motion.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'assets', 'og-image.png');

const engine = createEngine({ fetchImpl: fetch });
const { account, repositories, profile } = engine.sample();
const options = applyMotion(defaultOptions(account, repositories, profile), 'still');
// The preview carries its own credit line, so the map's footer text goes, and
// the page supplies the sky colour, so the map's framed backdrop goes too.
const sky = engine.render(account, repositories, options, { sample: true }).svg
  .replace(/<rect class="background"[^>]*\/>/, '')
  .replace(/<text class="generated-at"[^>]*>[^<]*<\/text>/, '')
  .replace(/<text class="credit"[^>]*>[^<]*<\/text>/, '')
  .replace(/<svg x="[^"]*" y="[^"]*"[^>]*aria-hidden="true"[\s\S]*?<\/svg>/, '');

const mark = '<svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path fill="#8f86ff" d="M12 1.5 14.6 9.4 22.5 12l-7.9 2.6L12 22.5l-2.6-7.9L1.5 12l7.9-2.6z"/></svg>';
const html = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; }
  body { width: 1200px; height: 630px; overflow: hidden; position: relative;
    background: radial-gradient(900px 520px at 78% 40%, #1b1f4d, transparent 70%), #080c24;
    font-family: Inter, "Segoe UI", system-ui, -apple-system, sans-serif; color: #eef1fb; }
  .sky { position: absolute; top: 15px; right: -30px; width: 860px; height: 600px;
    -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 34%); mask-image: linear-gradient(90deg, transparent 0%, #000 34%); }
  .sky svg { display: block; width: 100%; height: 100%; background: transparent !important; }
  .copy { position: absolute; left: 72px; top: 0; bottom: 0; width: 560px; display: flex; flex-direction: column; justify-content: center; gap: 26px; }
  .brand { display: flex; align-items: center; gap: 12px; font-size: 30px; font-weight: 700; letter-spacing: -.02em; }
  h1 { margin: 0; font-size: 76px; line-height: 1.02; font-weight: 750; letter-spacing: -.035em; }
  h1 em { font-style: normal; background: linear-gradient(100deg, #8f86ff, #c056d8 60%, #f08a4b); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p { margin: 0; font-size: 27px; line-height: 1.4; color: #b6bdd4; max-width: 30ch; }
  .url { font-size: 22px; color: #9aa3bf; }
</style>
<div class="sky">${sky}</div>
<div class="copy">
  <div class="brand">${mark}constellation</div>
  <h1>Your code, written in the <em>stars</em>.</h1>
  <p>Turn your GitHub projects into a sky full of stars.</p>
  <div class="url">mnichols08.github.io/constellation</div>
</div>`;

// The local system Chrome, as the Playwright tests use; set PLAYWRIGHT_CHANNEL= to use the bundled Chromium.
const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'chrome';
const browser = await chromium.launch(channel ? { channel } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await page.setContent(html, { waitUntil: 'load' });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, await page.screenshot({ type: 'png' }));
  console.log(`Wrote ${output}`);
} finally {
  await browser.close();
}
