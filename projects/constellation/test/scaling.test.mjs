import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConstellation, graphNodes, layoutStatistics, createPluginHost } from '../src/core-api.mjs';
import { ringOccupancy } from '../src/scaling.mjs';

const repos = Array.from({ length: 1024 }, (_, i) => ({ name: `node-${i}`, full_name: `scale/node-${i}`, language: i % 2 ? 'Rust' : 'JavaScript', topics: ['tools'] }));
const options = { nodeCap: 2048, maxRepos: 2048, animate: false, identityRing: false, snapToRings: false };
const positions = svg => new Map([...svg.matchAll(/<circle class="star" cx="([^"]+)" cy="([^"]+)"[^>]*data-repo="([^"]+)"/g)].map(m => [m[3], [m[1], m[2]]]));

test('spatial ring occupancy matches exact scan order at cell boundaries', () => {
  const stars = Array.from({ length: 400 }, (_, i) => ({ x: 99 + i % 20 / 10, y: 99 + Math.floor(i / 20) / 10, repo: { full_name: String(i) } }));
  const query = ringOccupancy(stars);
  for (const [x, y] of [[100, 100], [99.999, 100.001], [101, 101]]) assert.deepEqual(query(x, y), stars.filter(star => Math.hypot(star.x - x, star.y - y) < 1).map(star => star.repo.full_name));
});

test('1024-node overview reuses unaffected Rust coordinates across styles and filters', () => {
  const before = positions(renderConstellation('scale', repos, options));
  assert.equal(before.size, 1024);
  const computed = layoutStatistics.computedNodes;
  const styled = positions(renderConstellation('scale', repos, { ...options, colors: { star: '#123456' } }));
  assert.deepEqual(styled, before);
  assert.equal(layoutStatistics.computedNodes, computed);
  const subset = positions(renderConstellation('scale', repos, { ...options, languages: ['Rust'] }));
  assert.equal(subset.size, 512);
  assert.equal(layoutStatistics.computedNodes, computed);
  for (const [id, xy] of subset) assert.deepEqual(xy, before.get(id));
  const withNew = [...repos, { name: 'added', full_name: 'scale/added', language: 'Rust' }];
  renderConstellation('scale', withNew, options);
  assert.equal(layoutStatistics.computedNodes, computed + 1);
  assert.ok(graphNodes(repos, { ...options, nodeMode: 'combined' }).nodes.length > 1024);
});

test('large overview retains manual nodes and labels and reports bounded labels', () => {
  const diagnostics = [];
  const locked = { ...options, starPositions: { 'scale/node-0': { x: 100, y: 100 } }, labelOffsets: { 'scale/node-0': { x: 10, y: 20 } }, hiddenNodes: ['scale/node-1'] };
  const svg = renderConstellation('scale', repos, locked, { onDiagnostic: item => diagnostics.push(item) });
  assert.deepEqual(positions(svg).get('scale/node-0'), ['100.0', '100.0']);
  assert.ok(!positions(svg).has('scale/node-1'));
  assert.match(svg, /data-repo="scale\/node-0" x="110.0" y="120.0"/);
  assert.ok(diagnostics.some(item => item.reason === 'large-graph-overview'));
});

test('source snapshots survive view changes and explicit refresh gets fresh data', async () => {
  let calls = 0;
  const host = createPluginHost().registerSource({ id: 'counted', apiVersion: 1, load: async () => [{ id: 'x', name: `snapshot-${++calls}` }] });
  const config = { plugins: { sources: [{ id: 'one', source: 'counted' }] } };
  assert.equal((await host.load(config))[0].name, 'snapshot-1');
  assert.equal((await host.load({ ...config, theme: 'light' }))[0].name, 'snapshot-1');
  assert.equal((await host.load(config, { refresh: true }))[0].name, 'snapshot-2');
  assert.equal(calls, 2);
});

test('refresh prevents an old pending source response from replacing the new snapshot', async () => {
  const pending = [];
  const host = createPluginHost().registerSource({ id: 'deferred', apiVersion: 1, load: () => new Promise(resolve => pending.push(resolve)) });
  const config = { plugins: { sources: [{ id: 'one', source: 'deferred' }] } };
  const old = host.load(config);
  const rejected = assert.rejects(old, /refreshed/);
  const fresh = host.load(config, { refresh: true });
  pending[1]([{ id: 'x', name: 'New' }]);
  assert.equal((await fresh)[0].name, 'New');
  pending[0]([{ id: 'x', name: 'Old' }]);
  await rejected;
  assert.equal((await host.load(config))[0].name, 'New');
});

test('invalid and aborted responses never become reusable source snapshots', async () => {
  let calls = 0;
  const host = createPluginHost().registerSource({ id: 'retry', apiVersion: 1, load: async () => ++calls === 1 ? [{ name: 'No ID' }] : [{ id: 'x', name: 'Valid' }] });
  const config = { plugins: { sources: [{ id: 'one', source: 'retry' }] } };
  await assert.rejects(host.load(config), /valid id/);
  assert.equal((await host.load(config))[0].name, 'Valid');
  assert.equal(calls, 2);
  const controller = new AbortController();
  let resume;
  const delayed = createPluginHost().registerSource({ id: 'retry', apiVersion: 1, load: () => new Promise(resolve => { resume = resolve; }) });
  const load = delayed.load(config, { signal: controller.signal });
  const rejected = assert.rejects(load, /abort/i);
  controller.abort(); resume([{ id: 'x', name: 'Too late' }]);
  await rejected;
});

test('source cache evicts by byte budget and clears retained accounting', async () => {
  const host = createPluginHost().registerSource({ id: 'large', apiVersion: 1, load: async ({ options }) => [{ id: 'x', name: `View ${options.view}`, payload: 'x'.repeat(1500000) }] });
  for (let view = 0; view < 5; view++) await host.load({ plugins: { sources: [{ id: 'one', source: 'large', options: { view } }] } });
  const stats = host.cacheStatistics;
  assert.ok(stats.entries > 0 && stats.entries < 5);
  assert.ok(stats.estimatedBytes <= stats.budgetBytes);
  host.clearCache();
  assert.equal(host.cacheStatistics.entries, 0); assert.equal(host.cacheStatistics.estimatedBytes, 0);
});
