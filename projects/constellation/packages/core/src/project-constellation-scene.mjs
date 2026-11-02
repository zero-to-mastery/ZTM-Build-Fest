import { createScene } from './constellation.mjs';
import { createHierarchy } from './hierarchy.mjs';
import { validateProjectConstellation } from './project-constellation.mjs';
import { fitSceneViewport } from './scene-framing.mjs';

/** Adapt a normalized structural graph into the existing Scene API v1 renderer.
 * Network acquisition and structure parsing never enter the renderer. */
export function createProjectConstellationScene(model, options = {}, runtime = {}) {
  const validation = validateProjectConstellation(model);
  if (!validation.valid) throw new Error(`Invalid project constellation: ${validation.errors.join(' ')}`);
  const records = model.nodes.map(node => ({
    full_name: node.id, name: node.label, description: `${node.kind}: ${node.path || model.projectId}`,
    nodeKind: 'repository', projectStructureKind: node.kind, structuralPath: node.path,
    structuralParent: node.parent, structuralSource: node.source,
  }));
  const scene = createScene(model.projectId.split('/')[0], records, {
    ...options,
    arrangement: 'solar-system', nodeMode: 'repositories', maxRepos: 100,
    showOther: true,
    accountSun: 'off', nodeShape: 'mixed', seed: `project:${model.projectId}:${model.provenance.ref}`,
  }, runtime);
  const byId = new Map(scene.nodes.map(node => [node.id, node]));
  const levelById = new Map([[model.nodes.find(node=>node.kind==='project-root').id,0]]);
  const modelById = new Map(model.nodes.map(node=>[node.id,node]));
  const levelOf = node => {
    if (levelById.has(node.id)) return levelById.get(node.id);
    const parent = modelById.get(node.parent);
    const level = parent ? levelOf(parent) + 1 : 1;
    levelById.set(node.id,level); return level;
  };
  const maximumDepth=Math.max(1,...model.nodes.map(levelOf));
  const outerRadius=Math.max(84,Math.min(205,30+Math.sqrt(Math.max(1,model.nodes.length-1))*11+maximumDepth*25));
  const layers = new Map();
  for (const node of model.nodes) if (node.kind !== 'project-root') {
    const level=levelOf(node); if(!layers.has(level)) layers.set(level,[]); layers.get(level).push(node);
  }
  const centerX=scene.viewport.width/2, centerY=scene.viewport.height/2;
  for (const node of scene.nodes) {
    const structural = model.nodes.find(item => item.id === node.id);
    if (!structural) continue;
    Object.assign(node.metadata, { nodeKind: structural.kind, projectStructureKind: structural.kind, structuralPath: structural.path, structuralParent: structural.parent, structuralSource: structural.source });
    node.style.shape = ({ 'project-root':'star', package:'hexagon', directory:'diamond', module:'circle', 'entry-point':'square' })[structural.kind];
    node.geometry.radius = ({ 'project-root':8, package:6.5, directory:5.5, module:4, 'entry-point':5 })[structural.kind];
    if (structural.kind === 'project-root') { node.geometry.x=centerX; node.geometry.y=centerY; continue; }
    const siblings=layers.get(levelOf(structural)).sort((a,b)=>a.id.localeCompare(b.id));
    const level=levelOf(structural), index=siblings.findIndex(item=>item.id===structural.id), radius=outerRadius*level/maximumDepth;
    const angle=-Math.PI/2+2*Math.PI*index/siblings.length;
    node.geometry.x=centerX+Math.cos(angle)*radius; node.geometry.y=centerY+Math.sin(angle)*radius;
  }
  for (const label of scene.labels) {
    const node=byId.get(label.id); if (!node) continue;
    label.x=Math.max(4,Math.min(scene.viewport.width-4,node.geometry.x+node.geometry.radius+5));
    label.y=Math.max(12,Math.min(scene.viewport.height-4,node.geometry.y+4));
  }
  scene.edges = [];
  for (const edge of model.edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) continue;
    scene.edges.push({
      id: edge.id, from: edge.from, to: edge.to,
      metadata: { key: edge.id, shared: [], sharedLanguages: [], sharedTopics: [], sharedRepositories: [], strength: 1, structuralKind: edge.kind, evidence: structuredClone(edge.evidence) },
      geometry: { distance: (to.geometry.x - from.geometry.x) ** 2 + (to.geometry.y - from.geometry.y) ** 2 },
      style: { primary: true },
    });
  }
  scene.presentation.totalConnections = scene.edges.length;
  scene.presentation.graph.note = `${scene.presentation.graph.note || ''} Project structure at ${model.provenance.ref}${model.provenance.commit ? ` (${model.provenance.commit})` : ''}; ${model.statistics.filesInspected} files inspected${model.statistics.truncated ? `; limited scan: ${model.statistics.limitation}` : '.'}`;
  const framed=options.perspective?.enabled?scene:fitSceneViewport(scene);
  return { model: structuredClone(model), scene: framed };
}

/** Attach the project as a child Scene API hierarchy entry. Existing hierarchy
 * navigation supplies the breadcrumb, Back action, and parent view restoration. */
export function createProjectConstellationHierarchy(parentScene, projectNodeId, model, options = {}, runtime = {}) {
  const parent = structuredClone(parentScene);
  if (parent?.kind !== 'scene' || !Array.isArray(parent.nodes) || !parent.nodes.some(node => node.id === projectNodeId)) throw new Error('The parent scene must contain the selected project node.');
  if (parent.hierarchy) throw new Error('Open a project from the active hierarchy scene; nested hierarchy containers are not supported.');
  const childId = `project:${model.projectId}`;
  const { scene: child } = createProjectConstellationScene(model, options, runtime);
  return createHierarchy({ root: 'parent', scenes: [
    { id: 'parent', title: parent.metadata?.account || 'Projects', scene: parent, links: [{ nodeId: projectNodeId, target: childId }] },
    { id: childId, title: model.projectId, scene: child },
  ] }, runtime);
}
