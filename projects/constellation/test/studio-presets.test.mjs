import { createGitHubAccess } from "../src/github-access.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { studioPresets, presetOptions } from '../src/studio-presets.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { createPreviewData } from '../src/preview-data.mjs';
import { graphNodes, renderConstellation } from '../src/constellation.mjs';
import { resolveTheme } from '../src/themes.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';

test('Mnix is a portable theme independent of the account preset', () => {
  const options = { ...presetOptions('flagship-projects'), visualTheme: 'mnix', nodeColorMode: 'custom' };
  const shared = decodeShare(encodeShare('https://example.com/', 'alice', options));
  assert.equal(shared.options.visualTheme, 'mnix');
  assert.equal(shared.options.arrangement, 'solar-system');
  assert.deepEqual(resolveTheme(shared.options).colors, {
    background: '#111111', foreground: '#f3f3f4', accent: '#e3de13', line: '#555a38', star: '#e3de13',
  });
  assert.equal(presetOptions('classic-constellation').visualTheme, 'constellation');
  const svg = renderConstellation('alice', [], { theme: 'mnix' });
  assert.match(svg, /--sky-accent:#595600/);
  assert.match(svg, /@media\(prefers-color-scheme:dark\)\{svg\{[^}]*--sky-accent:#e3de13/);
  assert.match(svg, /background:transparent!important/);
  assert.doesNotMatch(svg, /<ellipse[^>]*fill="url\(#nebula\)"/);
});

test('general presets leave organization-only views', () => {
  const options = presetOptions('language-orbits', { accountType: 'organization', organizationView: 'collaboration' });
  assert.equal(options.organizationView, 'projects');
  assert.equal(options.nodeMode, 'languages');
  assert.equal(options.accountType, 'organization');
});

test('built-in presets round-trip, render, and replace restrictive random settings', () => {
  const repositories = [{ name: 'example', full_name: 'collective/example', private: false, language: 'Rust', languages: { Rust: 100 }, created_at: '2020-01-01T00:00:00Z', stargazers_count: 20 }];
  for (const preset of studioPresets) {
    const options = presetOptions(preset.id, { designCode: 'old', minStars: 999999, languages: [], history: { mode: 'historical', year: 1970 }, hiddenNodes: ['collective/example'] });
    const config = parseConfig(serializeConfig('collective', options));
    assert.ok(graphNodes(repositories, config.options).nodes.length, preset.id);
    assert.match(renderConstellation('collective', repositories, config.options), /<svg/);
    assert.equal(config.options.designCode, undefined);
    assert.equal(config.options.history, undefined);
    assert.equal(config.options.hiddenNodes, undefined);
  }
});

test('organization atlas loads without contributor or user contribution requests', async () => {
  const calls = [];
  const data = authenticatedPreviewData({ fetchImpl: async url => {
    calls.push(url);
    const path = new URL(url).pathname;
    if (path === '/orgs/collective') return Response.json({ login: 'collective', type: 'Organization', public_repos: 1 });
    if (path === '/orgs/collective/repos') return Response.json([{ name: 'example', full_name: 'collective/example', private: false, language: 'Rust', languages: { Rust: 100 } }]);
    if (path.endsWith('/events')) return Response.json([]);
    throw new Error('Unexpected request: ' + path);
  } });
  const repositories = await data.load('collective', presetOptions('organization-projects'));
  assert.equal(repositories.length, 1);
  assert.equal(data.organization('collective').scanned, 0);
  assert.equal(calls.some(url => /contributors|search\/issues/.test(url)), false);
});

function authenticatedPreviewData(options = {}) { return createPreviewData({ ...options, access: createGitHubAccess({ authenticated: true }) }); }
