import test from 'node:test';
import assert from 'node:assert/strict';
import { createHierarchy, createOrganizationHierarchy, createScene, serializeScene, parseScene, renderSceneSVG, renderSceneHTML } from '../src/core-api.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';

const options = { referenceDate: '2026-09-01T00:00:00Z', animate: false };
const root = createScene('demo', [{ name: 'compiler', full_name: 'demo/compiler', language: 'Rust' }], options);
const definition = { root: 'account', scenes: [
  { id: 'account', title: 'Projects', scene: root, links: [{ nodeId: 'demo/compiler', target: 'compiler' }] },
  { id: 'compiler', title: 'Compiler technologies', definition: { account: 'demo', records: [{ name: 'Rust', full_name: 'technology:Rust', nodeKind: 'language', language: 'Rust' }], options } },
] };

test('organization detail scenes reuse verified project and contributor scope without API calls', () => {
  const repositories = [{ name: 'compiler', full_name: 'demo/compiler', language: 'Rust', languages: { Rust: 90, C: 10 }, topics: ['compiler'] }, { name: 'private', full_name: 'demo/private', private: true, language: 'Rust' }];
  const scene = createOrganizationHierarchy('demo', repositories, { ...options, organizationData: { records: { 'demo/compiler': [{ login: 'alice', contributions: 5 }], 'demo/private': [{ login: 'secret', contributions: 8 }] }, scanned: 1, selected: 2, complete: false } });
  const child = scene.hierarchy.scenes.find(entry => entry.id === 'repository:demo/compiler').scene;
  assert.ok(child.nodes.some(node => node.id === 'contributor:alice'));
  assert.ok(child.nodes.some(node => node.id === 'language:Rust'));
  assert.ok(child.nodes.some(node => node.id === 'language:C'));
  assert.ok(!child.nodes.some(node => node.id === 'contributor:secret'));
  assert.ok(!serializeScene(scene).includes('contributor:secret'));
  assert.ok(!serializeScene(scene).includes('demo/private'));
  assert.match(child.presentation.graph.note, /already-loaded/);
  assert.equal(scene.hierarchy.scenes.length, 2);
  assert.throws(() => createOrganizationHierarchy('demo', repositories, options, { maxProjects: 64 }), /maxProjects/);
});

test('explicit node references compile into deterministic serializable child scenes', () => {
  const scene = createHierarchy(definition);
  assert.equal(scene.nodes[0].interaction.childScene, 'compiler');
  assert.equal(root.nodes[0].interaction.childScene, undefined);
  assert.equal(scene.hierarchy.scenes[1].scene.nodes[0].id, 'technology:Rust');
  assert.equal(serializeScene(scene), serializeScene(createHierarchy({ ...definition, scenes: [...definition.scenes].reverse() })));
  assert.equal(renderSceneSVG(parseScene(serializeScene(scene))), renderSceneSVG(scene.hierarchy.scenes[0].scene));
  const invalid = structuredClone(definition); invalid.scenes[0].links[0].target = 'missing';
  assert.throws(() => createHierarchy(invalid), /Missing child/);
  const abort = new AbortController(); abort.abort();
  assert.throws(() => createHierarchy(definition, { signal: abort.signal }), /abort/i);
});

test('hierarchy rejects cycles, shared-branch depth overflow and oversized catalogs', () => {
  const cyclic = structuredClone(definition);
  cyclic.scenes[1] = { id: 'compiler', scene: root, links: [{ nodeId: 'demo/compiler', target: 'account' }] };
  assert.throws(() => createHierarchy(cyclic), /cycle/);
  const chain = length => Array.from({ length }, (_, i) => ({ id: String(i).padStart(2, '0'), scene: root, links: i ? [{ nodeId: 'demo/compiler', target: String(i - 1).padStart(2, '0') }] : [] }));
  assert.equal(createHierarchy({ root: '15', scenes: chain(16) }).hierarchy.scenes.length, 16);
  assert.throws(() => createHierarchy({ root: '16', scenes: chain(17) }), /16 levels/);
  assert.throws(() => createHierarchy({ root: '00', scenes: chain(65) }), /definitions/);
});

test('hierarchy drill-down, breadcrumbs and browser deep links restore compiled scenes', { skip: !browser, timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'constellation-hierarchy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'index.html'); await writeFile(file, renderSceneHTML(createHierarchy(definition)));
  const { evaluate, waitFor, cdp, errors } = await openBrowser(t, pathToFileURL(file).href);
  await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
  await evaluate(`document.querySelector('main').constellation.selectNode('demo/compiler', {focus:false}); document.querySelector('[data-details] button').click()`);
  assert.deepEqual(await evaluate(`document.querySelector('main').constellation.scenePath`), ['account', 'compiler']);
  assert.equal(await evaluate(`document.querySelector('.star').dataset.repo`), 'technology:Rust');
  assert.equal(await evaluate(`document.querySelector('[aria-current=page]').textContent`), 'Compiler technologies');
  assert.match(await evaluate(`document.querySelector('main').constellation.shareURL()`), /constellation=/);
  await cdp('Page.reload');
  await waitFor(`document.querySelector('main')?.constellation?.scenePath?.length === 2`);
  await evaluate(`document.querySelector('main').constellation.home()`);
  assert.deepEqual(await evaluate(`document.querySelector('main').constellation.scenePath`), ['account']);
  await evaluate('history.back()');
  await waitFor(`document.querySelector('main')?.constellation?.scenePath?.length === 2`);
  await evaluate(`document.querySelector('main').constellation.back()`);
  assert.deepEqual(await evaluate(`document.querySelector('main').constellation.scenePath`), ['account']);
  assert.ok(await evaluate(`document.querySelector('main').constellation.navigationCacheStatistics.entries <= 8`));
  await evaluate(`history.replaceState(null,'','#constellation=%5B%22account%22%2C%22missing%22%5D')`);
  await cdp('Page.reload');
  await waitFor(`document.querySelector('main')?.constellation?.scenePath?.length === 1`);
  assert.deepEqual(errors, []);
});
