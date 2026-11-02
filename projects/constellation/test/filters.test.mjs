import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRepositoryPool, selectRepositories, sharedConnections, renderConstellation } from '../src/constellation.mjs';
import { renderWorkflow } from '../src/export.mjs';

const repos = [
  { name: 'app', full_name: 'user/app', language: 'JavaScript', languages: { JavaScript: 100, CSS: 30, HTML: 10 }, topics: ['web', 'pwa'], stargazers_count: 4 },
  { name: 'site', full_name: 'user/site', language: 'TypeScript', languages: { TypeScript: 100, CSS: 30 }, topics: ['web'], stargazers_count: 3 },
  { name: 'tool', full_name: 'user/tool', language: 'Python', languages: { Python: 100 }, topics: ['tools'], stargazers_count: 2 },
  { name: 'notes', full_name: 'user/notes', language: null, languages: {}, topics: ['web'], stargazers_count: 1 },
];
const names = options => selectRepositories(repos, options).map(repo => repo.name);

test('multi-select filters use any within a row, both across rows, and hide Other by default', () => {
  assert.deepEqual(names({}), ['app', 'site', 'tool']);
  assert.deepEqual(names({ languages: ['CSS', 'Python'] }), ['app', 'site', 'tool']);
  assert.deepEqual(names({ languages: ['CSS'], topics: ['pwa', 'tools'] }), ['app']);
  assert.deepEqual(names({ topics: ['web'] }), ['app', 'site']);
  assert.deepEqual(names({ languages: [], topics: null }), []);
  assert.deepEqual(names({ languages: null, topics: [] }), []);
  assert.deepEqual(names({ languages: ['Other'], showOther: true }), ['notes']);
  assert.deepEqual(names({ languages: ['Other'], showOther: false }), []);
  assert.equal(names({ showOther: true }).length, 4);
  assert.throws(() => names({ languages: 'CSS' }));
  assert.throws(() => names({ topics: [1] }));
});

test('the ranked project pool is fetched before filtering so secondary languages are available', () => {
  assert.equal(selectRepositoryPool(repos, { languages: [], topics: [], maxRepos: 4 }).length, 4);
  assert.deepEqual(names({ maxRepos: 1, languages: ['Python'] }), []);
  assert.deepEqual(names({ maxRepos: 4, languages: ['Python'] }), ['tool']);
  const privateAndForks = [...repos, { ...repos[0], private: true }, { ...repos[1], fork: true }];
  assert.equal(selectRepositories(privateAndForks, { includeForks: false }).length, 3);
});

test('connections reflect selected languages or explicit GitHub topics, never guessed topics', () => {
  assert.deepEqual(sharedConnections(repos[0], repos[1], { languages: ['CSS'] }).shared, ['CSS']);
  assert.deepEqual(sharedConnections(repos[0], repos[1], { connectionBasis: 'topics' }).shared, ['#web']);
  assert.deepEqual(sharedConnections(repos[0], repos[1], { connectionBasis: 'both' }).shared, ['CSS', '#web']);
  assert.deepEqual(sharedConnections(repos[0], repos[1], { connectionBasis: 'topics', topics: ['pwa'] }).shared, []);
  assert.deepEqual(sharedConnections(repos[0], { ...repos[1], topics: [] }, { connectionBasis: 'topics' }).shared, []);
  const svg = renderConstellation('user', repos, { connectionBasis: 'topics', topics: ['web'], connectionDensity: 'all' });
  assert.equal([...svg.matchAll(/class="shared-language"/g)].length, 1);
  assert.match(svg, /data-languages="" data-topics="web"/);
});

test('workflow preserves arbitrary category selections and empty graphs stay explicit', () => {
  const options = { languages: ['CSS', 'HTML'], topics: ['web'], connectionBasis: 'both', showOther: false, connectionDensity: 'all' };
  const workflow = renderWorkflow('user', options);
  const restored = JSON.parse(workflow.split('          config-json: |\n')[1].split('      - name:')[0]);
  assert.deepEqual(restored, { ...options, version: 7 });
  assert.equal(renderConstellation('user', repos, restored), renderConstellation('user', repos, options));
  assert.match(renderConstellation('user', repos, { languages: [] }), /No projects match these filters/);
});

test('metadata and historical filters do not claim that a populated profile has no repositories', () => {
  for (const options of [{ minStars: 1000000 }, { repoQuery: 'does-not-exist' }, { historicalYear: 2000 }]) {
    const svg = renderConstellation('user', repos, options);
    assert.match(svg, /No projects match these filters or historical year/);
    assert.doesNotMatch(svg, /No public repositories to show yet/);
  }
  assert.match(renderConstellation('user', [], {}), /No public repositories to show yet/);
  assert.match(renderConstellation('user', repos, { repoSource: 'pinned' }), /No public pinned repositories match this selection/);
});

test('curved paths preserve every selected relationship and emphasize only a spanning forest', () => {
  const connected = Array.from({ length: 12 }, (_, i) => ({ ...repos[0], name: `repo-${i}`, full_name: `user/repo-${i}` }));
  const svg = renderConstellation('user', connected, { layout: 'compact', connectionDensity: 'all' });
  assert.equal([...svg.matchAll(/class="shared-language"/g)].length, 66);
  assert.equal([...svg.matchAll(/data-emphasis="primary" d=/g)].length, 11);
  assert.equal([...svg.matchAll(/data-emphasis="secondary" d=/g)].length, 55);
  assert.equal([...svg.matchAll(/d="M[\d.]+ [\d.]+Q/g)].length, 66);
  assert.equal(svg, renderConstellation('user', [...connected].reverse(), { layout: 'compact', connectionDensity: 'all' }));
});
