import test from 'node:test';
import assert from 'node:assert/strict';
import { randomizeParts } from '../src/randomize-parts.mjs';
import { randomizeDesign } from '../src/design-randomizer.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';

const current = randomizeDesign('v5:mfff-y2026-f2012-original');
const recipe = randomizeDesign('v5:mfff-y2026-f2012-next');
const repos = Array.from({ length: 20 }, (_, i) => ({ full_name: `alice/project-${i}` }));

test('styling preserves project selection, layout, seed and motion', () => {
  const input = { ...current, includeRepos: ['alice/project-1'], customCSS: 'svg{opacity:.8}' };
  const result = randomizeParts(input, recipe, { styling: true });
  for (const key of ['includeRepos', 'seed', 'arrangement', 'nodeMode', 'history', 'minStars', 'animate', 'ringAnimation', 'floatingAnimation', 'perspective']) assert.deepEqual(result[key], input[key], key);
  assert.equal(result.starfield.twinkle, input.starfield.twinkle);
  assert.equal(result.customCSS, '');
  assert.equal(result.designCode, undefined);
  assert.equal(input.customCSS, 'svg{opacity:.8}');
  assert.doesNotThrow(() => parseConfig(serializeConfig('alice', result)));
});

test('animation draw preserves style, repository selection and static perspective', () => {
  const result = randomizeParts(current, recipe, { animations: true });
  for (const key of ['visualStyle', 'visualTheme', 'nodeColors', 'seed', 'arrangement', 'maxRepos', 'nodeMode', 'hiddenNodes', 'customCSS']) assert.deepEqual(result[key], current[key], key);
  for (const key of ['enabled', 'horizontal', 'vertical', 'zoom']) assert.equal(result.perspective[key], current.perspective[key]);
  assert.deepEqual(result.ringAnimation, recipe.ringAnimation);
  assert.equal(result.contributionOrbit.enabled, current.contributionOrbit.enabled);
  assert.doesNotThrow(() => parseConfig(serializeConfig('alice', result)));
});

test('repository shuffle only changes selection and stale code; results share exactly', () => {
  const result = randomizeParts(current, recipe, { repositories: true }, repos);
  const { designCode, ...unchanged } = current;
  const { includeRepos, ...rest } = result;
  assert.deepEqual(rest, unchanged);
  assert.ok(includeRepos.length > 0 && includeRepos.length <= current.maxRepos);
  assert.equal(new Set(includeRepos).size, includeRepos.length);
  assert.ok(includeRepos.every(id => repos.some(repo => repo.full_name === id)));
  assert.deepEqual(randomizeParts(current, recipe, { repositories: true }, repos), result);
  const decoded = decodeShare(encodeShare('https://example.com/', 'alice', result));
  assert.deepEqual(decoded.options.includeRepos, includeRepos);
  assert.deepEqual(decoded.options.visualStyle, current.visualStyle);
  assert.throws(() => randomizeParts(current, recipe, { repositories: true }, []), /No repositories match/);
});
