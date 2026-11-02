import test from 'node:test';
import assert from 'node:assert/strict';
import { movePair } from '../src/label-editor.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { renderWorkflow } from '../src/export.mjs';

test('moving a pair preserves its offset and clamps both items together', () => {
  const origin = { x: 450, y: 126 };
  const label = { x: 470, y: 143, halfWidth: 40 };
  for (const height of [280, 560]) {
    for (const target of [{ x: 500, y: 150 }, { x: -1000, y: -1000 }, { x: 2000, y: 2000 }]) {
      const pair = movePair(origin, target, label, height);
      assert.equal(pair.label.x - pair.star.x, 20);
      assert.equal(pair.label.y - pair.star.y, 17);
      assert.ok(pair.star.x >= 32 && pair.star.x <= 868);
      assert.ok(pair.star.y >= 28 && pair.star.y <= height - 60);
      assert.ok(pair.label.x >= 74 && pair.label.x <= 826);
      assert.ok(pair.label.y >= 28 && pair.label.y <= height - 43);
    }
  }
  assert.deepEqual(movePair(origin, { x: 460, y: 136 }, label, 280), { star: { x: 460, y: 136 }, label: { x: 480, y: 153 } });
  assert.deepEqual(movePair(origin, { x: 0, y: 0 }, null, 280), { star: { x: 32, y: 28 }, label: null });
});

test('relative labels follow nodes across moves, filters, node types and workflow exports', () => {
  const repos = [{ name: 'hello', full_name: 'octocat/hello', language: 'Rust', topics: ['tools'] }, { name: 'other', full_name: 'octocat/other', language: 'Rust', topics: ['tools'] }];
  for (const [nodeMode, id] of [['repositories', 'octocat/hello'], ['languages', 'language:Rust'], ['topics', 'topic:tools']]) {
    for (const includeRepos of [undefined, ['hello']]) {
      const options = { nodeMode, includeRepos, labelOffsets: { [id]: { x: 10, y: 17 } }, starPositions: { [id]: { x: 200, y: 100 } } };
      const svg = renderConstellation('octocat', repos, options);
      assert.ok(svg.includes(`data-repo="${id}" x="210.0" y="117.0"`));
      const moved = { ...options, starPositions: { [id]: { x: 300, y: 200 } } };
      const output = renderConstellation('octocat', repos, moved);
      assert.ok(output.includes(`data-repo="${id}" x="310.0" y="217.0"`));
      const exported = JSON.parse(renderWorkflow('octocat', moved).split('          config-json: |\n')[1]);
      assert.equal(renderConstellation('octocat', repos, exported), output);
    }
  }
  for (const labelOffsets of [[], 'bad', { node: { x: Infinity, y: 0 } }]) assert.throws(() => renderConstellation('octocat', repos, { labelOffsets }), /labelOffsets/);
});
