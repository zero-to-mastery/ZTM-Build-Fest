import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { newDesignCode, randomizeDesign } from '../src/design-randomizer.mjs';
import { temporalEligibility, v6Parameters } from '../src/design-randomizer-v6.mjs';
import { motionParts } from '../src/design-randomizer-v5.mjs';
import { randomizeParts } from '../src/randomize-parts.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';
import { createScene, renderSceneSVG } from '../src/core-api.mjs';

const records = Array.from({ length: 16 }, (_, i) => ({ name: `project-${i}`, full_name: `universe/project-${i}`, created_at: `${2015 + i % 8}-01-01`, language: ['Rust', 'TypeScript'][i % 2], stargazers_count: 100 - i }));
const code = (i, mask = 'fff') => `v6:m${mask}-y2026-f2015-e1-fixture-${i}`;

test('v6 deterministically discovers all forms with bounded, minority temporal draws', () => {
  let temporal = 0; const shapes = new Set();
  for (let i = 0; i < 400; i++) {
    const recipe = randomizeDesign(code(i), { repositories: records });
    assert.deepEqual(recipe, randomizeDesign(code(i), { repositories: [...records].reverse() }));
    assert.deepEqual(parseConfig(serializeConfig('universe', recipe)).options, recipe);
    if (!recipe.temporalGeometry) continue;
    temporal++; shapes.add(recipe.temporalGeometry.shape);
    const g = recipe.temporalGeometry;
    assert.ok(g.radius >= 270 && g.radius <= 360 && g.depth >= 270 && g.depth <= 750);
    assert.ok(Math.abs(g.twist) <= 240 && g.waist >= .35 && g.waist <= .55);
    assert.ok(recipe.temporalStack.yearStart >= 2015 && recipe.temporalStack.yearEnd === 2026);
    assert.equal(recipe.snapToRings, true);
  }
  assert.ok(temporal >= 80 && temporal <= 140, `temporal draws: ${temporal}/400`);
  assert.deepEqual([...shapes].sort(), ['cone', 'cylinder', 'dome', 'helix', 'hourglass', 'sphere', 'stack']);
});

test('eligibility uses observed history; new codes capture bounds and motion permissions', () => {
  for (const repositories of [[], records.slice(0, 2), records.map(r => ({ ...r, created_at: null })), records.map(r => ({ ...r, created_at: '2026-01-01' }))]) {
    assert.equal(temporalEligibility(repositories, [], 2026).eligible, false);
    assert.equal(v6Parameters(newDesignCode({ repositories, year: 2026 })).eligible, false);
    for (let i = 0; i < 20; i++) assert.notEqual(randomizeDesign(code(i), { repositories }).arrangement, 'temporal-stack');
  }
  const generated = newDesignCode({ repositories: records, year: 2026, motion: false });
  const parameters = v6Parameters(generated);
  assert.equal(parameters.firstYear, 2015); assert.equal(parameters.eligible, true);
  assert.ok(Object.values(parameters.animations).every(value => !value));
  assert.equal(parseConfig(generated).options.designCode, generated);
  assert.deepEqual(parseConfig(generated).options.temporalGeometry, randomizeDesign(generated).temporalGeometry);
  const recipe = randomizeDesign(generated);
  const { css, ...shared } = recipe; // Share links omit redundant generated CSS.
  assert.deepEqual(decodeShare(encodeShare('https://example.test', 'universe', recipe)).options, shared);
  const snapshots = ['2016-12-31', '2019-12-31', '2023-12-31'].map(date => ({ date, records }));
  assert.equal(temporalEligibility([], snapshots, 2026).eligible, true);
  const temporalCode = Array.from({ length: 50 }, (_, i) => code(i)).find(c => randomizeDesign(c).temporalGeometry);
  const snapshotRecipe = randomizeDesign(temporalCode, { repositories: records, snapshots });
  const scene = createScene('universe', records, snapshotRecipe);
  assert.ok(scene.timeline.frames.filter(f => f.evidence === 'snapshot').length === 3);
  for (const bad of ['v6:fixture', 'v6:mffff-y2026-f2015-e1-test', 'v6:mfff-y2026-f2030-e1-test']) assert.throws(() => randomizeDesign(bad));
});

test('temporal geometry is independent of permissions; partial draws and placements retain identity', () => {
  const baseCode = Array.from({ length: 80 }, (_, i) => code(i)).find(c => randomizeDesign(c).temporalGeometry);
  const placements = { 'universe/project-0': { ring: 1, point: 3 } };
  const original = randomizeDesign(baseCode, { ringPlacements: placements });
  for (let i = 0; i < motionParts.length; i++) {
    const mask = (1 << i).toString(16).padStart(3, '0');
    const recipe = randomizeDesign(baseCode.replace('mfff', `m${mask}`), { ringPlacements: placements });
    assert.deepEqual(recipe.temporalGeometry, original.temporalGeometry);
    assert.deepEqual(recipe.ringPlacements, placements);
    assert.equal(recipe.starlightAnimate, i === 0); assert.equal(recipe.starfield.twinkle, i === 1);
    assert.equal(recipe.perspective.animate, motionParts[i][0] === 'perspective');
    assert.equal(recipe.activityAnimate, motionParts[i][0] === 'activity');
    for (let ring = 0; ring < 4; ring++) if (i !== ring + 2) assert.equal(recipe.ringAnimation.speeds[ring], 0);
  }
  for (const parts of [{ styling: true }, { animations: true }]) {
    const partial = randomizeParts(original, randomizeDesign(code(92)), parts);
    assert.deepEqual(partial.temporalGeometry, original.temporalGeometry);
    assert.deepEqual(partial.ringPlacements, placements);
    parseConfig(serializeConfig('universe', partial));
  }
  const still = randomizeDesign(baseCode.replace('mfff', 'm000'), { ringPlacements: placements });
  const scene = createScene('universe', records, still);
  assert.deepEqual(scene.temporalStack.geometry.placements['universe/project-0'], placements['universe/project-0']);
  assert.doesNotMatch(renderSceneSVG(scene), /<animate|animation:temporal-starlight|class="[^"]*starfield-twinkle/);
});

test('seeded temporal examples retain their complete v6 recipes', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/randomizer-v6.json', import.meta.url)));
  for (const fixture of fixtures) {
    const recipe = randomizeDesign(fixture.code);
    assert.equal(recipe.temporalGeometry?.shape || 'ordinary', fixture.shape);
    assert.equal(createHash('sha256').update(JSON.stringify(recipe)).digest('hex'), fixture.sha256);
  }
});
