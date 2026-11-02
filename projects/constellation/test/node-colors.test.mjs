import test from 'node:test';
import assert from 'node:assert/strict';
import { randomNodeColors } from '../src/visual-style.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { renderWorkflow } from '../src/export.mjs';

test('random hues remain distinct at the maximum graph size', () => {
  const ids = Array.from({ length: 256 }, (_, i) => `node:${i}`);
  const colors = randomNodeColors(ids, () => .42);
  assert.equal(Object.keys(colors).length, 256);
  assert.equal(new Set(Object.values(colors)).size, 256);
  assert.ok(Object.values(colors).every(color => /^#[0-9a-f]{6}$/.test(color)));
  assert.deepEqual(randomNodeColors([]), {});
  assert.notDeepEqual(colors, randomNodeColors(ids, () => .7));
});

test('colored connections use both endpoints and survive exports and movement', () => {
  const repos = ['a', 'b'].map(name => ({ name, full_name: `o/${name}`, language: 'Rust' }));
  const options = { nodeColors: { 'o/a': '#ff0000', 'o/b': '#0000ff' }, colorConnections: true };
  const svg = renderConstellation('octocat', repos, options);
  assert.match(svg, /stop-color="#ff0000"/);
  assert.match(svg, /stop-color="#0000ff"/);
  assert.match(svg, /style="stroke:url\(#connection-color-0\)"/);
  const restored = JSON.parse(renderWorkflow('octocat', options).split('          config-json: |\n')[1]);
  assert.equal(renderConstellation('octocat', repos, restored), svg);
  const moved = renderConstellation('octocat', repos, { ...options, starPositions: { 'o/a': { x: 210, y: 140 } } });
  assert.match(moved, /x[12]="210.0" y[12]="140.0"/);
  const off = renderConstellation('octocat', repos, { ...options, colorConnections: false });
  assert.ok(!off.includes('linearGradient'));
  assert.match(off, /--node-color:#ff0000/);
  assert.throws(() => renderConstellation('octocat', repos, { colorConnections: 'true' }), /boolean/);
});
