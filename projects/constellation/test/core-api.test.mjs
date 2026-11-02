import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderConstellation, validateConfig, explainFilters, graphNodes } from '../packages/core/src/core-api.mjs';

const repos = [{ name: 'a', full_name: 'tester/a', language: 'Rust' }, { name: 'b', full_name: 'tester/b', language: 'JavaScript' }];

test('mutating returned category members cannot poison subsequent core renders', () => {
  const options = { nodeMode: 'languages', animate: false };
  const before = renderConstellation('tester', repos, options);
  const graph = graphNodes(repos, options);
  graph.nodes[0].members.push('injected/repository');
  assert.equal(renderConstellation('tester', repos, options), before);
  assert.ok(!graphNodes(repos, options).nodes[0].members.includes('injected/repository'));
});

test('core imports and renders outside the repository with bundled WASM', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'constellation-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../packages/core', import.meta.url), dir, { recursive: true });
  const core = await import(pathToFileURL(join(dir, 'src/core-api.mjs')));
  assert.equal(core.rustAvailable, true, core.engineError?.message);
  const scene = core.createScene('tester', repos, { animate: false, referenceDate: '2026-09-01T00:00:00Z' });
  assert.equal(core.renderSceneSVG(core.parseScene(core.serializeScene(scene))), core.renderSceneSVG(scene));
  await access(join(dir, 'scene-api.md'));
  await access(join(dir, 'layout-api.md'));
  assert.deepEqual(core.layoutScene(scene, { arrangement: 'galaxy' }).positions, core.layoutScene(scene, { arrangement: 'galaxy' }).positions);
  assert.equal(core.renderConstellation('tester', repos, { animate: false }), renderConstellation('tester', repos, { animate: false }));
  assert.equal(core.validateConfig({ maxRepos: 0 }).valid, false);
  assert.deepEqual(core.explainFilters(repos, { languages: ['Rust'] }), explainFilters(repos, { languages: ['Rust'] }));
});

test('validation reports unknown fields and malformed JSON without throwing', () => {
  assert.equal(validateConfig('{').valid, false);
  assert.equal(validateConfig({ maxRepo: 20 }).errors[0].path, 'maxRepo');
  assert.equal(validateConfig({ layoutRefinement: { intensity: 12 } }).valid, false);
  assert.equal(validateConfig({ maxRepos: 100 }).valid, true);
});

test('validation reports precise paths for color keys, ring angles and refinement intensity', () => {
  const result = validateConfig({ nodeColors: { 'bad id': '#123456' }, ringRotations: [0, 0, 0, 361], layoutRefinement: { intensity: 1.5 } });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map(error => error.path), ['nodeColors.bad id', 'ringRotations', 'layoutRefinement.intensity']);
  for (const ringRotations of [null, [0, 0, 0], Array(4), [0, NaN, 0, 0], [0, Infinity, 0, 0]]) assert.equal(validateConfig({ ringRotations }).valid, false);
  assert.equal(validateConfig({ nodeColors: { 'language:Jupyter Notebook': '#123456', 'tester/a': '#abcdef' }, ringRotations: [0, 90, 180, 360] }).valid, true);
});

test('CLI validate is offline and dry-run explanations leave output files untouched', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'constellation-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json'), fixture = join(dir, 'repos.json'), output = join(dir, 'absent.svg');
  await writeFile(config, JSON.stringify({ languages: ['Rust'] }));
  await writeFile(fixture, JSON.stringify(repos));
  const env = { ...process.env, CONSTELLATION_CONFIG: '', CONSTELLATION_CONFIG_JSON: '', GITHUB_OUTPUT: join(dir, 'action-output') };
  const run = args => spawnSync(process.execPath, ['src/cli.mjs', ...args], { encoding: 'utf8', env, windowsHide: true });
  const help = run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /--dry-run/);
  const version = run(['--version']); assert.equal(version.status, 0); assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/);
  const valid = run(['validate', '--config', config]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), { valid: true, errors: [] });
  const dry = run(['--username', 'tester', '--fixture', fixture, '--config', config, '--output', output, '--dry-run', '--explain']);
  assert.equal(dry.status, 0, dry.stderr);
  const report = JSON.parse(dry.stdout), evidence = report.evidence;
  delete report.evidence;
  assert.deepEqual(report, explainFilters(repos, { languages: ['Rust'] }));
  assert.equal(evidence.version, 1);
  assert.ok(evidence.facts.length > 0);
  await assert.rejects(access(output)); await assert.rejects(access(env.GITHUB_OUTPUT));
  await writeFile(config, '{"maxRepos":0}');
  const invalid = run(['validate', '--config', config]);
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /maxRepos/);
});
