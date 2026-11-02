import { createGitHubAccess } from "../src/github-access.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historyOptions, needsHistoryEvents } from '../src/history/settings.mjs';
import { referenceDate, historicalSnapshot, historyYears, DAY } from '../src/history/historical-snapshot.mjs';
import { projectLifecycle } from '../src/history/project-lifecycle.mjs';
import { contributionHistory } from '../src/history/contribution-history.mjs';
import { languageHistory } from '../src/history/language-history.mjs';
import { externalContributions } from '../src/history/external-contributions.mjs';
import { renderContributionOrbit } from '../src/history/history-svg.mjs';
import { normalizePublicEvents } from '../src/activity.mjs';
import { renderConstellation, graphNodes } from '../src/constellation.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';
import { renderWorkflow } from '../src/export.mjs';
import { createPreviewData } from '../src/preview-data.mjs';
import * as fixture from '../examples/fixtures/history.mjs';
const reference = Date.parse(fixture.referenceDate), repos = fixture.repositories;
const snapshot = { events: normalizePublicEvents(fixture.publicEvents), asOf: fixture.referenceDate, coverageStart: fixture.coverageStart };
const settings = historyOptions();
const options = { referenceDate: fixture.referenceDate, historyData: snapshot, showOther: true };

test('history config is opt-in, validated and portable without runtime event data', () => {
  assert.equal(needsHistoryEvents({}), false);
  assert.equal(needsHistoryEvents({ stellarAges: { enabled: true } }), false);
  assert.equal(needsHistoryEvents({ contributionOrbit: { enabled: true } }), true);
  const configuration = { ...options, history: { mode: 'historical', year: 2022 }, contributionOrbit: { enabled: true }, languageEvolution: { enabled: true, style: 'trails' }, stellarAges: { enabled: true }, foreignGalaxies: { enabled: true } };
  const normalized = parseConfig(serializeConfig('example', configuration));
  assert.equal(normalized.options.history.year, 2022);
  assert.equal(normalized.options.historyData, undefined);
  assert.deepEqual(decodeShare(encodeShare('https://example.com/', 'example', configuration)), normalized);
  assert.doesNotMatch(renderWorkflow('example', configuration), /week-\d|historyData|coverageStart/);
  for (const bad of [{ history: { mode: 'historical' } }, { history: { year: '2022' } }, { history: { maxHistoricalFrames: 9 } }, { contributionOrbit: { animate: 'yes' } }, { foreignGalaxies: { limit: 500 } }, { stellarAges: { thresholds: { active: 400 } } }, { referenceDate: 'invalid' }, { timeLapseDuration: 2 }, { languageEvolution: { style: '<svg>' } }]) assert.throws(() => parseConfig(bad));
});

test('reference date and snapshot reject future repositories and future maintenance evidence', () => {
  const date = referenceDate({ ...options, historicalYear: 2020 });
  assert.equal(date, Date.parse('2020-12-31T23:59:59.999Z'));
  const historical = historicalSnapshot(repos, date);
  assert.ok(historical.some(repo => repo.name === 'typed-orbits'));
  assert.ok(!historical.some(repo => repo.name === 'orbital-engine'));
  assert.equal(historical.find(repo => repo.name === 'active').pushed_at, undefined);
  assert.equal(historical.find(repo => repo.name === 'archived').archived, false);
  assert.equal(projectLifecycle(historical.find(repo => repo.name === 'active'), date), 'unknown');
  assert.equal(referenceDate({ ...options, historicalYear: 2090 }), reference);
  assert.throws(() => referenceDate({}), /explicit/);
});

test('all stellar age states use explicit thresholds, archived override and public maintenance', () => {
  for (const state of ['newborn', 'active', 'mature', 'quiet', 'dormant', 'archived']) assert.equal(projectLifecycle(repos.find(repo => repo.name === state), reference), state);
  const quiet = repos.find(repo => repo.name === 'quiet');
  assert.equal(projectLifecycle(quiet, reference, settings.stellarAges.thresholds, [{ id: 'maintenance', kind: 'push', repository: quiet.full_name, createdAt: fixture.referenceDate }]), 'active');
  assert.equal(projectLifecycle(quiet, reference, settings.stellarAges.thresholds, [{ id: 'private', private: true, kind: 'push', repository: quiet.full_name, createdAt: fixture.referenceDate }]), 'quiet');
  assert.equal(projectLifecycle({ ...quiet, created_at: fixture.referenceDate, archived: true }, reference), 'archived');
  assert.equal(projectLifecycle({ ...quiet, created_at: 'unknown' }, reference), 'unknown');
  assert.equal(projectLifecycle({ ...quiet, created_at: fixture.referenceDate, pushed_at: fixture.referenceDate }, reference + 90 * DAY), 'quiet');
});

test('weekly aggregation is UTC, deterministic, bounded and wraps the year boundary', () => {
  const data = contributionHistory(snapshot, reference);
  assert.equal(data.weeks.length, 52);
  assert.ok(data.weeks.every(week => new Date(week.start).getUTCDay() === 1));
  assert.equal(data.weeks.reduce((sum, week) => sum + week.count, 0), snapshot.events.length);
  assert.deepEqual(data, contributionHistory({ ...snapshot, events: [...snapshot.events].reverse() }, reference));
  const peak = Array.from({ length: 100 }, (_, i) => ({ id: String(i), kind: 'push', repository: 'example/a', createdAt: fixture.referenceDate }));
  assert.equal(contributionHistory({ ...snapshot, events: peak }, reference).weeks.at(-1).level, 4);
  assert.ok(data.weeks.some(week => new Date(week.start).getUTCFullYear() === 2025));
  assert.ok(data.weeks.some(week => new Date(week.start).getUTCFullYear() === 2026));
});

test('zero activity, unknown coverage and failed sources remain distinct', () => {
  const empty = contributionHistory({ ...snapshot, events: [] }, reference);
  assert.ok(empty.weeks.every(week => week.level === 0));
  assert.ok(empty.weeks.some(week => week.observed));
  assert.ok(contributionHistory({ events: [], asOf: fixture.referenceDate }, reference).weeks.every(week => !week.observed));
  assert.equal(contributionHistory(undefined, reference), null);
  assert.equal(contributionHistory({ ...snapshot, diagnostic: '429' }, reference), null);
});

test('orbit styles have bounded deterministic geometry and optional reduced motion', () => {
  const data = contributionHistory(snapshot, reference), geometry = { centerY: 270, spreadY: 192 };
  for (const style of ['segments', 'dots', 'pulse-ring']) {
    const config = { ...settings.contributionOrbit, enabled: true, style, animate: true };
    const svg = renderContributionOrbit(data, config, geometry);
    assert.equal(svg, renderContributionOrbit(data, config, geometry));
    assert.doesNotMatch(svg, /NaN|Infinity/);
    assert.ok(svg.length < 16000);
    assert.match(svg, /history-pulse/);
    assert.doesNotMatch(renderContributionOrbit(data, config, geometry, false), /history-pulse/);
  }
  assert.match(renderConstellation('example', repos, { ...options, contributionOrbit: { enabled: true, animate: true } }), /prefers-reduced-motion:reduce/);
});

test('language cohorts show language entry and disappearance with bounded per-repository weight', () => {
  const eras = languageHistory(repos, reference);
  assert.ok(eras.length >= 3 && eras.length <= 8);
  assert.equal(eras[0].languages[0].name, 'PHP');
  assert.ok(eras.at(-1).languages.some(language => language.name === 'Rust'));
  assert.ok(!eras.at(-1).languages.some(language => language.name === 'PHP'));
  assert.deepEqual(eras, languageHistory([...repos].reverse(), reference));
  assert.ok(languageHistory(repos, reference, '2-year').every(era => era.end - era.start <= 1));
  assert.ok(languageHistory(repos, reference, 'yearly').every(era => era.end === era.start));
  assert.deepEqual(languageHistory([{ ...repos[0], languages: {}, language: null }], reference)[0].languages, []);
  assert.ok(languageHistory(repos, Date.parse('2019-12-31')) .every(era => era.languages.every(language => language.name !== 'Rust')));
  assert.ok(eras.every(era => era.languages.every(language => language.prominence > 0 && language.prominence <= 1)));
});

test('external contributions exclude owned, private and watch activity, preserve merged PR evidence', () => {
  const raw = [
    { id: 'own', public: true, type: 'PullRequestEvent', repo: { name: 'EXAMPLE/own' }, created_at: fixture.referenceDate },
    { id: 'secret', public: false, type: 'PullRequestEvent', repo: { name: 'outside/SECRET' }, created_at: fixture.referenceDate },
    { id: 'watch', public: true, type: 'WatchEvent', repo: { name: 'outside/watch' }, created_at: fixture.referenceDate },
    ...fixture.publicEvents,
  ];
  const source = { ...snapshot, events: normalizePublicEvents(raw) };
  const foreign = externalContributions('example', source, reference, { ...settings.foreignGalaxies, limit: 2 });
  assert.equal(foreign.length, 2);
  assert.ok(foreign.every(value => !value.repository.startsWith('example/') && value.kinds.includes('merged-pr')));
  assert.doesNotMatch(JSON.stringify(foreign), /SECRET|watch/);
  assert.deepEqual(foreign, externalContributions('EXAMPLE', { ...source, events: [...source.events].reverse() }, reference, { ...settings.foreignGalaxies, limit: 2 }));
  assert.equal(externalContributions('example', source, reference, { ...settings.foreignGalaxies, minimumContribution: 'merged-pr' }).length, 4);
  assert.equal(externalContributions('example', source, Date.parse('2020-01-01'), settings.foreignGalaxies).length, 0);
});

test('historical rendering recalculates nodes, categories, ages, filters and language eras locally', () => {
  const before = { ...options, historicalYear: 2014, nodeMode: 'languages' };
  const after = { ...options, historicalYear: 2026, nodeMode: 'languages' };
  assert.ok(graphNodes(repos, before).nodes.length < graphNodes(repos, after).nodes.length);
  const svg = renderConstellation('example', repos, { ...options, historicalYear: 2014, stellarAges: { enabled: true }, languageEvolution: { enabled: true } });
  assert.doesNotMatch(svg, /data-repo="example\/orbital-engine"/);
  assert.equal(svg, renderConstellation('example', [...repos].reverse(), { ...options, historicalYear: 2014, stellarAges: { enabled: true }, languageEvolution: { enabled: true } }));
  const ages = renderConstellation('example', repos, { ...options, stellarAges: { enabled: true }, nodeColors: { 'example/archived': '#123456' } });
  assert.match(ages, /data-lifecycle="archived"[^>]*--node-color:#123456/);
});

test('all time-lapse modes are bounded, deterministic, script-free and retain latest reduced-motion state', () => {
  assert.deepEqual(historyYears(repos, reference), [2012, 2014, 2016, 2018, 2020, 2022, 2024, 2026]);
  for (const mode of ['grow', 'orbit', 'crossfade']) {
    const config = { ...options, animate: true, history: { mode: 'time-lapse', timeLapse: { mode, loop: false } }, stellarAges: { enabled: true }, languageEvolution: { enabled: true } };
    const svg = renderConstellation('example', repos, config);
    assert.equal(svg, renderConstellation('example', repos, config));
    assert.match(svg, /2012 to 2026; 8 sampled years/);
    assert.match(svg, /history-year-7\{opacity:1\}/);
    assert.doesNotMatch(svg, /<script|foreignObject|NaN|Infinity/);
    assert.ok(Buffer.byteLength(svg) < 750000);
    if (mode !== 'crossfade') assert.equal((svg.match(/class="repository"/g) || []).length, repos.length);
    const still = renderConstellation('example', repos, { ...config, animate: false });
    assert.doesNotMatch(still, /@keyframes history-birth|class="history-frame/);
    assert.match(still, /data-repo="example\/newborn"/);
  }
});

test('time-lapse file-size guard falls back to a shared growth scene for dense graphs', () => {
  const dense = Array.from({ length: 100 }, (_, i) => ({ ...repos[i % repos.length], name: `r${i}`, full_name: `example/r${i}` }));
  const svg = renderConstellation('example', dense, { ...options, maxRepos: 100, connectionDensity: 'all', history: { mode: 'time-lapse', timeLapse: { mode: 'crossfade' } } });
  assert.match(svg, /Crossfade exceeded the 750 KB budget/);
  assert.equal((svg.match(/class="repository"/g) || []).length, 100);
});

test('history and external layers degrade without fabricated contributions', () => {
  const svg = renderConstellation('example', repos, { ...options, historyData: { diagnostic: 'unavailable', events: [] }, contributionOrbit: { enabled: true }, foreignGalaxies: { enabled: true } });
  assert.match(svg, /Public history unavailable/);
  assert.doesNotMatch(svg, /class="contribution-orbit|https:\/\/github.com\/community-/);
  assert.match(svg, /data-repo="example\/newborn"/);
});

test('year and history customizations reuse cached events without API calls', async () => {
  let calls = 0;
  const data = authenticatedPreviewData({ fetchImpl: async url => { calls++; if (/\/users\/[^/?]+$/.test(url)) return Response.json({ login: 'example', type: 'User' }); return Response.json(url.includes('/events/public') ? fixture.publicEvents : repos); } });
  const loaded = await data.load('example', {});
  const count = calls;
  for (const year of [2014, 2018, 2022, 2026]) renderConstellation('example', loaded, { ...options, historyData: data.activity('example'), historicalYear: year, contributionOrbit: { enabled: true }, foreignGalaxies: { enabled: true } });
  assert.equal(calls, count);
});

test('four showcase configs reproduce fixture galleries within the size budget', async () => {
  for (const name of ['developer-history', 'open-source-galaxy', 'time-machine', 'stellar-ages']) {
    const config = parseConfig(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8')).options;
    const svg = renderConstellation('example', repos, { ...config, historyData: snapshot });
    assert.equal(svg, renderConstellation('example', repos, { ...config, historyData: snapshot }));
    assert.ok(Buffer.byteLength(svg) < 150000, name);
  }
});

function authenticatedPreviewData(options = {}) { return createPreviewData({ ...options, access: createGitHubAccess({ authenticated: true }) }); }
