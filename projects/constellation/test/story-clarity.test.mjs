import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStoryClarity, STORY_CLARITY_VERSION } from '../src/engine.mjs';

test('Story Clarity reports bounded, ID-addressed presentation diagnostics', () => {
  const input = {
    width: 200, height: 100,
    projects: [
      { id: 'a', role: 'featured', x: 20, y: 20, prominence: 1 },
      { id: 'b', role: 'supporting', x: 80, y: 20, prominence: 8 },
      { id: 'c', x: 140, y: 20 },
      { id: 'd', x: 80, y: 20 },
      { id: 'e', x: 80, y: 20 },
    ],
    labels: [
      { id: 'label:a', projectId: 'a', text: 'Alpha', bounds: { x: 10, y: 10, width: 60, height: 14 }, visible: true },
      { id: 'label:b', projectId: 'b', text: 'Bravo', bounds: { x: 30, y: 10, width: 60, height: 14 }, visible: true },
      { id: 'label:c', projectId: 'c', text: 'Charlie', bounds: { x: 180, y: 88, width: 50, height: 18 }, visible: true },
    ],
    relationships: [
      { id: 'r1', from: 'a', to: 'b', kind: 'language', style: 'solid', evidence: ['language:Rust'] },
      { id: 'r2', from: 'a', to: 'c', kind: 'topic', style: 'solid', evidence: ['topic:tools'] },
      { id: 'r3', from: 'b', to: 'c', kind: 'family', style: 'solid', evidence: ['family:systems'] },
      { id: 'r4', from: 'a', to: 'd', kind: 'language', style: 'solid' },
      { id: 'r5', from: 'a', to: 'e', kind: 'topic', style: 'solid' },
      { id: 'r6', from: 'b', to: 'd', kind: 'family', style: 'solid' },
      { id: 'r7', from: 'b', to: 'e', kind: 'explicit', style: 'solid' },
    ],
    groups: [{ id: 'group:systems', projectIds: ['a', 'b', 'c', 'd', 'e'] }],
    legend: { x: 10, y: 10, width: 60, height: 14 },
  };
  const result = analyzeStoryClarity(input);
  assert.equal(result.version, STORY_CLARITY_VERSION);
  const codes = new Set(result.diagnostics.map(item => item.code));
  for (const code of [
    'label-collision', 'label-out-of-bounds', 'featured-insufficient-prominence',
    'excessive-connection-density', 'relationship-crosses-important-label',
    'overcrowded-technical-region', 'unclear-relationship-differentiation',
    'legend-overlaps-label',
  ]) assert.ok(codes.has(code), `missing ${code}`);
  assert.ok(result.diagnostics.every(item => item.ids.every(id => typeof id === 'string')));
  assert.ok(result.suggestions.length <= 256);
  assert.equal('score' in result, false, 'presentation diagnostics do not rank candidates');
});

test('Story Clarity output is stable under input reordering and protects authored geometry', () => {
  const labels = [
    { id: 'label:b', projectId: 'b', text: 'Bravo', bounds: { x: 10, y: 10, width: 40, height: 14 }, visible: true, manualPosition: true },
    { id: 'label:a', projectId: 'a', text: 'Alpha', bounds: { x: 20, y: 10, width: 40, height: 14 }, visible: true, manualPosition: true },
  ];
  const projects = [{ id: 'b', x: 60, y: 20 }, { id: 'a', x: 20, y: 20 }];
  const left = analyzeStoryClarity({ width: 100, height: 60, labels, projects });
  const right = analyzeStoryClarity({ width: 100, height: 60, labels: [...labels].reverse(), projects: [...projects].reverse() });
  assert.deepEqual(left, right);
  assert.equal(left.suggestions.some(item => item.labelId), false);
  assert.throws(() => analyzeStoryClarity({ width: Infinity, height: 10 }), /Invalid Story Clarity input/);
});
