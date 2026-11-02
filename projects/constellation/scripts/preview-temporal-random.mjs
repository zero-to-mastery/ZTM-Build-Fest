import test from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomizeDesign } from '../src/design-randomizer.mjs';
import { createScene, renderSceneSVG, renderSceneHTML } from '../src/core-api.mjs';
import { browser, openBrowser } from './browser-harness.mjs';

const directory = '.dist/temporal-random';
await mkdir(directory, { recursive: true });
const fixtures = JSON.parse(await readFile(new URL('../test/fixtures/randomizer-v6.json', import.meta.url)));
const names = ['atlas', 'beacon', 'compiler', 'delta', 'engine', 'flux', 'gateway', 'harbor', 'insight', 'journey', 'kernel', 'lumen', 'meteor', 'nova', 'orbit', 'pulse'];
const records = names.map((name, i) => ({ name, full_name: `universe/${name}`, language: ['Rust', 'TypeScript'][i % 2], created_at: `${2015 + i % 8}-01-01`, updated_at: '2026-08-20', topics: ['visualization', 'developer-tools'], stargazers_count: 100 - i }));
for (const fixture of fixtures) {
  const recipe = randomizeDesign(fixture.code, { repositories: records });
  const scene = createScene('universe', records, recipe);
  await writeFile(`${directory}/${fixture.shape}.svg`, renderSceneSVG(scene));
  await writeFile(`${directory}/${fixture.shape}.html`, renderSceneHTML(scene, { title: `${fixture.shape} · ${fixture.code}` }));
  await writeFile(`${directory}/${fixture.shape}.json`, JSON.stringify({ account: 'universe', code: fixture.code, options: recipe, records }, null, 2));
}
await writeFile(`${directory}/index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Seeded Temporal Universe designs</title><style>body{margin:0;background:#080e20;color:#e6edff;font:16px system-ui}main{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}h2,p{margin:12px}a{color:inherit}img{width:100%;height:460px;object-fit:contain}code{font-size:11px}</style><main>${fixtures.map(f => `<section><h2><a href="${f.shape}.html">${f.shape} · ${f.starfield}</a></h2><p>${f.shape === 'hourglass' ? 'Reduced-motion preview' : f.code.includes('m000') ? 'Still recipe' : 'Motion permitted'}<br><code>${f.code}</code></p><img src="${f.shape}.svg" alt="Seeded ${f.shape} design"></section>`).join('')}</main></html>`);
test('capture the six seeded v6 examples', { skip: !browser }, async t => {
  const { cdp, waitFor } = await openBrowser(t, pathToFileURL(resolve(`${directory}/index.html`)).href);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1220, deviceScaleFactor: 1, mobile: false });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await waitFor(`[...document.images].every(image => image.complete && image.naturalWidth > 0)`);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(`${directory}/gallery.png`, Buffer.from(shot.data, 'base64'));
});
