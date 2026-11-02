import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScene, renderSceneSVG, renderSceneHTML } from '../src/core-api.mjs';
import { temporalGeometryDrawing } from '../src/temporal-geometry-drawing.mjs';
import { aggregateActivity } from '../src/activity.mjs';
import { deriveCodingRhythm } from '../src/coding-rhythm.mjs';
import { openBrowser, browser } from '../scripts/browser-harness.mjs';

const records = Array.from({ length: 8 }, (_, i) => ({ name: `p${i}`, full_name: `motion/p${i}`, language: 'Rust', created_at: '2018-01-01', stargazers_count: 80 - i }));
const options = { referenceDate: '2026-09-01', arrangement: 'temporal-stack', temporalGeometry: { shape: 'sphere' }, starfield: { mode: 'space', twinkle: true }, animate: true,
  ringPlacements: { 'motion/p0': { ring: 1, point: 0 }, 'motion/p1': { ring: 0, point: 0 } },
  ringAnimation: { enabled: true, speeds: [0, .5, 0, 0], modes: ['spin', 'spin', 'spin', 'spin'] },
  perspective: { enabled: true, animate: false, duration: 30, range: 5 } };
const sceneFor = extra => createScene('motion', records, { ...options, ...extra });

test('unrelated animation periods produce a bounded, seamless SVG loop instead of a still image', () => {
  const scene = sceneFor({ perspective: { enabled: true, animate: true, duration: 31, range: 15 } });
  const svg = renderSceneSVG(scene);
  const animations = [...svg.matchAll(/<(?:animate|animateTransform) data-temporal-motion=""[^>]*>/g)];
  assert.ok(animations.length > 0);
  for (const [tag] of animations) {
    assert.match(tag, /dur="120s"/);
    const samples = tag.match(/values="([^"]+)"/)[1].split(';');
    assert.ok(samples.length <= 145);
    assert.equal(samples[0], samples.at(-1));
  }
  assert.ok(animations.some(([tag]) => new Set(tag.match(/values="([^"]+)"/)[1].split(';')).size > 1));
  assert.equal(svg, renderSceneSVG(scene));
  assert.doesNotMatch(renderSceneSVG(sceneFor({ ...scene.presentation.options, animate: false })), /data-temporal-motion/);
});

test('ring permissions move only attached identities and keep trail/edge endpoints exact', () => {
  const scene = sceneFor(), before = temporalGeometryDrawing(scene), after = temporalGeometryDrawing(scene, { elapsed: 15 });
  const nodes = new Map(after.items.filter(item => item.kind === 'node').map(item => [`${item.year}:${item.node.id}`, item]));
  for (const item of before.items.filter(item => item.kind === 'node')) {
    const next = nodes.get(`${item.year}:${item.node.id}`);
    if (item.placement.ring === 1) assert.notDeepEqual(next.point, item.point);
    else assert.deepEqual(next.point, item.point);
  }
  const same = (a, b) => { assert.ok(Math.abs(a.x - b.x) < 1e-7); assert.ok(Math.abs(a.y - b.y) < 1e-7); };
  for (const item of after.items) {
    if (item.kind === 'relationship') { same(item.points[0], nodes.get(`${item.year}:${item.from}`).point); same(item.points.at(-1), nodes.get(`${item.year}:${item.to}`).point); }
    if (item.kind === 'temporal') { same(item.points[0], nodes.get(`${item.fromYear}:${item.nodeId}`).point); same(item.points.at(-1), nodes.get(`${item.toYear}:${item.nodeId}`).point); }
  }
  assert.deepEqual(after, temporalGeometryDrawing(scene, { elapsed: 15 }));
  const still = sceneFor({ animate: false });
  assert.deepEqual(temporalGeometryDrawing(still), temporalGeometryDrawing(still, { elapsed: 15 }));
  const camera = sceneFor({ perspective: { enabled: true, animate: true, duration: 30, range: 5 } });
  assert.notDeepEqual(temporalGeometryDrawing(camera).camera, temporalGeometryDrawing(camera, { elapsed: 7 }).camera);
  const floating = sceneFor({ snapToRings: false, temporalStack: { innerArrangement: 'solar-system' }, ringPlacements: {}, floatingAnimation: { enabled: true, amplitude: 3, duration: 30 } });
  assert.notDeepEqual(temporalGeometryDrawing(floating).items.find(item => item.kind === 'node').point, temporalGeometryDrawing(floating, { elapsed: 7 }).items.find(item => item.kind === 'node').point);
});

test('SVG composes twinkle, projected ring motion and observed activity without inventing historical activity', () => {
  const events = Array.from({ length: 24 }, (_, i) => ({ id: String(i), repository: 'motion/p0', kind: 'push', createdAt: `2026-08-${String(25 + i % 6).padStart(2, '0')}T${String(i).padStart(2, '0')}:00:00Z` }));
  const extra = { ...options, activityEffect: 'pulse', activityWindow: '30d', codingRhythm: true, codingRhythmAnimate: true, contributionOrbit: { enabled: true, animate: true } };
  extra.activityData = aggregateActivity(events, records, extra, options.referenceDate);
  extra.historyData = { events, asOf: options.referenceDate };
  extra.codingRhythmData = deriveCodingRhythm(events, extra, options.referenceDate);
  const scene = sceneFor(extra), svg = renderSceneSVG(scene);
  assert.match(svg, /data-temporal-motion/); assert.match(svg, /temporal-motion-still/);
  assert.match(svg, /animation:temporal-starlight/); assert.match(svg, /class="starfield-point[^"\n]*starfield-twinkle/);
  assert.equal([...svg.matchAll(/class="activity-halo activity-pulse"/g)].length, 1);
  assert.equal([...svg.matchAll(/class="contribution-orbit history-pulse"/g)].length, 1);
  assert.match(svg, /class="coding-rhythm-marker"/);
  assert.equal(svg, renderSceneSVG(scene));
  const off = renderSceneSVG(sceneFor({ ...extra, animate: false }));
  assert.doesNotMatch(off, /<animate|data-temporal-motion|class="activity-halo activity-pulse"|animation:temporal-starlight/);
  const permitted = renderSceneSVG(sceneFor({ ...extra, starlightAnimate: false, activityAnimate: false }));
  assert.doesNotMatch(permitted, /animation:temporal-starlight|class="activity-halo activity-pulse"/);
  assert.match(permitted, /starfield-twinkle/);
});

test('offline motion pauses for reduced motion and composes with form changes, filters and temporal playback', { skip: !browser, timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-motion-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scene = sceneFor({ perspective: { enabled: true, animate: true, range: 5, duration: 30 }, history: { mode: 'time-lapse', timeLapse: { enabled: true, mode: 'grow', duration: 8, loop: true } } });
  await writeFile(join(directory, 'index.html'), renderSceneHTML(scene));
  const { cdp, evaluate, waitFor, errors } = await openBrowser(t, pathToFileURL(join(directory, 'index.html')).href);
  await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
  const moved = `[...document.querySelectorAll('.repository')].find(node=>node.dataset.nodeId==='motion/p0')`;
  await evaluate(`window.api=document.querySelector('main').constellation; window.node=${moved}; window.before=node.getAttribute('transform'); window.sky=document.querySelector('[data-starfield-backdrop]').getAttribute('transform')`);
  await waitFor(`node.getAttribute('transform') !== before`);
  assert.equal(await evaluate(`document.querySelector('[data-starfield-backdrop]').getAttribute('transform') === sky`), true);
  assert.ok(await evaluate(`new Set([...document.querySelectorAll('.repository')].map(node=>node.getAttribute('opacity'))).size > 1`));
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate(`api.setTemporalView({shape:'cone',rotation:.3}); api.setFilter({query:'p0'}); api.focusTemporalNode('motion/p0'); window.still=node.getAttribute('transform')`);
  await evaluate(`new Promise(resolve=>setTimeout(resolve,250))`);
  assert.equal(await evaluate(`node.getAttribute('transform') === still`), true);
  assert.equal(await evaluate(`document.querySelector('svg').getAnimations({subtree:true}).length`), 0);
  assert.ok(await evaluate(`document.querySelectorAll('.temporal-bridge[data-related]').length > 0`));
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await waitFor(`node.getAttribute('transform') !== still`);
  assert.deepEqual(errors, []);
});

test('standalone animated SVG projects moving ring nodes and offers a reduced-motion image fallback', { skip: !browser, timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-svg-motion-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.svg'), renderSceneSVG(sceneFor({ perspective: { enabled: true, animate: true, duration: 31, range: 15 } })));
  const { cdp, evaluate, waitFor, errors } = await openBrowser(t, pathToFileURL(join(directory, 'index.svg')).href);
  await waitFor(`Boolean(document.querySelector('[data-temporal-motion]'))`);
  await evaluate(`window.svg=document.querySelector('svg'); svg.pauseAnimations(); svg.setCurrentTime(0); window.node=[...document.querySelectorAll('.repository')].find(node=>node.dataset.nodeId==='motion/p0'); window.initial=node.getCTM().e; svg.setCurrentTime(15)`);
  await waitFor(`node.getCTM().e !== initial`);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.temporal-motion-active')).display`), 'none');
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('.temporal-motion-still')).display`), 'none');
  assert.deepEqual(errors, []);
});
