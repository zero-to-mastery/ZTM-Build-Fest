import test from 'node:test';
import assert from 'node:assert/strict';
import { graphNodes, renderConstellation } from '../src/constellation.mjs';
import { computeScene } from '../src/engine.mjs';
import { renderWorkflow } from '../src/export.mjs';

const repos = [
  { name: 'site', full_name: 'o/site', language: 'JavaScript', languages: { JavaScript: 100, HTML: 20 }, topics: ['agile', 'JavaScript'], stargazers_count: 42 },
  { name: 'native', full_name: 'o/native', language: 'Rust', topics: ['agile'] },
];
const options = { nodeMode: 'combined' };
const nodes = graphNodes(repos, options).nodes;
const input = { account: 'octocat', compact: false, arrangement: 'field', basis: 'membership', all: false,
  repos: nodes.map(node => ({ name: node.full_name, kind: node.nodeKind, members: node.members, languages: [], topics: [], group: '', position: null })) };

test('combined Rust graph retains repository metadata and only direct membership edges', () => {
  assert.equal(nodes.length, 7);
  assert.equal(nodes.find(node => node.full_name === 'o/site').stargazers_count, 42);
  const scene = computeScene(input);
  assert.equal(scene.edges.length, 6);
  for (const edge of scene.edges) {
    const ends = [nodes[edge.from], nodes[edge.to]];
    assert.equal(ends.filter(node => node.nodeKind === 'repository').length, 1);
    const repo = ends.find(node => node.nodeKind === 'repository');
    assert.ok(ends.find(node => node !== repo).members.includes(repo.full_name));
  }
});

test('hiding nodes removes incident edges without changing any layout', () => {
  for (const arrangement of ['field', 'orbital', 'force']) {
    const before = computeScene({ ...input, arrangement });
    const after = computeScene({ ...input, arrangement, repos: input.repos.map(node => ({ ...node, hidden: node.name === 'o/site' })) });
    assert.deepEqual(after.positions, before.positions);
    assert.equal(after.edges.length, 2);
    const svg = renderConstellation('octocat', repos, { ...options, arrangement, hiddenNodes: ['o/site'], bridges: true });
    assert.ok(!svg.includes('data-repo="o/site"'));
    assert.ok(!svg.includes('data-from="o/site"') && !svg.includes('data-to="o/site"'));
  }
});

test('visibility, color and paired placement survive workflow export', () => {
  const config = { ...options, hiddenNodes: ['o/native'], hiddenLabels: ['language:HTML'],
    starPositions: { 'language:HTML': { x: 220, y: 140 } }, labelOffsets: { 'language:HTML': { x: 0, y: 17 } }, nodeColors: { 'language:HTML': '#ff3366' } };
  const svg = renderConstellation('octocat', repos, config);
  assert.match(svg, /data-repo="language:HTML" x="220.0" y="157.0" style="display:none"/);
  assert.match(svg, /class="star" cx="220.0" cy="140.0"/);
  assert.match(svg, /--node-color:#ff3366/);
  const restored = JSON.parse(renderWorkflow('octocat', config).split('          config-json: |\n')[1]);
  assert.equal(renderConstellation('octocat', repos, restored), svg);
  assert.match(renderConstellation('octocat', repos, { ...options, hiddenNodes: nodes.map(node => node.full_name) }), /All nodes are hidden/);
  for (const key of ['hiddenNodes', 'hiddenLabels']) assert.throws(() => renderConstellation('octocat', repos, { [key]: [123] }), /array of node IDs/);
});

test('combined graph stays within 256 nodes while retaining every repository', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ name: `r${i}`, full_name: `o/r${i}`, language: `L${i}`, topics: [`t${i}`, `extra${i}`] }));
  const graph = graphNodes(many, { ...options, maxRepos: 100 });
  assert.equal(graph.total, 400);
  assert.equal(graph.nodes.length, 256);
  assert.equal(graph.nodes.filter(node => node.nodeKind === 'repository').length, 100);
  assert.equal((renderConstellation('octocat', many, { ...options, maxRepos: 100 }).match(/class="star"/g) || []).length, 256);
});
