import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataPipeline, createPluginHost, createScene } from '../src/core-api.mjs';
const source = [{ full_name: 'cache/core', name: 'core', language: 'Rust', stargazers_count: 10 }];
test('pipeline caches are bounded, observable, isolated and explicitly clearable', () => {
  const pipeline = createDataPipeline({ maxEntries: 2, maxBytes: 6000 });
  const options = { transforms: [{ type: 'limit', count: 1 }] };
  const first = pipeline.run(source, options);
  first.records[0].label = 'poisoned';
  assert.equal(pipeline.run(source, options).records[0].label, 'core');
  assert.equal(pipeline.cacheStatistics.hits, 2);
  assert.equal(pipeline.cacheStatistics.entries, 2);
  pipeline.run([{ ...source[0], name: 'other' }], options);
  assert.ok(pipeline.cacheStatistics.entries <= 2);
  assert.ok(pipeline.cacheStatistics.estimatedBytes <= 6000);
  pipeline.clear();
  assert.equal(pipeline.cacheStatistics.entries, 0);
  assert.equal(pipeline.cacheStatistics.estimatedBytes, 0);
  const large = pipeline.run([{ ...source[0], description: 'x'.repeat(10000) }]);
  assert.equal(large.records.length, 1);
  assert.equal(pipeline.cacheStatistics.entries, 0);
});

test('cancelled and non-JSON inputs cannot poison pipeline caches', () => {
  const pipeline = createDataPipeline();
  const controller = new AbortController(); controller.abort();
  assert.throws(() => pipeline.run(source, { signal: controller.signal }), /abort/i);
  assert.equal(pipeline.cacheStatistics.entries, 0);
  assert.equal(pipeline.run([{ ...source[0], callback() {} }]).statistics.rejected, 1);
  assert.equal(pipeline.cacheStatistics.entries, 1, 'only the valid empty transform result is retained');
  assert.equal(pipeline.run(source).statistics.normalized, 1);
  const late = new AbortController();
  assert.throws(() => createScene('cache', source, {}, { pipeline, signal: late.signal, nodeRenderer() { late.abort(); return null; } }), /abort/i);
});

test('hosts reuse pipeline stages across styles without sharing state between hosts', () => {
  const first = createPluginHost(), second = createPluginHost();
  first.createScene('cache', source, { referenceDate: '2026-09-01T00:00:00Z' });
  first.createScene('cache', source, { referenceDate: '2026-09-01T00:00:00Z', theme: 'midnight' });
  assert.ok(first.pipelineCacheStatistics.hits >= 2);
  assert.equal(second.pipelineCacheStatistics.entries, 0);
  first.clearCache(); assert.equal(first.pipelineCacheStatistics.entries, 0);
});
