import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConstellation } from '../src/constellation.mjs';
import { renderWorkflow } from '../src/export.mjs';

const repos = [
  { name: 'a', full_name: 'o/a', language: 'Rust' },
  { name: 'b', full_name: 'o/b', language: 'Rust' },
  { name: 'c', full_name: 'o/c', language: 'CSS' },
];
test('selected node exports its highlighted neighborhood and clears cleanly', () => {
  const options = { selection: { start: 'o/a' } };
  const svg = renderConstellation('octocat', repos, options);
  assert.match(svg, /data-focus-start="o\/a"/);
  assert.equal((svg.match(/<g class="repository" data-related/g) || []).length, 2);
  assert.equal((svg.match(/<path class="shared-language" data-related/g) || []).length, 1);
  assert.match(svg, /svg\[data-exploring\] .repository/);
  const restored = JSON.parse(renderWorkflow('octocat', options).split('          config-json: |\n')[1]);
  assert.equal(renderConstellation('octocat', repos, restored), svg);
  assert.ok(!renderConstellation('octocat', repos, { selection: {} }).includes('data-exploring'));
  assert.ok(!renderConstellation('octocat', repos, { selection: { start: 'missing' } }).includes('data-exploring'));
});

test('path selections include only the traced edges and handle disconnected endpoints', () => {
  const svg = renderConstellation('octocat', repos, { nodeMode: 'combined', selection: { start: 'o/a', end: 'o/b' } });
  assert.equal((svg.match(/<g class="repository" data-related/g) || []).length, 3);
  assert.equal((svg.match(/<path class="shared-language" data-related/g) || []).length, 2);
  const disconnected = renderConstellation('octocat', repos, { selection: { start: 'o/a', end: 'o/c' } });
  assert.equal((disconnected.match(/<g class="repository" data-related/g) || []).length, 2);
  assert.equal((disconnected.match(/<path class="shared-language" data-related/g) || []).length, 0);
});

test('focused SVG preserves animation and focus in its reduced-motion fallback', () => {
  const svg = renderConstellation('octocat', repos, { selection: { start: 'o/a' }, ringAnimation: { enabled: true } });
  assert.match(svg, /<animate /);
  assert.match(svg, /<path class="shared-language" data-related/);
  const encoded = svg.match(/href="data:image\/svg\+xml,([^"]+)"/)[1];
  const fallback = decodeURIComponent(encoded);
  assert.match(fallback, /data-focus-start="o\/a"/);
  assert.match(fallback, /<g class="repository" data-related/);
  assert.throws(() => renderConstellation('octocat', repos, { selection: { start: 123 } }), /selection/);
});
