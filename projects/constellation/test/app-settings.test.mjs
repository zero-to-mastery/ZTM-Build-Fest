import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS, applySetting, searchSettings, settingsFor, GROUPS } from '../src/app/settings.mjs';
import { defaultOptions } from '../src/app/engine.mjs';
import { createScene } from '../src/constellation.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';

const repositories = Array.from({ length: 40 }, (_, i) => ({
  name: `project-${i}`,
  full_name: `octo/project-${i}`,
  language: ['TypeScript', 'Rust', 'Python', 'Go'][i % 4],
  topics: [['web'], ['cli'], ['data'], []][i % 4],
  stargazers_count: (i * 37) % 101,
  created_at: `${2016 + (i % 7)}-03-01T00:00:00Z`,
  pushed_at: `2026-0${(i % 9) + 1}-01T00:00:00Z`,
  updated_at: `2026-0${(i % 9) + 1}-01T00:00:00Z`,
  fork: i === 13,
  archived: i % 5 === 2,
}));
// More projects than the limit, so the limit and the keep-order both matter.
const base = { ...defaultOptions('octo', repositories), maxRepos: 20 };
const draw = (options) => renderSceneSVG(createScene('octo', repositories, { ...options, generatedAt: '2026-10-22T00:00:00Z' }));

// A value different from the current one, for each control type.
function alternative(setting, options) {
  const current = setting.read(options);
  const { control } = setting;
  if (control.choices) return control.choices.map((c) => c.value).find((v) => String(v) !== String(current));
  if (control.type === 'toggle') return !current;
  if (control.type === 'range' || control.type === 'number') return current === control.max ? control.min : control.max;
  if (control.type === 'color') return current === '#ff0066' ? '#00ff99' : '#ff0066';
  if (control.type === 'textarea') return 'svg { opacity: .99 }';
  return 'changed';
}

test('every setting has a group, label, control and unique id', () => {
  const ids = new Set();
  const groups = new Set(GROUPS.map((g) => g.id));
  for (const setting of SETTINGS) {
    assert.ok(!ids.has(setting.id), `duplicate id ${setting.id}`);
    ids.add(setting.id);
    assert.ok(groups.has(setting.group), `${setting.id} has unknown group`);
    assert.ok(setting.label && setting.label.length <= 48, `${setting.id} label`);
    assert.ok(['essential', 'more'].includes(setting.tier), `${setting.id} tier`);
    assert.equal(typeof setting.read, 'function');
    assert.equal(typeof setting.write, 'function');
  }
});

test('every setting writes a configuration that parses and renders', () => {
  for (const setting of SETTINGS) {
    const value = alternative(setting, base);
    const next = applySetting(base, setting.id, value);
    assert.notDeepEqual(next, base, `${setting.id} did not change options`);
    assert.deepEqual(setting.read(next), value, `${setting.id} round trip`);
    const parsed = parseConfig(JSON.parse(serializeConfig('octo', next)), 'octo');
    assert.equal(parsed.version, 7);
    assert.doesNotThrow(() => draw(next), `${setting.id}=${value} failed to render`);
  }
});

test('every essential setting visibly changes the drawing', () => {
  const before = draw(base);
  const inert = SETTINGS.filter((s) => s.tier === 'essential')
    .map((setting) => [setting.id, alternative(setting, base)])
    .filter(([id, value]) => draw(applySetting(base, id, value)) === before)
    .map(([id, value]) => `${id}=${value}`);
  assert.deepEqual(inert, [], 'essential settings that change nothing visible');
});

test('every gallery choice renders', () => {
  for (const setting of SETTINGS.filter((s) => s.control.type === 'gallery')) {
    for (const { value } of setting.control.choices) {
      assert.doesNotThrow(() => draw(applySetting(base, setting.id, value)), `${setting.id}=${value}`);
    }
  }
});

test('applySetting clamps ranges and rejects unknown choices and colours', () => {
  assert.equal(applySetting(base, 'projects.max', 9999).maxRepos, 100);
  assert.equal(applySetting(base, 'look.glow', -4).visualStyle.glow, 0);
  assert.throws(() => applySetting(base, 'look.theme', 'not-a-theme'), /choose one/);
  assert.throws(() => applySetting(base, 'look.colors.star', 'red'), /colour/);
  assert.throws(() => applySetting(base, 'nope', 1), /Unknown setting/);
  assert.equal(applySetting(base, 'details.title', 'x'.repeat(200)).title.length, 60);
});

test('panels show a small, fixed set of essential settings', () => {
  for (const group of ['look', 'layout', 'projects', 'details']) {
    const count = settingsFor(group, 'essential').length;
    assert.ok(count >= 3 && count <= 7, `${group} has ${count} essential settings`);
  }
});

test('search finds settings by plain words', () => {
  assert.ok(searchSettings('glow').some((s) => s.id === 'look.glow'));
  assert.ok(searchSettings('forks').some((s) => s.id === 'projects.forks'));
  assert.equal(searchSettings('').length, SETTINGS.length);
});

// Regression: the first Glow (or line/label) change used to replace the
// theme's colours with the default palette. The theme must survive it.
test('style changes keep the theme’s colours', () => {
  const themed = applySetting(base, 'look.theme', 'dracula');
  const sky = '#282a36';
  assert.match(draw(themed), new RegExp(sky, 'i'));
  for (const [id, value] of [['look.glow', 0.5], ['look.lineWidth', 2.5], ['details.labelSize', 16], ['details.labels', false]]) {
    const changed = applySetting(themed, id, value);
    assert.equal(changed.visualStyle.dark.background, sky, `${id} kept the theme palette`);
    const svg = draw(changed);
    // The last palette rule in the stylesheet is what the browser uses.
    const backgrounds = [...svg.matchAll(/--sky-background:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase());
    assert.equal(backgrounds.at(-1), sky, `${id}: last background rule is the theme's`);
  }
  // Switching theme afterwards takes the new theme's colours with it.
  const then = applySetting(applySetting(themed, 'look.glow', 4), 'look.theme', 'synthwave');
  assert.equal(then.visualStyle.dark.background, '#170d30');
  // Your own colour wins over the theme's, even with a style block present.
  const mine = applySetting(applySetting(themed, 'look.glow', 4), 'look.colors.background', '#123456');
  const last = [...draw(mine).matchAll(/--sky-background:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase()).at(-1);
  assert.equal(last, '#123456');
});

test('glow visibly changes the stars even with a theme', () => {
  const themed = applySetting(base, 'look.theme', 'deep-space');
  const low = draw(applySetting(themed, 'look.glow', 0));
  const high = draw(applySetting(themed, 'look.glow', 5));
  assert.notEqual(low, high);
  // The style block's star rule comes after the theme's, so it is the one applied.
  const rules = (svg) => [...svg.matchAll(/\.star\s*\{\s*filter:\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.equal(rules(low).at(-1), 'none');
  assert.match(rules(high).at(-1), /drop-shadow\(0 0 5px/);
});

// Regression: custom CSS was stored but never reached the renderer.
test('custom CSS reaches the map, and unsafe CSS is refused', () => {
  const styled = applySetting(base, 'look.css', '.repo-label { letter-spacing: 3px }');
  assert.match(styled.css, /letter-spacing: 3px/);
  assert.match(draw(styled), /letter-spacing: 3px/);
  assert.throws(() => applySetting(base, 'look.css', '.x { background: url(https://example.com/a.png) }'), /self-contained/);
  assert.throws(() => applySetting(base, 'look.css', '@import "x.css";'), /self-contained/);
});
