import { performance } from 'node:perf_hooks';
import { createScene } from '../src/constellation.mjs';
import { semanticGraphFromScene, semanticGraphFromProjectConstellation, semanticGraphFingerprint } from '../src/semantic-graph.mjs';
import { createProjectConstellation } from '../src/project-constellation.mjs';
import { createAtlasState, createAtlasHistory, navigateAtlasToGroup, navigateAtlasToProject, navigateAtlasToStructure, atlasBreadcrumbs } from '../src/developer-atlas.mjs';
import { projectDeveloperAtlasScene } from '../src/developer-atlas-scene.mjs';

function measure(action, rounds = 5) {
  const samples = [];
  for (let index = 0; index < rounds; index++) { const start = performance.now(); action(); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  return Number(samples[Math.floor(samples.length / 2)].toFixed(3));
}
function developerCase(count, groupCount = Math.min(32, count)) {
  const records = Array.from({ length: Math.min(count, 100) }, (_, index) => ({ full_name: `atlas-${index < groupCount ? 'tools' : 'project'}/${String(index).padStart(4, '0')}`, name: `Project ${index}`, language: index % 2 ? 'Rust' : 'JavaScript', topics: ['atlas', `batch-${index % 8}`] }));
  const graph = semanticGraphFromScene(createScene('atlas-tools', records, { maxRepos: records.length, includeRepos: records.map(record => record.full_name), projectFamilies: { tools: { label: 'Atlas Tools', members: records.slice(0, groupCount).map(record => record.full_name) } } }));
  if (count > records.length) {
    for (let index = records.length; index < count; index++) graph.nodes.push({ id: `atlas-bench/${String(index).padStart(4, '0')}`, kind: 'project', label: `Project ${index}`, properties: { language: index % 2 ? 'Rust' : 'JavaScript', topics: ['atlas', `batch-${index % 8}`] }, provenance: [{ category: 'source', source: 'github' }], evidenceIds: [] });
    graph.nodes.sort((a, b) => a.id.localeCompare(b.id));
    graph.statistics.nodeCount = graph.nodes.length;
  }
  const root = createAtlasState(graph), group = graph.groups.find(item => item.id === 'group:user:tools');
  if (!group) throw new Error(`benchmark fixture omitted its canonical user group for ${count} projects`);
  const groupState = navigateAtlasToGroup(root, graph, group.id);
  const projectState = navigateAtlasToProject(groupState, graph, group.members[0]);
  return { graph, records, root, group, groupState, projectState };
}
const output = [];
{
  const value = developerCase(45);
  const sameHistory = createAtlasHistory(value.root); sameHistory.push(value.groupState); sameHistory.push(value.projectState);
  const reorderedGraph = semanticGraphFromScene(createScene('atlas-tools', [...value.records].reverse(), { maxRepos: value.records.length, includeRepos: value.records.map(record => record.full_name), projectFamilies: { tools: { label: 'Atlas Tools', members: value.records.slice(0, 32).map(record => record.full_name) } } }));
  output.push({ case: 'same fingerprint reconciliation', fingerprintStable: semanticGraphFingerprint(value.graph) === semanticGraphFingerprint(reorderedGraph), reconcileMs: measure(() => sameHistory.reconcile(value.projectState, reorderedGraph)) });
  const changedRecords = value.records.map((record, index) => index === 5 ? { ...record, topics: ['atlas', 'refreshed'] } : record);
  const changedGraph = semanticGraphFromScene(createScene('atlas-tools', changedRecords, { maxRepos: changedRecords.length, includeRepos: changedRecords.map(record => record.full_name), projectFamilies: { tools: { label: 'Atlas Tools', members: changedRecords.slice(0, 32).map(record => record.full_name) } } }));
  const changedHistory = createAtlasHistory(value.root); changedHistory.push(value.groupState); changedHistory.push(value.projectState);
  output.push({ case: 'changed fingerprint reconciliation', fingerprintChanged: semanticGraphFingerprint(value.graph) !== semanticGraphFingerprint(changedGraph), preserveRoute: changedHistory.reconcile(value.projectState, changedGraph).projectId === value.projectState.projectId, reconcileMs: measure(() => changedHistory.reconcile(value.projectState, changedGraph)) });
  const remaining = value.records.filter(record => record.full_name !== value.projectState.projectId);
  const fallbackGraph = semanticGraphFromScene(createScene('atlas-tools', remaining, { maxRepos: remaining.length, includeRepos: remaining.map(record => record.full_name), projectFamilies: { tools: { label: 'Atlas Tools', members: remaining.slice(0, 31).map(record => record.full_name) } } }));
  const fallbackHistory = createAtlasHistory(value.root); fallbackHistory.push(value.groupState); fallbackHistory.push(value.projectState);
  output.push({ case: 'nearest parent fallback', fallbackLevel: fallbackHistory.reconcile(value.projectState, fallbackGraph).level, reconcileMs: measure(() => fallbackHistory.reconcile(value.projectState, fallbackGraph)) });
  const travelHistory = createAtlasHistory(value.root); travelHistory.push(value.groupState); travelHistory.push(value.projectState);
  output.push({ case: 'history restore', restoreMs: measure(() => { travelHistory.transact('back', () => true); travelHistory.transact('forward', () => true); }) });
}
for (const count of [45, 256]) {
  const value = developerCase(count);
  output.push({ case: `developer ${count}`, transitionMs: measure(() => navigateAtlasToProject(value.groupState, value.graph, value.group.members[0])), breadcrumbsMs: measure(() => atlasBreadcrumbs(value.projectState, value.graph)), projectionMs: measure(() => projectDeveloperAtlasScene(value.graph, value.groupState)), repeatTransitionProjectionMs: measure(() => { navigateAtlasToGroup(value.root, value.graph, value.group.id); projectDeveloperAtlasScene(value.graph, value.groupState); }) });
}
{
  const value = developerCase(45, 32);
  output.push({ case: 'group 32 members', transitionMs: measure(() => navigateAtlasToProject(value.groupState, value.graph, value.group.members[0])), breadcrumbsMs: measure(() => atlasBreadcrumbs(value.groupState, value.graph)), projectionMs: measure(() => projectDeveloperAtlasScene(value.graph, value.groupState)) });
}
for (const count of [50, 100]) {
  const tree = [{ path: 'src', type: 'tree' }, ...Array.from({ length: count - 2 }, (_, index) => ({ path: `src/module-${String(index).padStart(3, '0')}.mjs`, type: 'blob' }))];
  const model = createProjectConstellation({ projectId: 'atlas-tools/0000', ref: 'main', tree });
  const projectGraph = semanticGraphFromProjectConstellation(model);
  const value = developerCase(45);
  const project = navigateAtlasToProject(value.root, value.graph, 'atlas-tools/0000');
  const node = projectGraph.nodes.find(item => item.kind === 'module') || projectGraph.nodes[0];
  const structural = navigateAtlasToStructure(project, value.graph, projectGraph, node.id);
  output.push({ case: `project structure ${count} target files`, actualNodes: projectGraph.nodes.length, transitionMs: measure(() => navigateAtlasToStructure(project, value.graph, projectGraph, node.id)), breadcrumbsMs: measure(() => atlasBreadcrumbs(structural, value.graph, projectGraph)), projectionMs: measure(() => projectDeveloperAtlasScene(value.graph, structural, {}, projectGraph)) });
}
console.log(JSON.stringify({ benchmark: 'developer-atlas', network: false, milliseconds: output }, null, 2));
