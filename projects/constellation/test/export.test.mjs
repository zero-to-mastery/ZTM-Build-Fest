import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderWorkflow, readmeSnippet, projectUrl, installationLinks } from '../src/export.mjs';
import { renderConstellation } from '../src/constellation.mjs';
import { loadConfig } from '../src/config.mjs';

test('workflow round-trips every setting and arbitrary CSS into the generator', async () => {
  const options = {
    theme: 'light', layout: 'compact', animate: false, maxRepos: 15,
    includeForks: false, bridges: false, title: 'My “sky”', includeRepos: ['hello'],
    colors: { star: '#abcdef' },
    labelPositions: { 'octocat/hello': { x: 125.5, y: 90 } },
    starPositions: { 'octocat/hello': { x: 200, y: 150.5 } },
    css: '.star { fill: #f00; }\n/* ${{ secrets.TEST }}\n$(echo nope)\n`literal`\n</style><script>no</script> */\n.heading::after { content: "☄ \\ "; }',
  };
  const yaml = renderWorkflow('octocat', options);
  const block = yaml.split('          config-json: |\n')[1];
  const restored = await loadConfig(undefined, block.split('\n').map(line => line.slice(12)).join('\n'));
  assert.deepEqual(restored, options);
  assert.ok(!block.includes('${{'));
  assert.match(yaml, /uses: mnichols08\/constellation@v3/);
  assert.match(yaml, /cron: '17 6 \* \* \*'/);
  assert.match(yaml, /publish: 'true'/);
  assert.ok(!yaml.includes('git push'));
  const repos = [{ name: 'hello', full_name: 'octocat/hello', language: 'JavaScript' }];
  assert.equal(renderConstellation('octocat', repos, options), renderConstellation('octocat', repos, restored));
  assert.ok(!renderConstellation('octocat', repos, restored).includes('<script>'));
});

test('workflow always uses repository owner regardless of preview account and embeds preserve attribution', () => {
  const workflow = renderWorkflow(null, {});
  assert.ok(!workflow.includes('username:'));
  for (const account of ['octocat', 'mnichols08', 'x\nrun: malicious']) {
    assert.equal(renderWorkflow(account, {}), workflow);
  }
  const snippet = readmeSnippet('octocat');
  assert.ok(snippet.includes(`](${projectUrl})`));
  assert.ok(snippet.includes(`/output/constellation.svg)](${projectUrl})`));
  assert.match(snippet, /by \[@mnichols08\]/);
  assert.ok(snippet.includes('https://raw.githubusercontent.com/octocat/octocat/output/constellation.svg'));
  assert.ok(readmeSnippet('octocat', 'another-owner/gallery').includes('https://raw.githubusercontent.com/another-owner/gallery/output/constellation.svg'));
  assert.ok(readmeSnippet(null).includes('YOUR_USERNAME/YOUR_REPOSITORY/output/constellation.svg'));
  assert.throws(() => readmeSnippet('octocat', 'bad/repo/extra'));
  for (const layout of ['compact', 'atlas']) {
    const svg = renderConstellation('octocat', [], { layout });
    assert.ok(svg.includes(`href="${projectUrl}"`));
    assert.match(svg, /class="credit"/);
    assert.match(svg, />mnichols08\/constellation<\/text>/);
  }
});

test('installation links preserve workflow content and reject invalid targets', () => {
  const workflow = renderWorkflow('octocat', { css: '.star { fill: #abc; } /* & + ☄ */' });
  const links = installationLinks('octocat/octocat', workflow);
  const install = new URL(links.install);
  assert.equal(install.pathname, '/octocat/octocat/new/HEAD');
  assert.equal(install.searchParams.get('filename'), '.github/workflows/constellation.yml');
  assert.equal(install.searchParams.get('value'), workflow);
  assert.equal(new URL(links.create).searchParams.get('name'), 'octocat');
  assert.equal(links.actions, 'https://github.com/octocat/octocat/actions/workflows/constellation.yml');
  for (const target of ['', 'owner/repo/extra', 'https://evil.example', 'owner/..', 'owner/repo?x=1']) assert.throws(() => installationLinks(target, workflow));
  assert.equal(installationLinks('octocat/octocat', 'x'.repeat(8000)).install, null);
});

test('publishing workflow is bounded, checked out, least permission, and filename safe', async () => {
  const workflow = renderWorkflow('octocat', {}, { filename: 'alice-sky.svg', branch: 'images/daily' });
  assert.match(workflow, /uses: actions\/checkout@v6/);
  assert.match(workflow, /permissions:\n  contents: write/);
  assert.match(workflow, /output: 'alice-sky\.svg'/);
  assert.match(workflow, /output-branch: 'images\/daily'/);
  const action = await readFile(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(action, /if: \$\{\{ failure\(\).*steps\.publish\.outcome != 'failure'/);
  assert.match(action, /last known-good output branch artifact was preserved/);
  assert.match(readmeSnippet('octocat', 'octocat/octocat', 'alice-sky.svg'), /output\/alice-sky\.svg/);
  assert.throws(() => renderWorkflow('octocat', {}, { filename: '../steal.svg' }));
  assert.throws(() => renderWorkflow('octocat', {}, { filename: 'constellation.svg', branch: 'output;echo bad' }));
});

test('inline config rejects ambiguous or invalid inputs while file CSS still resolves', async () => {
  await assert.rejects(loadConfig('config.json', '{}'), /either config or config-json/);
  for (const value of ['null', '[]', '"string"', '{bad']) await assert.rejects(loadConfig(undefined, value));
  await assert.rejects(loadConfig(undefined, '{"cssFile":"style.css"}'), /must embed CSS/);
  const dir = await mkdtemp(join(tmpdir(), 'constellation-config-'));
  try {
    await writeFile(join(dir, 'style.css'), '.star{fill:#abc}');
    await writeFile(join(dir, 'config.json'), '{"cssFile":"style.css","layout":"compact"}');
    assert.deepEqual(await loadConfig(join(dir, 'config.json')), { cssFile: 'style.css', layout: 'compact', css: '.star{fill:#abc}' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
