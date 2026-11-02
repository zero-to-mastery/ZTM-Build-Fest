import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectConstellation, validateProjectConstellation, explainProjectStructuralNode, explainProjectStructuralEdge } from '../src/project-constellation.mjs';
import { fetchGitHubProjectConstellation } from '../src/github-project-structure.mjs';
import { createProjectConstellationScene, createProjectConstellationHierarchy } from '../src/project-constellation-scene.mjs';
import { createScene } from '../src/constellation.mjs';
import { validateScene } from '../src/scene.mjs';

const tree = [
  { path: 'package.json', type: 'blob', size: 80 },
  { path: 'packages', type: 'tree' },
  { path: 'packages/core', type: 'tree' },
  { path: 'packages/core/package.json', type: 'blob', size: 50 },
  { path: 'packages/core/src', type: 'tree' },
  { path: 'packages/core/src/index.mjs', type: 'blob', size: 70 },
  { path: 'packages/core/src/other.mjs', type: 'blob', size: 30 },
  { path: 'packages/core/src/private.txt', type: 'blob', size: 3 },
];
const contents = {
  'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
  'packages/core/package.json': JSON.stringify({ name: '@example/core', exports: { '.': { import: './src/index.mjs' } } }),
  'packages/core/src/index.mjs': "import './other.mjs'; export { x } from './other.mjs'; // import './commented.mjs'\nconst example = \"import './string.mjs'\"; const pattern = /import '\\.\\/regex.mjs'/; import('./dynamic.mjs');",
  'packages/core/src/other.mjs': 'export const x = 1;',
};

test('project structure is stable, bounded, and evidence backed', () => {
  const model = createProjectConstellation({ projectId: 'owner/repo', ref: 'main', commit: 'a'.repeat(40), tree, contents });
  const reversed = createProjectConstellation({ projectId: 'owner/repo', ref: 'main', commit: 'a'.repeat(40), tree: [...tree].reverse(), contents });
  assert.deepEqual(model, reversed);
  assert.equal(validateProjectConstellation(model).valid, true);
  assert.ok(model.nodes.some(node => node.kind === 'project-root'));
  assert.ok(model.nodes.some(node => node.kind === 'package' && node.path === 'packages/core'));
  assert.ok(model.nodes.some(node => node.kind === 'entry-point' && node.path === 'packages/core/src/index.mjs'));
  assert.ok(model.edges.some(edge => edge.kind === 'workspace-member' && edge.evidence.source === 'manifest'));
  assert.ok(model.edges.some(edge => edge.kind === 'imports' && edge.evidence.path === 'packages/core/src/index.mjs'), JSON.stringify({ nodes: model.nodes, edges: model.edges }));
  assert.ok(model.edges.every(edge => edge.evidence && !JSON.stringify(edge).includes('export const')));
  assert.equal(model.statistics.unsupportedFilesIgnored, 1);
  assert.equal(model.provenance.commit, 'a'.repeat(40));
  const entry = model.nodes.find(node => node.kind === 'entry-point');
  assert.equal(explainProjectStructuralNode(model, entry.id).path, entry.path);
  const importEdge = model.edges.find(edge => edge.kind === 'imports');
  assert.equal(explainProjectStructuralEdge(model, importEdge.id).evidence.path, 'packages/core/src/index.mjs');
  assert.equal(model.edges.filter(edge => edge.kind === 'imports').length, 1, 'duplicate imports to the same module produce one relationship');
  assert.equal(model.statistics.importsParsed, 2, 'comments, strings, and dynamic imports are ignored');
});

test('Cargo workspace membership and import cycles remain explicit and bounded', () => {
  const cargo = createProjectConstellation({ projectId: 'owner/rust-repo', tree: [
    { path: 'Cargo.toml', type: 'blob' }, { path: 'rust', type: 'tree' }, { path: 'rust/core', type: 'tree' },
    { path: 'rust/core/Cargo.toml', type: 'blob' }, { path: 'rust/core/src', type: 'tree' }, { path: 'rust/core/src/lib.rs', type: 'blob' },
  ], contents: { 'Cargo.toml': '[workspace]\nmembers = [\n  "rust/core",\n]\n', 'rust/core/Cargo.toml': '[package]\nname = "core"\n' } });
  assert.ok(cargo.nodes.some(node=>node.kind==='package'&&node.path==='rust/core'));
  assert.ok(cargo.edges.some(edge=>edge.kind==='workspace-member'&&edge.evidence.path==='Cargo.toml'&&edge.evidence.declaration==='rust/core'));

  const cycle=createProjectConstellation({projectId:'owner/cycle',tree:[{path:'src/a.js',type:'blob'},{path:'src/b.js',type:'blob'}],contents:{'src/a.js':"import './b.js';",'src/b.js':"import './a.js';"}});
  assert.equal(validateProjectConstellation(cycle).valid,true);
  assert.equal(cycle.edges.filter(edge=>edge.kind==='imports').length,2);
});

test('very large trees expose truncation and remain within graph bounds', () => {
  const many = Array.from({ length: 1000 }, (_, i) => ({ path: `src/file-${String(i).padStart(4, '0')}.js`, type: 'blob', size: 1 }));
  const model = createProjectConstellation({ projectId: 'owner/large', tree: many });
  assert.ok(model.nodes.length <= 100);
  assert.ok(model.edges.length <= 1024);
  assert.equal(model.statistics.filesInspected, 500);
  assert.equal(model.statistics.sourceFilesAvailable, 1000, 'source availability comes from the full supplied tree');
  assert.equal(model.statistics.sourceFilesSelected, 500);
  assert.equal(model.statistics.sourceFilesRead, 0);
  assert.equal(model.statistics.truncated, true);
  assert.match(model.statistics.limitation, /500 of 1000 files/);
});

test('repository-wide manifest and source availability stays truthful beyond the inspection window', () => {
  const ordinary = Array.from({ length: 501 }, (_, i) => ({ path: `a-files/file-${String(i).padStart(4, '0')}.txt`, type: 'blob', size: 1 }));
  const manifests = Array.from({ length: 501 }, (_, i) => ({ path: `z-packages/pkg-${String(i).padStart(4, '0')}/package.json`, type: 'blob', size: 2 }));
  const contents = Object.fromEntries(manifests.map(item => [item.path, '{}']));
  const model = createProjectConstellation({ projectId: 'owner/repository-wide', tree: [...ordinary, ...manifests], contents });
  const stats = model.statistics;
  assert.equal(stats.filesAvailable, 1002);
  assert.equal(stats.filesInspected, 500);
  assert.equal(stats.manifestsAvailable, 501);
  assert.equal(stats.manifestsSelected, 500, 'manifest priority moves manifests ahead of lexically earlier ordinary files');
  assert.equal(stats.manifestsRead, 32);
  assert.equal(stats.manifestsOmitted, 469);
  assert.equal(stats.sourceFilesAvailable, 0);
  assert.equal(stats.truncated, true);
  assert.match(stats.limitation, /501 manifests exist, 500 were selected and 32 read/);
  assert.equal(validateProjectConstellation(model).valid, true);
});

test('package nodes reference observed manifest paths, including unread manifests', () => {
  const packageTree = [
    { path: 'packages/foo/package.json', type: 'blob' },
    { path: 'packages/bar/pyproject.toml', type: 'blob' },
    { path: 'rust/core/Cargo.toml', type: 'blob' },
    { path: 'packages/unread/go.mod', type: 'blob' },
  ];
  const model = createProjectConstellation({ projectId: 'owner/manifests', tree: packageTree, contents: {
    'packages/foo/package.json': '{"main":"index.js"}',
  } });
  const manifests = Object.fromEntries(model.nodes.filter(node => node.kind === 'package').map(node => [node.path, node.metadata.manifest]));
  assert.equal(manifests['packages/foo'], 'packages/foo/package.json');
  assert.equal(manifests['packages/bar'], 'packages/bar/pyproject.toml');
  assert.equal(manifests['rust/core'], 'rust/core/Cargo.toml');
  assert.equal(manifests['packages/unread'], 'packages/unread/go.mod');
  assert.ok(Object.values(manifests).every(path => packageTree.some(item => item.path === path)));
  assert.equal(validateProjectConstellation(model).valid, true);
  const forged = structuredClone(model);
  forged.nodes.find(node => node.path === 'packages/foo').metadata.manifest = 'packages/foo/Cargo.toml';
  assert.equal(validateProjectConstellation(forged).valid, false, 'validator rejects inconsistent package manifest paths');
});

test('manifest and source file byte limits are separate and the global byte cap still applies', () => {
  const sourceUnderLimit = 'x'.repeat(70 * 1024);
  const sourceOverLimit = 'x'.repeat(129 * 1024);
  const tooLargeManifest = ' '.repeat(65 * 1024);
  const treeWithLimits = [
    { path: 'package.json', type: 'blob' },
    { path: 'src/normal.js', type: 'blob' },
    { path: 'src/large.js', type: 'blob' },
  ];
  const model = createProjectConstellation({ projectId: 'owner/content-limits', tree: treeWithLimits, contents: {
    'package.json': tooLargeManifest,
    'src/normal.js': sourceUnderLimit,
    'src/large.js': sourceOverLimit,
  } });
  assert.equal(model.statistics.manifestsRead, 0, 'oversized manifest is excluded');
  assert.equal(model.statistics.sourceFilesRead, 1, '70 KiB source is read even though it exceeds the manifest cap');
  assert.equal(model.statistics.bytesRead, new TextEncoder().encode(sourceUnderLimit).length);
  assert.equal(model.statistics.truncated, true);

  const capped = createProjectConstellation({ projectId: 'owner/global-content-limit', tree: [
    { path: 'package.json', type: 'blob' }, { path: 'src/index.js', type: 'blob' },
  ], contents: { 'package.json': ' '.repeat(30 * 1024), 'src/index.js': 'x'.repeat(80 * 1024) } }, { bytes: 100 * 1024 });
  assert.equal(capped.statistics.bytesRead, 30 * 1024);
  assert.equal(capped.statistics.sourceFilesRead, 0, 'combined cap prevents the next source read');
  assert.equal(capped.statistics.bytesRead <= 100 * 1024, true);
});

test('structural model adapts to Scene v1 and existing hierarchy navigation', () => {
  const model = createProjectConstellation({ projectId: 'owner/repo', ref: 'main', tree, contents });
  const project = createProjectConstellationScene(model);
  assert.equal(validateScene(project.scene).valid, true);
  assert.equal(project.scene.nodes.length, model.nodes.length, JSON.stringify({ graph: project.scene.presentation.graph, pipeline: project.scene.presentation.pipeline }));
  assert.equal(project.scene.edges.length, model.edges.length);
  assert.ok(project.scene.nodes.some(node => node.metadata.projectStructureKind === 'entry-point'));
  assert.ok(project.scene.edges.some(edge => edge.metadata.structuralKind === 'imports' && edge.metadata.evidence.path === 'packages/core/src/index.mjs'));

  const parent = createScene('developer', [{ full_name: 'owner/repo', name: 'repo', language: 'JavaScript' }], { accountSun: 'off' });
  const hierarchy = createProjectConstellationHierarchy(parent, 'owner/repo', model);
  assert.equal(validateScene(hierarchy).valid, true);
  assert.equal(hierarchy.hierarchy.scenes.length, 2);
  assert.equal(hierarchy.nodes.find(node => node.id === 'owner/repo').interaction.childScene, 'project:owner/repo');
});

test('GitHub acquisition keeps request count bounded and retains commit provenance', async () => {
  const calls = [];
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).endsWith('/repos/owner/repo')) return json({ default_branch: 'main', private: false });
    if (String(url).includes('/commits/main')) return json({ sha: 'b'.repeat(40), commit: { tree: { sha: 'c'.repeat(40) } } });
    if (String(url).includes('/git/trees/')) return json({ truncated: false, tree: tree.map(item => ({ ...item, sha: 'd'.repeat(40) })) });
    if (String(url).includes('/contents/')) {
      const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]);
      const content = contents[path];
      return json({ encoding: 'base64', content: Buffer.from(content || '').toString('base64') });
    }
    return new Response('', { status: 404 });
  };
  const model = await fetchGitHubProjectConstellation({ projectId: 'owner/repo', fetchImpl });
  assert.equal(model.provenance.commit, 'b'.repeat(40));
  assert.equal(model.provenance.visibility, 'public');
  assert.ok(Number.isFinite(Date.parse(model.provenance.scannedAt)));
  assert.ok(calls.length <= 11);
  assert.equal(model.statistics.filesAvailable, 5, 'the model receives the complete tree file count');
  assert.equal(model.statistics.manifestsAvailable, 2);
  assert.equal(model.statistics.manifestsSelected, 2);
  assert.equal(model.statistics.manifestsRead, 2);
  assert.equal(model.statistics.sourceFilesAvailable, 2);
  assert.equal(model.statistics.sourceFilesSelected, 2);
  assert.equal(model.statistics.sourceFilesRead, 0, 'anonymous acquisition does not fetch source text');
  assert.equal(model.statistics.truncated, true);
  assert.equal(model.statistics.sourceFilesOmitted, 2);

  calls.length = 0;
  const authenticated = await fetchGitHubProjectConstellation({ projectId: 'owner/repo', fetchImpl, authenticated: true });
  assert.ok(calls.length <= 3 + 24 + 16, 'authenticated acquisition stays within its request budget');
  assert.equal(authenticated.statistics.filesAvailable, 5);
  assert.equal(authenticated.statistics.manifestsAvailable, 2);
  assert.equal(authenticated.statistics.sourceFilesSelected, 2);
  assert.equal(authenticated.statistics.sourceFilesRead, 1, 'authenticated acquisition fetches only a declared existing entry');
  assert.equal(authenticated.statistics.truncated, true, 'unread source paths remain explicit');
});
