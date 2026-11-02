import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScene, renderSceneSVG, renderSceneHTML } from '../src/core-api.mjs';
import { browser, openBrowser } from './browser-harness.mjs';

test('preview temporal forms as static SVG and offline HTML', { skip: !browser }, async t => {
  await mkdir('.dist', { recursive: true });
  const names = ['atlas', 'beacon', 'compiler', 'delta', 'engine', 'flux', 'gateway', 'harbor', 'insight', 'journey', 'kernel', 'lumen'];
  const records = names.map((name, i) => ({ name, full_name: `universe/${name}`, language: ['Rust', 'TypeScript', 'Python'][i % 3], stargazers_count: 100 - i * 5, created_at: '2018-01-01' }));
  const shapes = ['cylinder', 'sphere', 'cone', 'dome', 'hourglass', 'helix'];
  for (const shape of shapes) {
    const scene = createScene('developer-universe', records, { referenceDate: '2026-09-01', arrangement: 'temporal-stack', temporalGeometry: { shape, twist: shape === 'helix' ? 240 : 0, surface: 'translucent' }, visualTheme: 'deep-space', identityRing: true, snapToRings: true, animate: false, temporalStack: { yearStart: 2018, innerArrangement: 'rings' }, selection: { start: 'universe/atlas' } });
    await writeFile(`.dist/temporal-${shape}.svg`, renderSceneSVG(scene));
    await writeFile(`.dist/temporal-${shape}.html`, renderSceneHTML(scene));
  }
  const gallery = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#080e20;color:#e6edff;font:20px system-ui}main{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}h2{margin:12px;text-transform:capitalize}img{width:100%;height:480px;object-fit:contain}</style></head><body><main>' + shapes.map(shape => `<section><h2>${shape}</h2><img src="temporal-${shape}.svg" alt="${shape} temporal form"></section>`).join('') + '</main></body></html>';
  await writeFile('.dist/temporal-forms.html', gallery);
  const { cdp, waitFor } = await openBrowser(t, pathToFileURL(resolve('.dist/temporal-forms.html')).href);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1120, deviceScaleFactor: 1, mobile: false });
  await waitFor(`[...document.images].every(image=>image.complete && image.naturalWidth>0)`);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('.dist/temporal-forms.png', Buffer.from(shot.data, 'base64'));
});
