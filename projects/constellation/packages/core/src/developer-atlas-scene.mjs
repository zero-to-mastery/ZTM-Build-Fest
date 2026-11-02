import { createScene } from './constellation.mjs';
import { projectSemanticLevel } from './semantic-groups.mjs';
import { projectSemanticGraphToScene } from './semantic-graph.mjs';
import { validateAtlasState } from './developer-atlas.mjs';

function retainEvidenceForScene(scene, graph) {
  if (!graph.evidence) return;
  const subjects = new Set([...(scene.nodes || []).map(node => node.id), ...(scene.semanticGroups?.sourceNodeIds || [])]);
  const evidenceSubjects = graph.evidence.subjects.filter(item => subjects.has(item.id));
  const factIds = new Set(evidenceSubjects.flatMap(item => item.facts));
  scene.evidence = { version: graph.evidence.version, facts: graph.evidence.facts.filter(fact => factIds.has(fact.id)), subjects: evidenceSubjects.map(item => ({ ...item, facts: item.facts.filter(id => factIds.has(id)) })) };
  if (scene.semanticGroups?.canonical) scene.semanticGroups.canonical.evidence = structuredClone(scene.evidence);
}

/** Project an already-validated graph for the current Atlas context. */
export function projectDeveloperAtlasScene(graph, atlasState, options = {}, projectGraph = null, runtime = {}) {
  const stateResult = validateAtlasState(atlasState, graph);
  if (!stateResult.valid) throw new Error(`Invalid Atlas state: ${stateResult.errors.join(' ')}`);
  if (atlasState.level === 'structure') {
    if (projectGraph?.subject?.id !== atlasState.projectId) throw new Error('Structural detail is not included in this graph.');
    return projectSemanticGraphToScene(projectGraph, options, runtime);
  }
  if (atlasState.level === 'developer') return projectSemanticGraphToScene(graph, options, runtime);
  const projectNodes = graph.nodes.filter(node => node.kind === 'project').sort((a, b) => a.id.localeCompare(b.id));
  const selectedGroup = atlasState.level === 'group' ? graph.groups.find(group => group.id === atlasState.groupId) : null;
  const selectedProject = atlasState.level === 'project' ? projectNodes.find(node => node.id === atlasState.projectId) : null;
  const candidates = selectedProject ? [selectedProject] : selectedGroup
    ? [...selectedGroup.members.map(id => projectNodes.find(node => node.id === id)).filter(Boolean), ...projectNodes.filter(node => !selectedGroup.members.includes(node.id))].slice(0, 100)
    : projectNodes.slice(0, 100);
  const records = candidates.map(node => ({
    full_name: node.id, name: node.label, description: node.properties.description || '',
    language: node.properties.language || null, topics: node.properties.topics || [],
  }));
  const view = createScene(graph.subject.id, records, {
    ...options, maxRepos: Math.max(1, records.length), includeRepos: records.map(record => record.full_name),
    projectFamilies: {}, projectRelationships: graph.edges.filter(edge => edge.kind === 'project-relationship').map(edge => [edge.from, edge.to]),
  }, runtime);
  if (atlasState.level === 'group') {
    const ids = new Set(records.map(record => record.full_name));
    const groups = graph.groups.filter(group => !selectedGroup || group.id === selectedGroup.id).map(group => ({
      version: 1, id: group.id, kind: group.kind, label: group.label, provenance: group.provenance,
      basis: [...group.basis], members: group.members.filter(id => ids.has(id)),
    })).filter(group => group.members.length >= 2);
    const hierarchy = { groups, projectIds: [...ids], source: view };
    const scene = projectSemanticLevel(view, 'groups', { hierarchy, expanded: selectedGroup ? [selectedGroup.id] : [] });
    retainEvidenceForScene(scene, graph);
    return scene;
  }
  retainEvidenceForScene(view, graph);
  return view;
}
