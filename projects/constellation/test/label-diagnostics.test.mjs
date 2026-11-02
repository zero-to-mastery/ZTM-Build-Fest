import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConstellation } from '../src/constellation.mjs';

test('crowded label omissions explain each missing label without changing SVG bytes', () => {
  const repos = Array.from({ length: 100 }, (_, i) => ({ name: `crowded-project-${i}`, full_name: `tester/project-${i}`, language: 'Rust' }));
  const options = { maxRepos: 100, animate: false, starPositions: Object.fromEntries(repos.map(repo => [repo.full_name, { x: 450, y: 120 }])) };
  const diagnostics = [];
  const svg = renderConstellation('tester', repos, options, { onDiagnostic: item => diagnostics.push(item) });
  assert.equal(svg, renderConstellation('tester', repos, options));
  assert.ok(diagnostics.length > 0);
  const labels = [...svg.matchAll(/<text class="repo-label" data-repo="([^"]+)"/g)].map(match => match[1]);
  assert.equal(labels.length + diagnostics.length, repos.length);
  assert.equal(new Set(diagnostics.map(item => item.node)).size, diagnostics.length);
  for (const item of diagnostics) {
    assert.equal(item.code, 'label-omitted');
    assert.equal(item.reason, 'no-collision-free-position');
    assert.ok(!labels.includes(item.node));
  }
});
