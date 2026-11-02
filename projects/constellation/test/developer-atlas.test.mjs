import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from '../src/constellation.mjs';
import { createProjectConstellation } from '../src/project-constellation.mjs';
import { semanticGraphFromScene, semanticGraphFromProjectConstellation, semanticGraphFingerprint, serializeSemanticGraph } from '../src/semantic-graph.mjs';
import { renderSemanticMarkdown } from '../src/semantic-markdown.mjs';
import { projectDeveloperAtlasScene } from '../src/developer-atlas-scene.mjs';
import { validateScene } from '../src/scene.mjs';
import { ATLAS_STATE_VERSION, createAtlasState, validateAtlasState, navigateAtlasToGroup, navigateAtlasToProject, navigateAtlasToStructure, parentAtlasState, atlasBreadcrumbs, resolveAtlasContext, createAtlasHistory, serializeAtlasState, parseAtlasState } from '../src/developer-atlas.mjs';

const records = [
  { full_name: 'alice/one', name: 'one', language: 'Rust' },
  { full_name: 'alice/two', name: 'two', language: 'Rust' },
  { full_name: 'alice/three', name: 'three', language: 'Rust' },
  { full_name: 'bob/three', name: 'three', language: 'Rust' },
  { full_name: 'bob/four', name: 'four', language: 'Rust' },
];
const graph = semanticGraphFromScene(createScene('alice', records, { projectFamilies: {
  tools: { label: 'Tools', members: ['alice/one', 'alice/two', 'alice/three'] },
} }));
const family = graph.groups.find(item => item.label === 'Tools');

test('Atlas validates explicit levels and preserves canonical route identities', () => {
  const root = createAtlasState(graph);
  assert.equal(ATLAS_STATE_VERSION, 1);
  assert.equal(validateAtlasState(root, graph).valid, true);
  const group = navigateAtlasToGroup(root, graph, family.id);
  assert.equal(resolveAtlasContext(group, graph).provenance, 'user');
  const derived = graph.groups.find(item => item.provenance === 'derived');
  assert.equal(resolveAtlasContext(navigateAtlasToGroup(root, graph, derived.id), graph).provenance, 'derived');
  const project = navigateAtlasToProject(group, graph, 'alice/one');
  assert.equal(resolveAtlasContext(project, graph).subject.id, 'alice/one');
  assert.equal(validateScene(projectDeveloperAtlasScene(graph, group)).valid, true);
  const projectScene = projectDeveloperAtlasScene(graph, project);
  assert.equal(validateScene(projectScene).valid, true);
  assert.deepEqual(projectScene.nodes.map(node => node.id), ['alice/one']);
  assert.deepEqual(atlasBreadcrumbs(project, graph).map(({ level, id }) => [level, id]), [
    ['developer', 'alice'], ['group', family.id], ['project', 'alice/one'],
  ]);
  assert.equal(parentAtlasState(project, graph).groupId, family.id);
  assert.equal(parentAtlasState(group, graph).level, 'developer');
  const direct = navigateAtlasToProject(root, graph, 'alice/two');
  assert.equal(direct.groupId, null);
  assert.deepEqual(atlasBreadcrumbs(direct, graph).map(item => item.level), ['developer', 'project']);
  assert.equal(parentAtlasState(direct, graph).level, 'developer');
  assert.throws(() => navigateAtlasToProject(group, graph, 'bob/three'), /not a member/);
  assert.throws(() => navigateAtlasToGroup(root, graph, 'missing'), /unavailable/);
  assert.equal(validateAtlasState({ ...root, projectId: 'alice/one' }, graph).valid, false);
});

test('Atlas structure, breadcrumbs, share fallback, and bounded history work without graph mutation', () => {
  const root = createAtlasState(graph);
  const project = navigateAtlasToProject(root, graph, 'alice/one');
  const model = createProjectConstellation({ projectId: 'alice/one', ref: 'main', tree: [
    { path: 'packages', type: 'tree' }, { path: 'packages/core', type: 'tree' }, { path: 'packages/core/package.json', type: 'blob' },
    { path: 'packages/core/index.mjs', type: 'blob' },
  ] });
  const projectGraph = semanticGraphFromProjectConstellation(model);
  const node = projectGraph.nodes.find(item => item.kind === 'package');
  const structure = navigateAtlasToStructure(project, graph, projectGraph, node.id);
  assert.equal(validateScene(projectDeveloperAtlasScene(graph, structure, {}, projectGraph)).valid, true);
  assert.equal(atlasBreadcrumbs(structure, graph, projectGraph).at(-1).label, 'packages/core');
  const enteredThroughGroup = navigateAtlasToStructure(navigateAtlasToProject(navigateAtlasToGroup(createAtlasState(graph), graph, family.id), graph, 'alice/one'), graph, projectGraph, node.id);
  assert.deepEqual(atlasBreadcrumbs(enteredThroughGroup, graph, projectGraph).map(item => item.level), ['developer', 'group', 'project', 'structure', 'structure']);
  const parentStructure = parentAtlasState(structure, graph, projectGraph);
  assert.equal(parentStructure.level, 'structure');
  const rootStructure = parentAtlasState(parentStructure, graph, projectGraph);
  assert.equal(rootStructure.level, 'structure');
  assert.equal(parentAtlasState(rootStructure, graph, projectGraph).level, 'project');
  assert.throws(() => navigateAtlasToStructure(project, graph, projectGraph, 'function:never'), /unavailable/);
  const encoded = serializeAtlasState(structure);
  assert.deepEqual(parseAtlasState(encoded, graph, projectGraph), structure);
  assert.equal(parseAtlasState(encoded, graph).level, 'project');
  const invalid = new URLSearchParams(encoded); invalid.set('n', 'missing');
  assert.equal(parseAtlasState(invalid.toString(), graph, projectGraph).level, 'project');
  assert.throws(() => parseAtlasState('x'.repeat(8193), graph), /oversized/);
  assert.throws(() => parseAtlasState(encoded + '&d=mallory', graph), /repeated/);
  assert.throws(() => serializeAtlasState({ ...root, projectId: 'alice/one' }), /inconsistent/);
  const history = createAtlasHistory(root, 3);
  history.push(navigateAtlasToGroup(root, graph, family.id));
  history.push(project);
  const historyBeforeFailure = history.snapshot();
  assert.equal(history.transact('back', () => false), false);
  assert.deepEqual(history.snapshot(), historyBeforeFailure);
  assert.equal(history.transact('back', candidate => candidate.level === 'group').level, 'group');
  assert.equal(history.transact('forward', () => { throw new Error('renderer failed'); }), false);
  assert.equal(history.current.level, 'group');
  assert.equal(history.transact('forward', () => true).level, 'project');
  assert.equal(history.transact('back', () => true).level, 'group');
  history.push(root);
  assert.equal(history.canForward, false);
  history.push(project); history.push(root);
  assert.equal(history.length, 3);
  const fingerprint = semanticGraphFingerprint(graph), bytes = serializeSemanticGraph(graph), markdown = renderSemanticMarkdown(graph);
  for (const next of [root, navigateAtlasToGroup(root, graph, family.id), project, structure, parentStructure, rootStructure, parentAtlasState(rootStructure, graph, projectGraph)]) assert.equal(validateAtlasState(next, graph).valid, true);
  assert.equal(semanticGraphFingerprint(graph), fingerprint);
  assert.equal(serializeSemanticGraph(graph), bytes);
  assert.equal(renderSemanticMarkdown(graph), markdown);
});

test('Atlas history reconciliation preserves valid entered routes and falls back to the nearest valid parent', () => {
  const root = createAtlasState(graph);
  const group = navigateAtlasToGroup(root, graph, family.id);
  const project = navigateAtlasToProject(group, graph, 'alice/one');
  const history = createAtlasHistory(root);
  history.push(group); history.push(project);
  const reordered = semanticGraphFromScene(createScene('alice', [...records].reverse(), { projectFamilies: {
    tools: { label: 'Tools', members: ['alice/one', 'alice/two', 'alice/three'] },
  } }));
  const route = history.reconcile(project, reordered);
  assert.equal(route.viaGroupId, family.id);
  assert.equal(history.current.projectId, 'alice/one');
  assert.equal(semanticGraphFingerprint(reordered), semanticGraphFingerprint(graph));

  const withoutProject = semanticGraphFromScene(createScene('alice', records.filter(item => item.full_name !== 'alice/one'), { projectFamilies: {
    tools: { label: 'Tools', members: ['alice/two', 'alice/three'] },
  } }));
  const recoveredGroup = history.reconcile(route, withoutProject);
  assert.equal(recoveredGroup.level, 'group');
  assert.equal(recoveredGroup.groupId, family.id);
  assert.equal(history.current.level, 'group');
  assert.equal(history.snapshot().entries.every(entry => validateAtlasState(entry, withoutProject).valid), true);

  const withoutGroup = semanticGraphFromScene(createScene('alice', records.filter(item => item.full_name !== 'alice/one'), {}));
  const recoveredRoot = history.reconcile(recoveredGroup, withoutGroup);
  assert.equal(recoveredRoot.level, 'developer');
  assert.equal(history.length, 1);
});

test('Atlas structure recovery prefers Project, then the entered Group, then Developer', () => {
  const model = createProjectConstellation({ projectId: 'alice/one', ref: 'main', tree: [
    { path: 'packages', type: 'tree' }, { path: 'packages/core', type: 'tree' }, { path: 'packages/core/package.json', type: 'blob' },
  ] });
  const projectGraph = semanticGraphFromProjectConstellation(model);
  const node = projectGraph.nodes.find(item => item.kind === 'package');
  const root = createAtlasState(graph);
  const group = navigateAtlasToGroup(root, graph, family.id);
  const project = navigateAtlasToProject(group, graph, 'alice/one');
  const structure = navigateAtlasToStructure(project, graph, projectGraph, node.id);
  const withoutProject = semanticGraphFromScene(createScene('alice', records.filter(item => item.full_name !== 'alice/one'), { projectFamilies: {
    tools: { label: 'Tools', members: ['alice/two', 'alice/three'] },
  } }));

  const history = createAtlasHistory(root);
  history.push(group); history.push(project); history.push(structure);
  const recovered = history.reconcile(structure, withoutProject, null);
  assert.equal(recovered.level, 'group');
  assert.equal(recovered.groupId, family.id);
  assert.equal(recovered.projectId, null);
  assert.equal(recovered.structuralNodeId, null);
  assert.equal(recovered.viaGroupId, null);
  assert.deepEqual(history.snapshot().entries, [recovered]);
  assert.equal(history.snapshot().entries.every(entry => validateAtlasState(entry, withoutProject).valid), true);

  const serialized = serializeAtlasState(structure);
  const parsed = parseAtlasState(serialized, withoutProject, null);
  assert.equal(parsed.level, 'group');
  assert.equal(parsed.groupId, family.id);
  assert.equal(parsed.projectId, null);

  const withoutGroup = semanticGraphFromScene(createScene('alice', records.filter(item => item.full_name !== 'alice/one'), {}));
  const noParentHistory = createAtlasHistory(root);
  noParentHistory.push(group); noParentHistory.push(project); noParentHistory.push(structure);
  const noParent = noParentHistory.reconcile(structure, withoutGroup, null);
  assert.equal(noParent.level, 'developer');
  assert.deepEqual(noParentHistory.snapshot().entries, [noParent]);
  assert.equal(parseAtlasState(serialized, withoutGroup, null).level, 'developer');

  const missingNode = new URLSearchParams(serializeAtlasState(structure));
  missingNode.set('n', 'missing:node');
  const projectFallback = parseAtlasState(missingNode.toString(), graph, projectGraph);
  assert.equal(projectFallback.level, 'project');
  assert.equal(projectFallback.projectId, 'alice/one');
  assert.equal(projectFallback.groupId, family.id);
  assert.equal(projectFallback.viaGroupId, family.id);

  const directStructure = navigateAtlasToStructure(navigateAtlasToProject(root, graph, 'alice/one'), graph, projectGraph, node.id);
  const directFallback = parseAtlasState(serializeAtlasState(directStructure), withoutProject, null);
  assert.equal(directFallback.level, 'developer');

  const groupA = graph.groups.find(item => item.id === family.id);
  const groupB = { ...groupA, id: 'group:user:group-b', label: 'Group B', members: ['alice/one', 'alice/three'] };
  const multiGraph = {
    ...graph,
    groups: [...graph.groups, groupB],
    edges: [...graph.edges,
      { kind: 'member-of', from: 'alice/one', to: groupB.id },
      { kind: 'member-of', from: 'alice/three', to: groupB.id },
    ],
  };
  const multiStructure = navigateAtlasToStructure(
    navigateAtlasToProject(navigateAtlasToGroup(createAtlasState(multiGraph), multiGraph, groupB.id), multiGraph, 'alice/one'),
    multiGraph, projectGraph, node.id,
  );
  const multiWithoutProject = {
    ...multiGraph,
    nodes: multiGraph.nodes.filter(item => item.id !== 'alice/one'),
    edges: multiGraph.edges.filter(edge => edge.from !== 'alice/one' && edge.to !== 'alice/one'),
    groups: multiGraph.groups.map(item => ({ ...item, members: item.members.filter(id => id !== 'alice/one') })),
  };
  const multiRecovered = parseAtlasState(serializeAtlasState(multiStructure), multiWithoutProject);
  assert.equal(multiRecovered.level, 'group');
  assert.equal(multiRecovered.groupId, groupB.id);
  assert.notEqual(multiRecovered.groupId, groupA.id);
});

test('Atlas navigation resets when the developer subject changes despite a shared Project ID', () => {
  const alice = semanticGraphFromScene(createScene('alice', [
    { full_name: 'shared-org/tool', name: 'tool', language: 'Rust' },
    { full_name: 'alice/other', name: 'other', language: 'Rust' },
  ], { projectFamilies: { shared: { label: 'Shared work', members: ['shared-org/tool', 'alice/other'] } } }));
  const bob = semanticGraphFromScene(createScene('bob', [
    { full_name: 'shared-org/tool', name: 'tool', language: 'Rust' },
    { full_name: 'bob/other', name: 'other', language: 'Rust' },
  ], { projectFamilies: { shared: { label: 'Shared work', members: ['shared-org/tool', 'bob/other'] } } }));
  const root = createAtlasState(alice);
  const group = navigateAtlasToGroup(root, alice, alice.groups[0].id);
  const project = navigateAtlasToProject(group, alice, 'shared-org/tool');
  const history = createAtlasHistory(root);
  history.push(group); history.push(project);

  const reset = history.reconcile(project, bob);
  assert.equal(reset.level, 'developer');
  assert.equal(reset.developerId, 'bob');
  assert.equal(reset.projectId, null);
  assert.deepEqual(history.snapshot().entries, [reset]);
  assert.equal(history.canBack, false);
  const sharedRoute = serializeAtlasState(project);
  const parsed = parseAtlasState(sharedRoute, bob);
  assert.equal(parsed.level, 'developer');
  assert.equal(parsed.developerId, 'bob');
  assert.equal(parsed.projectId, null);
});

test('canonical project IDs disambiguate duplicate labels and survive repository reordering', () => {
  const duplicateLabels = semanticGraphFromScene(createScene('alice', [
    { full_name: 'owner-a/api', name: 'api', language: 'Rust' },
    { full_name: 'owner-b/api', name: 'api', language: 'JavaScript' },
  ]));
  const first = navigateAtlasToProject(createAtlasState(duplicateLabels), duplicateLabels, 'owner-a/api');
  const reordered = semanticGraphFromScene(createScene('alice', [
    { full_name: 'owner-b/api', name: 'api', language: 'JavaScript' },
    { full_name: 'owner-a/api', name: 'api', language: 'Rust' },
  ]));
  const history = createAtlasHistory(first);
  assert.equal(history.reconcile(first, reordered).projectId, 'owner-a/api');
  assert.equal(validateAtlasState(history.current, reordered).valid, true);
});
