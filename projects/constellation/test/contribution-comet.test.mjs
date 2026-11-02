import test from 'node:test';
import assert from 'node:assert/strict';
import { contributionComet, renderContributionComet } from '../src/history/contribution-comet.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { needsHistoryEvents } from '../src/history/settings.mjs';
import { fetchPublicActivity } from '../src/github-activity.mjs';
import { createPreviewData } from '../src/preview-data.mjs';
import { sampleActivity } from '../src/sample-activity.mjs';

const event = (date, extra = {}) => ({ id: date, kind: 'push', repository: 'example/repo', createdAt: `${date}T12:00:00Z`, ...extra });
const snapshot = { coverageStart: '2026-09-20T00:00:00Z', asOf: '2026-09-27T12:00:00Z', events: ['2026-09-23', '2026-09-24', '2026-09-25'].map(date => event(date)) };
const at = date => Date.parse(date);

test('comet grows across consecutive UTC days and gives today time to finish', () => {
  for (const reference of ['2026-09-25T23:59:59Z', '2026-09-26T23:59:59.999Z']) {
    assert.deepEqual(contributionComet(snapshot, at(reference)), { state: 'active', days: 3, events: 3 });
  }
  assert.deepEqual(contributionComet(snapshot, at('2026-09-27T00:00:00Z')), { state: 'burst', days: 3, events: 3, missedDate: '2026-09-26' });
  assert.equal(contributionComet({ ...snapshot, events: [...snapshot.events, event('2026-09-27')] }, at(snapshot.asOf)).days, 1);
});

test('unavailable and stale coverage cannot fabricate a missed day', () => {
  for (const data of [undefined, { ...snapshot, diagnostic: '429' }, { ...snapshot, coverageStart: undefined }, { ...snapshot, asOf: '2026-09-26T18:00:00Z' }, { ...snapshot, events: [] }]) {
    assert.equal(contributionComet(data, at(snapshot.asOf)).state, 'unknown');
  }
});

test('recent positive activity can fly with a legacy cache lacking coverage', () => {
  const data = { ...snapshot, coverageStart: undefined, events: [event('2026-09-27')] };
  assert.equal(contributionComet(data, at(snapshot.asOf)).state, 'active');
  assert.equal(contributionComet(data, at('2026-09-29T00:00:00Z')).state, 'unknown');
});

test('studio demo stays active relative to the preview date, including UTC midnight', () => {
  const repos = Array.from({ length: 5 }, (_, i) => ({ full_name: `example/repo-${i}` }));
  for (const reference of ['2026-09-27T12:00:00Z', '2027-01-01T00:00:00Z']) {
    const data = sampleActivity(repos, reference);
    assert.equal(contributionComet(data, at(reference)).state, 'active');
    assert.ok(contributionComet(data, at(reference)).days >= 3);
  }
});

test('comet ignores future, private, watch and fork events and deduplicates', () => {
  const noisy = [...snapshot.events, snapshot.events[0], event('2026-09-28'), event('2026-09-26', { private: true }), event('2026-09-26', { id: 'watch', kind: 'watch' }), event('2026-09-26', { id: 'fork', kind: 'fork' })];
  assert.deepEqual(contributionComet({ ...snapshot, events: noisy.reverse() }, at(snapshot.asOf)), contributionComet(snapshot, at(snapshot.asOf)));
});

test('comet option survives config serialization and renders static and animated exports', () => {
  const options = { contributionComet: { enabled: true }, referenceDate: snapshot.asOf, historyData: snapshot };
  assert.equal(needsHistoryEvents(options), true);
  assert.equal(parseConfig(serializeConfig('example', options)).options.contributionComet.enabled, true);
  assert.throws(() => parseConfig({ contributionComet: { enabled: 'yes' } }));
  const svg = renderConstellation('example', [], options);
  assert.match(svg, /class="contribution-comet comet-burst comet-motion"/);
  assert.match(svg, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(svg, /NaN|Infinity|<script/);
  const still = renderContributionComet(contributionComet(snapshot, at(snapshot.asOf)), { centerY: 270, spreadY: 192, height: 540 }, false);
  assert.doesNotMatch(still, /comet-motion/);
  assert.equal((still.match(/class="comet-shard"/g) || []).length, 36);
  assert.doesNotMatch(renderConstellation('example', [], { referenceDate: snapshot.asOf }), /class="contribution-comet/);
});

test('fetched activity and reloaded caches retain conservative coverage', async () => {
  const raw = snapshot.events.map(e => ({ id: e.id, type: 'PushEvent', public: true, repo: { name: e.repository }, created_at: e.createdAt }));
  const data = await fetchPublicActivity('example', { asOf: snapshot.asOf, fetchImpl: async () => Response.json(raw) });
  assert.equal(data.coverageStart, '2026-09-23T12:00:00.000Z');
  const preview = createPreviewData({ storage: { getItem: key => key === 'constellation-public-activity-v1' ? JSON.stringify({ example: data }) : null } });
  assert.equal(preview.activity('example').coverageStart, data.coverageStart);
  assert.equal(contributionComet(preview.activity('example'), at(snapshot.asOf)).state, 'burst');
});
