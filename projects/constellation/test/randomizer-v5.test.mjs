import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomizeDesign, randomizeMatchingDesign } from '../src/design-randomizer.mjs';
import { motionParts, v5Parameters, newV5Code as newDesignCode } from '../src/design-randomizer-v5.mjs';
import { renderConstellation, graphNodes } from '../src/constellation.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';
import { normalizePublicEvents } from '../src/activity.mjs';
import { deriveCodingRhythm } from '../src/coding-rhythm.mjs';
import { aggregateActivity } from '../src/activity.mjs';
import * as fixture from '../examples/fixtures/history.mjs';

const code = (mask, seed = 'fixture') => `v5:m${mask}-y2026-f2012-${seed}`;
test('adding themes preserves released v5 recipes', () => {
  const recipes = Array.from({ length: 96 }, (_, i) => randomizeDesign(code('fff', String(i))));
  assert.equal(createHash('sha256').update(JSON.stringify(recipes)).digest('hex'), 'a9913f20af8e85a47ce5999d44b5eddcde19da09d7014cd1082e4b3558710dfd');
});
test('randomize retries empty pinned selections while exact recipes keep their empty results', () => {
  const repos = [{ ...fixture.repositories[0], pinned: true, stargazers_count: 0 }, { ...fixture.repositories[1], pinned: false, stargazers_count: 100 }];
  const options = recipe => ({ ...recipe, repoSource: 'pinned', referenceDate: fixture.referenceDate });
  const matches = recipe => graphNodes(repos, options(recipe)).nodes.length > 0;
  let empty, valid;
  for (let i = 0; i < 256 && (!empty || !valid); i++) {
    const candidate = code('000', `retry-${i}`);
    if (matches(randomizeDesign(candidate))) valid ??= candidate; else empty ??= candidate;
  }
  assert.ok(empty && valid);
  const candidates = [empty, empty, valid];
  let draws = 0;
  const recipe = randomizeMatchingDesign(() => candidates[draws++], matches);
  assert.equal(draws, 3);
  assert.equal(recipe.designCode, valid);
  assert.ok(graphNodes(repos, options(recipe)).nodes.length > 0);
  assert.equal(graphNodes(repos, options(randomizeDesign(empty))).nodes.length, 0, 'restoring the rejected code remains exact');
  assert.match(renderConstellation('example', repos, { ...options(randomizeDesign(empty)), nodeMode: 'repositories' }), /No projects match these filters/);
});

test('an empty source has bounded randomization attempts without applying an empty recipe', () => {
  let draws = 0;
  const result = randomizeMatchingDesign(() => { draws++; return code('000'); }, recipe => graphNodes([], recipe).nodes.length > 0, 3);
  assert.equal(result, null);
  assert.equal(draws, 3);
});

test('v5 recipes vary every tunable visual family, filters and temporal layer', () => {
  const variations = new Map();
  const visit = (value, path = '') => {
    for (const [key, entry] of Object.entries(value)) {
      const name = path ? `${path}.${key}` : key;
      if (entry && typeof entry === 'object') visit(entry, name);
      else { if (!variations.has(name)) variations.set(name, new Set()); variations.get(name).add(entry); }
    }
  };
  for (let i = 0; i < 96; i++) {
    const recipe = randomizeDesign(code('fff', String(i)));
    assert.deepEqual(recipe, randomizeDesign(recipe.designCode));
    assert.deepEqual(parseConfig(serializeConfig('example', recipe)).options, recipe);
    visit(recipe);
  }
  for (const path of ['arrangement', 'layout', 'exportProfile', 'maxRepos', 'includeForks', 'includeArchived', 'minStars', 'updatedWithin', 'sortBy', 'nodeMode', 'nodeSize', 'nodeColorMode', 'nodeGlowMode', 'nodeShape', 'connectionWeight', 'connectionBasis', 'connectionDensity', 'bridges', 'colorConnections', 'majorMetric', 'effect', 'legend', 'identityRing', 'snapToRings', 'showOther', 'visualStyle.light.star', 'visualStyle.dark.background', 'visualStyle.lineWidth', 'visualStyle.lineOpacity', 'visualStyle.secondaryOpacity', 'visualStyle.bridgeOpacity', 'visualStyle.glow', 'visualStyle.dustOpacity', 'visualStyle.labelSize', 'visualStyle.labels', 'ringAnimation.linked', 'ringAnimation.speeds.2', 'ringAnimation.directions.3', 'ringAnimation.modes.0', 'ringAnimation.amplitudes.1', 'ringAnimation.easing.2', 'floatingAnimation.mode', 'floatingAnimation.amplitude', 'floatingAnimation.duration', 'perspective.enabled', 'perspective.horizontal', 'perspective.vertical', 'perspective.zoom', 'perspective.range', 'perspective.duration', 'starfield.mode', 'starfield.density', 'starfield.brightness', 'starfield.depth', 'activityEffect', 'activityWindow', 'activityDetail', 'activityConnections', 'codingRhythm', 'codingRhythmStyle', 'codingRhythmWindow', 'codingRhythmDays', 'codingRhythmPeakLabel', 'codingRhythmLabels', 'codingRhythmCelestialMarkers', 'codingRhythmProjectHints', 'history.mode', 'history.year', 'history.maxHistoricalFrames', 'history.timeLapse.mode', 'history.timeLapse.duration', 'history.timeLapse.loop', 'contributionOrbit.enabled', 'contributionOrbit.style', 'contributionOrbit.showCurrent', 'languageEvolution.enabled', 'languageEvolution.style', 'languageEvolution.buckets', 'stellarAges.enabled', 'stellarAges.mode', 'stellarAges.showArchivedRemnants', 'stellarAges.thresholds.newborn', 'foreignGalaxies.enabled', 'foreignGalaxies.limit', 'foreignGalaxies.minimumContribution']) assert.ok(variations.get(path)?.size > 1, `${path} must vary`);
});

test('each animation switch is independently encoded, replayed and respected', () => {
  for (let i = 0; i < motionParts.length; i++) {
    const animations = Object.fromEntries(motionParts.map(([key], j) => [key, i === j]));
    const generated = newDesignCode({ animations, year: 2026, firstYear: 2012 });
    assert.deepEqual(v5Parameters(generated).animations, animations);
    const recipe = randomizeDesign(generated);
    assert.equal(recipe.starlightAnimate, animations.starlight);
    assert.equal(recipe.starfield.twinkle, animations.starfield);
    assert.equal(recipe.activityAnimate, animations.activity);
    assert.equal(recipe.codingRhythmAnimate, animations.codingRhythm);
    assert.equal(recipe.contributionOrbit.animate, animations.contributionOrbit);
    assert.equal(recipe.floatingAnimation.enabled, animations.floating);
    assert.equal(recipe.perspective.animate, animations.perspective);
    for (let ring = 0; ring < 4; ring++) assert.equal(recipe.ringAnimation.speeds[ring] > 0, animations[`ring${ring + 1}`]);
    if (!animations.timeLapse) assert.equal(recipe.history.timeLapse.enabled, false);
  }
  assert.match(newDesignCode({ motion: false }), /^v5:m000-/);
  assert.throws(() => randomizeDesign('v5:invalid'));
  assert.throws(() => randomizeDesign('v5:mfff-y2026-f2040-test'));
});

test('animation permissions preserve the visual draw sequence and share-link replay', () => {
  const all = randomizeDesign(code('fff')), still = randomizeDesign(code('000'));
  for (const key of ['seed', 'visualStyle', 'nodeMode', 'nodeShape', 'nodeSize', 'nodeColorMode', 'ringRotations', 'maxRepos', 'layout', 'activityEffect', 'foreignGalaxies']) assert.deepEqual(all[key], still[key], key);
  const restored = decodeShare(encodeShare('https://example.test', 'example', all));
  assert.equal(restored.options.designCode, all.designCode);
  assert.deepEqual(restored.options.history, all.history);
  assert.equal(restored.options.starlightAnimate, true);
});

test('still v5 exports remain motion-free with public history data and full feature combinations', () => {
  const events = normalizePublicEvents(fixture.publicEvents);
  for (let i = 0; i < 12; i++) {
    const recipe = randomizeDesign(code('000', String(i)));
    const options = { ...recipe, referenceDate: fixture.referenceDate, historyData: { events, asOf: fixture.referenceDate }, codingRhythmData: deriveCodingRhythm(events, recipe, fixture.referenceDate), activityData: aggregateActivity(events, fixture.repositories, recipe, fixture.referenceDate) };
    const svg = renderConstellation('example', fixture.repositories, options);
    assert.doesNotMatch(svg, /<animate(?:Transform)? |animation:twinkle|class="[^"]*(?:activity-pulse|activity-ripple|activity-streak|history-pulse)|@keyframes history-birth/);
    assert.doesNotMatch(svg, /NaN|Infinity|<script|foreignObject/);
    assert.equal(svg, renderConstellation('example', [...fixture.repositories].reverse(), options));
  }
});

test('twinkle and activity animation can be disabled while independent background motion remains enabled', () => {
  const events = normalizePublicEvents(fixture.publicEvents);
  const svg = renderConstellation('example', fixture.repositories, { referenceDate: fixture.referenceDate, animate: true, starlightAnimate: false, activityAnimate: false, activityEffect: 'comet', activityWindow: '30d', activityData: aggregateActivity(events, fixture.repositories, { activityWindow: '30d' }, fixture.referenceDate), starfield: { mode: 'space', twinkle: true } });
  assert.doesNotMatch(svg, /animation:twinkle|class="activity-comet activity-streak/);
  assert.match(svg, /starfield-twinkle/);
  assert.match(svg, /class="activity-comet"/);
});
