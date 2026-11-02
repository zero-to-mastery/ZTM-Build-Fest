import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGraphQuality, GRAPH_QUALITY_VERSION } from '../src/engine.mjs';

test('Graph Quality v1 penalizes dense, overlapping visualizations', () => {
  const good = { name: 'good', nodes: [
    { id: 'a', kind: 'project', label: 'Atlas', x: 100, y: 100, evidence: ['rust', 'cli'] },
    { id: 'b', kind: 'project', label: 'Garden', x: 300, y: 100, evidence: ['typescript', 'web'] },
    { id: 'c', kind: 'project', label: 'Orbit', x: 500, y: 100, evidence: ['rust', 'web'] },
  ], edges: [{ from: 'a', to: 'c' }], groups: [{ id: 'g', members: ['a', 'c'], evidence: ['systems'] }] };
  const bad = { ...good, name: 'bad', nodes: good.nodes.map(node => ({ ...node, x: 100, y: 100, evidence: [] })), edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'c' }] };
  const a = evaluateGraphQuality(good), b = evaluateGraphQuality(bad);
  assert.equal(GRAPH_QUALITY_VERSION, 1);
  assert.ok(a.score > b.score);
  assert.ok(b.diagnostics.includes('node-collisions'));
  assert.ok(b.diagnostics.includes('project-edges-too-dense'));
});

test('Graph Quality rejects unbounded candidate collections', () => {
  assert.throws(() => evaluateGraphQuality({ nodes: Array.from({ length: 513 }, (_, id) => ({ id: String(id) })) }), /bounds/);
});
