import test from 'node:test';
import assert from 'node:assert/strict';
import { graphNodes, renderConstellation } from '../src/constellation.mjs';
import { renderWorkflow } from '../src/export.mjs';
import { computeScene, graphSelection } from '../src/engine.mjs';

const repos = [
  { name: 'site', full_name: 'octocat/site', language: 'JavaScript', languages: { JavaScript: 100, HTML: 30, CSS: 20 }, topics: ['agile', 'good-first-issue'] },
  { name: 'styles', full_name: 'octocat/styles', language: 'CSS', languages: { CSS: 100 }, topics: ['agile'] },
  { name: 'native', full_name: 'octocat/native', language: 'Rust', topics: [] },
  { name: 'secret', full_name: 'octocat/secret', language: 'Secret', topics: ['private-topic'], private: true },
  { name: 'fork', full_name: 'octocat/fork', language: 'Go', topics: ['fork-topic'], fork: true },
];

test('language and topic nodes derive only from the filtered public project pool', () => {
  const languages = graphNodes(repos, { nodeMode: 'languages', includeForks: false });
  assert.equal(languages.repositoryCount, 3);
  assert.deepEqual(new Set(languages.nodes.map(node => node.full_name)), new Set(['language:JavaScript', 'language:HTML', 'language:CSS', 'language:Rust']));
  assert.deepEqual(languages.nodes.find(node => node.name === 'CSS').members, ['octocat/site', 'octocat/styles']);
  const topics = graphNodes(repos, { nodeMode: 'topics', includeForks: false, topics: ['good-first-issue'] });
  assert.equal(topics.nodes.length, 1);
  assert.equal(topics.nodes[0].full_name, 'topic:good-first-issue');
  assert.deepEqual(topics.nodes[0].members, ['octocat/site']);
  assert.deepEqual(graphNodes(repos, { nodeMode: 'languages', languages: [] }).nodes, []);
  assert.deepEqual(graphNodes(repos, { nodeMode: 'topics', includeRepos: ['native'] }).nodes, []);
  assert.throws(() => graphNodes(repos, { nodeMode: 'invalid' }), /nodeMode/);
});

test('category edges and Rust paths use common repositories, never inferred relationships', () => {
  const nodes = graphNodes(repos, { nodeMode: 'languages', includeForks: false }).nodes;
  const scene = computeScene({ account: 'octocat', repos: nodes.map(node => ({ name: node.full_name, group: 'language', languages: [], topics: [], members: node.members, position: null })), basis: 'repositories', compact: false, arrangement: 'field', all: true });
  const names = nodes.map(node => node.full_name);
  assert.equal(scene.edges.length, 3);
  assert.ok(scene.edges.every(edge => edge.members.length === 1 && edge.members[0] === 'octocat/site' && !edge.languages.length && !edge.topics.length));
  const pairs = scene.edges.flatMap(edge => [edge.from, edge.to]);
  assert.deepEqual(graphSelection(names, pairs, 'language:JavaScript', 'language:CSS'), ['language:JavaScript', 'language:CSS']);
  assert.deepEqual(graphSelection(names, pairs, 'language:JavaScript', 'language:Rust'), []);
});

test('node identities keep individual colors and manual placements through all exports', () => {
  for (const [nodeMode, id] of [['repositories', 'octocat/site'], ['languages', 'language:CSS'], ['topics', 'topic:agile']]) {
    for (const arrangement of ['field', 'orbital', 'force']) {
      const options = { nodeMode, arrangement, includeForks: false, nodeColors: { [id]: '#ff3366' }, starPositions: { [id]: { x: 200, y: 150 } }, labelPositions: { [id]: { x: 210, y: 170 } } };
      const svg = renderConstellation('octocat', repos, options);
      assert.match(svg, /style="--node-color:#ff3366"/);
      assert.match(svg, /class="star" cx="200.0" cy="150.0"/);
      assert.ok(svg.includes(`data-repo="${id}" x="210.0" y="170.0"`));
      assert.equal(svg, renderConstellation('octocat', [...repos].reverse(), options));
      const restored = JSON.parse(renderWorkflow('octocat', options).split('          config-json: |\n')[1]);
      assert.equal(svg, renderConstellation('octocat', repos, restored));
    }
  }
});

test('category labels and colors cannot escape SVG attributes or styles', () => {
  const odd = [{ name: 'site', full_name: 'octocat/site', language: 'Rust', topics: ['agile"><script>bad</script>'] }];
  const svg = renderConstellation('octocat', odd, { nodeMode: 'topics' });
  assert.ok(!svg.includes('<script>'));
  assert.match(svg, /agile&quot;&gt;&lt;script&gt;/);
  for (const nodeColors of [[], 'bad', { 'octocat/site': 'red' }, { 'octocat/site': '#fff;}</style>' }, { 'octocat/site': 123 }]) {
    assert.throws(() => renderConstellation('octocat', repos, { nodeColors }), /nodeColors/);
  }
  assert.doesNotMatch(renderConstellation('octocat', repos, { nodeColors: {} }), /style="--node-color:/);
});

test('empty categories and missing languages remain explicit', () => {
  const noCode = [{ name: 'notes', full_name: 'octocat/notes', languages: {}, topics: ['agile'] }];
  assert.equal(graphNodes(noCode, { nodeMode: 'topics' }).nodes.length, 0);
  assert.equal(graphNodes(noCode, { nodeMode: 'topics', showOther: true }).nodes[0].full_name, 'topic:agile');
  assert.equal(graphNodes(noCode, { nodeMode: 'languages', showOther: true }).nodes[0].full_name, 'language:Other');
  assert.match(renderConstellation('octocat', repos, { nodeMode: 'topics', includeRepos: ['native'] }), /No topics in the matching repositories/);
});
