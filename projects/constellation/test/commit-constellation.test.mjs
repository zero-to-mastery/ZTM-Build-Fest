import { createGitHubAccess } from "../src/github-access.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { commitConstellation } from '../src/commit-constellation.mjs';
import { createScene, renderConstellation } from '../src/constellation.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { createPreviewData } from '../src/preview-data.mjs';

const sha = n => String(n).padStart(40, '0');
const snapshot = { repository: 'team/project', branch: 'main', partial: false, commits: [[4, [3, 2], 'alice'], [3, [1], 'alice'], [2, [1], 'bob'], [1, [], 'bob']].map(([n, parents, author]) => ({ sha: sha(n), parents: parents.map(sha), author, login: author, subject: n === 4 ? 'Merge branches <safe>' : `Commit ${n}`, date: '2026-09-28T00:00:00Z' })) };
const options = { nodeMode: 'commits', commitHistory: { repository: snapshot.repository, branch: 'main' }, commitHistoryData: snapshot, animate: false };

test('commit stars preserve merge ancestry, author colors and real commit details in constellation layouts', () => {
  const graph = commitConstellation(options);
  assert.equal(graph.nodes.length, 4); assert.equal(graph.edges.length, 4);
  assert.equal(graph.nodes.find(node => node.commit.sha === sha(4)).commit.parents, 2);
  assert.equal(graph.nodes[0].commitColor, graph.nodes[1].commitColor);
  assert.notEqual(graph.nodes[0].commitColor, graph.nodes[2].commitColor);
  for (const arrangement of ['rings', 'galaxy', 'field', 'orbital', 'force']) {
    const scene = createScene('alice', [], { ...options, arrangement });
    assert.equal(scene.nodes.length, 4); assert.equal(scene.edges.length, 4);
    assert.equal(scene.presentation.graph.commits, true);
    assert.deepEqual(scene.edges.map(edge => [edge.from, edge.to]).sort(), graph.edges.map(edge => [edge.from, edge.to]).sort());
    const svg = renderConstellation('alice', [], { ...options, arrangement });
    assert.equal((svg.match(/data-kind="commit"/g) || []).length, 4);
    assert.match(svg, /Merge branches &lt;safe&gt;/); assert.match(svg, /lines connect commits to their parents/i);
    assert.doesNotMatch(svg, /NaN|No public repositories|appearing in the same repository/);
  }
});

test('commit star limits and highlighting keep identities, mark partial ancestry, and serialize settings only', () => {
  const highlighted = { ...options, maxRepos: 1, nodeCap: 3, commitHistory: { ...options.commitHistory, author: 'github:bob' } };
  const graph = commitConstellation(highlighted);
  assert.equal(graph.nodes.length, 3); assert.equal(graph.total, 4); assert.match(graph.note, /Partial view; 2 parent connections/);
  const scene = createScene('alice', [], highlighted);
  assert.equal(scene.nodes.find(node => node.metadata.commit.author === 'alice').style.opacity, .2);
  const restored = parseConfig(serializeConfig('alice', highlighted));
  assert.deepEqual(restored.options.commitHistory, highlighted.commitHistory);
  assert.equal(restored.options.commitHistoryData, undefined);
  assert.throws(() => parseConfig({ version: 7, account: 'alice', options: { ...options, commitHistory: { repository: 'https://evil.test/team/project' } } }), /owner\/repository/);
  assert.match(commitConstellation({ ...options, commitHistoryData: undefined }).emptyMessage, /Choose a repository/);
});

test('fresh saved commit constellation loads branch history for a personal account without contributor scans', async () => {
  const calls = [];
  const data = authenticatedPreviewData({ fetchImpl: async url => {
    calls.push(url);
    const path = new URL(url).pathname;
    if (path === '/users/alice') return Response.json({ login: 'alice', type: 'User' });
    if (path === '/users/alice/repos' || path.endsWith('/events/public')) return Response.json([]);
    if (path.endsWith('/commits')) return Response.json(snapshot.commits.map(commit => ({ sha: commit.sha, parents: commit.parents.map(sha => ({ sha })), author: { login: commit.author }, commit: { message: commit.subject, author: { name: commit.author }, committer: { date: commit.date } } })));
    return Response.json({ full_name: 'team/project', name: 'project', private: false, default_branch: 'main' });
  } });
  await data.load('alice', { ...options, commitHistoryData: undefined, includeRepos: ['team/project'] });
  assert.equal(data.commitHistory('alice').commits.length, 4);
  assert.ok(calls.some(url => url.includes('/commits?') && new URL(url).searchParams.get('sha') === 'main'));
  assert.ok(calls.every(url => !url.includes('/contributors') && !url.includes('/languages')));
});

test('large histories fit the constellation cap without fabricating boundary stars', () => {
  const commits = Array.from({ length: 300 }, (_, i) => ({ ...snapshot.commits[0], sha: sha(300 - i), parents: [sha(299 - i)] }));
  const scene = createScene('alice', [], { ...options, commitHistoryData: { ...snapshot, commits, partial: true } });
  assert.equal(scene.nodes.length, 256); assert.equal(scene.edges.length, 255);
  assert.match(scene.presentation.graph.note, /256 of 300 loaded commits/);
  assert.match(scene.presentation.graph.note, /1 parent connections continue/);
  const empty = renderConstellation('alice', [], { ...options, commitHistoryData: { ...snapshot, commits: [] } });
  assert.match(empty, /has no commits/); assert.doesNotMatch(empty, /class="star"/);
});

function authenticatedPreviewData(options = {}) { return createPreviewData({ ...options, access: createGitHubAccess({ authenticated: true }) }); }
