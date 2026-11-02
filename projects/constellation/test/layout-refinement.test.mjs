import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderConstellation } from '../src/constellation.mjs';
import { refineStars, layoutRefinementOptions } from '../src/layout-refinement.mjs';
import { parseConfig, serializeConfig } from '../src/config-schema.mjs';
import { encodeShare, decodeShare } from '../src/share-link.mjs';
import { renderWorkflow } from '../src/export.mjs';
import { loadConfig } from '../src/config.mjs';

const repos = Array.from({ length: 32 }, (_, i) => ({ name: `project-${i}`, full_name: `tester/project-${i}`, language: 'Rust', languages: { Rust: 100 }, stargazers_count: i, created_at: '2020-01-01T00:00:00Z' }));
const base = { animate: false, referenceDate: '2026-09-27T00:00:00Z', seedMode: 'custom', seed: 'refinement', snapToRings: false };
const enabled = { ...base, layoutRefinement: { enabled: true, intensity: 8 } };
const coordinates = svg => [...svg.matchAll(/<circle class="star" cx="([^"]+)" cy="([^"]+)"[^>]*data-repo="([^"]+)"/g)].map(m => [m[3], Number(m[1]), Number(m[2])]);

test('documented refinement defaults and intensity limits remain stable', () => {
  assert.deepEqual(layoutRefinementOptions(), { enabled: false, intensity: 5 });
  assert.deepEqual(layoutRefinementOptions({ enabled: true }), { enabled: true, intensity: 5 });
  for (const intensity of [0, 10]) assert.equal(layoutRefinementOptions({ intensity }).intensity, intensity);
});

test('refinement never writes to fixed nodes or labels', () => {
  const repo = repos[0];
  const star = Object.freeze({ repo, x: 400, y: 100, radius: 6 });
  const label = Object.freeze({ x: 400, y: 117, width: 70, size: 10 });
  for (const protection of [{ hiddenNodes: [repo.full_name] }, { hiddenLabels: [repo.full_name] }, { starPositions: { [repo.full_name]: { x: 400, y: 100 } } }]) {
    refineStars([star], new Map([[repo.full_name, label]]), { ...enabled, ...protection, snapToRings: true }, { seed: 'tester', height: 280, centerY: 126, spreadY: 88 });
  }
});

test('disabled and zero refinement preserve SVG bytes in every existing arrangement', () => {
  for (const arrangement of ['field', 'rings', 'orbital', 'force', 'galaxy', 'solar-system']) {
    const options = { ...base, arrangement };
    const before = renderConstellation('tester', repos, options);
    assert.equal(renderConstellation('tester', repos, { ...options, layoutRefinement: { enabled: false, intensity: 10 } }), before);
    assert.equal(renderConstellation('tester', repos, { ...options, layoutRefinement: { enabled: true, intensity: 0 } }), before);
  }
});

test('refined nodes and attached labels are deterministic and manually placed pairs stay fixed', () => {
  const stars = repos.slice(0, 4).map((repo, i) => ({ repo, x: 400 + i * 2, y: 100, radius: 6 }));
  const labels = new Map(stars.map(s => [s.repo.full_name, { x: s.x, y: s.y + 17, width: 70, size: 10 }]));
  const initial = structuredClone(stars), originalLabels = structuredClone(labels);
  const options = { ...enabled, starPositions: { 'tester/project-0': { x: 400, y: 100 } }, hiddenNodes: ['tester/project-1'], hiddenLabels: ['tester/project-2'] };
  refineStars(stars, labels, options, { seed: 'tester', height: 280, centerY: 126, spreadY: 88 });
  for (let i = 0; i < 3; i++) { assert.deepEqual(stars[i], initial[i]); assert.deepEqual(labels.get(stars[i].repo.full_name), originalLabels.get(stars[i].repo.full_name)); }
  assert.notDeepEqual(stars[3], initial[3]);
  const label = labels.get(stars[3].repo.full_name);
  assert.equal(label.x - stars[3].x, 0); assert.equal(label.y - stars[3].y, 17);
  assert.ok(Math.hypot(stars[3].x - initial[3].x, stars[3].y - initial[3].y) <= 48);
  const svg = renderConstellation('tester', repos, enabled);
  assert.equal(svg, renderConstellation('tester', repos, enabled));
  assert.deepEqual(coordinates(svg), coordinates(renderConstellation('tester', repos, { ...enabled, animate: true })));
});

test('manual label coordinates protect the entire pair and are not rewritten', () => {
  for (const key of ['labelOffsets', 'labelPositions']) {
    const options = { ...enabled, [key]: { 'tester/project-0': { x: 20, y: 15 } } };
    const before = renderConstellation('tester', repos, { ...options, layoutRefinement: { enabled: false } });
    const after = renderConstellation('tester', repos, options);
    assert.deepEqual(coordinates(after).find(n => n[0] === 'tester/project-0'), coordinates(before).find(n => n[0] === 'tester/project-0'));
    const label = /<text class="repo-label" data-repo="tester\/project-0"[^>]*>[^<]*<\/text>/;
    assert.equal(after.match(label)?.[0], before.match(label)?.[0]);
  }
});

test('refinement is validated and round-trips through JSON, share URLs and workflow config', async () => {
  for (const value of [null, [], { enabled: 'yes' }, { intensity: -1 }, { intensity: 11 }, { intensity: 1.5 }, { unknown: true }]) assert.throws(() => layoutRefinementOptions(value));
  assert.throws(() => parseConfig({ layoutRefinement: { enabled: true, intensity: 99 } }));
  const imported = parseConfig(serializeConfig('tester', enabled));
  const shared = decodeShare(encodeShare('https://example.com/', 'tester', imported.options));
  const block = renderWorkflow('tester', shared.options).split('          config-json: |\n')[1];
  const workflow = await loadConfig(undefined, block.split('\n').map(line => line.slice(12)).join('\n'));
  assert.deepEqual(workflow.layoutRefinement, enabled.layoutRefinement);
  assert.equal(renderConstellation('tester', repos, workflow), renderConstellation('tester', repos, enabled));
});

test('CLI config-file and Action config-json produce identical refined SVG coordinates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'constellation-refine-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = join(dir, 'repos.json'), config = join(dir, 'config.json');
  await writeFile(fixture, JSON.stringify(repos)); await writeFile(config, serializeConfig('tester', enabled));
  const environment = { ...process.env, CONSTELLATION_CONFIG: '', CONSTELLATION_CONFIG_JSON: '', GITHUB_OUTPUT: '' };
  for (const inline of [false, true]) {
    const output = join(dir, inline ? 'inline.svg' : 'file.svg');
    const args = ['src/cli.mjs', '--username', 'tester', '--fixture', fixture, '--output', output, ...(inline ? [] : ['--config', config])];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...environment, CONSTELLATION_CONFIG_JSON: inline ? serializeConfig('tester', enabled) : '' }, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const svg = await readFile(output, 'utf8');
    assert.deepEqual(coordinates(svg), coordinates(renderConstellation('tester', repos, enabled)));
  }
});
