import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../src/constellation.mjs';
import { serializeScene } from '../src/scene.mjs';
import { createProjectConstellation } from '../src/project-constellation.mjs';
import { semanticGraphFromScene, semanticGraphFromProjectConstellation, serializeSemanticGraph, semanticGraphFingerprint } from '../src/semantic-graph.mjs';
import { renderSemanticMarkdown } from '../src/semantic-markdown.mjs';
import { createPortableExport, EXPORT_MANIFEST_VERSION } from '../src/portable-export.mjs';
import { createPortfolioArtifact, validatePortfolioArtifact } from '../src/portfolio-artifact.mjs';
import { createAtlasState, navigateAtlasToProject, navigateAtlasToStructure } from '../src/developer-atlas.mjs';
import { projectDeveloperAtlasScene } from '../src/developer-atlas-scene.mjs';

async function manifestForFiles(manifest, files) {
  const updated = structuredClone(manifest);
  for (const [name, content] of Object.entries(files)) {
    if (!updated.artifacts[name]) continue;
    const bytes = new TextEncoder().encode(content);
    updated.artifacts[name].size = bytes.byteLength;
    updated.artifacts[name].sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return updated;
}

test('portable export creates deterministic artifacts from one canonical graph', () => {
  const graph = semanticGraphFromScene(createScene('alice', [
    { full_name: 'alice/compiler', name: 'compiler', language: 'Rust' },
    { full_name: 'alice/studio', name: 'studio', language: 'JavaScript' },
  ]));
  const before = structuredClone(graph);
  const first = createPortableExport(graph);
  const second = createPortableExport(graph);
  assert.equal(JSON.stringify(graph), JSON.stringify(before));
  assert.equal(JSON.stringify(first.files), JSON.stringify(second.files));
  assert.equal(first.manifest.version, EXPORT_MANIFEST_VERSION);
  assert.equal(first.manifest.fingerprint, semanticGraphFingerprint(graph));
  assert.equal(first.files['alice.semantic-graph.json'], serializeSemanticGraph(graph));
  assert.equal(first.files['constellation.md'], renderSemanticMarkdown(graph, { detail: 'standard' }));
  assert.match(first.files['constellation.svg'], /^<svg/);
  assert.match(first.files['constellation.html'], /Semantic Graph v1/);
  const manifest = JSON.parse(first.files['manifest.json']);
  assert.deepEqual(manifest.artifacts, first.manifest.artifacts);
  assert.equal(manifest.semanticGraphVersion, 1);
  assert.equal(manifest.semanticMarkdownVersion, 1);
});

test('portable project HTML and manifest retain private visibility and incomplete coverage', async () => {
  const model = createProjectConstellation({
    projectId: 'owner/private-repo', ref: 'main', visibility: 'private',
    tree: [{ path: '', type: 'tree' }, { path: 'package.json', type: 'blob' }],
    contents: { 'package.json': '{"name":"private-repo"}' },
  });
  const graph = semanticGraphFromProjectConstellation(model);
  graph.statistics.truncated = true;
  graph.statistics.limitations = ['bounded-source'];
  const portable = createPortableExport(graph);
  assert.equal(portable.manifest.sourceVisibility, 'private');
  assert.equal(portable.manifest.truncated, true);
  assert.match(portable.files['constellation.html'], /Source visibility is private/);
  assert.match(portable.files['constellation.html'], /coverage is incomplete/i);
  const artifact = await createPortfolioArtifact(graph);
  assert.equal(artifact.manifest.subject.kind, 'project');
  assert.equal((await validatePortfolioArtifact(artifact.files['manifest.json'], artifact.files)).files, 5);
  const sibling = await createPortfolioArtifact(semanticGraphFromProjectConstellation(createProjectConstellation({
    projectId: 'owner/other-repo', ref: 'main', tree: [{ path: '', type: 'tree' }], contents: {},
  })));
  const swapped = { ...artifact.files, 'scene.json': sibling.files['scene.json'] };
  await assert.rejects(validatePortfolioArtifact(await manifestForFiles(artifact.manifest, swapped), swapped), /Scene subject does not match the manifest/);
});

test('developer portfolio accepts an Atlas structure Scene for an organization-owned project', async () => {
  const graph = semanticGraphFromScene(createScene('alice', [
    { full_name: 'alice/compiler', name: 'compiler', language: 'Rust' },
    { full_name: 'acme-org/platform', name: 'platform', language: 'Go' },
  ]));
  const projectGraph = semanticGraphFromProjectConstellation(createProjectConstellation({
    projectId: 'acme-org/platform', ref: 'main', tree: [{ path: '', type: 'tree' }, { path: 'src', type: 'tree' }], contents: {},
  }));
  const projectState = navigateAtlasToProject(createAtlasState(graph), graph, 'acme-org/platform');
  const structure = navigateAtlasToStructure(projectState, graph, projectGraph, projectGraph.nodes[0].id);
  const scene = projectDeveloperAtlasScene(graph, structure, {}, projectGraph);
  assert.equal(scene.metadata.account, 'acme-org');
  const artifact = await createPortfolioArtifact(graph, { constellationVersion: '4.7.0', scene });
  assert.equal((await validatePortfolioArtifact(artifact.files['manifest.json'], artifact.files)).files, 5);
});

test('portfolio SVG validation accepts handler-like and URL-like project text', async () => {
  const scene = createScene('alice', [
    { full_name: 'alice/onclick', name: 'onclick', language: 'TypeScript', description: "Bob's x onload=1 JavaScript: basics", topics: ['onboarding'] },
    { full_name: 'alice/site', name: 'site', language: 'HTML', homepage: 'https://example.com/?a=1&b=2' },
  ], { animate: false, featuredTreatment: 'spotlight', projectShowcase: { 'alice/onclick': { role: 'featured' } } });
  const artifact = await createPortfolioArtifact(semanticGraphFromScene(scene), { constellationVersion: '4.7.0', scene });
  assert.match(artifact.files['constellation.svg'], /aria-label="[^"]*onload=1 JavaScript: basics[^"]*"/, 'author text is inside an SVG attribute');
  assert.equal((await validatePortfolioArtifact(artifact.files['manifest.json'], artifact.files)).files, 5);
});

test('portfolio artifact has deterministic Scene v1 entries and validates every bounded asset digest', async () => {
  const graph = semanticGraphFromScene(createScene('alice', [
    { full_name: 'alice/compiler', name: 'compiler', language: 'Rust' },
    { full_name: 'alice/studio', name: 'studio', language: 'JavaScript' },
  ]));
  const first = await createPortfolioArtifact(graph, { constellationVersion: '4.7.0' });
  const second = await createPortfolioArtifact(graph, { constellationVersion: '4.7.0' });
  assert.deepEqual(first.files, second.files);
  const authoredScene = structuredClone(first.scene);
  const sceneExport = await createPortfolioArtifact(graph, { constellationVersion: '4.7.0', scene: authoredScene });
  assert.deepEqual(sceneExport.scene, authoredScene, 'manual Scene data is preserved as supplied');
  assert.equal(first.manifest.sceneVersion, 1);
  assert.equal(first.manifest.constellationVersion, '4.7.0');
  assert.equal(first.manifest.entryPoints.static, 'constellation.svg');
  assert.deepEqual(first.manifest.runtime, { mode: 'embedded-html', wasm: 'embedded', assets: [] });
  assert.equal((await validatePortfolioArtifact(first.files['manifest.json'], first.files)).files, 5);
  assert.ok(first.scene.nodes.some(node => node.metadata?.full_name === 'alice/compiler'), 'Scene identities stay aligned with the source graph');

  const changed = { ...first.files, 'constellation.svg': first.files['constellation.svg'] + ' ' };
  await assert.rejects(validatePortfolioArtifact(first.files['manifest.json'], changed), /size or digest metadata|digest mismatch/);
  const sameSizeChanged = { ...first.files, 'constellation.svg': first.files['constellation.svg'].replace('<svg', '<sva') };
  await assert.rejects(validatePortfolioArtifact(first.files['manifest.json'], sameSizeChanged), /digest mismatch/);
  const missing = { ...first.files }; delete missing['constellation.svg'];
  await assert.rejects(validatePortfolioArtifact(first.files['manifest.json'], missing), /Missing portfolio asset/);
  const missingScene = { ...first.files }; delete missingScene['scene.json'];
  await assert.rejects(validatePortfolioArtifact(first.files['manifest.json'], missingScene), /Missing portfolio asset/);
  const missingGraph = { ...first.files }; delete missingGraph['alice.semantic-graph.json'];
  await assert.rejects(validatePortfolioArtifact(first.files['manifest.json'], missingGraph), /Missing portfolio asset/);
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, fingerprint: 'sg1:wrong' }, first.files), /identity or Semantic Graph fingerprint mismatch/);
  const unsafe = structuredClone(first.manifest);
  unsafe.artifacts['../payload.js'] = { size: 0, sha256: '0'.repeat(64) };
  await assert.rejects(validatePortfolioArtifact(unsafe, { ...first.files, '../payload.js': 'x' }), /Unsafe or unexpected executable/);
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, version: 2 }, first.files), /Unsupported portfolio artifact version/);
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, constellationVersion: '4.6.0' }, first.files), /Incompatible Constellation package version/);
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, constellationVersion: 'next' }, first.files), /Incompatible Constellation package version/);
  // Later releases keep writing portfolio v1; the format versions guard compatibility.
  for (const constellationVersion of ['4.8.0', '5.0.0', '5.1.2-beta.1']) {
    const later = await createPortfolioArtifact(graph, { constellationVersion });
    assert.equal((await validatePortfolioArtifact(later.manifest, later.files)).manifest.constellationVersion, constellationVersion);
  }
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, subject: { kind: 'developer', id: '../secret' } }, first.files), /Invalid portfolio project identity/);
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, semanticGraphVersion: 2 }, first.files), /Unsupported semantic contract version/);
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, artifacts: [] }, first.files), /Invalid portfolio artifact metadata/);
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, artifacts: { ...first.manifest.artifacts, 'constellation.js': { size: 1, sha256: '0'.repeat(64) } } }, { ...first.files, 'constellation.js': 'x' }), /Unsafe or unexpected executable/);
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, entryPoints: { ...first.manifest.entryPoints, scene: '../scene.json' } }, first.files), /Invalid portfolio entry points/);
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, runtime: { mode: 'embedded-html', wasm: 'remote', assets: ['https://example.invalid/runtime.wasm'] } }, first.files), /Invalid or unsupported portfolio runtime assets/);
  const scriptedSvg = { ...first.files, 'constellation.svg': first.files['constellation.svg'].replace('</svg>', '<script>alert(1)</script></svg>') };
  await assert.rejects(validatePortfolioArtifact(await manifestForFiles(first.manifest, scriptedSvg), scriptedSvg), /Static SVG fallback is invalid or executable/);
  for (const [label, svg] of [
    ['event handler', first.files['constellation.svg'].replace('<svg', '<svg onload="alert(1)"')],
    ['encoded javascript URL', first.files['constellation.svg'].replace('</svg>', '<a href="&#106;ava&#x09;script:alert(1)"><text>x</text></a></svg>')],
    ['animated javascript URL', first.files['constellation.svg'].replace('</svg>', '<a><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>')],
    ['foreignObject', first.files['constellation.svg'].replace('</svg>', '<foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://example.invalid"></iframe></foreignObject></svg>')],
  ]) {
    const files = { ...first.files, 'constellation.svg': svg };
    await assert.rejects(validatePortfolioArtifact(await manifestForFiles(first.manifest, files), files), /Static SVG fallback is invalid or executable/, label);
  }
  for (const [name, body] of [['extra.htm', '<script>alert(1)</script>'], ['extra.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'], ['other.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>']]) {
    const files = { ...first.files, [name]: body };
    const manifest = await manifestForFiles({ ...first.manifest, artifacts: { ...first.manifest.artifacts, [name]: { size: 0, sha256: '0'.repeat(64) } } }, files);
    await assert.rejects(validatePortfolioArtifact(manifest, files), /Unsafe or unexpected executable/, name);
  }
  const foreignScene = { ...first.files, 'scene.json': serializeScene(createScene('mallory', [])) };
  await assert.rejects(validatePortfolioArtifact(await manifestForFiles(first.manifest, foreignScene), foreignScene), /Scene subject does not match the manifest/);
  const invalidHtml = { ...first.files, 'constellation.html': first.files['constellation.html'].replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, '') };
  await assert.rejects(validatePortfolioArtifact(await manifestForFiles(first.manifest, invalidHtml), invalidHtml), /Interactive HTML is missing its offline runtime or CSP policy/);
  const wrongScene = createScene('alice', [{ name: 'unknown', full_name: 'alice/unknown', language: 'Rust' }]);
  const inconsistentScene = { ...first.files, 'scene.json': serializeScene(wrongScene) };
  await assert.rejects(validatePortfolioArtifact(await manifestForFiles(first.manifest, inconsistentScene), inconsistentScene), /Scene project identity is absent from Semantic Graph/);
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, artifacts: { ...first.manifest.artifacts, 'constellation.md': { ...first.manifest.artifacts['constellation.md'], size: -1 } } }, first.files), /Invalid size or digest metadata/);
  await assert.rejects(validatePortfolioArtifact({ ...first.manifest, artifacts: Object.fromEntries([...Object.entries(first.manifest.artifacts), ...Array.from({ length: 8 }, (_, i) => [`extra-${i}.txt`, { size: 0, sha256: '0'.repeat(64) }])]) }, first.files), /Invalid portfolio artifact count/);
  await assert.rejects(validatePortfolioArtifact(' '.repeat(16 * 1024 + 1), first.files), /Manifest exceeds 16 KiB/);
  const oversized = structuredClone(first.manifest);
  oversized.artifacts['constellation.md'].size = 17 * 1024 * 1024;
  await assert.rejects(validatePortfolioArtifact(oversized, { ...first.files, 'constellation.md': 'x'.repeat(17 * 1024 * 1024) }), /Invalid size or digest metadata/);
  await assert.rejects(validatePortfolioArtifact(first.files['manifest.json'], { ...first.files, 'payload.exe': 'unexpected' }), /Unexpected portfolio asset/);
  await assert.rejects(validatePortfolioArtifact(first.files['manifest.json'], { ...first.files, ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`extra-${i}.txt`, 'x'])) }), /Invalid portfolio asset count/);
  await assert.rejects(validatePortfolioArtifact('[]', first.files), /expected an object/);
  await assert.rejects(validatePortfolioArtifact('{', first.files), /Invalid portfolio manifest/);
});
