import { createGitHubAccess } from "../src/github-access.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicEvents, aggregateActivity, recencyDecay, eventWeights } from '../src/activity.mjs';
import { cometGeometry } from '../src/activity-effects.mjs';
import { fetchPublicActivity } from '../src/github-activity.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { renderWorkflow } from '../src/export.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';
import { createPreviewData } from '../src/preview-data.mjs';

const date = '2026-01-08T12:00:00Z';
const repos = ['one', 'two'].map(name => ({ name, full_name: `tester/${name}`, language: 'Rust', languages: { Rust: 100 }, stargazers_count: 20 }));
const event = (id, type = 'PushEvent', hours = 1, repository = 'tester/one') => ({ id: String(id), public: true, type, repo: { name: repository }, created_at: new Date(Date.parse(date) - hours * 3600000).toISOString(), actor: { login: 'PRIVATE_ACTOR' }, payload: { title: 'PRIVATE_TITLE', commits: [{ message: 'PRIVATE_MESSAGE' }] } });
const aggregate = (events, options = {}) => aggregateActivity(normalizePublicEvents(events), repos, options, date);

test('public events normalize and deduplicate without retaining activity content', () => {
  const valid = event(1);
  const normalized = normalizePublicEvents([valid, valid, { ...event(2), public: false }, { ...event(3), created_at: null }, event(4, 'UnknownEvent'), { ...event(6), repo: { name: ['tester/one'] } }, null, {}, { ...event(5), repo: { name: '<script>' } }]);
  assert.equal(normalized.length, 1);
  assert.deepEqual(Object.keys(normalized[0]).sort(), ['createdAt', 'id', 'kind', 'newRepository', 'repository']);
  assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE|payload|actor|commits/);
  assert.deepEqual(normalizePublicEvents(null), []);
  assert.deepEqual(aggregateActivity([null, {}], repos, {}, date).repositories, {});
});

test('mapping, decay, weighting, windows and high-volume scores stay bounded', () => {
  assert.equal(recencyDecay(0), 1); assert.equal(recencyDecay(72), .5); assert.equal(recencyDecay(-1), 0);
  assert.ok(recencyDecay(24) > recencyDecay(168));
  assert.ok(aggregate([event(1, 'ReleaseEvent')]).repositories['tester/one'].score > aggregate([event(1)]).repositories['tester/one'].score);
  assert.equal(eventWeights.comment, .2);
  const result = aggregate([event(1), event(2, 'PullRequestEvent'), event(3, 'ReleaseEvent'), event(4, 'PushEvent', 2, 'elsewhere/repo'), event(5, 'PushEvent', -1)]);
  assert.equal(result.repositories['tester/one'].eventCount, 3);
  assert.equal(result.repositories['tester/one'].pushCount, 1);
  assert.equal(result.repositories['tester/one'].pullRequestCount, 1);
  assert.equal(result.repositories['tester/one'].releaseCount, 1);
  assert.equal(Object.keys(result.repositories).length, 1);
  assert.deepEqual(aggregate([event(1, 'PushEvent', 25)], { activityWindow: '1d' }).repositories, {});
  assert.equal(aggregate([event(1, 'PushEvent', 25)], { activityWindow: 'auto' }).window, '7d');
  assert.equal(aggregate([event(1, 'PushEvent', 200)], { activityWindow: 'auto' }).window, '30d');
  assert.deepEqual(aggregate([event(1, 'PushEvent', 721)], { activityWindow: '30d' }).repositories, {});
  const many = aggregate(Array.from({ length: 10000 }, (_, i) => event(i))).repositories['tester/one'];
  assert.equal(many.eventCount, 300); assert.ok(many.score > 0 && many.score < .9);
  assert.deepEqual(aggregateActivity(normalizePublicEvents([event(1)]), [{ ...repos[0], private: true }], {}, date).repositories, {});
  assert.throws(() => aggregateActivity([], repos), /reference date/);
});

test('activity renders deterministically without moving nodes or replacing visual mappings', () => {
  const events = [event(1), event(2, 'PullRequestEvent', 2, 'tester/two')];
  const activityData = aggregate(events);
  const options = { seedMode: 'custom', seed: 'activity', nodeSize: 'stars', nodeColorMode: 'language', nodeGlowMode: 'seeded', legend: true };
  const baseline = renderConstellation('tester', repos, options);
  assert.equal(baseline, renderConstellation('tester', repos, { ...options, activityEffect: 'off', activityData }));
  const stars = svg => [...svg.matchAll(/<circle class="star"[^>]+>/g)].map(match => match[0]);
  for (const activityEffect of ['glow', 'pulse', 'comet', 'ripple']) {
    const settings = { ...options, activityEffect, activityData, activityDetail: 'event-types', activityConnections: true };
    const svg = renderConstellation('tester', repos, settings);
    assert.equal(svg, renderConstellation('tester', [...repos].reverse(), { ...settings, activityData: aggregate([...events].reverse()) }));
    assert.deepEqual(stars(svg), stars(baseline));
    assert.match(svg, /data-activity-score=/); assert.match(svg, /prefers-reduced-motion:reduce/);
    assert.match(svg, /public activity \/ 7d/); assert.match(svg, /activity-halo/);
    assert.doesNotMatch(svg, /PRIVATE|<script|foreignObject/);
    const still = renderConstellation('tester', repos, { ...settings, animate: false });
    assert.doesNotMatch(still, /class="activity-(?:halo activity-pulse|comet activity-streak|ring activity-ripple)"/);
  }
  assert.deepEqual(cometGeometry(100, 100, .8, 'seed', 'one'), cometGeometry(100, 100, .8, 'seed', 'one'));
  assert.notDeepEqual(cometGeometry(100, 100, .8, 'seed', 'one'), cometGeometry(100, 100, .8, 'other', 'one'));
  assert.equal(renderConstellation('tester', repos, { ...options, activityEffect: 'comet', activityData: aggregate([event(1, 'PushEvent', 1, 'other/ignored')]) }), renderConstellation('tester', repos, { ...options, activityEffect: 'comet', activityData: aggregate([]) }));
});

test('comets follow ring and floating motion and retain a static reduced-motion image', () => {
  for (const options of [{ arrangement: 'rings', ringAnimation: { enabled: true } }, { arrangement: 'galaxy', floatingAnimation: { enabled: true }, perspective: { enabled: true, animate: true } }]) {
    const svg = renderConstellation('tester', repos, { ...options, activityEffect: 'comet', activityData: aggregate([event(1)]) });
    assert.match(svg, /<path class="activity-comet[^>]*><animateTransform attributeName="transform" type="translate"/);
    assert.match(svg, /class="ring-motion-still"/);
    const encoded = svg.match(/href="data:image\/svg\+xml,([^"]+)"/)[1];
    assert.match(decodeURIComponent(encoded), /class="activity-comet/);
    assert.doesNotMatch(decodeURIComponent(encoded), /<animateTransform/);
  }
});

test('activity settings round-trip through config, workflows and shares without runtime data', () => {
  const options = { activityEffect: 'comet', activityWindow: 'auto', activityDetail: 'event-types', activityConnections: true, activityMetricDate: date };
  const runtime = { ...options, activityData: aggregate([event(1)]) };
  assert.deepEqual(parseConfig(serializeConfig('tester', runtime)).options, options);
  assert.deepEqual(decodeShare(encodeShare('https://example.test', 'tester', runtime)).options, options);
  assert.doesNotMatch(renderWorkflow('tester', runtime), /activityData|latestEventAt|eventCount/);
  assert.deepEqual(parseConfig({ nodeSize: 'stars' }).options, { nodeSize: 'stars' });
  for (const value of [{ activityEffect: 'sparkles' }, { activityWindow: '365d' }, { activityDetail: 'raw' }, { activityConnections: 1 }, { activityMetricDate: 'invalid' }]) assert.throws(() => parseConfig(value));
});

test('public event fetching is centralized, bounded, authenticated and fails without leaking errors', async () => {
  const calls = [];
  const snapshot = await fetchPublicActivity('tester', { token: 'TOKEN', asOf: date, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.headers.Authorization, 'Bearer TOKEN');
    assert.match(url, /\/users\/tester\/events\/public\?/);
    return Response.json(Array.from({ length: 100 }, (_, i) => event(calls.length * 100 + i)));
  } });
  assert.equal(calls.length, 3); assert.equal(snapshot.events.length, 300);
  for (const fetchImpl of [async () => new Response('SECRET', { status: 403 }), async () => { throw Error('TOKEN'); }, async () => Response.json({ bad: true })]) {
    const failure = await fetchPublicActivity('tester', { fetchImpl, asOf: date });
    assert.deepEqual(failure.events, []); assert.match(failure.diagnostic, /unavailable/); assert.doesNotMatch(failure.diagnostic, /TOKEN|SECRET/);
  }
});

test('failed activity stays nonfatal and cached until explicit refresh', async () => {
  let eventCalls = 0;
  const data = authenticatedPreviewData({ fetchImpl: async url => {
    if (/\/users\/[^/?]+$/.test(url)) return Response.json({ login: 'tester', type: 'User' });
    if (!url.includes('/events/public')) return Response.json(repos);
    eventCalls++;
    return eventCalls === 1 ? new Response('', { status: 429 }) : Response.json([event(1)]);
  } });
  assert.equal((await data.load('tester', {})).length, 2);
  assert.match(data.activity('tester').diagnostic, /unavailable/);
  await data.load('tester', {}); assert.equal(eventCalls, 1);
  await data.load('tester', {}, { refresh: true }); assert.equal(eventCalls, 2);
  assert.equal(data.activity('tester').events.length, 1);
});

function authenticatedPreviewData(options = {}) { return createPreviewData({ ...options, access: createGitHubAccess({ authenticated: true }) }); }
