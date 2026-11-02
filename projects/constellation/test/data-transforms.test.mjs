import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecords, applyTransforms, createScene, renderSceneSVG, parseConfig, serializeConfig } from '../src/core-api.mjs';
const source = [3, 1, 2].map(stars => ({ full_name: `transform/${stars}`, name: `Project ${stars}`, language: stars === 2 ? 'JavaScript' : 'Rust', stargazers_count: stars }));
const records = normalizeRecords(source).records;

test('declarative filter/sort/limit/derive/map stages are deterministic and isolated', () => {
  const transforms = [
    { type: 'filter', field: 'metrics.stars', op: 'gte', value: 2 },
    { type: 'sort', field: 'metrics.stars', direction: 'desc' },
    { type: 'limit', count: 1 },
    { type: 'derive', field: 'metrics.score', expression: { op: 'multiply', args: [{ field: 'metrics.stars' }, { value: 2 }] } },
    { type: 'map', fields: { label: { op: 'lowercase', args: [{ field: 'label' }] } } },
  ];
  const result = applyTransforms(records, transforms);
  assert.equal(result.records[0].id, 'transform/3');
  assert.equal(result.records[0].metrics.score, 6);
  assert.equal(result.records[0].label, 'project 3');
  assert.equal(records[0].label, 'Project 3');
  assert.deepEqual(applyTransforms(records, transforms), result);
  assert.deepEqual(parseConfig(serializeConfig('transform', { transforms })).options.transforms, transforms);
  assert.equal(createScene('transform', source, { transforms }).nodes.length, 1);
});

test('group and deduplicate preserve membership with stable group IDs', () => {
  const grouped = applyTransforms(records, [{ type: 'group', field: 'attributes.language' }]);
  const rust = grouped.records.find(record => record.label === 'Rust');
  assert.equal(rust.metrics.stars, 4);
  assert.deepEqual(rust.attributes.members, ['transform/1', 'transform/3']);
  assert.deepEqual(applyTransforms([...records].reverse(), [{ type: 'group', field: 'attributes.language' }]), grouped);
  const deduplicated = applyTransforms(records, [{ type: 'deduplicate', field: 'attributes.language' }]);
  assert.equal(deduplicated.records.length, 2);
  const scene = createScene('transform', source, { transforms: [{ type: 'group', field: 'attributes.language' }] });
  assert.match(renderSceneSVG(scene), /data-kind="group"/);
});

test('transforms cannot reveal private/fork records or execute configuration code', () => {
  const scene = createScene('transform', [...source, { full_name: 'secret/private', name: 'SECRET', private: true }, { full_name: 'secret/fork', name: 'FORK', fork: true }], {
    includeForks: false, transforms: [{ type: 'group', field: 'attributes.language' }],
  });
  assert.doesNotMatch(renderSceneSVG(scene), /secret\/|SECRET|FORK/);
  for (const transforms of [
    [{ type: 'execute', code: 'alert(1)' }],
    [{ type: 'derive', field: 'attributes.__proto__.polluted', expression: { value: true } }],
    [{ type: 'derive', field: 'id', expression: { value: 'replacement' } }],
    [{ type: 'derive', field: 'metrics.score', expression: { op: 'eval', args: [{ value: '1+1' }] } }],
    [{ type: 'map', fields: { label: { value: () => 'code' } } }],
  ]) assert.throws(() => applyTransforms(records, transforms));
  const safe = applyTransforms(records, [{ type: 'derive', field: 'metrics.score', expression: { op: 'coalesce', args: [{ op: 'divide', args: [{ value: 1 }, { value: 0 }] }, { value: 0 }] } }]);
  assert.equal(safe.records[0].metrics.score, 0);
});
