// Evidence Navigation v1: Core adapter between Semantic Graph v1 and the Rust index.
// Navigation reads the graph; it never writes to the graph, Scene, or config.
import { semanticGraphFromScene } from './semantic-graph.mjs';
export { evidenceNavigatorAdapter } from './evidence-navigator.mjs';

export const EVIDENCE_NAVIGATION_VERSION = 1;
export const EVIDENCE_NAVIGATION_RELATIONSHIP_TYPES = Object.freeze(['explicit-relationship', 'authored-family', 'shared-language', 'shared-topic']);
const NODE_KINDS = new Set(['project', 'language', 'topic', 'semantic-group']);
const EDGE_KINDS = new Set(['uses-language', 'has-topic', 'member-of', 'project-relationship']);
const provenance = items => (Array.isArray(items) ? items : []).slice(0, 16).map(item => ({ category: item?.category }));

// The compact graph keeps only identities, labels, provenance and the four edge
// kinds navigation explains; descriptions, URLs and evidence payloads stay in the
// source graph and scene. The result is still a valid subset of Semantic Graph v1.
export function evidenceNavigationGraph(graph) {
  if (!graph || graph.version !== 1 || !Array.isArray(graph.nodes)) throw new Error('Evidence Navigation requires Semantic Graph v1.');
  const nodes = graph.nodes.filter(node => NODE_KINDS.has(node?.kind)).map(node => ({
    id: node.id, kind: node.kind, label: node.label,
    ...(node.kind === 'semantic-group' && typeof node.properties?.groupKind === 'string' ? { properties: { groupKind: node.properties.groupKind } } : {}),
    provenance: provenance(node.provenance),
  }));
  const ids = new Set(nodes.map(node => node.id));
  const edges = (graph.edges || []).filter(edge => EDGE_KINDS.has(edge?.kind) && ids.has(edge.from) && ids.has(edge.to))
    .map(edge => ({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, provenance: provenance(edge.provenance) }));
  return { version: 1, nodes, edges };
}

// Scenes that cannot produce portable semantic truth (for example a projected
// scene without canonical groups, or a time-lapse) keep the existing behavior.
export function evidenceNavigationGraphFromScene(scene) {
  try { return evidenceNavigationGraph(semanticGraphFromScene(scene)); } catch { return null; }
}
