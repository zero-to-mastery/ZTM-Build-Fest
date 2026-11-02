import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createScene, renderSceneSVG, renderConstellation, serializeScene, parseScene, validateScene } from '../src/core-api.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/scene-svg-v2.json', import.meta.url)));
const snapshot = await readFile(new URL('./fixtures/scene-v1.json', import.meta.url), 'utf8');

test('scene snapshot, IDs and ordering are stable across cache state and object key order', () => {
  const options = fixture.cases[0].options;
  const scene = createScene(fixture.account, fixture.repositories, options);
  assert.equal(serializeScene(scene), snapshot);
  createScene('another-account', fixture.repositories, { ...options, arrangement: 'force' });
  const reordered = fixture.repositories.map(repo => Object.fromEntries(Object.entries(repo).reverse()));
  assert.equal(serializeScene(createScene(fixture.account, reordered, options)), snapshot);
  assert.equal(serializeScene(parseScene(snapshot)), snapshot);
  assert.deepEqual(validateScene(scene), { valid: true, errors: [] });
});

test('malformed scene data fails at the scene boundary with diagnostics', () => {
  const mutations = [
    scene => { scene.nodes[0].geometry.x = NaN; },
    scene => { scene.nodes[1].id = scene.nodes[0].id; },
    scene => { scene.edges[0].to = 'absent'; },
    scene => { scene.layers[1].order = scene.layers[0].order; },
    scene => { scene.labels[0].x = Infinity; },
    scene => { scene.nodes[0].style.color = 'red;stroke:url(https://example.com)'; },
    scene => { scene.geometry.ringPoints.push(1); },
    scene => { scene.metadata.callback = () => {}; },
    scene => { scene.metadata.cycle = scene; },
  ];
  for (const mutate of mutations) {
    const scene = parseScene(snapshot);
    mutate(scene);
    assert.equal(validateScene(scene).valid, false);
    assert.throws(() => renderSceneSVG(scene), /Scene/);
    assert.throws(() => serializeScene(scene), /Scene/);
  }
  assert.throws(() => parseScene('{"version":99}'), /version/);
  assert.throws(() => parseScene('{"__proto__":{}}'), /unsafe/);
});

test('scene rendering and JSON round trips preserve reference SVG bytes', () => {
  for (const { options, sha256 } of fixture.cases) {
    const scene = createScene(fixture.account, fixture.repositories, options);
    const svg = renderSceneSVG(JSON.parse(serializeScene(scene)));
    assert.equal(createHash('sha256').update(svg).digest('hex'), sha256, JSON.stringify(options));
    assert.equal(renderConstellation(fixture.account, fixture.repositories, options), svg);
  }
});

test('scene records own geometry, metadata, labels and trusted plugin icon data', () => {
  const repositories = structuredClone(fixture.repositories);
  const scene = createScene(fixture.account, repositories, fixture.cases[0].options, { nodeRenderer: () => ({ path: 'M0 -1L1 0L0 1L-1 0Z', fill: '#abcdef' }) });
  assert.equal(scene.nodes.length, 4);
  assert.ok(scene.nodes.every(node => node.id === node.metadata.full_name && Number.isFinite(node.geometry.x)));
  assert.ok(scene.edges.every(edge => scene.nodes.some(node => node.id === edge.from) && scene.nodes.some(node => node.id === edge.to)));
  assert.ok(scene.labels.every(label => Number.isFinite(label.x) && typeof label.text === 'string'));
  const before = serializeScene(scene);
  repositories[0].name = 'changed';
  repositories[0].languages.Rust = 0;
  assert.equal(serializeScene(scene), before);
  const moved = structuredClone(scene);
  moved.nodes[0].geometry.x = 123;
  assert.match(renderSceneSVG(moved), /cx="123.0"/);
  assert.notEqual(renderSceneSVG(moved), renderSceneSVG(scene));
});
