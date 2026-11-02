import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createScene, createEvidenceNavigator, navigateEvidence, evidenceNavigationGraph, evidenceNavigationGraphFromScene,
  EVIDENCE_NAVIGATION_VERSION, EVIDENCE_NAVIGATION_RELATIONSHIP_TYPES, semanticGraphFromScene, semanticGraphFingerprint,
  validateSemanticGraph, serializeScene,
} from '../src/core-api.mjs';

const graph = JSON.parse(await readFile(new URL('./fixtures/evidence-navigation/graph.json', import.meta.url), 'utf8'));
const expected = JSON.parse(await readFile(new URL('./fixtures/evidence-navigation/expected.json', import.meta.url), 'utf8'));
const sceneFixture = JSON.parse(await readFile(new URL('./fixtures/scene-svg-v2.json', import.meta.url), 'utf8'));

test('the shared fixture is a valid Semantic Graph v1', () => {
  assert.deepEqual(validateSemanticGraph(graph), { valid: true, errors: [] });
});

test('WASM navigation matches the native Rust expectation for every fixture case', () => {
  // rust/constellation-core/src/evidence_navigation.rs asserts the same file natively.
  const navigator = createEvidenceNavigator(graph);
  assert.ok(expected.length >= 5);
  for (const item of expected) {
    assert.deepEqual(navigator.navigate(item.projectId, item.depth), item.result, `${item.projectId} depth ${item.depth}`);
    assert.deepEqual(navigateEvidence(graph, item.projectId, { depth: item.depth }), item.result);
  }
  assert.equal(EVIDENCE_NAVIGATION_VERSION, expected[0].result.version);
  navigator.destroy();
  assert.equal(navigator.navigate('octo/compiler'), null, 'a destroyed navigator fails closed');
});

test('every relationship is explained by evidence that exists in the graph', () => {
  const nodes = new Set(graph.nodes.map(node => node.id)), edges = new Map(graph.edges.map(edge => [edge.id, edge]));
  const navigator = createEvidenceNavigator(evidenceNavigationGraph(graph));
  for (const project of graph.nodes.filter(node => node.kind === 'project')) {
    const result = navigator.navigate(project.id, 2);
    for (const connection of result.connections) {
      assert.deepEqual(connection.relationshipTypes, connection.relationships.map(item => item.type));
      for (const relationship of connection.relationships) {
        assert.ok(EVIDENCE_NAVIGATION_RELATIONSHIP_TYPES.includes(relationship.type));
        assert.ok(relationship.evidence.length > 0 && relationship.evidenceCount >= relationship.evidence.length);
        for (const item of relationship.evidence) {
          if (item.nodeId) assert.ok(nodes.has(item.nodeId));
          for (const id of item.edgeIds) {
            const edge = edges.get(id);
            assert.ok(edge, `missing evidence edge ${id}`);
            assert.ok([edge.from, edge.to].includes(project.id) || [edge.from, edge.to].includes(connection.projectId));
          }
        }
      }
    }
    for (const reached of result.secondDegree) {
      assert.equal(reached.path[0], project.id);
      assert.equal(reached.path.at(-1), reached.projectId);
      assert.ok(result.connections.some(connection => connection.projectId === reached.path[1]));
    }
  }
});

test('the compact graph navigates identically to the full graph and keeps no payloads', () => {
  const compact = evidenceNavigationGraph(graph);
  assert.ok(compact.nodes.every(node => !('evidenceIds' in node) && !node.properties?.description && !node.properties?.url));
  assert.ok(compact.nodes.every(node => node.kind !== 'developer'));
  assert.ok(compact.edges.every(edge => ['uses-language', 'has-topic', 'member-of', 'project-relationship'].includes(edge.kind)));
  const full = createEvidenceNavigator(graph), small = createEvidenceNavigator(compact);
  for (const id of ['octo/compiler', 'octo/site', 'octo/loner', 'octo/missing']) assert.deepEqual(small.navigate(id, 2), full.navigate(id, 2));
  assert.throws(() => evidenceNavigationGraph({ version: 2, nodes: [] }), /Semantic Graph v1/);
});

test('navigation is independent of record order and does not mutate the graph', () => {
  const before = semanticGraphFingerprint(graph), snapshot = JSON.stringify(graph);
  const reversed = structuredClone(graph); reversed.nodes.reverse(); reversed.edges.reverse();
  const a = createEvidenceNavigator(graph), b = createEvidenceNavigator(reversed);
  for (const id of ['octo/compiler', 'octo/docs']) assert.deepEqual(a.navigate(id, 2), b.navigate(id, 2));
  const result = a.navigate('octo/compiler', 2);
  result.connections.length = 0; // Results are isolated copies.
  assert.equal(a.navigate('octo/compiler', 2).connections.length, 2);
  assert.equal(JSON.stringify(graph), snapshot);
  assert.equal(semanticGraphFingerprint(graph), before);
});

test('invalid and missing project IDs fail safely', () => {
  const navigator = createEvidenceNavigator(graph);
  assert.deepEqual(navigator.navigate('octo/removed').diagnostics.map(item => item.code), ['unknown-project']);
  assert.equal(navigator.navigate('octo/removed').status, 'unavailable');
  assert.deepEqual(navigator.navigate('topic:wasm').diagnostics.map(item => item.code), ['not-a-project']);
  for (const value of ['', 'x'.repeat(513), 7, null, '<img src=x onerror=alert(1)>']) {
    const result = navigator.navigate(value);
    assert.ok(result === null || result.status === 'unavailable', String(value).slice(0, 20));
  }
  assert.equal(navigator.navigate('octo/compiler', 3), null);
  assert.throws(() => navigateEvidence(graph, 'octo/compiler', { depth: 3 }), /depth/);
  assert.throws(() => navigateEvidence({ version: 1, nodes: [{ id: 'a', kind: 'project' }, { id: 'a', kind: 'project' }] }, 'a'), /duplicate/);
  assert.equal(createEvidenceNavigator(null), null);
});

test('scenes produce navigation graphs whose relationships come from repository metadata', () => {
  const scene = createScene(sceneFixture.account, sceneFixture.repositories, sceneFixture.cases[0].options);
  const before = serializeScene(scene);
  const compact = evidenceNavigationGraphFromScene(scene);
  assert.ok(compact);
  assert.equal(serializeScene(scene), before, 'adapting a scene does not change it');
  const semantic = semanticGraphFromScene(scene);
  const navigator = createEvidenceNavigator(compact);
  const projects = semantic.nodes.filter(node => node.kind === 'project');
  assert.equal(navigator.projectCount, projects.length);
  for (const project of projects) {
    const result = navigator.navigate(project.id, 1);
    assert.equal(result.status, 'ok');
    for (const connection of result.connections) for (const relationship of connection.relationships) {
      for (const item of relationship.evidence) {
        // A shared language/topic is backed by both projects' metadata edges.
        const label = item.label;
        const metadata = id => scene.nodes.find(node => node.id === id).metadata;
        if (relationship.type === 'shared-language') for (const id of [project.id, connection.projectId]) assert.equal(metadata(id).language, label);
        if (relationship.type === 'shared-topic') for (const id of [project.id, connection.projectId]) assert.ok(metadata(id).topics.includes(label));
      }
    }
  }
  assert.equal(evidenceNavigationGraphFromScene({ kind: 'not-a-scene' }), null);
});
