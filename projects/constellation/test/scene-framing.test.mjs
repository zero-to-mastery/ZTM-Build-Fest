import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScene } from '../src/constellation.mjs';
import { buildSemanticHierarchy, projectSemanticLevel } from '../src/semantic-groups.mjs';
import { contentBounds, fitSceneViewport } from '../src/scene-framing.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';

const records = count => Array.from({ length: count }, (_, i) => ({ full_name: `studio/project-${String(i).padStart(3, '0')}`, name: `project-${i}`, language: ['Rust', 'TypeScript', 'Go'][i % 3], topics: ['tooling'] }));

test('fitted project scenes keep content centered and use the viewBox without stretching', () => {
  for (const count of [8, 15, 50, 100]) {
    const scene = createScene('studio', records(count));
    const bounds = contentBounds(scene);
    const [x, y, width, height] = scene.viewport.viewBox;
    const xFill = bounds.width / width, yFill = bounds.height / height;
    assert.ok(xFill > 0.55, `${count} projects occupy ${Math.round(xFill * 100)}% width`);
    assert.ok(yFill > 0.4, `${count} projects occupy ${Math.round(yFill * 100)}% height`);
    assert.ok(Math.abs((bounds.centerX - x) / width - 0.5) < 0.01);
    assert.ok(Math.abs((bounds.centerY - y) / height - 0.5) < 0.01);
    assert.ok(Math.abs(width / height - scene.viewport.width / scene.viewport.height) < 1e-9);
    const svg = renderSceneSVG(scene);
    assert.ok(svg.includes(`viewBox="${scene.viewport.viewBox.join(' ')}"`));
    assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
  }
});

test('grouped overview frames its visible groups and ignores hidden outliers', () => {
  const list = records(45);
  const families = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`family-${i}`, { label: `Family ${i}`, members: list.slice(i * 5, i * 5 + 5).map(repo => repo.full_name) }]));
  const base = createScene('studio', list, { projectFamilies: families });
  const hierarchy = buildSemanticHierarchy(base);
  const grouped = projectSemanticLevel(base, 'groups', { hierarchy });
  const bounds = contentBounds(grouped);
  assert.ok(bounds.width / grouped.viewport.viewBox[2] > 0.55);
  const hiddenOutlier = structuredClone(grouped);
  hiddenOutlier.nodes.push({ ...structuredClone(grouped.nodes[0]), id: 'hidden-outlier', geometry: { ...grouped.nodes[0].geometry, x: 100000, y: -100000 }, interaction: { hidden: true } });
  assert.deepEqual(fitSceneViewport(hiddenOutlier).viewport.viewBox, grouped.viewport.viewBox);
  assert.deepEqual(contentBounds(grouped).nodeCount, grouped.nodes.filter(node => node.interaction?.hidden !== true && node.style?.opacity !== 0).length);
});

test('frame furniture follows a non-zero fitted viewBox while world nodes retain Scene coordinates', () => {
  const scene = createScene('studio', records(4), { legend: true, generatedAt: '2026-09-26T18:05:07Z', semanticLegend: true, ringMeaning: 'identity' });
  const originalNodeX = scene.nodes[0].geometry.x;
  scene.viewport.viewBox = [100, 50, 700, 400];
  const [x, y, width, height] = scene.viewport.viewBox;
  const right = x + width, bottom = y + height;
  assert.ok(x > 32 && y > 0 && right < 868);
  const svg = renderSceneSVG(scene, { animate: false });
  const attrs = (selector) => {
    const tag = svg.match(new RegExp(`<[^>]*class="${selector}"[^>]*>`))?.[0];
    assert.ok(tag, `${selector} is rendered`);
    return Object.fromEntries([...tag.matchAll(/(x|y|width|height|cx|cy|rx|ry)="([\d.-]+)"/g)].map(([, key, value]) => [key, Number(value)]));
  };
  const credit = attrs('credit');
  const mark = svg.match(/<svg x="([\d.-]+)" y="([\d.-]+)"/);
  assert.ok(credit.x >= x && credit.x <= right && credit.y >= y && credit.y <= bottom);
  assert.ok(Number(mark[1]) >= x && Number(mark[1]) < right && Number(mark[2]) >= y && Number(mark[2]) < bottom);
  for (const selector of ['mapping-legend', 'generated-at']) {
    const position = attrs(selector);
    assert.ok(position.x >= x && position.x < right, `${selector} left anchor is within frame`);
    assert.ok(position.y >= y && position.y <= bottom, `${selector} baseline is within frame`);
  }
  assert.doesNotMatch(svg, /class="empty-state"/);
  const background = attrs('background');
  assert.deepEqual(background, { x, y, width, height, rx: 18 });
  const nebula = svg.match(/<ellipse cx="([\d.-]+)" cy="([\d.-]+)" rx="([\d.-]+)" ry="([\d.-]+)" fill="url\(#nebula\)"/);
  assert.ok(nebula);
  assert.ok(Number(nebula[1]) > x && Number(nebula[1]) < right && Number(nebula[2]) > y && Number(nebula[2]) < bottom);
  assert.equal(scene.nodes[0].geometry.x, originalNodeX);
  const semanticLine = svg.match(/<text x="([\d.-]+)" y="([\d.-]+)" font-size="11">/);
  assert.ok(semanticLine);
  assert.equal(Number(semanticLine[1]), x + 32);
  assert.ok(Number(semanticLine[2]) > bottom);

  const empty = createScene('studio', [], { legend: true });
  empty.viewport.viewBox = [x, y, width, height];
  assert.match(renderSceneSVG(empty), new RegExp(`class="empty-state" x="${x + width / 2}" y="${y + height / 2}"`));
});

test('fitSceneViewport recenters when width is unchanged', () => {
  const scene = createScene('studio', records(12));
  const [x, y, width, height] = scene.viewport.viewBox;
  scene.viewport.viewBox = [x + width * 0.08, y - height * 0.06, width, height];
  const fitted = fitSceneViewport(scene);
  assert.notEqual(fitted, scene);
  assert.ok(Math.abs(fitted.viewport.viewBox[0] - scene.viewport.viewBox[0]) > width * 0.05);
  assert.ok(Math.abs(fitted.viewport.viewBox[1] - scene.viewport.viewBox[1]) > height * 0.04);
});

test('fixed export profiles keep their origin-based card composition', () => {
  for (const exportProfile of ['readme', 'compact', 'repository', 'wide']) {
    const scene = createScene('studio', records(4), { exportProfile });
    assert.deepEqual(scene.viewport.viewBox.slice(0, 2), [0, 0], `${exportProfile} keeps its established origin`);
    assert.equal(scene.viewport.viewBox[2], 900);
    const svg = renderSceneSVG(scene, { animate: false });
    assert.match(svg, /<rect class="background" x="0" y="0" width="900"/);
    assert.match(svg, /<text class="credit" x="868" y="\d+">/);
    assert.match(svg, /<ellipse cx="440" cy="\d+" rx="420"/);
  }
});

test('browser keeps circles circular and fitted scene centered at common aspect ratios', { skip: !browser, timeout: 120000 }, async t => {
  const scene = createScene('studio', records(45));
  const directory = await mkdtemp(join(tmpdir(), 'constellation-framing-'));
  const html = join(directory, 'scene.html');
  const screenshot = process.env.CONSTELLATION_REVIEW_SCREENSHOT || join(directory, 'scene-1200x720.png');
  await writeFile(html, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#080e20}svg{display:block;width:100vw;height:100vh}</style>${renderSceneSVG(scene, { animate: false })}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const page = await openBrowser(t, new URL(`file:///${html.replaceAll('\\', '/')}`).href);
  for (const [width, height] of [[900, 540], [1200, 720], [1440, 900]]) {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const geometry = await page.evaluate(`(() => { const svg=document.querySelector('svg'), circle=svg.querySelector('circle.star'); const b=circle.getBoundingClientRect(), s=svg.getBoundingClientRect(), v=svg.viewBox.baseVal; return {svg:[s.width,s.height],circle:[b.width,b.height],viewBox:[v.x,v.y,v.width,v.height]}; })()`);
    assert.ok(Math.abs(geometry.circle[0] - geometry.circle[1]) < 0.1, `${width}x${height}: circles stay circular`);
    assert.ok(Math.abs(geometry.svg[0] / geometry.svg[1] - width / height) < 0.01);
    if (width === 1200) {
      const image = await page.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(screenshot, Buffer.from(image.data, 'base64'));
    }
  }
  assert.deepEqual(page.errors, []);
  assert.ok((await readFile(screenshot)).byteLength > 1000);
});

test('browser keeps frame furniture visible in a non-zero fitted viewport', { skip: !browser, timeout: 120000 }, async t => {
  const scene = createScene('studio', records(4), { legend: true, generatedAt: '2026-09-26T18:05:07Z' });
  scene.viewport.viewBox = [100, 50, 700, 400];
  const directory = await mkdtemp(join(tmpdir(), 'constellation-furniture-'));
  const html = join(directory, 'scene.html');
  await writeFile(html, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${renderSceneSVG(scene, { animate: false, generatedAt: '2026-09-26T18:05:07Z' })}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const page = await openBrowser(t, new URL(`file:///${html.replaceAll('\\', '/')}`).href);
  // Measure only once the page has parsed the SVG (a busy machine can be slower than navigation).
  await page.waitFor("document.querySelector('svg .credit') && document.querySelector('svg .generated-at')");
  const geometry = await page.evaluate(`(() => {const svg=document.querySelector('svg'), box=svg.getBoundingClientRect();return Object.fromEntries(['.credit','.mapping-legend','.generated-at'].map(s=>{const r=svg.querySelector(s).getBoundingClientRect();return [s,{left:r.left,top:r.top,right:r.right,bottom:r.bottom,visible:r.width>0&&r.height>0&&r.right>box.left&&r.left<box.right&&r.bottom>box.top&&r.top<box.bottom}]}))})()`);
  for (const selector of ['.credit', '.mapping-legend', '.generated-at']) assert.equal(geometry[selector].visible, true, `${selector} intersects rendered SVG viewport`);
  assert.deepEqual(page.errors, []);
});
