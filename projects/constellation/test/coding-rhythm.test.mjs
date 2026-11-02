import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCodingRhythm, codingRhythmOptions, rhythmWeights } from '../src/coding-rhythm.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';
import { renderWorkflow } from '../src/export.mjs';
import { visualThemes } from '../src/themes.mjs';

const asOf = '2026-01-20T12:00:00Z';
const event = (createdAt, kind = 'push', id = createdAt) => ({ id, createdAt, kind, repository: 'tester/one' });
const events = [15, 16, 17].flatMap(day => [22, 23, 0, 1].map(hour => event(`2026-01-${day}T${String(hour).padStart(2, '0')}:00:00Z`)));
const derive = (input = events, options = {}, date = asOf) => deriveCodingRhythm(input, options, date);
const repos = [{ name: 'one', full_name: 'tester/one', language: 'Rust', stargazers_count: 10 }];

test('hours, Monday-first weekdays, peak and a four-hour window wrapping midnight', () => {
  const data = derive();
  assert.equal(data.eventCount, 12);
  assert.deepEqual(data.peakWindow, { start: 22, end: 2 });
  assert.equal(data.peakHour, 0);
  assert.deepEqual(data.hourly.filter(Boolean), [1, 1, 1, 1]);
  assert.deepEqual(data.weekday, [0, 0, 0, 1, 1, 1, 0]);
  assert.equal(data.peakDay, 3);
  assert.deepEqual(data, derive([...events].reverse()));
});

test('timezone conversion changes date and maps DST spring and fall transitions once', () => {
  const options = { codingRhythmTimezone: 'America/New_York' };
  const midnight = derive([event('2026-01-19T02:00:00Z')], options);
  assert.equal(midnight.hourly[21], 1); assert.equal(midnight.weekday[6], 1);
  const spring = derive([event('2026-03-08T06:30:00Z'), event('2026-03-08T07:30:00Z')], options, '2026-03-09T00:00:00Z');
  assert.equal(spring.eventCount, 2); assert.equal(spring.hourly[1], 1); assert.equal(spring.hourly[2], 0); assert.equal(spring.hourly[3], 1);
  const fall = derive([event('2026-11-01T05:30:00Z'), event('2026-11-01T06:30:00Z')], options, '2026-11-02T00:00:00Z');
  assert.equal(fall.eventCount, 2); assert.equal(fall.hourly.filter(Boolean).length, 1); assert.equal(fall.hourly[1], 1);
  assert.equal(codingRhythmOptions({ codingRhythmTimezone: 'local' }).codingRhythmTimezone, 'UTC');
  assert.throws(() => derive([], { codingRhythmTimezone: 'Mars/Olympus' }), /timezone/);
  assert.throws(() => deriveCodingRhythm([]), /reference date/);
});

test('central weights, bounded saturation, independent windows and sparse data', () => {
  assert.equal(rhythmWeights.push, 1); assert.equal(rhythmWeights.comment, .15);
  const weighted = derive([event('2026-01-19T10:00:00Z'), event('2026-01-19T11:00:00Z', 'comment'), event('2026-01-19T12:00:00Z', 'watch'), event('2026-01-19T13:00:00Z', 'unknown')]);
  assert.ok(weighted.hourly[10] > weighted.hourly[11]); assert.equal(weighted.eventCount, 2);
  const burst = Array.from({ length: 200 }, (_, i) => event('2026-01-19T10:00:00Z', 'push', String(i)));
  const data = derive([...burst, event('2026-01-19T11:00:00Z')]);
  assert.ok(data.hourly[11] > .6); assert.equal(data.peakWindow, null);
  assert.equal(derive(events.slice(0, 4)).peakWindow, null);
  assert.equal(derive([]).eventCount, 0); assert.equal(derive([]).confidence, 0);
  const old = [event('2026-01-10T10:00:00Z'), event('2026-01-01T10:00:00Z'), event('2026-01-21T00:00:00Z')];
  assert.equal(derive(old, { codingRhythmWindow: '7d' }).eventCount, 0);
  assert.equal(derive(old, { codingRhythmWindow: '14d' }).eventCount, 1);
  assert.equal(derive(old, { activityWindow: '1d' }).eventCount, 2);
});

test('old configs stay off; settings round trip through config, sharing and workflows without data', () => {
  assert.equal(codingRhythmOptions(parseConfig({}).options).codingRhythm, false);
  const settings = { codingRhythm: true, codingRhythmStyle: 'halo', codingRhythmTimezone: 'America/New_York', codingRhythmWindow: '14d', codingRhythmDays: 'full', codingRhythmAnimate: true };
  assert.deepEqual(parseConfig(serializeConfig('tester', settings)).options, settings);
  assert.deepEqual(decodeShare(encodeShare('https://example.com', 'tester', settings)).options, settings);
  assert.doesNotMatch(renderWorkflow('tester', { ...settings, codingRhythmData: derive() }), /hourly|projectHours|codingRhythmData/);
  assert.throws(() => parseConfig({ codingRhythmWindow: '1d' }), /codingRhythmWindow/);
  assert.throws(() => parseConfig({ codingRhythm: 'true' }), /boolean/);
});

test('deterministic lightweight layers across styles, themes and output profiles preserve nodes', () => {
  const settings = { codingRhythm: true, codingRhythmData: derive(), legend: true };
  const stars = svg => [...svg.matchAll(/<circle class="star"[^>]*>/g)].map(match => match[0]);
  for (const exportProfile of ['profile', 'repository', 'compact', 'hero', 'transparent']) {
    for (const theme of ['auto', ...Object.keys(visualThemes)]) {
      const base = { ...settings, theme, exportProfile };
      const off = renderConstellation('tester', repos, { ...base, codingRhythm: false });
      for (const codingRhythmStyle of ['orbit', 'active-arc', 'halo']) {
        const options = { ...base, codingRhythmStyle };
        const svg = renderConstellation('tester', repos, options);
        assert.equal(svg, renderConstellation('tester', repos, options));
        assert.deepEqual(stars(svg), stars(off));
        assert.match(svg, /class="coding-rhythm"/); assert.match(svg, /22:00–02:00/);
        assert.ok(Buffer.byteLength(svg) - Buffer.byteLength(off) < 6500);
        assert.doesNotMatch(svg, /NaN|undefined|<script|foreignObject/);
      }
    }
  }
  const animated = renderConstellation('tester', repos, { ...settings, codingRhythmAnimate: true });
  assert.match(animated, /<animateMotion/);
  assert.match(animated, /prefers-reduced-motion:reduce\)\{\.coding-rhythm-marker\{display:none/);
  assert.doesNotMatch(renderConstellation('tester', repos, settings), /<animateMotion/);
  const sparse = renderConstellation('tester', repos, { ...settings, codingRhythmData: derive(events.slice(0, 2)) });
  assert.doesNotMatch(sparse, /Peak activity|class="coding-rhythm-peak"/);
  assert.doesNotMatch(renderConstellation('tester', repos, { ...settings, codingRhythmData: derive([]) }), /class="coding-rhythm"/);
});


test('optional weekday labels, celestial marks, project hints and hidden style stay bounded', () => {
  const settings = { codingRhythm: true, codingRhythmData: derive(), codingRhythmDays: 'full', codingRhythmCelestialMarkers: true, codingRhythmProjectHints: true, codingRhythmLabels: 'cardinal' };
  const svg = renderConstellation('tester', repos, settings);
  assert.equal([...svg.matchAll(/class="coding-rhythm-day"/g)].length, 7);
  assert.match(svg, /Midnight/); assert.match(svg, /class="star-halo" style="opacity:/);
  const none = renderConstellation('tester', repos, { ...settings, codingRhythmDays: 'off', codingRhythmLabels: 'none' });
  assert.doesNotMatch(none, /class="coding-rhythm-day"|>Midnight</);
  const hidden = renderConstellation('tester', repos, { ...settings, codingRhythmStyle: 'hidden' });
  assert.doesNotMatch(hidden, /class="coding-rhythm"|class="star-halo" style="opacity:/);
});
