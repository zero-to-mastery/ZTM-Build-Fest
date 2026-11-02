import { createGitHubAccess } from "../src/github-access.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRepositories, fetchPinnedRepositories, selectRepositoryPool, renderConstellation } from '../src/constellation.mjs';
import { createPreviewData, createPinnedFetch } from '../src/preview-data.mjs';
import { renderWorkflow } from '../src/export.mjs';

const pin = (name, overrides = {}) => ({ name, nameWithOwner: `someone/${name}`, isPrivate: false, isFork: false, stargazerCount: 2, primaryLanguage: { name: 'Rust' }, repositoryTopics: { nodes: [{ topic: { name: 'tools' } }] }, ...overrides });
const payload = (nodes, hasNextPage = false, endCursor = null) => ({ data: { repositoryOwner: { pinnedItems: { nodes, pageInfo: { hasNextPage, endCursor } } } } });

test('fetches authenticated profile pins, includes other owners, omits private repositories, and paginates', async () => {
  const calls = [];
  const result = await fetchRepositories('octocat', { token: 'secret', repoSource: 'pinned', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json(calls.length === 1 ? payload([pin('one'), pin('private', { isPrivate: true })], true, 'next') : payload([pin('two', { isFork: true })]));
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.github.com/graphql');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[1].options.body).variables, { login: 'octocat', after: 'next' });
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.deepEqual(result.map(repo => repo.full_name), ['someone/one', 'someone/two']);
  assert.ok(result.every(repo => repo.pinned && repo.private === false));
  assert.deepEqual(result.map(repo => repo.pin_order), [0, 1]);
  assert.deepEqual(result[0].topics, ['tools']);
});

test('missing tokens and failed or partial GraphQL results fail explicitly', async () => {
  let calls = 0;
  await assert.rejects(fetchPinnedRepositories('octocat', { fetchImpl: () => calls++ }), /token/);
  assert.equal(calls, 0);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(fetchPinnedRepositories('octocat', { token: 'secret', fetchImpl: async () => new Response('', { status }) }));
  }
  for (const body of [{ data: { repositoryOwner: null } }, { errors: [{ message: 'secret' }], ...payload([pin('one')]) }, {}, payload([{}]), payload([], true)]) {
    await assert.rejects(fetchPinnedRepositories('octocat', { token: 'secret', fetchImpl: async () => Response.json(body) }), error => !error.message.includes('secret'));
  }
  assert.deepEqual(await fetchPinnedRepositories('octocat', { token: 'secret', fetchImpl: async () => Response.json(payload([])) }), []);
});

test('pinned selection honors filters but keeps all pins regardless of the normal project limit', async () => {
  const pins = await fetchPinnedRepositories('octocat', { token: 'test', fetchImpl: async () => Response.json(payload(Array.from({ length: 6 }, (_, i) => pin(`pin-${i}`, { stargazerCount: i * 100 })))) });
  const mixed = [...pins, { name: 'not-pinned', full_name: 'octocat/not-pinned', language: 'Rust', stargazers_count: 10000 }];
  assert.deepEqual(selectRepositoryPool(mixed, { repoSource: 'pinned', maxRepos: 1 }).map(repo => repo.name), pins.map(repo => repo.name));
  assert.equal(selectRepositoryPool(mixed, { repoSource: 'all', maxRepos: 1 })[0].name, 'not-pinned');
  const options = { repoSource: 'pinned', includeRepos: ['someone/pin-0'], nodeMode: 'languages' };
  const svg = renderConstellation('octocat', pins, options);
  assert.match(svg, /1 languages from 1 public repositories/);
  const restored = JSON.parse(renderWorkflow('octocat', options).split('          config-json: |\n')[1]);
  assert.equal(renderConstellation('octocat', pins, restored), svg);
  assert.match(renderConstellation('octocat', [], { repoSource: 'pinned' }), /No public pinned repositories/);
  assert.throws(() => selectRepositoryPool(mixed, { repoSource: 'invalid' }), /repoSource/);
});

test('pin and all-repository snapshots are separate, cached, refreshable, and retained on failure', async () => {
  const storageMap = new Map();
  const storage = { getItem: key => storageMap.get(key), setItem: (key, value) => storageMap.set(key, value) };
  let pinCalls = 0, allCalls = 0, fail = false;
  const pinned = { name: 'pinned', full_name: 'someone/pinned', language: 'Rust', languages: { Rust: 100 }, pinned: true };
  const all = { name: 'owned', full_name: 'octocat/owned', language: 'CSS', languages: { CSS: 100 } };
  const args = { storage, fetchPinned: async () => { pinCalls++; if (fail) throw Error('Token rejected'); return [pinned]; }, fetchImpl: async url => { if (/\/users\/[^/?]+$/.test(url)) return Response.json({ login: 'octocat', type: 'User' }); if (url.includes('/events/public')) return Response.json([]); allCalls++; return Response.json([all]); } };
  let data = authenticatedPreviewData(args);
  await data.load('octocat', {});
  await data.load('octocat', { repoSource: 'pinned' });
  data = authenticatedPreviewData(args);
  await data.load('octocat', { repoSource: 'pinned' });
  assert.equal(pinCalls, 1); assert.equal(allCalls, 1);
  assert.deepEqual(data.snapshot('octocat'), [all]);
  assert.deepEqual(data.snapshot('octocat', { repoSource: 'pinned' }), [pinned]);
  await data.load('octocat', { repoSource: 'pinned' }, { refresh: true });
  assert.equal(pinCalls, 2);
  fail = true;
  await assert.rejects(data.load('octocat', { repoSource: 'pinned' }, { refresh: true }), /Token rejected/);
  assert.deepEqual(data.snapshot('octocat', { repoSource: 'pinned' }), [pinned]);
});

test('browser pin loading uses only the local endpoint and provides a setup error on static hosting', async () => {
  await assert.rejects(createPinnedFetch()('octocat'), /local studio/);
  const calls = [];
  const fetchPins = createPinnedFetch({ localAuth: true, proxyBase: '/api/github', fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json([]); } });
  await fetchPins('octocat');
  assert.equal(calls[0].url, '/api/github/users/octocat/pinned');
  assert.equal(calls[0].options.headers, undefined);
});

function authenticatedPreviewData(options = {}) { return createPreviewData({ ...options, access: createGitHubAccess({ authenticated: true }) }); }
