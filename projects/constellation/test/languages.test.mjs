import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRepositoryLanguages, repositoryLanguages, selectRepositories } from '../src/constellation.mjs';

const repos = Array.from({ length: 8 }, (_, i) => ({ name: `repo-${i}`, full_name: `octocat/repo-${i}`, language: 'JavaScript', stargazers_count: i }));

test('loads full languages only for selected public repos, with bounded concurrency and caching', async () => {
  const cache = new Map(), calls = [];
  let active = 0, maximum = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options }); maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return { ok: true, json: async () => ({ JavaScript: 100, CSS: 20, HTML: 5 }) };
  };
  const selected = selectRepositories([...repos, { ...repos[0], name: 'private', private: true }], { maxRepos: 5 });
  const result = await fetchRepositoryLanguages(selected, { fetchImpl, cache, token: 'test-token' });
  assert.equal(calls.length, 5);
  assert.ok(maximum <= 3);
  assert.deepEqual(repositoryLanguages(result[0]), ['CSS', 'HTML', 'JavaScript']);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.ok(calls.every(call => call.url.startsWith('https://api.github.com/repos/octocat/') && !call.url.includes('test-token')));
  assert.deepEqual(await fetchRepositoryLanguages(selected, { fetchImpl, cache }), result);
  assert.equal(calls.length, 5);
  await fetchRepositoryLanguages([{ ...repos[0], private: true }], { fetchImpl });
  assert.equal(calls.length, 5);
});

test('language failures are explicit, evicted from cache, and do not become invented primary-only data', async () => {
  const cache = new Map();
  for (const status of [403, 429, 404, 500]) {
    await assert.rejects(fetchRepositoryLanguages([repos[0]], { cache, fetchImpl: async () => ({ ok: false, status }) }));
    assert.equal(cache.size, 0);
  }
  for (const body of [null, [], 'bad', { CSS: -1 }, { CSS: '123' }]) {
    await assert.rejects(fetchRepositoryLanguages([repos[0]], { fetchImpl: async () => ({ ok: true, json: async () => body }) }));
  }
  const empty = await fetchRepositoryLanguages([repos[0]], { cache, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.deepEqual(repositoryLanguages(empty[0]), []);
  assert.deepEqual(repositoryLanguages(repos[0]), ['JavaScript']);
});

test('concurrent consumers share requests and abort signals reach GitHub', async () => {
  const cache = new Map(), controller = new AbortController(); let count = 0;
  const fetchImpl = async (url, options) => {
    count++; assert.equal(options.signal, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 1));
    return { ok: true, json: async () => ({ CSS: 1 }) };
  };
  await Promise.all([1, 2].map(() => fetchRepositoryLanguages([repos[0]], { cache, fetchImpl, signal: controller.signal })));
  assert.equal(count, 1);
});
