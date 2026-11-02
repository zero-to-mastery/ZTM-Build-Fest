import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultStarfield, starfieldOptions, generateStarfield, renderStarfield } from '../src/starfield.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { randomizeDesign } from '../src/design-randomizer.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';
import { renderWorkflow } from '../src/export.mjs';
import { loadConfig } from '../src/config.mjs';

test('starfield has stable prefixes, independently seeded layers and bounded output', () => {
  const dense = generateStarfield('sky', { ...defaultStarfield, density: 100 });
  const sparse = generateStarfield('sky', { ...defaultStarfield, density: 20 });
  assert.equal(dense.length, 500); assert.equal(sparse.length, 100);
  assert.deepEqual(dense.slice(0, 100), sparse);
  assert.deepEqual(dense, generateStarfield('sky', { ...defaultStarfield, density: 100 }));
  assert.notDeepEqual(sparse, generateStarfield('another', { ...defaultStarfield, density: 20 }));
  assert.deepEqual(generateStarfield('a', { ...defaultStarfield, seed: 'background' }), generateStarfield('b', { ...defaultStarfield, seed: 'background' }));
  assert.equal(new Set(dense.map(point => point.layer)).size, 3);
  assert.ok(dense.some(point => point.sparkle));
  for (const point of dense) {
    assert.ok(point.x >= 6 && point.x <= 894 && point.y >= 6 && point.y <= 554);
    assert.ok(point.radius >= .3 && point.radius <= 1.5);
    assert.ok(point.opacity > 0 && point.opacity < 1);
  }
  assert.ok(generateStarfield('sky', defaultStarfield, { height: 280, detail: .3 }).length < sparse.length);
  assert.ok(Buffer.byteLength(renderStarfield('sky', { ...defaultStarfield, density: 100 })) < 100000);
});

test('framed starfields stay in the camera bounds without changing viewport density', () => {
  const svg = renderStarfield('sky', { ...defaultStarfield, density: 80, mode: 'milky-way' }, { x: 180, y: 60, width: 540, height: 337, densityHeight: 560 });
  const points = [...svg.matchAll(/<circle class="starfield-point[^>]*cx="([\d.]+)" cy="([\d.]+)"/g)];
  assert.equal(points.length, 400);
  for (const [, rawX, rawY] of points) {
    assert.ok(Number(rawX) >= 186 && Number(rawX) <= 714);
    assert.ok(Number(rawY) >= 66 && Number(rawY) <= 391);
  }
  assert.match(svg, /<ellipse cx="234\.0" cy="[\d.]+" rx="144\.0"/);
});

test('Milky Way concentrates stars in a band, flat depth removes size differences', () => {
  const options = { ...defaultStarfield, density: 100 };
  const field = generateStarfield('band', options), band = generateStarfield('band', { ...options, mode: 'milky-way' });
  const spread = points => points.reduce((sum, point) => sum + Math.abs(point.y / 560 - (.5 + .2 * Math.sin(point.x / 900 * Math.PI * 1.4 - .7))), 0) / points.length;
  assert.ok(spread(band) < spread(field) * .65);
  assert.deepEqual([...new Set(generateStarfield('sky', { ...options, depth: 0 }).map(point => point.radius))], [.6]);
});

test('legacy defaults, off, validation and motion/transparent output are safe', () => {
  assert.equal(starfieldOptions().mode, 'classic');
  assert.deepEqual(generateStarfield('sky', {}), []);
  assert.equal(renderStarfield('sky', { ...defaultStarfield, mode: 'off' }), '');
  assert.equal(renderStarfield('sky', { ...defaultStarfield, brightness: 0 }), '');
  for (const value of [null, [], { mode: 'invalid' }, { density: 101 }, { brightness: -1 }, { depth: NaN }, { twinkle: 'true' }, { seed: 1 }, { token: 'no' }]) assert.throws(() => starfieldOptions(value));
  const svg = renderConstellation('sky', [], { theme: 'deep-space', starfield: { ...defaultStarfield, mode: 'milky-way' } });
  assert.match(svg, /starfield-twinkle/); assert.match(svg, /prefers-reduced-motion:reduce.*starfield-twinkle/s);
  assert.doesNotMatch(renderStarfield('sky', defaultStarfield, { animate: false }), /starfield-twinkle/);
  assert.doesNotMatch(renderStarfield('sky', { ...defaultStarfield, twinkle: false }), /starfield-twinkle/);
  assert.doesNotMatch(renderStarfield('sky', { ...defaultStarfield, mode: 'milky-way' }, { transparent: true }), /starfield-haze/);
  assert.match(svg, /class="dust starfield" aria-hidden="true" pointer-events="none"/);
  assert.doesNotMatch(svg, /<script|<image|foreignObject/);
});

test('background generation never changes graph positions, selection or repository counts', () => {
  const repos = ['a', 'b', 'c'].map(name => ({ name, full_name: `sky/${name}`, language: 'Rust' }));
  const graph = svg => [...svg.matchAll(/<circle class="star"[^>]*>/g)].map(match => match[0]);
  const original = renderConstellation('sky', repos);
  const space = renderConstellation('sky', repos, { starfield: defaultStarfield });
  const changed = renderConstellation('sky', repos, { starfield: { ...defaultStarfield, seed: 'another', mode: 'milky-way' } });
  assert.deepEqual(graph(original), graph(space)); assert.deepEqual(graph(space), graph(changed));
  assert.equal(graph(space).length, 3);
  assert.match(renderConstellation('sky', repos, { starfield: defaultStarfield, selection: { start: 'sky/a' } }), /data-focus-start="sky\/a"/);
});

test('starfield config and v2 recipes round-trip through JSON, share links and workflows', async () => {
  const options = { starfield: { ...defaultStarfield, seed: 'my background', mode: 'milky-way' }, seedMode: 'custom', seed: 'my design' };
  assert.deepEqual(parseConfig(serializeConfig('sky', options)).options, options);
  assert.deepEqual(decodeShare(encodeShare('https://example.test', 'sky', options)).options, options);
  assert.deepEqual(await loadConfig(undefined, renderWorkflow('sky', options).split('          config-json: |\n')[1]), options);
  const v1 = randomizeDesign('v1:fixture'), v2 = randomizeDesign('v2:fixture');
  assert.equal(v1.starfield, undefined); assert.ok(v2.starfield);
  assert.deepEqual(v2, randomizeDesign('v2:fixture'));
  assert.deepEqual(parseConfig(serializeConfig('sky', v2)).options, v2);
  assert.equal(renderConstellation('sky', [], v2), renderConstellation('sky', [], v2));
});
