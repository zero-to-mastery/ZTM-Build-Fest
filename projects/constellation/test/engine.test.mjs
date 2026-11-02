import test from 'node:test';
import assert from 'node:assert/strict';
import { computeScene, identityGeometry, graphSelection, rustAvailable, engineError } from '../src/engine.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { renderWorkflow } from '../src/export.mjs';

test('the shipped Rust binary loads and matches the identity gist seed vector', () => {
  assert.equal(rustAvailable, true, engineError?.message);
  const ring = identityGeometry('a');
  assert.equal(ring.length, 90);
  assert.deepEqual(ring.slice(0, 2), [1, 4167209092]);
  assert.deepEqual(ring, identityGeometry('a'));
  assert.notDeepEqual(ring, identityGeometry('b'));
  assert.throws(() => identityGeometry('', 0));
  assert.throws(() => identityGeometry('a', 1000));
});

test('Rust traversal follows displayed edges, handles cycles and isolated nodes', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'isolated'];
  const pairs = [0, 1, 1, 2, 2, 3, 0, 4, 4, 3];
  assert.deepEqual(graphSelection(names, pairs, 'a'), ['a', 'b', 'e']);
  assert.deepEqual(graphSelection(names, pairs, 'a', 'd'), ['a', 'e', 'd']);
  assert.deepEqual(graphSelection(names, pairs, 'a', 'isolated'), []);
  assert.deepEqual(graphSelection(names, pairs, 'a', 'a'), ['a']);
  assert.deepEqual(graphSelection(names, pairs, 'missing'), []);
});

test('Rust layouts preserve filters, manual edits and exported settings', () => {
  const repos = Array.from({ length: 12 }, (_, i) => ({ name: `repo-${i}`, full_name: `octocat/repo-${i}`, language: 'Rust', languages: { Rust: 100, CSS: 10 }, topics: ['tools'] }));
  for (const layout of ['compact', 'atlas']) for (const arrangement of ['field', 'orbital', 'force']) {
    const options = { layout, arrangement, identityRing: true, connectionBasis: 'both', languages: ['CSS'], topics: ['tools'],
      starPositions: { 'octocat/repo-0': { x: 222, y: 111 } }, labelPositions: { 'octocat/repo-0': { x: 230, y: 140 } } };
    const svg = renderConstellation('octocat', repos, options);
    assert.match(svg, /class="identity-ring" aria-hidden="true"/);
    assert.match(svg, /class="star" cx="222.0" cy="111.0"/);
    assert.match(svg, /data-languages="CSS" data-topics="tools"/);
    assert.match(svg, /data-repo="octocat\/repo-0" x="230.0" y="140.0"/);
    assert.equal(svg, renderConstellation('octocat', [...repos].reverse(), options));
    const restored = JSON.parse(renderWorkflow('octocat', options).split('          config-json: |\n')[1]);
    assert.equal(svg, renderConstellation('octocat', repos, restored));
    assert.doesNotMatch(renderConstellation('octocat', repos, { ...options, identityRing: false }), /<g class="identity-ring"/);
  }
});

test('scene validation rejects unsupported layouts and oversized graphs', () => {
  const input = { account: 'octocat', repos: [], compact: false, arrangement: 'orbital', basis: 'languages', all: false };
  assert.deepEqual(computeScene(input), { positions: [], edges: [], total: 0 });
  assert.throws(() => computeScene({ ...input, arrangement: 'unknown' }));
  assert.throws(() => renderConstellation('octocat', [], { identityRing: 'yes' }));
  const repo = { name: 'test', group: 'Rust', languages: ['Rust'], topics: [], position: null };
  assert.throws(() => computeScene({ ...input, repos: Array(101).fill(repo) }));
});
