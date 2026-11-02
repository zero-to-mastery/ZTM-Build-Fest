import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecords, toGraphRecords, createScene, renderSceneSVG, createPluginHost } from '../src/core-api.mjs';

const repositories = [{ full_name: 'data/one', name: 'one', language: 'Rust', stargazers_count: 42, topics: ['space'] }];
const options = { referenceDate: '2026-09-01T00:00:00Z' };
test('GitHub records and normalized records compile to the same visualization', () => {
  const { records, statistics } = normalizeRecords(repositories);
  assert.deepEqual(statistics, { loaded: 1, rejected: 0, normalized: 1 });
  assert.deepEqual(toGraphRecords(records), repositories);
  assert.equal(renderSceneSVG(createScene('data', records, options)), renderSceneSVG(createScene('data', repositories, options)));
  records[0].attributes.topics.push('changed');
  assert.deepEqual(repositories[0].topics, ['space']);
});

test('normalization reports rejected records and prevents ID collisions', () => {
  const diagnostics = [];
  const result = normalizeRecords([null, { name: 'missing-id' }, ...repositories], { onDiagnostic: value => diagnostics.push(value) });
  assert.equal(result.statistics.rejected, 2);
  assert.deepEqual(diagnostics, result.diagnostics);
  assert.throws(() => normalizeRecords([...repositories, ...repositories]), /Duplicate graph node ID/);
  const scene = createScene('data', [null, ...repositories], options);
  assert.deepEqual(scene.presentation.pipeline, { loaded: 2, rejected: 1, normalized: 1, transformed: 1, filtered: 0, transforms: [], graphNodes: 1, sceneNodes: 1 });
});

test('source API 1 remains compatible with normalized record loading and cancellation', async () => {
  const host = createPluginHost().registerSource({ id: 'legacy', apiVersion: 1, load: async () => [{ id: 'one', name: 'one', language: 'Rust' }] });
  const config = { plugins: { sources: [{ id: 'fixture', source: 'legacy' }] } };
  const legacy = await host.load(config);
  const canonical = await host.loadRecords(config);
  assert.equal(canonical.records[0].id, legacy[0].full_name);
  assert.equal(canonical.records[0].source.id, 'legacy');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(host.loadRecords(config, { signal: controller.signal }), /abort/i);
});
