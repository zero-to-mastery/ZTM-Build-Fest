import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScene, createStory, renderSceneHTML, renderSceneSVG, serializeScene, parseScene } from '../src/core-api.mjs';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';

const records = ['compiler', 'runtime'].map(name => ({ name, full_name: `demo/${name}`, language: 'Rust' }));
const options = { referenceDate: '2026-09-01T00:00:00Z', animate: false };
const scene = createScene('demo', records, options);
const definition = { scenes: [{ id: 'projects', scene }], chapters: [
  { id: 'intro', title: 'Projects', narration: 'A supplied project story.', scene: 'projects' },
  { id: 'detail', title: 'Compiler', narration: '<script>window.injected=true</script>', scene: 'projects', path: { start: 'demo/compiler', end: 'demo/runtime' }, camera: [200, 100, 450, 280], theme: 'light', annotations: [{ x: 450, y: 50, text: 'Shared Rust' }], layers: { starfield: { visible: false } } },
] };

test('stories compile declarative chapter state with static fallback and safe serialization', () => {
  const story = createStory(definition);
  assert.equal(story.story.chapters[1].scene.layers.find(layer => layer.id === 'starfield').visible, false);
  assert.equal(story.story.chapters[1].scene.presentation.options.theme, 'light');
  assert.match(renderSceneSVG(story.story.chapters[1].scene), /scene-annotation/);
  assert.equal(renderSceneSVG(story), renderSceneSVG(scene));
  assert.equal(serializeScene(parseScene(serializeScene(story))), serializeScene(story));
  assert.throws(() => createStory({ chapters: [{ scene, selection: ['missing'] }] }), /missing node/);
  assert.throws(() => createStory({ chapters: [{ scene, layout: 'force' }] }), /definition/);
  const laidOut = createStory({ chapters: [{ definition: { account: 'demo', records, options }, layout: 'force' }] });
  assert.equal(laidOut.story.chapters[0].scene.presentation.options.arrangement, 'force');
});

test('offline stories apply chapter camera, selection, narration and controls', { skip: !browser, timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'constellation-story-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'index.html'); await writeFile(file, renderSceneHTML(createStory(definition)));
  const { evaluate, waitFor, errors, cdp } = await openBrowser(t, pathToFileURL(file).href);
  await waitFor(`Boolean(document.querySelector('main')?.constellation)`);
  assert.equal(await evaluate(`document.querySelector('main').constellation.chapterIndex`), 0);
  await evaluate(`window.originalNode = document.querySelector('[data-repo="demo/compiler"]').closest('.repository'); document.querySelector('main').constellation.setChapter('detail')`);
  assert.equal(await evaluate(`originalNode === document.querySelector('[data-repo="demo/compiler"]').closest('.repository')`), true);
  await waitFor(`document.querySelector('main').constellation.camera[2] === 450`, 30000);
  assert.deepEqual(await evaluate(`document.querySelector('main').constellation.camera`), [200, 100, 450, 280]);
  assert.deepEqual(await evaluate(`document.querySelector('main').constellation.selectionState.path`), ['demo/compiler', 'demo/runtime']);
  assert.match(await evaluate(`document.querySelector('[aria-label=Story] p').textContent`), /<script>/);
  assert.equal(await evaluate('Boolean(window.injected)'), false);
  await evaluate(`document.querySelector('[aria-label=Story] button').click()`);
  assert.equal(await evaluate(`document.querySelector('main').constellation.chapterIndex`), 0);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await waitFor(`document.querySelector('main').hasAttribute('data-reduced-motion')`);
  await evaluate(`document.querySelector('main').constellation.setChapter('detail')`);
  assert.deepEqual(await evaluate(`document.querySelector('main').constellation.camera`), [200, 100, 450, 280]);
  assert.equal(await evaluate(`document.querySelector('.repository').getAnimations().length`), 0);
  assert.deepEqual(errors, []);
});
