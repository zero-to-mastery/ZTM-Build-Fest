import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, explainNode, explainEdge, explainVisual, validateEvidence, serializeScene, parseScene } from '../src/core-api.mjs';
import { validateScene } from '../src/scene.mjs';
import { renderSceneHTML } from '../src/renderer-html.mjs';

const repositories = [
  { full_name: 'demo/engine', name: 'engine', language: 'Rust', languages: { Rust: 800, JavaScript: 200 }, topics: ['systems-programming', 'webassembly'], stargazers_count: 42, created_at: '2023-04-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  { full_name: 'demo/site', name: 'site', language: 'Rust', topics: ['web-components'], stargazers_count: 12, created_at: '2024-02-01T00:00:00Z' },
];

test('Scene Evidence v1 is deterministic, bounded, serializable and rejects malformed or secret-like facts', () => {
  const options = { projectShowcase: { 'demo/engine': { role: 'featured' } }, arrangement: 'profile' };
  const scene = createScene('demo', repositories, options);
  assert.deepEqual(scene.evidence, createScene('demo', repositories, options).evidence);
  assert.equal(validateEvidence(scene.evidence, new Set(scene.nodes.map(node => node.id))), true);
  assert.equal(validateEvidence({ version: 1, facts: [{ ...scene.evidence.facts[0], id: '__proto__' }], subjects: [] }), false);
  const invalid = structuredClone(scene.evidence); invalid.facts[0].value = 'ghp_123456789012345678901234567890';
  assert.equal(validateEvidence(invalid), false);
  const leaked = structuredClone(scene.evidence); leaked.facts[0].authorization = 'private';
  assert.equal(validateEvidence(leaked), false);
  assert.equal(parseScene(serializeScene(scene)).evidence.version, 1);
  assert.ok(scene.evidence.facts.length < 32_768);
  assert.ok(Buffer.byteLength(JSON.stringify(scene.evidence)) > 0);
});

test('node explanation distinguishes inclusion provenance, user choices and derived Developer Topology evidence', () => {
  const scene = createScene('demo', repositories, { arrangement: 'profile', projectShowcase: { 'demo/engine': { role: 'featured' } } });
  const explanation = explainNode(scene, 'demo/engine');
  assert.equal(explanation.included.provenance, 'derived');
  assert.match(explanation.included.summary, /current scene selection and filters/);
  assert.match(explanation.role.summary, /Featured by you/);
  assert.equal(explanation.position.provenance, 'derived');
  assert.match(explanation.position.summary, /Systems/);
  assert.ok(explanation.evidence.some(item => item.provenance === 'source' && item.claim.value === 'Rust'));
  assert.ok(explanation.evidence.some(item => item.provenance === 'user' && item.claim.value === 'featured'));
  assert.ok(explanation.evidence.some(item => item.provenance === 'derived' && item.claim.kind === 'profile-evidence'));
  assert.equal(explainNode(scene, 'missing'), null);
});

test('visual explanations report mapping inputs and manual override precedence without inventing defaults', () => {
  const scene = createScene('demo', repositories, { mappings: { size: { field: 'metrics.stars', domain: [0, 100], range: [2, 10], scale: 'sqrt' } }, nodeColors: { 'demo/engine': '#123456' }, starPositions: { 'demo/site': { x: 300, y: 200 } } });
  const visual = explainVisual(scene, 'demo/engine');
  assert.match(visual.size.summary, /metrics.stars/);
  assert.equal(visual.size.scale, 'sqrt');
  assert.equal(visual.size.input, 42);
  assert.equal(visual.color.provenance, 'user');
  assert.match(visual.color.summary, /Manual color/);
  assert.equal(explainNode(scene, 'demo/site').position.provenance, 'user');
  const identityScene = createScene('demo', repositories, {});
  assert.match(explainNode(identityScene, 'demo/site').position.summary, /Identity Rings/);
  const orbitalScene = createScene('demo', repositories, { arrangement: 'orbital' });
  assert.match(explainNode(orbitalScene, 'demo/site').position.summary, /Identity Orbits/);
  assert.match(explainNode(orbitalScene, 'demo/site').position.summary, /does not indicate project importance or shared technology/);
  assert.doesNotMatch(explainNode(orbitalScene, 'demo/site').position.summary, /grouped by shared technology/i);
  for (const arrangement of ['field', 'force', 'galaxy', 'solar-system']) assert.doesNotMatch(explainNode(createScene('demo', repositories, { arrangement }), 'demo/site').position.summary, /Identity Rings/);
  const selected = explainNode(createScene('demo', repositories, { includeRepos: ['demo/site'] }), 'demo/site');
  assert.equal(selected.included.provenance, 'user');
  assert.match(selected.included.summary, /Selected by you/);
  const colorScene = createScene('demo', repositories, { mappings: { color: { field: 'attributes.language', palette: 'language' } } });
  assert.match(explainVisual(colorScene, 'demo/engine').color.summary, /attributes.language/);
  assert.equal(explainVisual(colorScene, 'demo/engine').color.input, 'Rust');
  const defaultScene = createScene('demo', repositories, {});
  assert.match(explainVisual(defaultScene, 'demo/site').size.summary, /default/);
  assert.equal(explainVisual(defaultScene, 'demo/site').size.input, undefined);
  const fallbackScene = createScene('demo', repositories, { mappings: { size: { field: 'metrics.derived-score', domain: [0, 10], range: [2, 10], fallback: 4 } } });
  assert.match(explainVisual(fallbackScene, 'demo/site').size.summary, /Fallback 4 is configured/);
  assert.equal(explainVisual(fallbackScene, 'demo/site').size.fallback, 4);
});

test('ordinary inclusion is derived, explicit includeRepos is user intent, and source facts stay source facts', () => {
  const automatic = createScene('demo', repositories, {});
  assert.ok(automatic.nodes.every(node => explainNode(automatic, node.id).included.provenance === 'derived'));
  assert.ok(automatic.evidence.facts.some(fact => fact.kind === 'primary-language' && fact.provenance === 'source'));
  const explicit = createScene('demo', repositories, { includeRepos: ['engine'] });
  assert.equal(explainNode(explicit, 'demo/engine').included.provenance, 'user');
});

test('scene evidence validation rejects unknown nodes and oversized lists', () => {
  const scene = createScene('demo', repositories, {});
  const invalid = structuredClone(scene); invalid.evidence.subjects[0].id = 'not-in-scene';
  assert.equal(validateScene(invalid).valid, false);
  const oversized = structuredClone(scene.evidence); oversized.facts.length = 32_769;
  assert.equal(validateEvidence(oversized), false);
});

test('temporal position explanation states its date source and current-metadata limitation', () => {
  const scene = createScene('demo', repositories, { referenceDate: '2026-09-01T00:00:00Z', arrangement: 'temporal-stack', temporalStack: { enabled: true, yearStart: 2023, yearEnd: 2026 } });
  const item = scene.nodes.find(node => node.id === 'demo/engine');
  const explanation = explainNode(scene, item.id);
  assert.match(explanation.position.summary, /Created in 2023/);
  assert.match(explanation.position.summary, /does not reconstruct historical language, stars, or activity/);
});

test('dimensional evidence references validate against nodes in bounded scene frames', () => {
  const scene = createScene('demo', repositories, { arrangement: 'temporal-stack', referenceDate: '2026-09-01T00:00:00Z', temporalStack: { axis: 'language', innerArrangement: 'rings' } });
  assert.equal(validateScene(scene).valid, true);
  assert.ok(scene.temporalStack.frames.some(frame => frame.scene.nodes.some(node => node.id === 'demo/engine')));
});

test('edge explanations reuse structured shared metadata and report unsupported reasons honestly', () => {
  const scene = createScene('demo', repositories, {});
  const edge = scene.edges[0];
  assert.ok(edge);
  const explanation = explainEdge(scene, edge.id);
  assert.match(explanation.summary, /shared project metadata/);
  assert.ok(explanation.evidence.length > 0);
  const unavailable = structuredClone(scene); unavailable.edges[0].metadata = {};
  assert.match(explainEdge(unavailable, edge.id).summary, /unavailable/);
});

test('registered source provenance is preserved without copying provider payloads', () => {
  const scene = createScene('demo', [{ ...repositories[0], pluginSource: 'fixture-source', pluginInstance: 'one', secret: 'ghp_123456789012345678901234567890' }], {});
  const fact = scene.evidence.facts.find(item => item.kind === 'primary-language');
  assert.equal(fact.source, 'fixture-source');
  assert.equal(JSON.stringify(scene.evidence).includes('ghp_'), false);
});

test('offline HTML bundles the canonical explanation helpers and retains CSP and DOM text rendering', () => {
  const scene = createScene('demo', repositories, { arrangement: 'orbital', mappings: { size: { field: 'metrics.stars', domain: [0, 100], range: [2, 10] } } });
  const html = renderSceneHTML(scene);
  assert.match(html, /Identity Orbits/);
  assert.match(html, /Mapped from \$\{mapping\.field/);
  assert.match(html, /Explanation unavailable for this connection type/);
  assert.match(html, /textContent/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /Selected project in this scene\./);
});
