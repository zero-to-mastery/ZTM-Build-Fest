import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishOutput, publicationSummary } from '../scripts/publish-output.mjs';

const validSvg = label => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560" role="img" aria-labelledby="title description"><title id="title">${label}</title><desc id="description">Project constellation</desc></svg>`;

test('publication summary links to the actual branch and published basename', () => {
  const summary = publicationSummary({ repository: 'octocat/octocat', branch: 'images/daily', file: 'dist/custom.svg' });
  assert.match(summary, /https:\/\/raw\.githubusercontent\.com\/octocat\/octocat\/images\/daily\/custom\.svg/);
  assert.ok(!summary.includes('dist/'));
  assert.ok(summary.includes('```md\n[![My GitHub constellation]'));
  assert.ok(summary.includes('/custom.svg)](https://github.com/mnichols08/constellation)'));
  assert.throws(() => publicationSummary({ repository: 'owner/repo\ninjected', file: 'x.svg' }));
});

test('publishes to an isolated output branch and preserves other generated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'constellation-publish-test-'));
  const remote = join(directory, 'remote.git');
  const cwd = join(directory, 'source');
  const git = (args, path = cwd) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '--bare', remote], directory);
    git(['init', '-b', 'main', cwd], directory);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'commit.gpgsign', 'false']);
    await writeFile(join(cwd, 'README.md'), 'Source branch');
    git(['add', 'README.md']);
    git(['commit', '-m', 'Initial source']);
    git(['remote', 'add', 'origin', remote]);
    git(['push', 'origin', 'main']);
    const sourceHead = git(['rev-parse', 'HEAD']);
    await writeFile(join(cwd, 'constellation.svg'), validSvg('first'));
    assert.equal((await publishOutput({ cwd, file: 'constellation.svg', repository: 'octocat/octocat', sourceRevision: 'abcdef0123456789', account: 'octocat', configJson: '{}', evidenceDigest: `sha256:${'a'.repeat(64)}` })).status, 'published');
    git(['fetch', 'origin', 'output']);
    assert.equal(git(['ls-tree', '--name-only', 'FETCH_HEAD']), '.constellation\nconstellation.svg');
    assert.equal(git(['show', 'FETCH_HEAD:constellation.svg']), validSvg('first'));
    assert.match(git(['show', 'FETCH_HEAD:.constellation/publication-manifest.json']), /"generation": "success"/);
    assert.match(git(['show', 'FETCH_HEAD:.constellation/publication-manifest.json']), new RegExp(`"evidenceDigest": "sha256:${'a'.repeat(64)}"`));
    assert.equal(git(['rev-parse', 'HEAD']), sourceHead);
    await rm(join(cwd, 'constellation.svg'));
    git(['switch', '-c', 'metrics', 'FETCH_HEAD']);
    await writeFile(join(cwd, 'metrics.svg'), validSvg('metrics'));
    await writeFile(join(cwd, '.constellation/publication-manifest.json'), '{corrupt manifest');
    git(['add', 'metrics.svg']);
    git(['add', '.constellation/publication-manifest.json']);
    git(['commit', '-m', 'Existing Metrics output']);
    git(['push', 'origin', 'HEAD:output']);
    git(['switch', 'main']);
    await writeFile(join(cwd, 'constellation.svg'), validSvg('updated'));
    assert.equal((await publishOutput({ cwd, file: 'constellation.svg', repository: 'octocat/octocat' })).status, 'published');
    git(['fetch', 'origin', 'output']);
    assert.equal(git(['show', 'FETCH_HEAD:metrics.svg']), validSvg('metrics'));
    assert.equal(git(['show', 'FETCH_HEAD:constellation.svg']), validSvg('updated'));
    const outputHead = git(['rev-parse', 'FETCH_HEAD']);
    assert.equal((await publishOutput({ cwd, file: 'constellation.svg', repository: 'octocat/octocat', sourceRevision: 'fedcba9876543210', account: 'octocat', configJson: '{"changed":true}' })).status, 'skipped');
    git(['fetch', 'origin', 'output']);
    assert.equal(git(['rev-parse', 'FETCH_HEAD']), outputHead, 'unchanged image adds no commit');
    assert.equal(git(['branch', '--show-current']), 'main');
    assert.equal(git(['rev-parse', 'HEAD']), sourceHead);
    await assert.rejects(publishOutput({ cwd, file: 'constellation.svg', branch: 'main' }), /source branch/);
    await assert.rejects(publishOutput({ cwd, file: 'constellation.svg', branch: '../invalid' }));
    await writeFile(join(cwd, 'constellation.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560" role="img" aria-labelledby="title description"><title>bad</title><desc>bad</desc><g></svg>');
    await assert.rejects(publishOutput({ cwd, file: 'constellation.svg' }), /unbalanced/);
    git(['fetch', 'origin', 'output']);
    assert.equal(git(['show', 'FETCH_HEAD:constellation.svg']), validSvg('updated'), 'failed generation preserves the prior valid artifact');
    await writeFile(join(cwd, 'constellation.svg'), validSvg('recovered'));
    assert.equal((await publishOutput({ cwd, file: 'constellation.svg' })).status, 'published');
    git(['fetch', 'origin', 'output']);
    assert.match(git(['show', 'FETCH_HEAD:.constellation/publication-manifest.json']), /"version": 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent first refreshes converge on one output branch without force pushes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'constellation-publish-race-'));
  const remote = join(directory, 'remote.git');
  const cwd = join(directory, 'source');
  const git = (args, path = cwd) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '--bare', remote], directory);
    git(['init', '-b', 'main', cwd], directory);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.com']);
    await writeFile(join(cwd, 'README.md'), 'Source branch');
    git(['add', 'README.md']);
    git(['commit', '-m', 'Initial source']);
    git(['remote', 'add', 'origin', remote]);
    git(['push', 'origin', 'main']);
    await writeFile(join(cwd, 'constellation.svg'), validSvg('race'));
    const results = await Promise.all([
      publishOutput({ cwd, file: 'constellation.svg' }),
      publishOutput({ cwd, file: 'constellation.svg' }),
    ]);
    assert.ok(results.every(result => ['published', 'skipped'].includes(result.status)));
    git(['fetch', 'origin', 'output']);
    assert.equal(git(['show', 'FETCH_HEAD:constellation.svg']), validSvg('race'));
    assert.equal(git(['rev-list', '--count', 'FETCH_HEAD']), '2', 'one initial branch commit and one artifact publication');
    assert.equal(git(['branch', '--show-current']), 'main');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function assertConcurrentManifestRepair(manifestState) {
  const directory = await mkdtemp(join(tmpdir(), `constellation-manifest-${manifestState}-`));
  const remote = join(directory, 'remote.git');
  const cwd = join(directory, 'source');
  const git = (args, path = cwd) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const artifact = validSvg(`preserve-${manifestState}`);
  try {
    git(['init', '--bare', remote], directory);
    git(['init', '-b', 'main', cwd], directory);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'commit.gpgsign', 'false']);
    await writeFile(join(cwd, 'README.md'), 'Source branch');
    await writeFile(join(cwd, 'constellation.svg'), artifact);
    git(['add', 'README.md']);
    git(['commit', '-m', 'Initial source']);
    git(['remote', 'add', 'origin', remote]);
    git(['push', 'origin', 'main']);

    assert.equal((await publishOutput({ cwd, file: 'constellation.svg', repository: 'octocat/octocat' })).status, 'published');
    git(['fetch', 'origin', 'output']);
    const publishedArtifact = git(['show', 'FETCH_HEAD:constellation.svg']);
    assert.equal(publishedArtifact, artifact);
    const publishedSidecar = '.constellation/publication-manifest.json';
    await rm(join(cwd, 'constellation.svg'));
    git(['switch', '-c', 'invalidate-manifest', 'FETCH_HEAD']);
    if (manifestState === 'missing') git(['rm', publishedSidecar]);
    else {
      await writeFile(join(cwd, publishedSidecar), '{corrupt manifest');
      git(['add', publishedSidecar]);
    }
    git(['commit', '-m', `Make publication metadata ${manifestState}`]);
    git(['push', 'origin', 'HEAD:output']);
    const invalidatedHead = git(['rev-parse', 'HEAD']);
    git(['switch', 'main']);
    await writeFile(join(cwd, 'constellation.svg'), artifact);

    const repairs = await Promise.all([
      publishOutput({ cwd, file: 'constellation.svg', repository: 'octocat/octocat' }),
      publishOutput({ cwd, file: 'constellation.svg', repository: 'octocat/octocat' }),
    ]);
    assert.ok(repairs.some(result => result.status === 'published'), 'one concurrent invocation repairs the sidecar');
    assert.ok(repairs.every(result => ['published', 'skipped'].includes(result.status)));
    git(['fetch', 'origin', 'output']);
    const repairedHead = git(['rev-parse', 'FETCH_HEAD']);
    assert.notEqual(repairedHead, invalidatedHead);
    assert.equal(git(['rev-list', '--count', 'FETCH_HEAD']), '4', 'concurrent repair creates exactly one metadata commit');
    assert.equal(git(['show', 'FETCH_HEAD:constellation.svg']), publishedArtifact, 'repair preserves the validated artifact bytes');
    const repairedManifest = JSON.parse(git(['show', `FETCH_HEAD:${publishedSidecar}`]));
    assert.equal(repairedManifest.version, 1);
    assert.equal(repairedManifest.artifact.filename, 'constellation.svg');
    assert.equal(repairedManifest.artifact.bytes, Buffer.byteLength(publishedArtifact));

    assert.equal((await publishOutput({ cwd, file: 'constellation.svg', repository: 'octocat/octocat' })).status, 'skipped');
    git(['fetch', 'origin', 'output']);
    assert.equal(git(['rev-parse', 'FETCH_HEAD']), repairedHead, 'identical run after repair is a true no-op');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('concurrent refreshes repair a missing manifest without rewriting identical artifact bytes', async () => {
  await assertConcurrentManifestRepair('missing');
});

test('concurrent refreshes repair a corrupt manifest without rewriting identical artifact bytes', async () => {
  await assertConcurrentManifestRepair('corrupt');
});
