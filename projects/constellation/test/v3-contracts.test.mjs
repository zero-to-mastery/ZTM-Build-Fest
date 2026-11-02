import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { CONFIG_VERSION, SCENE_VERSION, RENDERER_API_VERSION, LAYOUT_API_VERSION, PLUGIN_API_VERSION, SOURCE_API_VERSION, THEME_API_VERSION, STORY_VERSION, createScene, renderScene, renderSceneSVG, htmlRenderer, migrateConfig, migrateWorkflow, parseConfig, createPluginHost } from '../src/core-api.mjs';
import { renderWorkflow } from '../src/export.mjs';
import { themePacksV2 } from '../packages/themes/index.mjs';

test('stable v3 contracts migrate v6 data without changing SVG output', async () => {
  assert.deepEqual([CONFIG_VERSION, SCENE_VERSION, RENDERER_API_VERSION, LAYOUT_API_VERSION, PLUGIN_API_VERSION, SOURCE_API_VERSION, THEME_API_VERSION, STORY_VERSION], [7, 1, 1, 1, 2, 2, 2, 1]);
  const fixture = JSON.parse(await readFile(new URL('./fixtures/migration-v6.json', import.meta.url)));
  const migrated = migrateConfig(fixture), options = parseConfig(migrated).options;
  assert.equal(migrated.version, 7); assert.deepEqual(migrateConfig(migrated), migrated);
  const records = [{ name: 'core', full_name: 'fixture/core', language: 'Rust', stargazers_count: 42 }];
  const before = createScene('fixture', records, fixture.options), after = createScene('fixture', records, options);
  assert.equal(renderSceneSVG(before), renderSceneSVG(after));
  assert.equal(renderScene(after), renderSceneSVG(after));
  assert.match(renderScene(after, { renderer: htmlRenderer }), /^<!doctype html>/);
  const workflow = renderWorkflow('fixture', fixture.options).replace('@v3', '@v2').replace('"version": 7', '"version": 6');
  const output = migrateWorkflow(workflow);
  assert.match(output, /constellation@v3/); assert.match(output, /"version": 7/);
  assert.equal(migrateWorkflow(output), output);
  assert.throws(() => migrateWorkflow('uses: mnichols08/constellation@v2-custom'), /Expected/);
  assert.match(migrateWorkflow("uses: 'mnichols08/constellation@v2'"), /@v3'/);
  assert.throws(() => parseConfig({ version: 8, account: 'fixture', options: {} }), /Unsupported/);
});

test('CLI explains canonical JSON sources with activity enabled and stays offline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'constellation-source-v2-')); t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'repos.json'), config = join(root, 'config.json');
  await writeFile(fixture, '[]');
  await writeFile(config, JSON.stringify({ version: 7, account: 'fixture', activityEffect: 'pulse', plugins: { sources: [{ id: 'canonical', source: 'json-records', options: { items: [{ version: 1, type: 'record', id: 'one', label: 'One', kind: 'project', source: { id: 'fixture' }, metrics: { stars: 10 }, attributes: { language: 'Rust' } }] } }] } }));
  const result = spawnSync(process.execPath, ['src/cli.mjs', '--username', 'fixture', '--fixture', fixture, '--config', config, '--scene', '--explain', '--reference-date', '2026-09-01'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CONSTELLATION_CONFIG_JSON: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).nodes, 1);
});

test('Source API v2 preserves normalized metrics and coexists with legacy sources and Theme API v2', async () => {
  const record = { version: 1, type: 'record', id: 'one', label: 'One', kind: 'project', source: { id: 'custom' }, metrics: { stars: 9, quality: 0.75 }, attributes: { language: 'Rust' } };
  const host = createPluginHost().registerSource({ id: 'canonical', apiVersion: 2, load: async () => [record] });
  const options = { plugins: { sources: [{ id: 'new', source: 'canonical' }, { id: 'old', source: 'json-feed', options: { items: [{ id: 'one', name: 'Legacy', language: 'Rust' }] } }] } };
  const result = await host.loadRecords(options);
  assert.equal(result.records.length, 2);
  assert.equal(result.records.find(record => record.id === 'source:new:one').metrics.quality, 0.75);
  assert.equal(host.apiVersion, 2);
  const scene = host.createScene('fixture', result.records, { referenceDate: '2026-09-01', mappings: { opacity: { field: 'metrics.quality', domain: [0, 1], range: [0, 1] } } });
  assert.equal(scene.nodes.find(node => node.id === 'source:new:one').style.opacity, .75);
  const pack = themePacksV2[0]; assert.equal(pack.apiVersion, 2); host.registerThemePack(pack);
  assert.match(host.render('fixture', result.records, { themePack: pack }), /<svg/);
  const bad = createPluginHost().registerSource({ id: 'bad', apiVersion: 2, load: async () => [{ ...record, metrics: { quality: NaN } }] });
  await assert.rejects(bad.load({ plugins: { sources: [{ id: 'bad', source: 'bad' }] } }), /normalized records/);
  assert.equal(bad.cacheStatistics.entries, 0);
});

test('missing WASM fails explicitly instead of selecting a JavaScript rendering fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'constellation-no-wasm-')); t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../packages/core/', import.meta.url), root, { recursive: true });
  await rm(join(root, 'src', 'wasm', 'inline.mjs'));
  const entry = join(root, 'probe.mjs');
  await writeFile(entry, `await import(${JSON.stringify(pathToFileURL(join(root, 'src/core-api.mjs')).href)});`);
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /requires its bundled Rust\/WASM engine/);
});

test('Studio reports a blocked required WASM asset accessibly', { skip: !browser, timeout: 120000 }, async t => {
  const server = createPreviewServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { cdp, evaluate, waitFor } = await openBrowser(t, 'about:blank');
  await cdp('Network.enable'); await cdp('Network.setBlockedURLs', { urls: ['*wasm/inline.mjs', '*wasm/constellation_core_bg.wasm'] });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await waitFor(`document.querySelector('#status')?.getAttribute('role') === 'alert'`);
  assert.match(await evaluate(`document.querySelector('#status').textContent`), /engine couldn.t start/);
  assert.equal(await evaluate(`document.querySelector('#engine-status').hidden`), false);
  assert.match(await evaluate(`document.querySelector('#engine-status').textContent`), /WebAssembly/);
  assert.equal(await evaluate(`document.querySelector('#open-studio').disabled`), true);
});
