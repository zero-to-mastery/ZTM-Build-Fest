import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createScene, renderSceneSVG, serializeScene, parseScene, parseConfig, sceneStatistics } from '../src/core-api.mjs';

test('2048-node scenes preserve coordinates, references and bounded automatic labels through serialization', () => {
  const repositories = Array.from({ length: 2048 }, (_, i) => ({ full_name: `large/node-${i}`, name: `node-${i}`, language: 'Rust' }));
  const options = { nodeCap: 2048, maxRepos: 2048, referenceDate: '2026-09-01T00:00:00Z', animate: false };
  const first = createScene('large', repositories, options);
  const clone = parseScene(serializeScene(first));
  assert.equal(sceneStatistics(clone).nodes, 2048);
  assert.ok(clone.labels.length <= 100);
  assert.ok(clone.edges.length < 2048 * 4);
  assert.equal((renderSceneSVG(clone).match(/class="star"/g) || []).length, 2048);
  clone.nodes[0].geometry.x = -1;
  const again = createScene('large', repositories, options);
  assert.deepEqual(again.nodes.map(node => node.geometry), first.nodes.map(node => node.geometry));
  assert.notEqual(again.nodes[0].geometry.x, -1);
});

test('existing example configs preserve v6 options through scene compilation and rendering', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/scene-svg-v2.json', import.meta.url)));
  const directory = new URL('../examples/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.json'))) {
    const parsed = parseConfig(await readFile(new URL(name, directory), 'utf8'));
    assert.equal(parsed.version, 7, name);
    // Network plugin acquisition is separate from compiling an offline record set.
    const scene = createScene('fixture', fixture.repositories, { ...parsed.options, referenceDate: '2026-09-01T00:00:00Z' });
    assert.equal(renderSceneSVG(parseScene(serializeScene(scene))), renderSceneSVG(scene), name);
  }
});
