import { deriveCodingRhythm } from '../src/coding-rhythm.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { aggregateActivity, normalizePublicEvents } from '../src/activity.mjs';
import { parseConfig } from '../src/config-schema.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import * as historyFixture from '../examples/fixtures/history.mjs';
import * as organizationFixture from '../examples/fixtures/organization.mjs';

// Synthetic public projects keep the gallery reproducible without API access.
for (const name of ['organization-community', 'organization-user', 'organization-eras']) {
  const { options } = parseConfig(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
  const svg = renderConstellation('example-community', organizationFixture.repositories, { ...options, organizationData: organizationFixture.organizationData });
  await mkdir(new URL('../examples/gallery/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../examples/gallery/${name}.svg`, import.meta.url), svg);
  console.log(`${name}: ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KiB`);
}
const groups = { Rust: ['orbit-core', 'starship', 'signal'], JavaScript: ['stargazer', 'tiny-world', 'moonrise'], Python: ['night-sky', 'telescope', 'atlas'], TypeScript: ['constellation', 'sky-map', 'observatory'] };
const repos = Object.entries(groups).flatMap(([language, names]) => names.map((name, i) => ({ name, full_name: `example/${name}`, language, languages: { [language]: 100 }, topics: i % 2 ? ['tools'] : ['space', 'creative-coding'], stargazers_count: [128, 32, 8][i], created_at: '2020-01-01T00:00:00Z', pushed_at: `202${i + 3}-01-01T00:00:00Z` })));
await mkdir(new URL('../examples/gallery/', import.meta.url), { recursive: true });
for (const name of ['layer-study', 'deep-space', 'terminal', 'minimal', 'solar-system', 'starfield', 'active-developer', 'night-owl', 'weekend-builder']) {
  const { options } = parseConfig(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
  const events = normalizePublicEvents(JSON.parse(await readFile(new URL(`../examples/fixtures/${options.codingRhythm ? name + '-events' : 'public-events'}.json`, import.meta.url), 'utf8')));
  const activityData = options.activityEffect ? aggregateActivity(events, repos, options, options.activityMetricDate) : undefined;
  const codingRhythmData = options.codingRhythm ? deriveCodingRhythm(events, options, options.activityMetricDate) : undefined;
  const svg = renderConstellation('example', repos, { ...options, activityData, codingRhythmData });
  await writeFile(new URL(`../examples/gallery/${name}.svg`, import.meta.url), svg);
  const baseline = renderConstellation('example', repos, { ...options, activityData, codingRhythm: false });
  console.log(`${name}: ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KiB${options.codingRhythm ? ` (+${((Buffer.byteLength(svg) - Buffer.byteLength(baseline)) / 1024).toFixed(1)} KiB rhythm)` : ''}`);
}

for (const name of ['developer-history', 'open-source-galaxy', 'time-machine', 'stellar-ages']) {
  const { options } = parseConfig(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
  const events = normalizePublicEvents(historyFixture.publicEvents);
  const historyData = { events, asOf: historyFixture.referenceDate, coverageStart: historyFixture.coverageStart };
  const activityData = aggregateActivity(events, historyFixture.repositories, options, historyFixture.referenceDate);
  const svg = renderConstellation('example', historyFixture.repositories, { ...options, historyData, activityData });
  await writeFile(new URL(`../examples/gallery/${name}.svg`, import.meta.url), svg);
  console.log(`${name}: ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KiB`);
}
