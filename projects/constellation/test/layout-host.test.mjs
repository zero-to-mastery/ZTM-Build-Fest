import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayoutHost, createPluginHost, createScene, parseConfig, serializeConfig, renderSceneSVG, layoutScene, layoutCacheStatistics } from '../src/core-api.mjs';
const capabilities = { maxNodes: 100, manualPositioning: true, ringSnapping: false, deterministicSeed: true, animation: true, refinement: true };
const records = [0, 1, 2].map(i => ({ full_name: `registered/p${i}`, name: `p${i}`, language: 'Rust' }));
const grid = { id: 'grid', apiVersion: 1, capabilities, layout: scene => Object.fromEntries(scene.nodes.map((node, i) => [node.id, { x: 100 + i * 100, y: 150 }])) };

test('layout cancellation, cache isolation and bounds survive repeated execution', () => {
  const scene = createScene('registered', records, { referenceDate: '2026-09-01T00:00:00Z' });
  let calls = 0;
  const host = createLayoutHost({ maxEntries: 1, maxBytes: 100000 }).register({ ...grid, layout(scene) { calls++; return grid.layout(scene); } });
  const first = host.run(scene, { layoutEngine: 'grid' });
  first.positions[scene.nodes[0].id].x = 999;
  assert.notEqual(host.run(scene, { layoutEngine: 'grid' }).positions[scene.nodes[0].id].x, 999);
  assert.equal(calls, 1); assert.equal(host.cacheStatistics.hits, 1);
  host.run(scene, { layoutEngine: 'grid', layoutOptions: { variant: 1 } });
  assert.equal(host.cacheStatistics.entries, 1);
  assert.ok(host.cacheStatistics.estimatedBytes <= 100000);
  host.clearCache(); assert.equal(host.cacheStatistics.estimatedBytes, 0);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => host.run(scene, { layoutEngine: 'grid' }, { signal: controller.signal }), /abort/i);
  assert.throws(() => layoutScene(scene, {}, { signal: controller.signal }), /abort/i);
  const late = new AbortController();
  const cancelled = createLayoutHost().register({ ...grid, layout(scene) { late.abort(); return grid.layout(scene); } });
  assert.throws(() => cancelled.run(scene, { layoutEngine: 'grid' }, { signal: late.signal }), /abort/i);
  assert.equal(cancelled.cacheStatistics.entries, 0);
  const stats = layoutCacheStatistics();
  assert.ok(stats.scenes <= stats.sceneLimit && stats.stableCoordinates <= stats.stableCoordinateLimit);
});

test('stable large layout results preserve manual nodes and cannot poison Rust cache data', () => {
  const nodes = Array.from({ length: 2048 }, (_, i) => ({ id: `large/${i}`, metadata: { full_name: `large/${i}`, name: String(i), language: 'Rust' } }));
  const options = { nodeCap: 2048, starPositions: { 'large/0': { x: 321, y: 123 } } };
  const first = layoutScene({ nodes }, options);
  assert.equal(Object.keys(first.positions).length, 2048);
  assert.deepEqual(first.positions['large/0'], { x: 321, y: 123 });
  first.positions['large/1'].x = -999; first.edges.length = 0;
  const second = layoutScene({ nodes }, options);
  assert.notEqual(second.positions['large/1'].x, -999); assert.ok(second.edges.length > 0);
});

test('trusted layout registration produces scenes and survives declarative config round trips', () => {
  const host = createPluginHost().registerLayout(grid);
  const options = parseConfig(serializeConfig('registered', { layoutEngine: 'grid', starPositions: { 'registered/p0': { x: 333, y: 222 } } })).options;
  const scene = host.createScene('registered', records, options);
  assert.equal(scene.nodes.find(node => node.id === 'registered/p0').geometry.x, 333);
  assert.equal(scene.nodes.find(node => node.id === 'registered/p1').geometry.y, 150);
  assert.match(renderSceneSVG(scene), /class="shared-language"/);
  assert.throws(() => createScene('registered', records, options), /Register it/);
  assert.throws(() => parseConfig({ layoutEngine: 'https://example.com/layout.js' }), /identifier/);
});

test('registrations and callback inputs are isolated; capabilities and positions are enforced', () => {
  const definition = { ...grid, capabilities: { ...capabilities } };
  const host = createLayoutHost().register(definition);
  definition.layout = () => { throw new Error('mutated'); }; definition.capabilities.maxNodes = 0;
  const scene = createScene('registered', records);
  assert.equal(Object.keys(host.run(scene, { layoutEngine: 'grid' }).positions).length, 3);
  assert.throws(() => host.register(grid), /already registered/);
  assert.throws(() => host.run(scene, { layoutEngine: 'grid', snapToRings: true }), /ring snapping/);
  assert.equal(createLayoutHost().describe('grid'), null);
  const broken = createLayoutHost().register({ ...grid, id: 'broken', layout: () => ({ unknown: { x: 1, y: 2 } }) });
  assert.throws(() => broken.run(scene, { layoutEngine: 'broken' }), /every scene node/);
  const mutation = createLayoutHost().register({ ...grid, id: 'isolated', layout(input) { input.nodes[0].metadata.name = 'changed'; return grid.layout(input); } });
  mutation.run(scene, { layoutEngine: 'isolated' });
  assert.notEqual(scene.nodes[0].metadata.name, 'changed');
});
