import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginHost, serializeConfig, parseConfig } from '../src/core-api.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';
import { themePacks } from '../packages/themes/index.mjs';

const feed = (id, items) => ({ id, source: 'json-feed', options: { items } });
test('source definitions and instance IDs are stable during an asynchronous load', async () => {
  let resume;
  const plugin = { id: 'delayed', apiVersion: 1, load: () => new Promise(resolve => { resume = resolve; }) };
  const host = createPluginHost().registerSource(plugin);
  plugin.load = () => { throw new Error('mutated'); };
  const config = { plugins: { sources: [{ id: 'original', source: 'delayed' }] } };
  const pending = host.load(config);
  config.plugins.sources[0].id = 'changed';
  resume([{ id: 'x', name: 'Stable' }]);
  const nodes = await pending;
  assert.equal(nodes[0].full_name, 'source:original:x');
  assert.throws(() => host.render('tester', [nodes[0], nodes[0]]), /Duplicate graph node ID/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(host.load(config, { signal: controller.signal }), /abort/i);
});
test('source instances coexist, report collisions, render custom nodes and preserve config', async () => {
  const host = createPluginHost();
  host.registerSource({ id: 'custom', apiVersion: 1, load: async () => [{ id: 'one', name: 'Custom' }], renderNode: () => ({ path: 'M0 -1 L1 1 L-1 1 Z', fill: '#abcdef' }) });
  const options = { plugins: { sources: [feed('a', [{ id: 'one', name: 'First' }]), { id: 'b', source: 'custom' }] }, animate: false };
  const nodes = await host.load(options);
  assert.deepEqual(nodes.map(node => node.full_name), ['source:a:one', 'source:b:one']);
  assert.match(host.render('tester', nodes, options), /class="plugin-node-icon"/);
  assert.equal(host.render('tester', nodes, options), host.render('tester', nodes, options));
  const restored = parseConfig(serializeConfig('tester', options));
  assert.deepEqual(decodeShare(encodeShare('https://example.com/', 'tester', restored.options)).options.plugins, options.plugins);
  await assert.rejects(host.load({ plugins: { sources: [feed('a', [{ id: 'one', name: 'A' }, { id: 'one', name: 'B' }])] } }), /Duplicate source node ID/);
  assert.throws(() => host.registerSource({ id: 'custom', apiVersion: 1, load() {} }), /already registered/);
});

test('JSON feed uses the injected fetch and rejects malformed feeds', async () => {
  let calls = 0;
  const host = createPluginHost({ fetchImpl: async url => { calls++; assert.equal(url, 'https://example.com/feed.json'); return Response.json([{ id: 'x', name: 'Feed' }]); } });
  const config = { plugins: { sources: [{ id: 'feed', source: 'json-feed', options: { url: 'https://example.com/feed.json' } }] } };
  assert.equal((await host.load(config))[0].name, 'Feed'); assert.equal(calls, 1);
  await assert.rejects(createPluginHost({ fetchImpl: async () => Response.json({}) }).load(config), /array/);
});

test('independent theme packs swap and portable embedded themes render identically', async () => {
  const host = createPluginHost();
  for (const pack of themePacks) host.registerThemePack(pack);
  const nodes = await host.load({ plugins: { sources: [feed('a', [{ id: 'one', name: 'A' }])] } });
  const pack = themePacks[0], options = { animate: false, themePack: { id: pack.id, version: pack.version } };
  const first = host.render('tester', nodes, options);
  assert.equal(first, host.render('tester', nodes, { ...options, themePack: pack }));
  assert.notEqual(first, host.render('tester', nodes, { ...options, themePack: themePacks[1] }));
  const external = { ...pack, id: 'external', version: '2.0.0' };
  host.registerThemePack(external);
  const restored = parseConfig(serializeConfig('tester', { ...options, themePack: { id: external.id, version: external.version } }));
  assert.match(host.render('tester', nodes, restored.options), /<svg/);
});

test('theme pack versions and fields are explicit; custom is a valid external pack ID', () => {
  const host = createPluginHost();
  for (const version of ['01.0.0', 'latest', '^1.0.0']) assert.throws(() => host.registerThemePack({ ...themePacks[0], version }), /version/);
  assert.throws(() => host.registerThemePack({ ...themePacks[0], preset: { ...themePacks[0].preset, maxRepos: 1 } }), /styling only/);
  const custom = { ...themePacks[0], id: 'custom' };
  const svg = host.registerThemePack(custom).render('tester', [], { themePack: { id: 'custom', version: '1.0.0' } });
  assert.ok(svg.includes(custom.preset.palette[2]));
});
