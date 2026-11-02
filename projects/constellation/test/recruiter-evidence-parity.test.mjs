import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRecruiterProjects, orderRecruiterProjects } from '../src/recruiter.mjs';
import { repositories, options, referenceDate } from './fixtures/recruiter.mjs';
import { oracleAnalyzeRecruiterEvidence } from './fixtures/recruiter-evidence-oracle.mjs';

function actual(repos, settings, account = 'alice', reference = Date.parse(referenceDate)) {
  const result = analyzeRecruiterProjects(repos, settings, account, reference);
  return {
    projects: result.projects.map(({ repository, ...evidence }) => evidence),
    order: result.ordered.map(item => item.repository.full_name),
  };
}

function parity(repos, settings, account = 'alice', reference = Date.parse(referenceDate)) {
  assert.deepEqual(actual(repos, settings, account, reference), oracleAnalyzeRecruiterEvidence(repos, settings, account, reference));
}

test('Recruiter Evidence v1 matches the preserved fixture oracle', () => {
  parity(repositories, options);
  parity([...repositories].reverse(), options);
  parity([], options);
});

test('Recruiter Evidence v1 matches the oracle across honesty and date edge cases', () => {
  const repos = [
    { name: 'missing', full_name: 'alice/missing', pushed_at: null },
    { name: 'invalid', full_name: 'alice/invalid', pushed_at: 'not-a-date' },
    { name: 'future', full_name: 'alice/future', pushed_at: '2099-01-01' },
    { name: 'partial', full_name: 'alice/partial', pushed_at: '2026-09-02' },
    { name: 'diagnostic', full_name: 'alice/diagnostic', pushed_at: '2026-04-01' },
    { name: 'contributed', full_name: 'community/contributed', pushed_at: '2026-08-01' },
    { name: 'external', full_name: 'community/external', pushed_at: '2026-08-01' },
    { name: 'no-org', full_name: 'community/no-org', pushed_at: '2026-08-01' },
  ];
  const settings = {
    projectShowcase: { 'alice/partial': { role: 'supporting', priority: 2 } },
    commitFieldData: {
      'alice/future': { partial: false, commits: [{ date: '2099-01-02', login: 'alice' }, { date: '2026-01-01', login: 'alice' }] },
      'alice/partial': { partial: true, commits: [{ date: '2026-02-01', login: 'alice' }] },
      'alice/diagnostic': { partial: false, diagnostic: 'unavailable', commits: [{ date: '2024-02-29', login: 'alice' }] },
      'community/contributed': { partial: false, commits: [{ date: '2026-07-01', login: 'alice' }] },
      'community/external': { partial: false, commits: [{ date: '2026-07-01', login: 'bob' }] },
    },
    historyData: { events: [
      { id: 'future', repository: 'alice/future', kind: 'push', createdAt: '2099-01-03' },
      { id: 'release', repository: 'alice/diagnostic', kind: 'release', createdAt: '2026-03-31' },
    ] },
    organizationData: { complete: false, records: {
      'community/contributed': [{ login: 'alice' }, { login: 'Bob' }, { login: 'bob' }],
      'community/external': [{ login: 'bob' }],
    } },
  };
  parity(repos, settings);
});

test('Recruiter Evidence v1 preserves locale ordering for mixed-case ties', () => {
  const repos = [
    { name: 'A', full_name: 'alice/A', pushed_at: '2026-09-01' },
    { name: 'a', full_name: 'alice/a', pushed_at: '2026-09-01' },
    { name: 'new', full_name: 'alice/new', pushed_at: '2026-09-02' },
    { name: 'old', full_name: 'alice/old', pushed_at: '2026-09-01' },
  ];
  const settings = { projectShowcase: Object.fromEntries(repos.map(repo => [repo.full_name, { role: 'featured', priority: 1 }])) };
  parity(repos, settings);
});

test('Recruiter Evidence v1 pins deterministic ASCII punctuation ordering', () => {
  const repos = ['myapp', 'my_app', 'my.app', 'my-app'].map(name => ({ name, full_name: `alice/${name}`, pushed_at: '2026-09-01' }));
  assert.deepEqual(orderRecruiterProjects(repos).map(repo => repo.full_name), ['alice/my-app', 'alice/my.app', 'alice/my_app', 'alice/myapp']);
});
