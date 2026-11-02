import { createScene } from '../src/core-api.mjs';
import { aggregateEdgeStyle, applyStaticExportDensity, exportDensityPolicy, prioritizeExportLabels } from '../src/export-density.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { buildSemanticHierarchy, projectSemanticLevel } from '../src/semantic-groups.mjs';

const clock = () => performance.now();
const elapsed = (start) => Number((performance.now() - start).toFixed(2));

for (const [count, groupCount] of [[45, 9], [256, 16], [2048, 32]]) {
  const repositories = Array.from({ length: count }, (_, index) => ({
    full_name: `benchmark/project-${String(index).padStart(4, '0')}`,
    name: `project-${String(index).padStart(4, '0')}`,
    language: index % 3 ? 'Rust' : 'JavaScript',
    topics: [`topic-${index % 12}`, 'dense-export'],
    stargazers_count: count - index,
  }));
  const perGroup = Math.ceil(count / groupCount);
  const projectFamilies = Object.fromEntries(Array.from({ length: groupCount }, (_, index) => [
    `family-${String(index).padStart(2, '0')}`,
    { label: `Family ${String(index).padStart(2, '0')}`, members: repositories.slice(index * perGroup, (index + 1) * perGroup).map(repo => repo.full_name) },
  ]).filter(([, family]) => family.members.length >= 2));
  const scene = createScene('benchmark', repositories, { exportProfile: 'readme', animate: false, maxRepos: count, nodeCap: count, projectFamilies });
  scene.viewport.width = 720;

  let start = clock();
  const hierarchy = buildSemanticHierarchy(scene, { projectFamilies });
  const hierarchyMs = elapsed(start);
  start = clock();
  const projected = projectSemanticLevel(scene, 'groups', { hierarchy });
  const projectionMs = elapsed(start);
  const policy = exportDensityPolicy({ profile: 'readme', width: 720, nodeCount: projected.nodes.length, groupCount: hierarchy.groups.length });
  start = clock();
  const labelSelection = prioritizeExportLabels(structuredClone(projected), policy);
  const labelSelectionMs = elapsed(start);
  start = clock();
  const staticScene = applyStaticExportDensity(projected, policy);
  const densityPassMs = elapsed(start);
  start = clock();
  const weightedEdges = projected.edges.filter(edge => edge.metadata.aggregated).map(edge => aggregateEdgeStyle(edge.metadata.relationshipCount, policy.edgeWidthRange, policy.edgeOpacityRange));
  const edgeStyleMs = elapsed(start);
  start = clock();
  const svg = renderSceneSVG(scene);
  const svgRenderMs = elapsed(start);

  console.log(JSON.stringify({
    projects: count,
    authoredGroups: hierarchy.groups.length,
    visibleNodes: staticScene.nodes.length,
    visibleLabels: labelSelection.visibleIds.length,
    aggregateEdges: weightedEdges.length,
    hierarchyMs,
    groupedProjectionMs: projectionMs,
    exportDensityMs: densityPassMs,
    labelPrioritizationMs: labelSelectionMs,
    edgeStyleCalculationMs: edgeStyleMs,
    svgRenderMs,
    svgBytes: Buffer.byteLength(svg),
  }));
}
