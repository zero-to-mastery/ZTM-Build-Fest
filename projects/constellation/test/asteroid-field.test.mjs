import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConstellation } from '../src/constellation.mjs';
import { asteroidFieldMarkup } from '../src/asteroid-field.mjs';
import { createCommitFieldData, sampleCommitField } from '../src/commit-field.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
const reference = Date.parse('2026-09-27T12:00:00Z');
const repos = [{ name: 'repo', full_name: 'example/repo', language: 'Rust', stargazers_count: 10, created_at: '2020-01-01T00:00:00Z' }];
const demo = sampleCommitField(repos, reference);
const snapshot = { ...demo['example/repo'], demo: false };
const settings = { referenceDate: new Date(reference).toISOString(), activityEffect: 'asteroids', commitFieldData: { 'example/repo': snapshot } };

test('commit asteroids are deterministic, tied to real commit links and exclude future and duplicate data', () => {
  const commit = snapshot.commits[0];
  const data = { ...snapshot, commits: [commit, commit, { ...commit, sha: 'f'.repeat(40), date: '2099-01-01' }] };
  const options = { id: 'example/repo', x: 450, y: 270, radius: 5, snapshot: data, reference };
  const svg = asteroidFieldMarkup(options);
  assert.equal((svg.match(/class="commit-asteroid"/g) || []).length, 1);
  assert.match(svg, new RegExp(`/commit/${commit.sha}`));
  assert.doesNotMatch(svg, /animateMotion|commit-ship|commit-flight-path/);
  assert.equal(svg, asteroidFieldMarkup(options));
  assert.equal(asteroidFieldMarkup({ ...options, snapshot: undefined }), '');
  assert.equal(asteroidFieldMarkup({ ...options, id: 'other/repo' }), '');
  assert.doesNotMatch(asteroidFieldMarkup({ ...options, animate: false }), /animateMotion|commit-ship-moving/);
  assert.doesNotMatch(asteroidFieldMarkup({ ...options, snapshot: { ...data, demo: true } }), /href=/);
});

test('fields follow repository motion and retain reduced-motion and static exports', () => {
  const svg = renderConstellation('example', repos, { ...settings, ringAnimation: { enabled: true } });
  assert.match(svg, /<svg class="activity-asteroid-field"[^>]*><animate attributeName="x"/);
  assert.match(svg, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(svg, /commit-ship|commit-flight-path/);
  assert.doesNotMatch(svg, /NaN|Infinity|<script/);
  const still = renderConstellation('example', repos, { ...settings, animate: false });
  assert.doesNotMatch(still, /<animateMotion/);
  assert.match(still, /commit-asteroid/);
  assert.doesNotMatch(renderConstellation('example', [], settings), /class="activity-asteroid-field"/);
  const config = parseConfig(serializeConfig('example', settings)).options;
  assert.equal(config.activityEffect, 'asteroids'); assert.equal(config.commitFieldData, undefined);
});

test('field loading is explicit, excludes private repositories, requests 24 commits and reuses loaded snapshots', async () => {
  const urls = [];
  const field = createCommitFieldData({ fetchImpl: async url => {
    urls.push(url);
    if (!url.includes('/commits?')) return Response.json({ full_name: 'example/repo', private: false, default_branch: 'main' });
    return Response.json([{ sha: 'a'.repeat(40), parents: [], author: { login: 'alice' }, commit: { message: 'Ship it', committer: { date: new Date(reference).toISOString() } } }]);
  } });
  assert.equal(urls.length, 0);
  await field.load([...repos, { ...repos[0], full_name: 'example/private', private: true }]);
  assert.equal(urls.length, 2); assert.equal(new URL(urls[1]).searchParams.get('per_page'), '24');
  assert.equal(field.snapshots['example/repo'].commits.length, 1);
  await field.load(repos); assert.equal(urls.length, 2);
  await field.load(repos, { refresh: true }); assert.equal(urls.length, 4);
});
