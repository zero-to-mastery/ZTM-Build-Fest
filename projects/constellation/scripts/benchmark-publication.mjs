import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createPublicationManifest, classifyPublicationChange, validatePublicationArtifact, sha256Digest, validatePublicationManifest } from '../src/publication-integrity.mjs';
import { publishOutput } from './publish-output.mjs';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560" role="img" aria-labelledby="title description"><title id="title">Fixture</title><desc id="description">Publication benchmark</desc></svg>';
const bytes = Buffer.from(svg);
const manifest = createPublicationManifest({ source: { identity: 'fixture/repo@abcdef0123456', account: 'fixture', configurationDigest: sha256Digest('{}'), evidenceDigest: sha256Digest('fixture-evidence') }, referenceDate: '2026-10-11', format: 'svg', filename: 'constellation.svg', digest: sha256Digest(bytes), bytes: bytes.length, destination: 'fixture/repo@output' });
const iterations = 20_000;
let started = performance.now();
for (let index = 0; index < iterations; index++) validatePublicationManifest(manifest);
const validationMs = performance.now() - started;
started = performance.now();
for (let index = 0; index < iterations; index++) classifyPublicationChange(manifest, manifest);
const comparisonMs = performance.now() - started;
const artifact = validatePublicationArtifact(bytes, { format: 'svg', filename: 'constellation.svg' });

const directory = await mkdtemp(join(tmpdir(), 'constellation-publication-bench-'));
const remote = join(directory, 'remote.git');
const cwd = join(directory, 'source');
const git = (args, path = cwd) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
let localGitPublication = { available: false };
try {
  git(['init', '--bare', remote], directory);
  await mkdir(cwd);
  git(['init', '-b', 'main', cwd], directory);
  git(['config', 'user.name', 'Benchmark']);
  git(['config', 'user.email', 'benchmark@example.invalid']);
  await writeFile(join(cwd, 'README.md'), 'Fixture source');
  git(['add', 'README.md']);
  git(['commit', '-m', 'Fixture source']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', 'origin', 'main']);
  await writeFile(join(cwd, 'constellation.svg'), svg);
  started = performance.now();
  const first = await publishOutput({ cwd, file: 'constellation.svg', repository: 'fixture/repo', sourceRevision: 'abcdef0123456789', account: 'fixture', configJson: '{}' });
  const firstPublicationMs = performance.now() - started;
  started = performance.now();
  const unchanged = await publishOutput({ cwd, file: 'constellation.svg', repository: 'fixture/repo', sourceRevision: 'fedcba9876543210', account: 'fixture', configJson: '{"same-output":true}' });
  const unchangedRefreshMs = performance.now() - started;
  if (first.status !== 'published' || unchanged.status !== 'skipped') throw new Error('Publication benchmark fixture produced an unexpected result.');
  localGitPublication = { available: true, firstPublicationMs, unchangedRefreshMs };
} catch (error) {
  if (error.code !== 'EPERM') throw error;
  localGitPublication = { available: false, reason: 'This environment blocked Git child-process startup; use the local publication fixture test for its measured duration.' };
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function directoryBytes(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else total += (await stat(child)).size;
  }
  return total;
}
const wasm = await readFile(new URL('../src/wasm/constellation_core_bg.wasm', import.meta.url));
const gzip = await import('node:zlib');
console.log(JSON.stringify({
  fixture: { svgBytes: bytes.length, digest: artifact.digest },
  manifest: { iterations, validationMeanMs: validationMs / iterations, comparisonMeanMs: comparisonMs / iterations },
  localGitPublication,
  sizes: { wasmBytes: wasm.length, wasmGzipBytes: gzip.gzipSync(wasm, { level: 9 }).length, corePackageBytes: await directoryBytes(fileURLToPath(new URL('../packages/core/', import.meta.url))), componentEntryBytes: (await stat(new URL('../packages/web-component/index.mjs', import.meta.url))).size },
}, null, 2));
