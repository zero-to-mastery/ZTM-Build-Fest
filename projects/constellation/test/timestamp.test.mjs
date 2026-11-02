import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConstellation } from '../src/constellation.mjs';

test('generation time uses UTC in both layouts without changing the graph', () => {
  for (const [layout, y] of [['compact', 266], ['atlas', 546]]) {
    const options = { layout, generatedAt: '2026-09-26T14:05:07-04:00' };
    const svg = renderConstellation('octocat', [], options);
    assert.ok(svg.includes(`<text class="generated-at" x="32" y="${y}">Generated 2026-09-26 18:05:07 UTC</text>`));
    assert.match(svg, /class="credit".*mnichols08\/constellation/);
    assert.equal(svg, renderConstellation('octocat', [], options));
    assert.match(svg, /\.generated-at\{[^}]*var\(--sky-foreground\)/);
    const later = renderConstellation('octocat', [], { ...options, generatedAt: '2026-09-27T18:05:07Z' });
    assert.equal(svg.replace('Generated 2026-09-26', 'Generated 2026-09-27'), later);
  }
  assert.throws(() => renderConstellation('octocat', [], { generatedAt: '<script>' }), /valid date/);
});
