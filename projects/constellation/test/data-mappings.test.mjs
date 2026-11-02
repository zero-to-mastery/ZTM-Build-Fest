import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, renderSceneSVG, serializeScene, parseScene, normalizeRecords, serializeConfig, parseConfig } from '../src/core-api.mjs';
const source = [{ full_name: 'mapping/core', name: 'core', language: 'Rust', stargazers_count: 1000, created_at: '2020-01-01T00:00:00Z', pushed_at: '2026-09-01T00:00:00Z' }];
const referenceDate = '2026-09-01T00:00:00Z';

test('common declarative mappings resolve into scene style and retain manual color overrides', () => {
  const mappings = { size: 'stars', color: 'language', glow: 'activity', opacity: 'age' };
  const scene = createScene('mapping', source, { mappings, referenceDate });
  const node = scene.nodes[0];
  assert.equal(node.geometry.radius, 10);
  assert.equal(node.style.color, '#dea584');
  assert.equal(node.style.glow, 1);
  assert.ok(node.style.opacity > 0.25 && node.style.opacity < 1);
  assert.match(renderSceneSVG(parseScene(serializeScene(scene))), /opacity:0\./);
  assert.equal(createScene('mapping', source, { mappings, referenceDate, nodeColors: { 'mapping/core': '#123456' } }).nodes[0].style.color, '#123456');
  assert.deepEqual(parseConfig(serializeConfig('mapping', { mappings })).options.mappings, mappings);
});

test('derived metrics feed numeric and categorical mappings with clamping and missing-value fallback', () => {
  const records = normalizeRecords(source).records;
  records[0].metrics.score = 5;
  const mappings = {
    size: { expression: { op: 'multiply', args: [{ field: 'metrics.score' }, { value: 3 }] }, domain: [0, 10], range: [2, 12] },
    color: { field: 'attributes.language', categories: { Rust: '#abcdef' }, fallback: '#123456' },
    opacity: { field: 'metrics.missing', domain: [0, 1], range: [0, 1], fallback: 0.5 },
  };
  const scene = createScene('mapping', records, { mappings, referenceDate, transforms: [{ type: 'limit', count: 1 }] });
  assert.equal(scene.nodes[0].geometry.radius, 12);
  assert.equal(scene.nodes[0].style.color, '#abcdef');
  assert.equal(scene.nodes[0].style.opacity, 0.5);
});

test('invalid mapping ranges, colors and executable expressions are rejected before layout', () => {
  for (const mappings of [
    { size: { field: 'metrics.stars', domain: [1, 1], range: [1, 5] } },
    { opacity: { field: 'metrics.stars', domain: [0, 1], range: [0, 2] } },
    { color: { field: 'attributes.language', categories: { Rust: 'url(javascript:alert(1))' } } },
    { size: { expression: { op: 'Function', args: [] }, domain: [0, 1], range: [1, 5] } },
    { opacity: { field: 'attributes.constructor.name', domain: [0, 1], range: [0, 1] } },
  ]) assert.throws(() => createScene('mapping', source, { mappings }));
});
