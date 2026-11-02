import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScene, renderSceneSVG, renderSceneHTML, serializeScene, parseScene, parseConfig, validateScene, temporalGeometryMath as math } from '../src/core-api.mjs';
import { temporalGeometryDrawing } from '../src/temporal-geometry-drawing.mjs';
import { identityPoints } from '../src/engine.mjs';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';

const records = Array.from({ length: 24 }, (_, i) => ({ name: `project-${i}`, full_name: `demo/project-${i}`, language: 'Rust', created_at: '2010-01-01', stargazers_count: 100 - i }));
const settings = { arrangement: 'temporal-stack', referenceDate: '2026-09-01', snapToRings: true, temporalStack: { innerArrangement: 'rings' }, temporalGeometry: { shape: 'cylinder' } };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('semantic ring positions use Rust identity points and survive every temporal form and config round trip', () => {
  const scene = createScene('demo', records, settings), geometry = scene.temporalStack.geometry;
  const expected = identityPoints('demo', 24);
  geometry.points.forEach((point, i) => { close(point.x, 450 + (expected[i * 3] - 240) * 368 / 172); close(point.y, 270 + (expected[i * 3 + 1] - 240) * 192 / 172); });
  assert.equal(new Set(Object.values(geometry.placements).map(p => `${p.ring}:${p.point}`)).size, records.length);
  const pinned = { ...settings, ringPlacements: geometry.placements };
  for (const shape of math.shapes) {
    const options = { ...pinned, temporalGeometry: { shape, twist: shape === 'helix' ? 240 : 0 } };
    assert.deepEqual(parseConfig(options).options.ringPlacements, geometry.placements);
    const next = createScene('demo', records, options);
    assert.deepEqual(next.temporalStack.geometry.placements, geometry.placements);
    assert.deepEqual(next.timeline.frames.map(frame => frame.scene.nodes.map(node => [node.id, node.geometry.x, node.geometry.y])), scene.timeline.frames.map(frame => frame.scene.nodes.map(node => [node.id, node.geometry.x, node.geometry.y])));
    assert.equal(serializeScene(parseScene(serializeScene(next))), serializeScene(next));
    assert.ok(!renderSceneSVG(next).includes('NaN'));
  }
});

test('profile equations form spheres, cones and hourglasses; transformed planes inverse-project accurately', () => {
  for (const shape of math.shapes) {
    const profile = math.options({ shape, twist: 240, orientation: { x: 13, y: 37, z: -8 }, planeTilt: { x: 15, y: -12, z: 5 }, lean: { x: 80, y: -60, z: 30 } });
    for (let i = 0; i < 6; i++) {
      const plane = math.plane(profile, i, 6), camera = math.camera(profile, { tilt: .35, perspective: .8 }, { rotation: .6 });
      for (const local of [{ x: 200, y: 170 }, { x: 720, y: 370 }]) {
        const projected = math.project(math.world(local, plane, profile, 168), camera), restored = math.unproject(projected, plane, profile, 168, camera);
        assert.ok(restored); close(restored.x, local.x); close(restored.y, local.y);
      }
    }
  }
  const sphere = math.options({ shape: 'sphere' });
  for (const t of [.1, .3, .5, .8]) { const p = math.section(sphere, t); close(p.radius ** 2 + p.center.z ** 2, sphere.radius ** 2); }
  const cone = math.options({ shape: 'cone', startRadius: 400, endRadius: 80 });
  close(math.section(cone, .5).radius, 240);
  const hourglass = math.options({ shape: 'hourglass', waist: .2 });
  close(math.section(hourglass, .5).radius, 64); close(math.section(hourglass, 0).radius, math.section(hourglass, 1).radius);
  assert.equal(math.options({ shape: 'helix' }).twist, 0);
});

test('painter depth is camera-based, front and back segments differ, and guides are distinct from data edges', () => {
  const scene = createScene('demo', records, { ...settings, temporalGeometry: { shape: 'sphere', surface: 'translucent', orientation: { x: 20, y: 30, z: 0 } } });
  const drawing = temporalGeometryDrawing(scene, { rotation: .7 });
  assert.ok(drawing.items.every((item, i) => i === 0 || item.depth >= drawing.items[i - 1].depth));
  const rings = drawing.items.filter(item => item.kind === 'ring');
  assert.ok(rings.some(item => item.rear) && rings.some(item => !item.rear));
  assert.ok(drawing.items.some(item => item.kind === 'surface'));
  const years = rings.map(item => item.year); assert.ok(years.some((year, i) => i > 1 && year === years[i - 2] && year !== years[i - 1]));
  const html = renderSceneHTML(scene); assert.ok(html.includes('data-geometric-guide=""'));
  assert.ok(drawing.items.filter(item => item.kind === 'temporal').every(item => item.points.length > 2));
  for (const bad of [{ shape: 'unknown' }, { twist: Infinity }, { radius: -1 }, { orientation: { x: 0, y: 0, z: '0' } }, { radiusAt: 'code' }]) assert.throws(() => createScene('demo', records, { ...settings, temporalGeometry: bad }));
  assert.throws(() => createScene('demo', records, { ...settings, ringPlacements: { 'demo/project-0': { ring: 8, point: 1 } } }));
  for (const mutate of [s => { s.temporalStack.geometry.points[0].x += 20; }, s => { s.temporalStack.geometry.placements['demo/project-0'] = { ring: 0, point: 500 }; }]) { const value = structuredClone(scene); mutate(value); assert.equal(validateScene(value).valid, false); }
});

test('offline form switching keeps nodes, trails, filters and reduced-motion behavior', { skip: !browser, timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'constellation-forms-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'index.html'); await writeFile(file, renderSceneHTML(createScene('demo', records, settings)));
  const { evaluate, waitFor, errors, cdp } = await openBrowser(t, pathToFileURL(file).href);
  await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
  await evaluate(`window.api=document.querySelector('main').constellation; api.focusTemporalNode('demo/project-0'); window.node=document.querySelector('.repository'); window.placement=[node.dataset.ring,node.dataset.ringPoint]; api.setFilter({query:'project-0'});`);
  for (const shape of ['sphere', 'cone', 'helix', 'cylinder']) {
    await evaluate(`api.setTemporalView({shape:'${shape}',twist:240,surface:'translucent'})`);
    assert.equal(await evaluate(`node.isConnected`), true);
    assert.deepEqual(await evaluate(`[node.dataset.ring,node.dataset.ringPoint]`), await evaluate('placement'));
    assert.equal(await evaluate(`document.querySelector('svg').dataset.temporalForm`), shape);
    assert.equal(await evaluate(`api.selection`), 'demo/project-0');
    assert.equal(await evaluate(`document.querySelectorAll('.temporal-bridge[data-related]').length`), 5);
  }
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate(`api.setTemporalView({shape:'sphere',rotation:.8}); api.focusYear(2023); api.focusYear(null)`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-temporal-year][opacity="1"]').length`), 6);
  assert.equal(await evaluate(`document.querySelector('svg').getAnimations({subtree:true}).length`), 0);
  assert.deepEqual(errors, []);
});
