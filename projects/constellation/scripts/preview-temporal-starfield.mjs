import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScene, renderSceneSVG, renderSceneHTML } from '../src/core-api.mjs';
import { browser, openBrowser } from './browser-harness.mjs';

// Reproducible SVG/offline HTML fixtures; screenshots when Chromium is present.
await mkdir('.dist/temporal-starfield', { recursive: true });
const records = ['atlas', 'beacon', 'compiler', 'delta', 'engine', 'flux', 'gateway', 'harbor'].map((name, i) => ({ name, full_name: `universe/${name}`, language: ['Rust', 'TypeScript'][i % 2], stargazers_count: 100 - i * 10, created_at: '2018-01-01' }));
const fixtures = [
  ['space', { starfield: { mode: 'space' } }],
  ['milky-way', { starfield: { mode: 'milky-way' } }],
  ['classic', { starfield: { mode: 'classic' } }],
  ['off', { starfield: { mode: 'off' } }],
  ['light', { theme: 'light', starfield: { mode: 'space' } }],
  ['transparent', { exportProfile: 'transparent', starfield: { mode: 'milky-way' } }],
];
for (const [name, options] of fixtures) {
  const scene = createScene('universe', records, { referenceDate: '2026-09-01', arrangement: 'temporal-stack', temporalGeometry: { shape: 'sphere', surface: 'translucent' }, theme: 'midnight', animate: false, ...options });
  await writeFile(`.dist/temporal-starfield/${name}.svg`, renderSceneSVG(scene));
  await writeFile(`.dist/temporal-starfield/${name}.html`, renderSceneHTML(scene));
}
await writeFile('.dist/temporal-starfield/index.html', `<!doctype html><html lang="en"><meta charset="utf-8"><title>Temporal Universe starfield regression</title><style>body{margin:0;background:#080e20;color:#e6edff;font:18px system-ui}main{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}h2{margin:12px}img{width:100%;height:470px;object-fit:contain}a{color:inherit}</style><main>${fixtures.map(([name]) => `<section><h2><a href="${name}.html">${name}</a></h2><img src="${name}.svg" alt="Temporal sphere with ${name} sky"></section>`).join('')}</main></html>`);
test('capture Temporal Universe starfield gallery', { skip: !browser }, async t => {
  const { cdp, waitFor } = await openBrowser(t, pathToFileURL(resolve('.dist/temporal-starfield/index.html')).href);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1100, deviceScaleFactor: 1, mobile: false });
  await waitFor(`[...document.images].every(image => image.complete && image.naturalWidth > 0)`);
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('.dist/temporal-starfield/gallery.png', Buffer.from(screenshot.data, 'base64'));
});
