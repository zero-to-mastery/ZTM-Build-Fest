import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { migrateConfig, migrateWorkflow } from '../src/migrate.mjs';
import { parseConfig, CONFIG_VERSION } from '../src/config-schema.mjs';
import { randomizeDesign } from '../src/design-randomizer.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { renderWorkflow } from '../src/export.mjs';
import { decodeShare } from '../src/share-link.mjs';

const repos = [{ name: 'a', full_name: 'tester/a', language: 'Rust', created_at: '2020-01-01T00:00:00Z' }];
const render = options => renderConstellation('tester', repos, { ...options, referenceDate: '2026-09-27T00:00:00Z' });

test('every released recipe migrates to v7 with identical rendered SVG', () => {
  assert.equal(CONFIG_VERSION, 7);
  for (const code of ['v1:fixture', 'v2:fixture', 'v3:motion-fixture', 'v4:motion-fixture', 'v5:m000-y2026-f2012-fixture']) {
    const migrated = migrateConfig(code, { account: 'tester' });
    assert.equal(migrated.version, 7);
    assert.equal(render(parseConfig(migrated).options), render(randomizeDesign(code)));
    assert.deepEqual(migrateConfig(migrated), migrated);
  }
});

test('legacy configs and encoded share links preserve manual/hidden and new settings', () => {
  const options = { layoutRefinement: { enabled: true, intensity: 5 }, starPositions: { 'tester/a': { x: 100, y: 100 } }, hiddenLabels: ['tester/a'], plugins: { sources: [] }, themePack: { id: 'deep-space', version: '1.0.0' } };
  const legacy = { version: 1, account: 'tester', options };
  const encoded = Buffer.from(JSON.stringify(legacy)).toString('base64url');
  const url = `https://example.com/?user=tester&view=${encoded}`;
  const migrated = migrateConfig(url);
  assert.equal(migrated.version, 7);
  assert.deepEqual(parseConfig(migrated).options, options);
  assert.equal(render(parseConfig(migrated).options), render(options));
  assert.equal(decodeShare(url).version, 7);
  const cli = spawnSync(process.execPath, ['src/cli.mjs', 'migrate', '--from', url], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), migrated);
});

test('workflow migration changes the major reference and preserves generated config', () => {
  const options = { animate: false, css: '.heading::after { content: "\\\\"; }' };
  const old = renderWorkflow(null, options).replace('@v3', '@v1.9.3').replace('"version": 7', '"version": 1');
  // Legacy generated workflows were unversioned and permitted trusted CSS.
  const unversioned = old.replace(/,\n\s*"version": 1/, '');
  const migrated = migrateWorkflow(unversioned);
  assert.match(migrated, /constellation@v3/);
  const block = migrated.split('config-json: |\n')[1];
  const config = JSON.parse(block);
  assert.equal(config.version, 7);
  assert.equal(render(parseConfig(config).options), render(options));
  assert.throws(() => migrateWorkflow('uses: mnichols08/constellation@v1\nconfig-json: "{}"'), /separately/);
});
