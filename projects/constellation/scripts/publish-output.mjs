import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, readFile, appendFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { projectUrl } from '../src/export.mjs';
import { createPublicationManifest, validatePublicationArtifact, validatePublicationManifest } from '../src/publication-integrity.mjs';

const MANIFEST_PATH = '.constellation/publication-manifest.json';

export function publicationSummary({ repository, branch = 'output', file, status = 'published' }) {
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repository || '') || repository.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid GitHub repository for publication summary.');
  if (!/^[a-z\d][a-z\d._-]{0,127}\.svg$/i.test(basename(file || ''))) throw new Error('Invalid SVG filename for publication summary.');
  const path = repository.split('/').map(encodeURIComponent).join('/');
  const branchPath = branch.split('/').map(encodeURIComponent).join('/');
  const image = `https://raw.githubusercontent.com/${path}/${branchPath}/${encodeURIComponent(basename(file))}`;
  const snippet = `[![My GitHub constellation](${image})](${projectUrl})\n\nMade with [GitHub Constellation](${projectUrl}) by [@mnichols08](https://github.com/mnichols08).`;
  return `## Your GitHub constellation\n\n**Refresh status:** ${status === 'skipped' ? 'unchanged; no commit was created' : 'published successfully'}\n\n${snippet}\n\n[Open the generated image](${image})\n\nPaste this into your profile README:\n\n\`\`\`md\n${snippet}\n\`\`\`\n\nThe image updates when a validated artifact changes.\n`;
}

export async function publishOutput({ cwd = process.cwd(), file, branch = 'output', repository = process.env.GITHUB_REPOSITORY, sourceRevision = process.env.GITHUB_SHA, account = process.env.CONSTELLATION_USERNAME, configJson = process.env.CONSTELLATION_CONFIG_JSON, configFile = process.env.CONSTELLATION_CONFIG, evidenceDigest = process.env.CONSTELLATION_EVIDENCE_DIGEST }) {
  const git = (args, directory = cwd, input) => execFileSync('git', args, { cwd: directory, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  if (typeof branch !== 'string' || branch.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.includes('//')) throw new Error('Invalid output branch name.');
  git(['check-ref-format', '--branch', branch]);
  const source = resolve(cwd, file);
  const sourceRelative = relative(resolve(cwd), source);
  if (!file || isAbsolute(file) || sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) throw new Error('Published output must stay inside the checked out workspace.');
  const filename = basename(source);
  if (!/^[a-z\d][a-z\d._-]{0,127}\.svg$/i.test(filename)) throw new Error('Published output must have a simple .svg filename.');
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 1 || sourceInfo.size > 12 * 1024 * 1024) throw new Error('Published output must be a bounded regular file, not a link.');
  const realWorkspace = await realpath(cwd);
  const realSource = await realpath(source);
  const actualRelative = relative(realWorkspace, realSource);
  if (actualRelative.startsWith('..') || isAbsolute(actualRelative)) throw new Error('Published output resolves outside the checked out workspace.');
  const artifact = await readFile(source); // Fail before touching Git if generation did not succeed.
  const artifactInfo = validatePublicationArtifact(artifact, { format: 'svg', filename });
  let configBytes = typeof configJson === 'string' && configJson ? Buffer.from(configJson) : null;
  if (!configBytes && configFile) {
    try {
      const configPath = resolve(cwd, configFile);
      const configInfo = await lstat(configPath);
      if (configInfo.isFile() && !configInfo.isSymbolicLink() && configInfo.size <= 1024 * 1024) configBytes = await readFile(configPath);
    } catch { /* The configuration digest remains unknown if unavailable or over its bound. */ }
  }
  if (configBytes?.byteLength > 1024 * 1024) configBytes = null;
  const destination = `${repository || 'unknown/repository'}@${branch}`;
  const manifest = createPublicationManifest({
    source: {
      identity: sourceRevision && /^[a-f\d]{7,64}$/i.test(sourceRevision) ? `${repository || 'unknown/repository'}@${sourceRevision}` : null,
      account: typeof account === 'string' && /^[a-z\d-]{1,39}$/i.test(account) ? account : null,
      configurationDigest: configBytes ? `sha256:${createHash('sha256').update(configBytes).digest('hex')}` : null,
      evidenceDigest: /^sha256:[a-f\d]{64}$/i.test(evidenceDigest || '') ? evidenceDigest : null,
    },
    referenceDate: new Date().toISOString().slice(0, 10),
    format: 'svg', filename, digest: artifactInfo.digest, bytes: artifactInfo.bytes,
    destination, revision: 1,
  });
  if (git(['branch', '--show-current']) === branch) throw new Error('Check out the source branch before publishing to the output branch.');
  const identity = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
  for (let attempt = 0; attempt < 3; attempt++) {
    const directory = await mkdtemp(join(tmpdir(), 'constellation-output-'));
    const worktree = join(directory, 'branch');
    let attached = false;
    try {
      const existing = git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
      let base;
      if (existing) {
        git(['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]);
        base = git(['rev-parse', 'FETCH_HEAD']);
      } else {
        const tree = git(['mktree'], cwd, '');
        base = git([...identity, 'commit-tree', tree, '-m', 'Initialize constellation output']);
      }
      git(['worktree', 'add', '--detach', worktree, base]);
      attached = true;
      const manifestDirectory = join(worktree, '.constellation');
      try {
        const directoryInfo = await lstat(manifestDirectory);
        if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) await rm(manifestDirectory, { recursive: true, force: true });
      } catch { /* Directory is created below on first publication. */ }
      await mkdir(manifestDirectory, { recursive: true });
      let previousManifest;
      try {
        const manifestPath = join(worktree, MANIFEST_PATH);
        const manifestInfo = await lstat(manifestPath);
        if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 16 * 1024) throw new Error('Invalid prior manifest file.');
        const parsedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (validatePublicationManifest(parsedManifest).valid) previousManifest = parsedManifest;
      } catch { /* Missing or corrupt sidecars never block a validated refresh. */ }
      let priorArtifact;
      try {
        const priorPath = join(worktree, filename);
        const priorInfo = await lstat(priorPath);
        if (priorInfo.isFile() && !priorInfo.isSymbolicLink() && priorInfo.size <= 12 * 1024 * 1024) priorArtifact = await readFile(priorPath);
      } catch { /* New destination or first publication. */ }
      const artifactUnchanged = Boolean(priorArtifact && priorArtifact.equals(artifact));
      const manifestMatchesArtifact = Boolean(previousManifest
        && previousManifest.artifact.format === 'svg'
        && previousManifest.artifact.filename === filename
        && previousManifest.artifact.digest === artifactInfo.digest
        && previousManifest.artifact.bytes === artifactInfo.bytes
        && previousManifest.destination.identity === destination);
      if (artifactUnchanged && manifestMatchesArtifact) {
        return { status: 'skipped', changed: false, digest: artifactInfo.digest, manifestValid: true };
      }
      // Preserve identical validated bytes during metadata recovery. Otherwise,
      // replace only this image; unrelated output files survive and symlinks
      // are removed before copying so the copy cannot follow them.
      if (!artifactUnchanged) {
        await rm(join(worktree, filename), { force: true });
        await copyFile(source, join(worktree, filename));
      }
      const manifestPath = join(worktree, MANIFEST_PATH);
      try {
        const sidecarInfo = await lstat(manifestPath);
        if (sidecarInfo.isSymbolicLink()) await rm(manifestPath, { force: true });
        else if (!sidecarInfo.isFile()) throw new Error('Publication manifest path is occupied by a directory.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, revision: (Number.isSafeInteger(previousManifest?.revision) && previousManifest.revision > 0 ? previousManifest.revision : 0) + 1 }, null, 2)}\n`, { flag: 'w' });
      git(['add', '--', filename], worktree);
      git(['add', '--', MANIFEST_PATH], worktree);
      if (!git(['diff', '--cached', '--name-only'], worktree)) return { status: 'skipped', changed: false, digest: artifactInfo.digest };
      git([...identity, 'commit', '-m', 'Update GitHub constellation'], worktree);
      try {
        git(['push', 'origin', `HEAD:refs/heads/${branch}`], worktree);
        return { status: 'published', changed: true, digest: artifactInfo.digest };
      } catch (error) {
        // A different workflow may have updated output. Rebase our single file
        // onto its latest state by rebuilding the worktree; never force-push.
        if (attempt === 2) throw error;
      }
    } finally {
      if (attached) git(['worktree', 'remove', '--force', worktree]);
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await publishOutput({ file: process.env.CONSTELLATION_OUTPUT, branch: process.env.CONSTELLATION_OUTPUT_BRANCH || 'output' });
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, publicationSummary({
      repository: process.env.GITHUB_REPOSITORY,
      branch: process.env.CONSTELLATION_OUTPUT_BRANCH || 'output',
      file: process.env.CONSTELLATION_OUTPUT,
      status: result.status,
    }));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publication-status=${result.status}\npublication-digest=${result.digest}\n`);
    console.log(result.status === 'skipped' ? 'Validated artifact is unchanged; no publication commit was created.' : 'Published validated constellation artifact.');
  } catch (error) {
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '\n## Constellation refresh failed\n\nThe refresh did not publish a replacement. The last known-good output branch artifact was preserved.\n').catch(() => {});
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'publication-status=failed\n').catch(() => {});
    console.error(error.message);
    process.exitCode = 1;
  }
}
